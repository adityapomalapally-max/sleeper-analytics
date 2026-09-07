#!/usr/bin/env node
/**
 * calibrate-manager.js — can you separate the manager from the roster?
 *
 * ffwrapped's own analytics guide names this and does not define it:
 * "manager performance vs. roster quality — distinguishing decision-making
 * ability from draft luck". It is the most interesting thing on their site and
 * the one thing they do not actually publish.
 *
 * It is computable, because Sleeper gives starters AND bench points every week:
 *
 *   optimal   the best legal lineup available that week — what the ROSTER was
 *             worth, with every decision taken perfectly
 *   actual    what was started — the roster minus whatever the manager got wrong
 *   efficiency actual / optimal — the only number here that is about the person
 *
 * Everything else a fantasy site prints (points, wins, all-play) is roster plus
 * luck. Efficiency is the manager, isolated.
 *
 * WHETHER IT MEANS ANYTHING IS A SEPARATE QUESTION, and the point of this
 * script. Two things get measured before a single number is published:
 *
 *   1. does it predict? correlate each candidate with rest-of-season win rate
 *   2. is it a SKILL? a skill persists — a manager good at it in the first half
 *      should be good at it in the second. Split-half correlation says whether
 *      there is a person in the number or just noise.
 *
 * The second test is the one that matters, and almost nobody runs it.
 *
 *   node scripts/calibrate-manager.js
 */

const START = process.env.LEAGUE_ID || '1312177397189062656';
const API = 'https://api.sleeper.app/v1';

async function j(u) { const r = await fetch(u); if (!r.ok) throw new Error(`${u} → ${r.status}`); return r.json(); }
const mean = (a) => a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0;

function corr(xs, ys) {
  const mx = mean(xs), my = mean(ys);
  const cov = mean(xs.map((x, i) => (x - mx) * (ys[i] - my)));
  const sx = Math.sqrt(mean(xs.map(x => (x - mx) ** 2))) || 1e-12;
  const sy = Math.sqrt(mean(ys.map(y => (y - my) ** 2))) || 1e-12;
  return cov / (sx * sy);
}

const FLEX = { FLEX: ['RB','WR','TE'], SUPER_FLEX: ['QB','RB','WR','TE'], REC_FLEX: ['WR','TE'], WRRB_FLEX: ['WR','RB'] };

// The best legal lineup from everyone rostered that week.
function optimalOf(entry, slots, players) {
  const pts = entry.players_points || {};
  const pool = (entry.players || []).map(id => ({
    id, pts: pts[id] || 0, pos: (players[id] || {}).position || null,
  })).filter(p => p.pos);
  const byPos = {};
  for (const p of pool) (byPos[p.pos] ||= []).push(p);
  for (const a of Object.values(byPos)) a.sort((x, y) => y.pts - x.pts);

  const used = new Set();
  let total = 0;
  const take = (positions) => {
    let best = null;
    for (const pos of positions) {
      for (const p of (byPos[pos] || [])) { if (used.has(p.id)) continue; if (!best || p.pts > best.pts) best = p; break; }
    }
    if (best) { used.add(best.id); total += best.pts; }
  };
  for (const s of slots) if (!FLEX[s]) take([s]);
  for (const s of slots) if (FLEX[s]) take(FLEX[s]);
  return total;
}

async function completed() {
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

async function main() {
  const players = await j(`${API}/players/nfl`);
  // Who each team DRAFTED, so production can be split into what the draft
  // handed you and what you went and got. Acquisition is the candidate skill:
  // unlike lineup efficiency it is an action taken before the outcome is known.
  const draftedBy = new Map();
  const leagues = await completed();
  const rows = [];   // one per team-season, with both halves separated

  for (const l of leagues) {
    const last = (l.settings.playoff_week_start || 15) - 1;
    const slots = (l.roster_positions || []).filter(s => s !== 'BN' && s !== 'IR' && s !== 'TAXI');
    const weeks = [];
    for (let w = 1; w <= last; w++) weeks.push(await j(`${API}/league/${l.league_id}/matchups/${w}`));

    const drafts = await j(`${API}/league/${l.league_id}/drafts`).catch(() => []);
    const picks = drafts.length ? await j(`${API}/draft/${drafts[0].draft_id}/picks`).catch(() => []) : [];
    const drafted = new Map();
    for (const pk of picks) {
      if (!drafted.has(pk.roster_id)) drafted.set(pk.roster_id, new Set());
      drafted.get(pk.roster_id).add(pk.player_id);
    }
    draftedBy.set(l.league_id, drafted);

    const ids = [...new Set(weeks[0].map(m => m.roster_id))];
    const acc = new Map(ids.map(i => [i, { a1: 0, o1: 0, a2: 0, o2: 0, w: 0, g: 0, w2: 0, g2: 0, opt: 0,
                                           acq1: 0, acq2: 0, rq1: 0, rq2: 0, n1: 0, n2: 0 }]));
    const half = Math.floor(last / 2);

    weeks.forEach((rowsW, i) => {
      const pts = new Map(rowsW.map(m => [m.roster_id, m.points]));
      for (const m of rowsW) {
        const t = acc.get(m.roster_id); if (!t) continue;
        const actual = m.points || 0;
        if (actual <= 0) continue;
        const opt = optimalOf(m, slots, players);
        if (i < half) { t.a1 += actual; t.o1 += opt; t.rq1 += opt; t.n1++; }
        else { t.a2 += actual; t.o2 += opt; t.rq2 += opt; t.n2++; }
        t.opt += opt;

        // STARTED POINTS FROM PLAYERS THIS TEAM DID NOT DRAFT. A waiver claim
        // or a trade is a decision made BEFORE the week is played, which is
        // what makes it a candidate skill in a way that "did you start the guy
        // who happened to boom" is not.
        const mine = drafted.get(m.roster_id) || new Set();
        const pp = m.players_points || {};
        let acq = 0;
        for (const id of (m.starters || [])) if (id && !mine.has(id)) acq += pp[id] || 0;
        if (i < half) t.acq1 += acq; else t.acq2 += acq;
      }
      for (const [a, b] of pairsOf(rowsW)) {
        const sa = pts.get(a) || 0, sb = pts.get(b) || 0;
        if (!(sa > 0 && sb > 0)) continue;
        const A = acc.get(a), B = acc.get(b);
        A.g++; B.g++;
        if (sa > sb) A.w++; else if (sb > sa) B.w++; else { A.w += 0.5; B.w += 0.5; }
        if (i >= half) {
          A.g2++; B.g2++;
          if (sa > sb) A.w2++; else if (sb > sa) B.w2++; else { A.w2 += 0.5; B.w2 += 0.5; }
        }
      }
    });

    for (const [id, t] of acc) {
      if (!t.o1 || !t.o2 || !t.g2) continue;
      rows.push({
        season: l.season, id,
        eff1: t.a1 / t.o1, eff2: t.a2 / t.o2,
        effAll: (t.a1 + t.a2) / (t.o1 + t.o2),
        rosterQuality: t.opt / t.g,          // points the roster was worth per week
        rq1: t.n1 ? t.rq1 / t.n1 : 0, rq2: t.n2 ? t.rq2 / t.n2 : 0,
        acq1: t.n1 ? t.acq1 / t.n1 : 0, acq2: t.n2 ? t.acq2 / t.n2 : 0,
        acqAll: (t.n1 + t.n2) ? (t.acq1 + t.acq2) / (t.n1 + t.n2) : 0,
        winPct: t.w / t.g,
        winPct2: t.w2 / t.g2,
      });
    }
    console.log(`[data] ${l.season}: ${acc.size} teams, ${last} weeks`);
  }

  console.log('');
  console.log(`[fit] ${rows.length} team-seasons`);
  console.log('');
  console.log('      DOES IT PREDICT? correlation with win rate');
  console.log(`        lineup efficiency   r = ${corr(rows.map(r => r.effAll), rows.map(r => r.winPct)).toFixed(3)}`);
  console.log(`        roster quality      r = ${corr(rows.map(r => r.rosterQuality), rows.map(r => r.winPct)).toFixed(3)}`);
  console.log('');
  console.log('      IS IT A SKILL? first half vs second half of the same season');
  console.log(`        lineup efficiency   r = ${corr(rows.map(r => r.eff1), rows.map(r => r.eff2)).toFixed(3)}`);
  console.log('');
  console.log('      and does first-half efficiency predict SECOND-half wins?');
  console.log(`        efficiency -> wins  r = ${corr(rows.map(r => r.eff1), rows.map(r => r.winPct2)).toFixed(3)}`);
  console.log(`        roster     -> wins  r = ${corr(rows.map(r => r.rosterQuality), rows.map(r => r.winPct2)).toFixed(3)}`);
  console.log('');
  console.log('');
  console.log('      THE SAME TWO TESTS FOR EVERY CANDIDATE');
  console.log('        candidate            predicts wins   persists (1st vs 2nd half)');
  const cands = [
    ['lineup efficiency', r => r.effAll, r => r.eff1, r => r.eff2],
    ['roster quality',    r => r.rosterQuality, r => r.rq1, r => r.rq2],
    ['acquisition points', r => r.acqAll, r => r.acq1, r => r.acq2],
  ];
  for (const [name, all, h1, h2] of cands) {
    const pred = corr(rows.map(all), rows.map(r => r.winPct));
    const pers = corr(rows.map(h1), rows.map(h2));
    console.log(`        ${name.padEnd(20)} ${pred >= 0 ? ' ' : ''}${pred.toFixed(3)}          ${pers >= 0 ? ' ' : ''}${pers.toFixed(3)}`);
  }
  console.log('');
  console.log('      out of sample: first half -> SECOND-half wins');
  for (const [name, , h1] of cands) {
    console.log(`        ${name.padEnd(20)} r = ${corr(rows.map(h1), rows.map(r => r.winPct2)).toFixed(3)}`);
  }

  console.log('');
  const effs = rows.map(r => r.effAll);
  console.log(`      efficiency ranges ${(Math.min(...effs) * 100).toFixed(1)}% to ${(Math.max(...effs) * 100).toFixed(1)}%, mean ${(mean(effs) * 100).toFixed(1)}%`);
  const spread = Math.sqrt(mean(effs.map(e => (e - mean(effs)) ** 2)));
  console.log(`      spread (sd) ${(spread * 100).toFixed(2)} points of efficiency`);
}

main().catch(e => { console.error(e.stack); process.exit(1); });
