#!/usr/bin/env node
/**
 * calibrate-power.js — which ingredients of a power ranking actually earn a place?
 *
 * THE FORMULA THIS REPLACES was:
 *
 *     power = winPct*40 + (avg/maxAvg)*35 + (consistency/maxC)*15 + (recent3/maxAvg)*10
 *
 * Four weights, no source, and the tab printed them to the reader as though
 * they meant something: "Record (40%) + Avg Scoring (35%) + Consistency (15%) +
 * Recent Form (10%)". It is the same shape as computeKTCValue, which this
 * codebase already had to remove once.
 *
 * A power ranking is a FORWARD-LOOKING CLAIM — it says who is better, which is
 * only checkable against what happens next. So every candidate ingredient is
 * measured on one question: computed from weeks 1..k, how well does it predict
 * a team's WIN RATE over the rest of the regular season?
 *
 * Ingredients on trial:
 *   winPct       what the standings say
 *   allPlay      record against everyone every week — the standings with the
 *                schedule's luck removed
 *   meanScore    scoring, shrunk toward the league (K from lib/playoffs.js)
 *   consistency  1 - coefficient of variation. The one I expect to be worthless.
 *   recent3      last three weeks, the "hot team" claim
 *   sosFaced     mean strength of opponents already played
 *   sosLeft      mean strength of opponents still to come — the only ingredient
 *                that is about the future rather than the past
 *
 *   node scripts/calibrate-power.js
 */

const { K } = require('../lib/playoffs');

const START = process.env.LEAGUE_ID || '1312177397189062656';
const API = 'https://api.sleeper.app/v1';

async function j(u) { const r = await fetch(u); if (!r.ok) throw new Error(`${u} → ${r.status}`); return r.json(); }
const mean = (a) => a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0;

async function seasons() {
  const out = []; let id = START;
  while (id && out.length < 12) {
    const l = await j(`${API}/league/${id}`);
    if (l.status === 'complete') {
      const last = (l.settings.playoff_week_start || 15) - 1;
      const weeks = [];
      for (let w = 1; w <= last; w++) weeks.push(await j(`${API}/league/${l.league_id}/matchups/${w}`));
      out.push({ season: l.season, weeks });
    }
    id = l.previous_league_id;
  }
  return out;
}

function pairsOf(rows) {
  const by = {};
  for (const m of rows) if (m.matchup_id != null) (by[m.matchup_id] ||= []).push(m.roster_id);
  return Object.values(by).filter(p => p.length === 2);
}

// Everything a season needs, per week: who played whom and what they scored.
function shape(weeks) {
  const ids = [...new Set(weeks[0].map(m => m.roster_id))];
  const score = weeks.map(rows => new Map(rows.map(m => [m.roster_id, m.points])));
  const pairs = weeks.map(pairsOf);
  return { ids, score, pairs, n: weeks.length };
}

// Opponent of `id` in week w.
function oppOf(pairs, w, id) {
  for (const [a, b] of pairs[w]) { if (a === id) return b; if (b === id) return a; }
  return null;
}

function predictors(S, k, leagueMean) {
  const { ids, score, pairs, n } = S;

  // Shrunk mean score per team from weeks 1..k — the same estimator the
  // playoff simulator draws with, so the two tabs cannot disagree about who is
  // good.
  const strength = new Map();
  for (const id of ids) {
    const own = [];
    for (let w = 0; w < k; w++) { const p = score[w].get(id); if (p > 0) own.push(p); }
    const kk = own.length;
    strength.set(id, kk ? (kk / (kk + K)) * mean(own) + (1 - kk / (kk + K)) * leagueMean : leagueMean);
  }

  const rows = [];
  for (const id of ids) {
    const own = [];
    let wins = 0, games = 0, apWins = 0, apGames = 0;
    for (let w = 0; w < k; w++) {
      const p = score[w].get(id);
      if (!(p > 0)) continue;
      own.push(p);
      const o = oppOf(pairs, w, id);
      const op = o != null ? score[w].get(o) : null;
      if (op > 0) { games++; if (p > op) wins++; else if (p === op) wins += 0.5; }
      // All-play: this score against every other score that week.
      for (const other of ids) {
        if (other === id) continue;
        const q = score[w].get(other);
        if (!(q > 0)) continue;
        apGames++; if (p > q) apWins++; else if (p === q) apWins += 0.5;
      }
    }
    if (!own.length) continue;

    const avg = mean(own);
    const sd = own.length > 1 ? Math.sqrt(mean(own.map(x => (x - avg) ** 2))) : 0;

    // Opponent quality, using the shrunk estimate rather than raw averages so a
    // team is not credited for beating someone who happened to have two hot
    // weeks in a small sample.
    const faced = [], left = [];
    for (let w = 0; w < k; w++) { const o = oppOf(pairs, w, id); if (o != null) faced.push(strength.get(o)); }
    for (let w = k; w < n; w++) { const o = oppOf(pairs, w, id); if (o != null) left.push(strength.get(o)); }

    // The target: win rate over the rest of the regular season.
    let fw = 0, fg = 0;
    for (let w = k; w < n; w++) {
      const p = score[w].get(id); const o = oppOf(pairs, w, id);
      const op = o != null ? score[w].get(o) : null;
      if (p > 0 && op > 0) { fg++; if (p > op) fw++; else if (p === op) fw += 0.5; }
    }
    if (!fg) continue;

    rows.push({
      id,
      x: {
        winPct: games ? wins / games : 0.5,
        allPlay: apGames ? apWins / apGames : 0.5,
        meanScore: strength.get(id),
        consistency: avg > 0 ? 1 - sd / avg : 0,
        recent3: mean(own.slice(-3)),
        sosFaced: mean(faced),
        sosLeft: mean(left),
      },
      y: fw / fg,
    });
  }
  return rows;
}

// Standardise within each split so ingredients on different scales (a win rate
// and a points total) can carry comparable weights.
function standardise(rows, names) {
  for (const r of rows) r.raw = { ...r.x };
  for (const nm of names) {
    const vals = rows.map(r => r.x[nm]);
    const m = mean(vals);
    const sd = Math.sqrt(mean(vals.map(v => (v - m) ** 2))) || 1;
    for (const r of rows) r.x[nm] = (r.x[nm] - m) / sd;
  }
  return rows;
}

// Least squares by normal equations with a small ridge term, solved by
// Gauss-Jordan. Seven predictors and 520 rows does not need anything cleverer.
function fit(rows, names, ridge = 1e-6) {
  const p = names.length;
  const A = Array.from({ length: p + 1 }, () => new Array(p + 2).fill(0));
  for (const r of rows) {
    const v = [1, ...names.map(nm => r.x[nm])];
    for (let i = 0; i <= p; i++) {
      for (let jj = 0; jj <= p; jj++) A[i][jj] += v[i] * v[jj];
      A[i][p + 1] += v[i] * r.y;
    }
  }
  for (let i = 1; i <= p; i++) A[i][i] += ridge;
  for (let c = 0; c <= p; c++) {
    let piv = c;
    for (let r2 = c + 1; r2 <= p; r2++) if (Math.abs(A[r2][c]) > Math.abs(A[piv][c])) piv = r2;
    [A[c], A[piv]] = [A[piv], A[c]];
    const d = A[c][c] || 1e-12;
    for (let jj = c; jj <= p + 1; jj++) A[c][jj] /= d;
    for (let r2 = 0; r2 <= p; r2++) {
      if (r2 === c) continue;
      const f = A[r2][c];
      for (let jj = c; jj <= p + 1; jj++) A[r2][jj] -= f * A[c][jj];
    }
  }
  const coef = {}; names.forEach((nm, i) => coef[nm] = A[i + 1][p + 1]);
  return { intercept: A[0][p + 1], coef };
}

function cc(xs, ys) {
  const mx = mean(xs), my = mean(ys);
  const cov = mean(xs.map((x, i) => (x - mx) * (ys[i] - my)));
  const sx = Math.sqrt(mean(xs.map(x => (x - mx) ** 2))) || 1e-12;
  const sy = Math.sqrt(mean(ys.map(y => (y - my) ** 2))) || 1e-12;
  return cov / (sx * sy);
}

const rmseOf = (rows, predict) => Math.sqrt(mean(rows.map(r => (predict(r) - r.y) ** 2)));

function corr(rows, nm) {
  const xs = rows.map(r => r.x[nm]), ys = rows.map(r => r.y);
  const mx = mean(xs), my = mean(ys);
  const cov = mean(xs.map((x, i) => (x - mx) * (ys[i] - my)));
  const sx = Math.sqrt(mean(xs.map(x => (x - mx) ** 2))) || 1e-12;
  const sy = Math.sqrt(mean(ys.map(y => (y - my) ** 2))) || 1e-12;
  return cov / (sx * sy);
}

async function main() {
  const NAMES = ['winPct', 'allPlay', 'meanScore', 'consistency', 'recent3', 'sosFaced', 'sosLeft'];
  const all = [];
  const seasonsData = await seasons();

  for (const s of seasonsData) {
    const S = shape(s.weeks);
    const flat = S.score.flatMap(m => [...m.values()].filter(p => p > 0));
    const lm = mean(flat);
    // Splits 2..n-2: one week is not a ranking, and the last week has no
    // "rest of season" left to be judged against.
    for (let k = 2; k <= S.n - 2; k++) {
      const rows = predictors(S, k, lm);
      for (const r of rows) r.season = s.season;
      const split = {
        maxMean: Math.max(...rows.map(r => r.x.meanScore), 1),
        maxCons: Math.max(...rows.map(r => r.x.consistency), 1e-6),
      };
      for (const r of rows) r.split = split;
      all.push(...standardise(rows, NAMES));
    }
    console.log(`[data] ${s.season}: ${S.ids.length} teams, ${S.n} weeks`);
  }

  console.log('');
  console.log(`[fit] ${all.length} team-splits across ${seasonsData.length} seasons`);
  console.log('');
  console.log('      each ingredient ALONE, correlated with rest-of-season win rate:');
  const solo = NAMES.map(nm => [nm, corr(all, nm)]).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
  for (const [nm, c] of solo) console.log(`        ${nm.padEnd(12)} r = ${c >= 0 ? ' ' : ''}${c.toFixed(3)}`);

  const full = fit(all, NAMES);
  console.log('');
  console.log('      fitted together (standardised weights):');
  for (const nm of NAMES) console.log(`        ${nm.padEnd(12)} ${full.coef[nm] >= 0 ? ' ' : ''}${full.coef[nm].toFixed(4)}`);

  const predWith = (f, names) => (r) => f.intercept + names.reduce((s, nm) => s + f.coef[nm] * r.x[nm], 0);

  // Does dropping an ingredient hurt? If not, it does not belong on the page.
  console.log('');
  console.log('      leave-one-out (RMSE rises by, if dropped):');
  const baseR = rmseOf(all, predWith(full, NAMES));
  const keep = [];
  for (const nm of NAMES) {
    const rest = NAMES.filter(x => x !== nm);
    const f2 = fit(all, rest);
    const r2 = rmseOf(all, predWith(f2, rest));
    const delta = r2 - baseR;
    if (delta > 0.0005) keep.push(nm);
    console.log(`        drop ${nm.padEnd(12)} RMSE ${r2.toFixed(4)}  (${delta >= 0 ? '+' : ''}${delta.toFixed(4)})${delta > 0.0005 ? '   ← earns its place' : ''}`);
  }

  // THE INCUMBENT, COMPUTED THE WAY THE APP COMPUTES IT — on raw values, scaled
  // to the maximum in its own split. Standardising it first would have scored a
  // different formula than the one that ships, and the whole point is a fair
  // comparison.
  //
  // A power ranking is an ORDERING, so both are judged on how well the score
  // they produce correlates with what happened next. RMSE is not comparable
  // between a 0-100 score and a predicted win rate; correlation is.
  const oldScore = (r) => {
    const x = r.raw;
    return x.winPct * 40 + (x.meanScore / r.split.maxMean) * 35
         + (x.consistency / r.split.maxCons) * 15 + (x.recent3 / r.split.maxMean) * 10;
  };
  const corrOf = (score) => {
    const xs = all.map(score), ys = all.map(r => r.y);
    const mx = mean(xs), my = mean(ys);
    const cov = mean(xs.map((x, i) => (x - mx) * (ys[i] - my)));
    const sx = Math.sqrt(mean(xs.map(x => (x - mx) ** 2))) || 1e-12;
    const sy = Math.sqrt(mean(ys.map(y => (y - my) ** 2))) || 1e-12;
    return cov / (sx * sy);
  };

  const lean = fit(all, keep);
  const CURATED = ['meanScore', 'allPlay', 'sosFaced', 'sosLeft'];
  const cur = fit(all, CURATED);

  console.log('');
  console.log(`[score] always the league average (0.5) : RMSE ${rmseOf(all, () => 0.5).toFixed(4)}`);
  console.log(`[score] win% alone                      : RMSE ${rmseOf(all, predWith(fit(all, ['winPct']), ['winPct'])).toFixed(4)}`);
  console.log(`[score] all seven fitted                : RMSE ${baseR.toFixed(4)}`);
  console.log(`[score] only what earns its place       : RMSE ${rmseOf(all, predWith(lean, keep)).toFixed(4)}   [${keep.join(', ')}]`);
  console.log(`[score] curated (drops the two duds)    : RMSE ${rmseOf(all, predWith(cur, CURATED)).toFixed(4)}   [${CURATED.join(', ')}]`);

  // WHY sosLeft IS NOT IN THE SHIPPED SCORE.
  //
  // It correlates -0.132 with future wins on its own — a harder run-in means
  // fewer wins, which is what anyone would expect — and then fits POSITIVE
  // (+0.026) alongside the rest. A coefficient that reverses sign depending on
  // what sits beside it is not identifying a stable effect, and shipping it
  // would tell a reader that a harder schedule makes them better.
  //
  // The first guess was collinearity with sosFaced: in a league where everyone
  // plays everyone, what you have faced and what you have left ought to be two
  // halves of one fixed total. MEASURED, THAT IS FALSE — the two correlate
  // -0.021, essentially independent, because fourteen weeks between ten teams
  // is not a round robin. The guess was wrong; the instability is real either
  // way, and leave-one-season-out below is what actually decides the question.
  console.log('');
  console.log(`      collinearity: corr(sosFaced, sosLeft) = ${
    (() => {
      const xs = all.map(r => r.x.sosFaced), ys = all.map(r => r.x.sosLeft);
      const mx = mean(xs), my = mean(ys);
      return (mean(xs.map((x, i) => (x - mx) * (ys[i] - my)))
        / ((Math.sqrt(mean(xs.map(x => (x - mx) ** 2))) || 1) * (Math.sqrt(mean(ys.map(y => (y - my) ** 2))) || 1))).toFixed(3);
    })()}`);

  // ONE INTERPRETABLE SCHEDULE TERM INSTEAD OF TWO. A team's scoring, credited
  // for the quality of what it was posted against. This is a claim about how
  // good a team IS; what is left on its schedule is context for the season
  // ahead, reported beside the ranking rather than folded into it.
  for (const r of all) r.x.adjMean = r.x.meanScore + r.x.sosFaced;
  const ADJ = ['adjMean', 'allPlay'];
  const adj = fit(all, ADJ);

  console.log('');
  console.log('      as an ORDERING — correlation of the score with what happened next:');
  console.log(`        the 40/35/15/10 formula   r = ${corrOf(oldScore).toFixed(3)}`);
  console.log(`        win% alone                r = ${corrOf(r => r.raw.winPct).toFixed(3)}`);
  console.log(`        lean (3)                  r = ${corrOf(predWith(lean, keep)).toFixed(3)}`);
  console.log(`        curated (4)               r = ${corrOf(predWith(cur, CURATED)).toFixed(3)}`);
  console.log(`        all seven                 r = ${corrOf(predWith(full, NAMES)).toFixed(3)}`);
  console.log(`        adjMean + allPlay         r = ${corrOf(predWith(adj, ADJ)).toFixed(3)}   ← interpretable`);
  console.log('');
  console.log(`[score] adjMean + allPlay               : RMSE ${rmseOf(all, predWith(adj, ADJ)).toFixed(4)}`);
  console.log('      weights (standardised):');
  for (const nm of ADJ) console.log(`        ${nm.padEnd(12)} ${adj.coef[nm].toFixed(4)}`);

  // LEAVE-ONE-SEASON-OUT. Everything above is in-sample: with 440 rows and
  // seven correlated predictors, the richest model will always look best.
  // Fit on three seasons, score the fourth, and a term that only helps in
  // sample stops helping here.
  console.log('');
  console.log('      OUT OF SAMPLE — fit on three seasons, score the fourth:');
  const seasonsOf = [...new Set(all.map(r => r.season))];
  const candidates = {
    'win% alone': ['winPct'],
    'adjMean + allPlay': ADJ,
    'curated (4)': CURATED,
    'all seven': NAMES,
  };
  for (const [label, names] of Object.entries(candidates)) {
    const preds = [], actuals = [];
    for (const held of seasonsOf) {
      const train = all.filter(r => r.season !== held);
      const test = all.filter(r => r.season === held);
      const f = fit(train, names);
      for (const r of test) { preds.push(predWith(f, names)(r)); actuals.push(r.y); }
    }
    const mx = mean(preds), my = mean(actuals);
    const cov = mean(preds.map((x, i) => (x - mx) * (actuals[i] - my)));
    const sx = Math.sqrt(mean(preds.map(x => (x - mx) ** 2))) || 1e-12;
    const sy = Math.sqrt(mean(actuals.map(y => (y - my) ** 2))) || 1e-12;
    const rmse = Math.sqrt(mean(preds.map((x, i) => (x - actuals[i]) ** 2)));
    console.log(`        ${label.padEnd(20)} r = ${(cov / (sx * sy)).toFixed(3)}   RMSE ${rmse.toFixed(4)}`);
  }
  console.log(`        ${'40/35/15/10 (fixed)'.padEnd(20)} r = ${corrOf(oldScore).toFixed(3)}   (no fitting, so in and out of sample are the same)`);

  // PER-SEASON, because "better on average over four seasons" can be one good
  // season carrying three flat ones, and four is not many.
  console.log('');
  console.log('      out-of-sample by held-out season (correlation):');
  const compare = { 'allPlay only': ['allPlay'], 'adjMean + allPlay': ADJ };
  const header = ['season', ...Object.keys(compare), '40/35/15/10'];
  console.log('        ' + header.map(h => h.padEnd(19)).join(''));
  for (const held of seasonsOf) {
    const test = all.filter(r => r.season === held);
    const train = all.filter(r => r.season !== held);
    const cells = [held.padEnd(19)];
    for (const [, names] of Object.entries(compare)) {
      const f = fit(train, names);
      const pr = test.map(predWith(f, names)), ac = test.map(r => r.y);
      cells.push(cc(pr, ac).toFixed(3).padEnd(19));
    }
    cells.push(cc(test.map(oldScore), test.map(r => r.y)).toFixed(3));
    console.log('        ' + cells.join(''));
  }

  console.log('');
  console.log('      weights to ship (standardised, curated set):');
  for (const nm of CURATED) console.log(`        ${nm.padEnd(12)} ${cur.coef[nm].toFixed(4)}`);
  console.log(`        intercept    ${cur.intercept.toFixed(4)}`);
}

main().catch(e => { console.error(e.stack); process.exit(1); });
