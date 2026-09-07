#!/usr/bin/env node
/**
 * calibrate-draft.js — is a draft grade worth printing?
 *
 * A draft grade is the easiest number on a fantasy site to fake: pick a few
 * weights, sum something, print a letter. So before building one, two questions
 * get measured.
 *
 *   1. WHAT DOES A PICK AT SLOT N ACTUALLY RETURN? A grade has to be value over
 *      expectation, and the expectation has to come from somewhere. It is fitted
 *      here from the drafts themselves rather than assumed.
 *
 *   2. DOES THE GRADE PREDICT ANYTHING? If teams that drafted well did not go on
 *      to win more, the grade is a decoration, and this script is where that
 *      gets said rather than discovered later.
 *
 * Production is points scored WHILE ROSTERED IN THIS LEAGUE, summed from the
 * weekly matchup rows. A player dropped and never picked up again stops
 * counting — that is a limitation and it is stated on the page, not hidden.
 *
 *   node scripts/calibrate-draft.js
 */

const START = process.env.LEAGUE_ID || '1312177397189062656';
const API = 'https://api.sleeper.app/v1';

async function j(u) { const r = await fetch(u); if (!r.ok) throw new Error(`${u} → ${r.status}`); return r.json(); }
const mean = (a) => a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0;

async function completedSeasons() {
  const out = []; let id = START;
  while (id && out.length < 12) {
    const l = await j(`${API}/league/${id}`);
    if (l.status === 'complete') out.push(l);
    id = l.previous_league_id;
  }
  return out;
}

function pairsOf(rows) {
  const by = {};
  for (const m of rows) if (m.matchup_id != null) (by[m.matchup_id] ||= []).push(m.roster_id);
  return Object.values(by).filter(p => p.length === 2);
}

async function seasonData(league) {
  const last = (league.settings.playoff_week_start || 15) - 1;
  const weeks = [];
  for (let w = 1; w <= last; w++) weeks.push(await j(`${API}/league/${league.league_id}/matchups/${w}`));

  // Points scored while rostered by anyone in the league. A player sits on one
  // roster per week, so summing across rosters cannot double count him.
  const points = {};
  for (const rows of weeks) {
    for (const m of rows) {
      for (const [pid, pts] of Object.entries(m.players_points || {})) {
        points[pid] = (points[pid] || 0) + (pts || 0);
      }
    }
  }

  // Actual regular-season record, to check the grade against.
  const rec = {};
  for (const rows of weeks) {
    const pts = new Map(rows.map(m => [m.roster_id, m.points]));
    for (const [a, b] of pairsOf(rows)) {
      const sa = pts.get(a) || 0, sb = pts.get(b) || 0;
      if (!(sa > 0 && sb > 0)) continue;
      rec[a] ||= { w: 0, g: 0 }; rec[b] ||= { w: 0, g: 0 };
      rec[a].g++; rec[b].g++;
      if (sa > sb) rec[a].w++; else if (sb > sa) rec[b].w++;
      else { rec[a].w += 0.5; rec[b].w += 0.5; }
    }
  }

  const drafts = await j(`${API}/league/${league.league_id}/drafts`);
  const picks = drafts.length ? await j(`${API}/draft/${drafts[0].draft_id}/picks`) : [];
  return { season: league.season, points, rec, picks };
}

function corr(xs, ys) {
  const mx = mean(xs), my = mean(ys);
  const cov = mean(xs.map((x, i) => (x - mx) * (ys[i] - my)));
  const sx = Math.sqrt(mean(xs.map(x => (x - mx) ** 2))) || 1e-12;
  const sy = Math.sqrt(mean(ys.map(y => (y - my) ** 2))) || 1e-12;
  return cov / (sx * sy);
}

async function main() {
  const leagues = await completedSeasons();
  const seasons = [];
  for (const l of leagues) { seasons.push(await seasonData(l)); console.log(`[data] ${l.season}: ${(await 0, seasons[seasons.length-1].picks.length)} picks`); }

  // ---- 1. what a pick at slot N returns -----------------------------------
  // Pooled across seasons and smoothed over a window, because a single pick
  // number across four drafts is four observations.
  const byPick = {};
  for (const s of seasons) {
    for (const p of s.picks) {
      if (p.is_keeper) continue;   // a keeper is not a pick anyone made this year
      (byPick[p.pick_no] ||= []).push(s.points[p.player_id] || 0);
    }
  }
  const maxPick = Math.max(...Object.keys(byPick).map(Number));
  const expectedAt = (n, win = 6) => {
    const vals = [];
    for (let k = n - win; k <= n + win; k++) if (byPick[k]) vals.push(...byPick[k]);
    return mean(vals);
  };

  console.log('');
  console.log('      what a pick actually returns (points, smoothed over +/-6 picks):');
  for (const n of [1, 5, 10, 20, 30, 50, 70, 100, 130]) {
    if (n > maxPick) continue;
    console.log(`        pick ${String(n).padStart(3)}   ${expectedAt(n).toFixed(0).padStart(5)} pts`);
  }

  // ---- 2. does the grade predict anything? --------------------------------
  const gx = [], gy = [], rows = [];
  for (const s of seasons) {
    const grade = {};
    for (const p of s.picks) {
      if (p.is_keeper) continue;
      const got = s.points[p.player_id] || 0;
      grade[p.roster_id] = (grade[p.roster_id] || 0) + (got - expectedAt(p.pick_no));
    }
    for (const [rid, g] of Object.entries(grade)) {
      const r = s.rec[rid];
      if (!r || !r.g) continue;
      gx.push(g); gy.push(r.w / r.g);
      rows.push({ season: s.season, rid, grade: g, winPct: r.w / r.g });
    }
  }

  console.log('');
  console.log(`[check] ${rows.length} team-seasons`);
  console.log(`[check] draft grade vs actual win rate:  r = ${corr(gx, gy).toFixed(3)}`);

  // Per season, because four seasons is not many and one can carry the rest.
  console.log('');
  console.log('      by season:');
  for (const s of seasons) {
    const sub = rows.filter(r => r.season === s.season);
    console.log(`        ${s.season}   r = ${corr(sub.map(r => r.grade), sub.map(r => r.winPct)).toFixed(3)}   (n=${sub.length})`);
  }

  console.log('');
  console.log('      best and worst drafts on record:');
  rows.sort((a, b) => b.grade - a.grade);
  for (const r of [rows[0], rows[1], rows[rows.length - 2], rows[rows.length - 1]]) {
    console.log(`        ${r.season} roster ${String(r.rid).padStart(2)}  grade ${(r.grade >= 0 ? '+' : '') + r.grade.toFixed(0).padStart(5)}   went ${(r.winPct * 100).toFixed(0)}%`);
  }
}

main().catch(e => { console.error(e.stack); process.exit(1); });
