#!/usr/bin/env node
/**
 * calibrate-playoffs.js — where the playoff model's two numbers come from.
 *
 * THE MISTAKE THIS EXISTS TO AVOID has already been made once in this codebase.
 * `computeKTCValue` was ten hand-tuned constants with no source, and every trade
 * verdict rested on them; lib/values.js replaced it with a published quantity.
 * A playoff simulator needs two numbers of exactly that dangerous kind:
 *
 *   K — how much to trust a team's own scoring average over the league's, given
 *       how few games it is built on. Pick it by feel and the early-season odds
 *       are whatever the constant says they are.
 *   SIGMA — how far a team's weekly score strays from its own average. This is
 *       the entire width of the forecast. Guess it and the confidence is fiction.
 *
 * So both are FITTED against four completed seasons of this league (2022-2025,
 * 10 teams, weeks 1-14), and the fit is reported against the two baselines it
 * has to beat: trusting the team's own average completely (K=0) and ignoring it
 * completely (K=inf). If shrinkage did not beat both it would not be worth
 * having, and this script would be the place that said so.
 *
 *   node scripts/calibrate-playoffs.js
 */

const START = process.env.LEAGUE_ID || '1312177397189062656';
const API = 'https://api.sleeper.app/v1';

async function j(u) { const r = await fetch(u); if (!r.ok) throw new Error(`${u} → ${r.status}`); return r.json(); }

async function chain() {
  const out = [];
  let id = START;
  while (id && out.length < 12) {
    const l = await j(`${API}/league/${id}`);
    if (l.status === 'complete') out.push(l);
    id = l.previous_league_id;
  }
  return out;
}

// Regular-season weekly scores per roster: { rosterId: [w1, w2, ...] }
async function seasonScores(league) {
  const lastWeek = (league.settings.playoff_week_start || 15) - 1;
  const byRoster = {};
  for (let w = 1; w <= lastWeek; w++) {
    const rows = await j(`${API}/league/${league.league_id}/matchups/${w}`);
    for (const m of rows) {
      // A bye, a vacated roster, or a week not played reads as 0 and is not a
      // score. Averaging it in would invent a bad week that never happened.
      if (typeof m.points !== 'number' || m.points <= 0) continue;
      (byRoster[m.roster_id] ||= []).push(m.points);
    }
  }
  return byRoster;
}

const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;

function evaluate(seasons, K) {
  let se = 0, n = 0;
  for (const scores of seasons) {
    const teams = Object.values(scores);
    const weeks = Math.min(...teams.map(t => t.length));
    for (let k = 1; k < weeks; k++) {
      const known = teams.map(t => t.slice(0, k));
      const leagueMean = mean(known.flat());
      for (const t of teams) {
        const future = t.slice(k);
        if (!future.length) continue;
        const w = K === Infinity ? 0 : k / (k + K);
        const pred = w * mean(t.slice(0, k)) + (1 - w) * leagueMean;
        se += (pred - mean(future)) ** 2;
        n++;
      }
    }
  }
  return { rmse: Math.sqrt(se / n), n };
}

// How far a single week strays from the team's own season average. This is the
// width the simulator draws with, and it is a within-team number: the spread
// BETWEEN teams is signal, not noise, and pooling them would inflate it.
function weeklySigma(seasons) {
  let se = 0, n = 0;
  for (const scores of seasons) {
    for (const t of Object.values(scores)) {
      if (t.length < 3) continue;
      const m = mean(t);
      for (const x of t) { se += (x - m) ** 2; n++; }
    }
  }
  return Math.sqrt(se / (n - 1));
}

async function main() {
  const leagues = await chain();
  if (!leagues.length) { console.error('no completed seasons to calibrate on'); process.exit(1); }

  const seasons = [];
  for (const l of leagues) {
    const s = await seasonScores(l);
    seasons.push(s);
    const teams = Object.keys(s).length;
    console.log(`[data] ${l.season}: ${teams} teams, ${Math.min(...Object.values(s).map(t => t.length))} weeks each`);
  }

  let best = { K: null, rmse: Infinity };
  for (let K = 0; K <= 40; K += 0.25) {
    const { rmse } = evaluate(seasons, K);
    if (rmse < best.rmse) best = { K, rmse };
  }

  const ownAverage = evaluate(seasons, 0);         // trust the team completely
  const leagueOnly = evaluate(seasons, Infinity);  // ignore the team completely
  const sigma = weeklySigma(seasons);

  console.log('');
  console.log(`[fit] observations:            ${ownAverage.n} team-splits across ${seasons.length} seasons`);
  console.log(`[fit] K = 0    (own average):  RMSE ${ownAverage.rmse.toFixed(3)}`);
  console.log(`[fit] K = inf  (league mean):  RMSE ${leagueOnly.rmse.toFixed(3)}`);
  console.log(`[fit] K = ${String(best.K).padEnd(5)} (fitted)      RMSE ${best.rmse.toFixed(3)}`);
  console.log('');

  const beatsOwn = ((ownAverage.rmse - best.rmse) / ownAverage.rmse) * 100;
  const beatsLeague = ((leagueOnly.rmse - best.rmse) / leagueOnly.rmse) * 100;
  console.log(`[fit] shrinkage beats the team's own average by ${beatsOwn.toFixed(1)}% and the league mean by ${beatsLeague.toFixed(1)}%`);
  console.log(`[fit] weekly sigma (within-team): ${sigma.toFixed(2)} points`);
  console.log('');
  console.log(`      At K=${best.K}, a team's own scoring is trusted:`);
  for (const k of [1, 2, 3, 4, 6, 8, 10, 14]) {
    console.log(`        after ${String(k).padStart(2)} weeks: ${(100 * k / (k + best.K)).toFixed(0)}%`);
  }
}

main().catch(e => { console.error(e.stack); process.exit(1); });
