#!/usr/bin/env node
/**
 * score-claims.js — score every published number against what it claims.
 *
 * lib/claims.js says what each number on this site asserts. This measures
 * whether the assertion is still true, against the completed seasons of the
 * league, and writes the scorecard the pages quote.
 *
 * The rule it enforces is the one in lib/claims.js: a number about a SITUATION
 * has to predict, a number about a PERSON has to persist. Two of the claims are
 * marked expectFail — they are published as descriptions precisely BECAUSE they
 * do not hold, and if one of them ever starts holding that is a finding too, so
 * it is reported rather than ignored.
 *
 *   node scripts/score-claims.js              # print the scorecard
 *   node scripts/score-claims.js --write      # and save data/claims-score.json
 *   node scripts/score-claims.js --strict     # exit 1 if a supported claim fails
 */

const fs = require('fs');
const path = require('path');
const { CLAIMS } = require('../lib/claims');
const { simulate } = require('../lib/playoffs');
const { allPlayRecord } = require('../lib/power');

const START = process.env.LEAGUE_ID || '1312177397189062656';
const API = 'https://api.sleeper.app/v1';
const argv = process.argv.slice(2);

async function j(u) { const r = await fetch(u); if (!r.ok) throw new Error(`${u} → ${r.status}`); return r.json(); }
const mean = (a) => a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0;
function corr(xs, ys) {
  if (xs.length < 3) return null;
  const mx = mean(xs), my = mean(ys);
  const cov = mean(xs.map((x, i) => (x - mx) * (ys[i] - my)));
  const sx = Math.sqrt(mean(xs.map(x => (x - mx) ** 2))) || 1e-12;
  const sy = Math.sqrt(mean(ys.map(y => (y - my) ** 2))) || 1e-12;
  return cov / (sx * sy);
}
const FLEX = { FLEX: ['RB','WR','TE'], SUPER_FLEX: ['QB','RB','WR','TE'], REC_FLEX: ['WR','TE'], WRRB_FLEX: ['WR','RB'] };

function optimalOf(entry, slots, players) {
  const pts = entry.players_points || {};
  const pool = (entry.players || []).map(id => ({ id, pts: pts[id] || 0, pos: (players[id] || {}).position || null })).filter(p => p.pos);
  const byPos = {};
  for (const p of pool) (byPos[p.pos] ||= []).push(p);
  for (const a of Object.values(byPos)) a.sort((x, y) => y.pts - x.pts);
  const used = new Set(); let total = 0;
  const take = (ps) => { let b = null; for (const pos of ps) for (const p of (byPos[pos] || [])) { if (used.has(p.id)) continue; if (!b || p.pts > b.pts) b = p; break; } if (b) { used.add(b.id); total += b.pts; } };
  for (const s of slots) if (!FLEX[s]) take([s]);
  for (const s of slots) if (FLEX[s]) take(FLEX[s]);
  return total;
}
const pairsOf = (rows) => {
  const by = {};
  for (const m of rows) if (m.matchup_id != null) (by[m.matchup_id] ||= []).push(m.roster_id);
  return Object.values(by).filter(p => p.length === 2);
};

async function gather() {
  const players = await j(`${API}/players/nfl`);
  const seasons = [];
  let id = START;
  while (id && seasons.length < 12) {
    const l = await j(`${API}/league/${id}`);
    if (l.status === 'complete') {
      const last = (l.settings.playoff_week_start || 15) - 1;
      const slots = (l.roster_positions || []).filter(s => s !== 'BN' && s !== 'IR' && s !== 'TAXI');
      const weeks = [];
      for (let w = 1; w <= last; w++) weeks.push(await j(`${API}/league/${l.league_id}/matchups/${w}`));
      const drafts = await j(`${API}/league/${l.league_id}/drafts`).catch(() => []);
      const picks = drafts.length ? await j(`${API}/draft/${drafts[0].draft_id}/picks`).catch(() => []) : [];
      // Kept players never appear in the picks. Without last season's rosters
      // every keeper reads as something the manager went and got, which is how
      // the first version of this scorecard reported a skill that was mostly
      // roster continuity.
      const rosters = await j(`${API}/league/${l.league_id}/rosters`).catch(() => []);
      let keptBy = new Map();
      if (l.previous_league_id) {
        const prev = await j(`${API}/league/${l.previous_league_id}/rosters`).catch(() => []);
        const byOwner = new Map(prev.map(r => [r.owner_id, new Set(r.players || [])]));
        keptBy = new Map(rosters.map(r => [r.roster_id, byOwner.get(r.owner_id) || new Set()]));
      }
      seasons.push({ league: l, weeks, slots, picks, players, last, keptBy, hasPrev: !!l.previous_league_id });
    }
    id = l.previous_league_id;
  }
  return seasons;
}

// Per team-season: both halves separated, so persistence can be measured.
function teamRows(s) {
  const ids = [...new Set(s.weeks[0].map(m => m.roster_id))];
  const drafted = new Map();
  for (const pk of s.picks) { if (!drafted.has(pk.roster_id)) drafted.set(pk.roster_id, new Set()); drafted.get(pk.roster_id).add(pk.player_id); }
  const half = Math.floor(s.last / 2);
  const acc = new Map(ids.map(i => [i, { a1:0,o1:0,a2:0,o2:0,rq1:0,rq2:0,acq1:0,acq2:0,n1:0,n2:0,w:0,g:0,w2:0,g2:0 }]));

  s.weeks.forEach((rows, i) => {
    const pts = new Map(rows.map(m => [m.roster_id, m.points]));
    for (const m of rows) {
      const t = acc.get(m.roster_id); if (!t) continue;
      const actual = m.points || 0; if (actual <= 0) continue;
      const opt = optimalOf(m, s.slots, s.players);
      const mine = drafted.get(m.roster_id) || new Set();
      const pp = m.players_points || {};
      const kept = s.keptBy.get(m.roster_id) || new Set();
      let acq = 0;
      for (const id of (m.starters || [])) {
        if (!id || mine.has(id) || kept.has(id)) continue;   // neither drafted nor kept
        acq += pp[id] || 0;
      }
      if (i < half) { t.a1 += actual; t.o1 += opt; t.rq1 += opt; t.acq1 += acq; t.n1++; }
      else { t.a2 += actual; t.o2 += opt; t.rq2 += opt; t.acq2 += acq; t.n2++; }
    }
    for (const [a, b] of pairsOf(rows)) {
      const sa = pts.get(a) || 0, sb = pts.get(b) || 0;
      if (!(sa > 0 && sb > 0)) continue;
      const A = acc.get(a), B = acc.get(b);
      A.g++; B.g++;
      if (sa > sb) A.w++; else if (sb > sa) B.w++; else { A.w += 0.5; B.w += 0.5; }
      if (i >= half) { A.g2++; B.g2++; if (sa > sb) A.w2++; else if (sb > sa) B.w2++; else { A.w2 += 0.5; B.w2 += 0.5; } }
    }
  });

  return [...acc.entries()].filter(([, t]) => t.o1 && t.o2 && t.g2).map(([id, t]) => ({
    id, hasPrev: s.hasPrev,
    eff1: t.a1 / t.o1, eff2: t.a2 / t.o2, effAll: (t.a1 + t.a2) / (t.o1 + t.o2),
    rq1: t.rq1 / t.n1, rq2: t.rq2 / t.n2, rqAll: (t.rq1 + t.rq2) / (t.n1 + t.n2),
    acq1: t.acq1 / t.n1, acq2: t.acq2 / t.n2, acqAll: (t.acq1 + t.acq2) / (t.n1 + t.n2),
    winPct: t.w / t.g, winPct2: t.w2 / t.g2,
  }));
}

// All-play through week k against the win rate after it, pooled over splits —
// the claim the power ranking actually makes.
function allPlayScore(seasons) {
  const xs = [], ys = [];
  for (const s of seasons) {
    const ids = [...new Set(s.weeks[0].map(m => m.roster_id))];
    for (let k = 3; k <= s.last - 3; k++) {
      const teams = ids.map(id => ({ rosterId: id, scores: [] }));
      const byId = new Map(teams.map(t => [t.rosterId, t]));
      for (let i = 0; i < k; i++) for (const m of s.weeks[i]) { const t = byId.get(m.roster_id); if (t && m.points > 0) t.scores.push(m.points); }
      const ap = allPlayRecord(teams);
      const fut = new Map(ids.map(i => [i, { w: 0, g: 0 }]));
      for (let i = k; i < s.last; i++) {
        const pts = new Map(s.weeks[i].map(m => [m.roster_id, m.points]));
        for (const [a, b] of pairsOf(s.weeks[i])) {
          const sa = pts.get(a) || 0, sb = pts.get(b) || 0;
          if (!(sa > 0 && sb > 0)) continue;
          fut.get(a).g++; fut.get(b).g++;
          if (sa > sb) fut.get(a).w++; else if (sb > sa) fut.get(b).w++;
        }
      }
      for (const id of ids) { const f = fut.get(id); if (f.g) { xs.push(ap.get(id).pct); ys.push(f.w / f.g); } }
    }
  }
  return corr(xs, ys);
}

// Playoff odds scored the way a forecast is scored: Brier against the base rate.
function playoffScore(seasons) {
  let se = 0, seBase = 0, n = 0;
  for (const s of seasons) {
    const ids = [...new Set(s.weeks[0].map(m => m.roster_id))];
    const pt = s.league.settings.playoff_teams || 6;
    const base = pt / ids.length;
    const finalRank = (() => {
      const acc = new Map(ids.map(i => [i, { w: 0, pf: 0 }]));
      for (const rows of s.weeks) {
        const pts = new Map(rows.map(m => [m.roster_id, m.points]));
        for (const [a, b] of pairsOf(rows)) {
          const sa = pts.get(a) || 0, sb = pts.get(b) || 0;
          if (!(sa > 0 && sb > 0)) continue;
          acc.get(a).pf += sa; acc.get(b).pf += sb;
          if (sa > sb) acc.get(a).w++; else if (sb > sa) acc.get(b).w++; else { acc.get(a).w += 0.5; acc.get(b).w += 0.5; }
        }
      }
      return new Set([...acc.entries()].sort((x, y) => (y[1].w - x[1].w) || (y[1].pf - x[1].pf)).slice(0, pt).map(e => e[0]));
    })();

    for (const k of [4, 7, 10]) {
      if (k >= s.last) continue;
      const teams = ids.map(id => ({ rosterId: id, wins: 0, losses: 0, ties: 0, pf: 0, scores: [] }));
      const byId = new Map(teams.map(t => [t.rosterId, t]));
      for (let i = 0; i < k; i++) {
        const pts = new Map(s.weeks[i].map(m => [m.roster_id, m.points]));
        for (const [a, b] of pairsOf(s.weeks[i])) {
          const A = byId.get(a), B = byId.get(b); if (!A || !B) continue;
          const sa = pts.get(a) || 0, sb = pts.get(b) || 0;
          A.pf += sa; B.pf += sb;
          if (sa > 0) A.scores.push(sa); if (sb > 0) B.scores.push(sb);
          if (sa > sb) A.wins++; else if (sb > sa) B.wins++; else { A.wins += 0.5; B.wins += 0.5; }
        }
      }
      const remaining = [];
      for (let i = k; i < s.last; i++) remaining.push({ week: i + 1, pairs: pairsOf(s.weeks[i]) });
      const flat = teams.flatMap(t => t.scores);
      const out = simulate({ teams, remaining, playoffTeams: pt, leagueMean: mean(flat) }, 2000);
      for (const t of out) {
        const actual = finalRank.has(t.rosterId) ? 1 : 0;
        se += (t.playoffOdds - actual) ** 2;
        seBase += (base - actual) ** 2;
        n++;
      }
    }
  }
  // Expressed as skill over the base rate, so it sits on the same 0-1 scale as
  // the correlations and a floor means the same kind of thing.
  return n ? 1 - (se / n) / (seBase / n) : null;
}

async function main() {
  const seasons = await gather();
  const rows = seasons.flatMap(teamRows);
  const withPrev = rows.filter(r => r.hasPrev);
  console.log(`[claims] ${seasons.length} completed seasons, ${rows.length} team-seasons\n`);

  const measured = {
    'playoff-odds':      { value: playoffScore(seasons), unit: 'Brier skill over the base rate' },
    'all-play':          { value: allPlayScore(seasons), unit: 'r, all-play now vs win rate after' },
    'roster-quality':    { value: corr(rows.map(r => r.rq1), rows.map(r => r.winPct2)), unit: 'r, first half vs second-half wins' },
    // Only seasons with a predecessor can tell a keeper from an addition.
    'added-in-season':   { value: corr(withPrev.map(r => r.acq1), withPrev.map(r => r.acq2)),
                           extra: { predicts: corr(withPrev.map(r => r.acqAll), withPrev.map(r => r.winPct)) },
                           unit: `r, first half vs second half (${withPrev.length} team-seasons with a previous roster)` },
    'lineup-efficiency': { value: corr(rows.map(r => r.eff1), rows.map(r => r.eff2)), unit: 'r, first half vs second half' },
    'draft-grade':       { value: null, unit: 'r vs win rate — measured -0.045 in scripts/calibrate-draft.js' },
  };

  const out = [];
  let broke = 0;
  for (const c of CLAIMS) {
    const m = measured[c.id] || {};
    const v = m.value;
    let verdict;
    // A NUMBER PUBLISHED AS "NOT WHY YOU WIN" HAS TO KEEP NOT PREDICTING.
    // If it starts predicting, the page is understating it, which is its own
    // kind of wrong.
    if (c.alsoMustNotPredict != null && m.extra && m.extra.predicts != null
        && Math.abs(m.extra.predicts) >= c.alsoMustNotPredict) {
      out.push({ id: c.id + ':not-a-cause', metric: c.metric, about: c.about, test: 'must not predict',
                 floor: c.alsoMustNotPredict, value: m.extra.predicts, unit: 'r vs win rate',
                 verdict: 'NOW PREDICTS — the page calls this "not why you win"', published: c.published });
      broke++;
    }
    if (c.expectFail) {
      verdict = (v != null && c.floorIfHeld && v >= c.floorIfHeld) ? 'NOW HOLDS (was not expected to)' : 'as expected: not supported';
    } else if (v == null) {
      verdict = 'not measurable';
    } else if (v >= c.floor) {
      verdict = 'holds';
    } else {
      verdict = 'FAILS';
      broke++;
    }
    out.push({ id: c.id, metric: c.metric, about: c.about, test: c.test, floor: c.floor, value: v, unit: m.unit, verdict, published: c.published });
  }

  const w = (s, n) => String(s).padEnd(n);
  console.log(`  ${w('claim', 22)}${w('about', 11)}${w('test', 10)}${w('measured', 11)}${w('floor', 8)}verdict`);
  for (const r of out) {
    const val = r.value == null ? '—' : r.value.toFixed(3);
    console.log(`  ${w(r.id, 22)}${w(r.about, 11)}${w(r.test, 10)}${w(val, 11)}${w(r.floor ?? '—', 8)}${r.verdict}`);
  }

  console.log('');
  for (const r of out.filter(r => r.verdict.startsWith('FAILS'))) {
    console.log(`  ❌ ${r.metric} no longer supports what the ${r.published} says about it.`);
  }
  for (const r of out.filter(r => r.verdict.startsWith('NOW HOLDS'))) {
    console.log(`  ⚠️  ${r.metric} now holds and is still labelled as not holding. Re-read the page.`);
  }
  if (!broke) console.log('  every supported claim still holds.');

  if (argv.includes('--write')) {
    const dest = path.join(__dirname, '..', 'data');
    fs.mkdirSync(dest, { recursive: true });
    fs.writeFileSync(path.join(dest, 'claims-score.json'),
      JSON.stringify({ generated: new Date().toISOString(), seasons: seasons.length, teamSeasons: rows.length, claims: out }, null, 2));
    console.log('\n  wrote data/claims-score.json');
  }
  process.exit(broke && argv.includes('--strict') ? 1 : 0);
}

main().catch(e => { console.error(e.stack); process.exit(1); });
