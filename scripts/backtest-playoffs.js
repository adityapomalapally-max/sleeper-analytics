#!/usr/bin/env node
/**
 * backtest-playoffs.js — is the forecast any good?
 *
 * The calibration script fits the two constants. This one asks the separate and
 * more important question: run the simulator at week k of a season that has
 * since finished, and did the teams it liked actually make the playoffs?
 *
 * Scored with Brier — mean squared error of a probability against a 0/1
 * outcome — against two baselines a forecast has to beat to be worth printing:
 *
 *   always 0.6   the base rate, six of ten. A model that cannot beat this knows
 *                nothing about the league it is looking at.
 *   current rank the standings on the day, top six get 1.0 and the rest 0.0.
 *                This is what a reader can already see without a model, and it
 *                is a surprisingly hard baseline early on.
 *
 *   node scripts/backtest-playoffs.js
 */

const { simulate } = require('../lib/playoffs');

const START = process.env.LEAGUE_ID || '1312177397189062656';
const API = 'https://api.sleeper.app/v1';
const RUNS = 4000;

async function j(u) { const r = await fetch(u); if (!r.ok) throw new Error(`${u} → ${r.status}`); return r.json(); }

async function completedLeagues() {
  const out = []; let id = START;
  while (id && out.length < 12) {
    const l = await j(`${API}/league/${id}`);
    if (l.status === 'complete') out.push(l);
    id = l.previous_league_id;
  }
  return out;
}

async function weeks(league) {
  const last = (league.settings.playoff_week_start || 15) - 1;
  const out = [];
  for (let w = 1; w <= last; w++) out.push(await j(`${API}/league/${league.league_id}/matchups/${w}`));
  return out;
}

// Pairings for a week, from matchup_id.
function pairsOf(rows) {
  const by = {};
  for (const m of rows) (by[m.matchup_id] ||= []).push(m.roster_id);
  return Object.values(by).filter(p => p.length === 2);
}

function stateAt(allWeeks, k, rosterIds, leagueMean) {
  const teams = rosterIds.map(id => ({ rosterId: id, wins: 0, losses: 0, ties: 0, pf: 0, scores: [] }));
  const byId = new Map(teams.map(t => [t.rosterId, t]));

  for (let w = 0; w < k; w++) {
    const rows = allWeeks[w];
    const pts = new Map(rows.map(m => [m.roster_id, m.points]));
    for (const [a, b] of pairsOf(rows)) {
      const A = byId.get(a), B = byId.get(b);
      if (!A || !B) continue;
      const sa = pts.get(a) || 0, sb = pts.get(b) || 0;
      A.pf += sa; B.pf += sb;
      if (sa > 0) A.scores.push(sa);
      if (sb > 0) B.scores.push(sb);
      if (sa > sb) A.wins++; else if (sb > sa) B.wins++; else { A.wins += 0.5; B.wins += 0.5; }
    }
  }
  const remaining = [];
  for (let w = k; w < allWeeks.length; w++) remaining.push({ week: w + 1, pairs: pairsOf(allWeeks[w]) });
  return { teams, remaining, playoffTeams: 6, leagueMean };
}

function finalTop6(allWeeks, rosterIds) {
  const st = stateAt(allWeeks, allWeeks.length, rosterIds, 110);
  return new Set([...st.teams].sort((a, b) => (b.wins - a.wins) || (b.pf - a.pf))
    .slice(0, 6).map(t => t.rosterId));
}

async function main() {
  const leagues = await completedLeagues();
  const rows = [];

  for (const l of leagues) {
    const all = await weeks(l);
    const rosterIds = [...new Set(all[0].map(m => m.roster_id))];
    const made = finalTop6(all, rosterIds);
    const flat = all.flatMap(rows => rows.map(m => m.points).filter(p => p > 0));
    const leagueMean = flat.reduce((s, x) => s + x, 0) / flat.length;

    for (let k = 1; k <= all.length - 1; k++) {
      const st = stateAt(all, k, rosterIds, leagueMean);
      const out = simulate(st, RUNS);
      const standings = [...st.teams].sort((a, b) => (b.wins - a.wins) || (b.pf - a.pf));
      const topNow = new Set(standings.slice(0, 6).map(t => t.rosterId));

      for (const t of out) {
        const actual = made.has(t.rosterId) ? 1 : 0;
        rows.push({
          season: l.season, k, id: t.rosterId, actual,
          model: t.playoffOdds,
          base: 0.6,
          rank: topNow.has(t.rosterId) ? 1 : 0,
        });
      }
    }
    console.log(`[backtest] ${l.season}: ${all.length} weeks, ${rosterIds.length} teams`);
  }

  const brier = (pick) => rows.reduce((s, r) => s + (pick(r) - r.actual) ** 2, 0) / rows.length;
  const bModel = brier(r => r.model), bBase = brier(r => r.base), bRank = brier(r => r.rank);

  console.log('');
  console.log(`[score] ${rows.length} team-week forecasts across ${leagues.length} seasons`);
  console.log(`[score] Brier — always 0.6      : ${bBase.toFixed(4)}`);
  console.log(`[score] Brier — today's top six : ${bRank.toFixed(4)}`);
  console.log(`[score] Brier — the simulator   : ${bModel.toFixed(4)}`);
  console.log(`[score] the simulator beats the base rate by ${(100 * (bBase - bModel) / bBase).toFixed(1)}% `
            + `and the naive standings by ${(100 * (bRank - bModel) / bRank).toFixed(1)}%`);

  console.log('');
  console.log('        by week (Brier, lower is better):');
  console.log('        wk   model   standings   base');
  const byWeek = {};
  for (const r of rows) (byWeek[r.k] ||= []).push(r);
  for (const k of Object.keys(byWeek).sort((a, b) => a - b)) {
    const rs = byWeek[k];
    const b = (pick) => rs.reduce((s, r) => s + (pick(r) - r.actual) ** 2, 0) / rs.length;
    console.log(`        ${String(k).padStart(2)}   ${b(r => r.model).toFixed(3)}   ${b(r => r.rank).toFixed(3)}       ${b(r => r.base).toFixed(3)}`);
  }

  console.log('');
  console.log('        calibration — of the forecasts in each band, how many happened:');
  const bands = [[0, .2], [.2, .4], [.4, .6], [.6, .8], [.8, 1.01]];
  for (const [lo, hi] of bands) {
    const rs = rows.filter(r => r.model >= lo && r.model < hi);
    if (!rs.length) continue;
    const said = rs.reduce((s, r) => s + r.model, 0) / rs.length;
    const did = rs.reduce((s, r) => s + r.actual, 0) / rs.length;
    console.log(`        said ${(said * 100).toFixed(0).padStart(3)}%  →  happened ${(did * 100).toFixed(0).padStart(3)}%   (n=${rs.length})`);
  }
}

main().catch(e => { console.error(e.stack); process.exit(1); });
