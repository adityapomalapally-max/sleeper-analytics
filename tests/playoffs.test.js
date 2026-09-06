/**
 * The playoff simulator.
 *
 * A percentage is the most confident-looking thing a fantasy site can print,
 * and the easiest to fabricate. `computeKTCValue` is the cautionary tale in
 * this repo: ten constants nobody could check, driving every trade verdict.
 * The two constants here are fitted in scripts/calibrate-playoffs.js and the
 * fit is reported against the baselines it has to beat — these tests are about
 * the simulator around them behaving like arithmetic rather than like a mood.
 *
 *   node --test 'tests/*.test.js'
 */

const test = require('node:test');
const assert = require('node:assert');
const { simulate, expectedScore, championOf, rank, seeded, K } = require('../lib/playoffs');

// A league of n teams with a full round-robin-ish remaining schedule.
function league(n, opts = {}) {
  const teams = [];
  for (let i = 1; i <= n; i++) {
    teams.push({
      rosterId: i,
      wins: (opts.wins && opts.wins[i - 1]) ?? 0,
      losses: 0, ties: 0,
      pf: (opts.pf && opts.pf[i - 1]) ?? 1000,
      scores: (opts.scores && opts.scores[i - 1]) || [],
    });
  }
  const remaining = [];
  for (let w = 0; w < (opts.weeksLeft ?? 6); w++) {
    const ids = teams.map(t => t.rosterId);
    const pairs = [];
    // rotate so the pairings differ week to week
    const rot = [ids[0], ...ids.slice(1 + w % (n - 1)), ...ids.slice(1, 1 + w % (n - 1))];
    for (let i = 0; i < n / 2; i++) pairs.push([rot[i], rot[n - 1 - i]]);
    remaining.push({ week: w + 1, pairs });
  }
  return { teams, remaining, playoffTeams: opts.playoffTeams ?? 6, leagueMean: 110 };
}

test('the odds are probabilities, and they add up to the seats available', () => {
  const out = simulate(league(10), 3000);
  for (const t of out) {
    assert.ok(t.playoffOdds >= 0 && t.playoffOdds <= 1, 'playoff odds outside [0,1]');
    assert.ok(t.titleOdds >= 0 && t.titleOdds <= 1, 'title odds outside [0,1]');
  }
  const berths = out.reduce((s, t) => s + t.playoffOdds, 0);
  assert.ok(Math.abs(berths - 6) < 1e-9, `six seats must be filled in every simulation, got ${berths}`);

  const titles = out.reduce((s, t) => s + t.titleOdds, 0);
  assert.ok(Math.abs(titles - 1) < 1e-9, `exactly one champion per simulation, got ${titles}`);
});

test('with nothing played, nobody is special', () => {
  // Every team identical and the schedule symmetric: the honest answer is that
  // six of ten make it and each is equally likely. A model that produced a
  // confident spread here would be reporting its own constants.
  const out = simulate(league(10, { weeksLeft: 8 }), 4000);
  for (const t of out) {
    assert.ok(Math.abs(t.playoffOdds - 0.6) < 0.06,
      `an unplayed season should sit near 6/10, got ${t.playoffOdds.toFixed(3)} for roster ${t.rosterId}`);
  }
});

test('a team that cannot be caught is not given a number below certainty', () => {
  // Nine wins banked with two weeks left in a six-of-ten league: mathematically
  // safe. If the simulator ever prints 97% here it is wrong, not cautious.
  const st = league(10, { weeksLeft: 2, wins: [9, 0, 0, 0, 0, 0, 0, 0, 0, 0], pf: [2000, 1, 1, 1, 1, 1, 1, 1, 1, 1] });
  const out = simulate(st, 2000);
  const leader = out.find(t => t.rosterId === 1);
  assert.strictEqual(leader.playoffOdds, 1, 'a clinched team must read 100%, not 99.8%');
});

test('a team that cannot get there is not given hope', () => {
  const st = league(10, { weeksLeft: 1, wins: [0, 9, 9, 9, 9, 9, 9, 8, 8, 8], pf: [1, 9, 9, 9, 9, 9, 9, 8, 8, 8] });
  const out = simulate(st, 2000);
  assert.strictEqual(out.find(t => t.rosterId === 1).playoffOdds, 0,
    'a mathematically eliminated team must read 0%');
});

test('winning more is never worth less', () => {
  const st = league(10, { weeksLeft: 6, wins: [5, 4, 3, 3, 3, 3, 3, 3, 3, 2] });
  const out = simulate(st, 4000);
  const odds = (id) => out.find(t => t.rosterId === id).playoffOdds;
  assert.ok(odds(1) >= odds(2), 'five wins must not be worth less than four');
  assert.ok(odds(2) >= odds(10), 'four wins must not be worth less than two');
});

test('the shrinkage is heavy early and never complete', () => {
  const hot = [160, 160, 160];
  // Three big weeks move the estimate off the league mean, but nowhere near to
  // the team's own average — that is the whole finding the constant encodes.
  const after3 = expectedScore(hot, 110);
  assert.ok(after3 > 110 && after3 < 130,
    `three hot weeks should pull only about a third of the way, got ${after3.toFixed(1)}`);

  const after12 = expectedScore(new Array(12).fill(160), 110);
  assert.ok(after12 > after3, 'more evidence must count for more');
  assert.ok(after12 < 160, 'a team is never trusted completely, however long the sample');

  assert.strictEqual(expectedScore([], 110), 110, 'with nothing played, the league is the estimate');
});

test('the bracket re-seeds and gives byes to the top', () => {
  // Deterministic: the higher seed always outscores the lower one, so the top
  // seed must win from any bracket shape it can be handed.
  const alwaysBetter = (id) => 1000 - id;
  for (const n of [4, 6, 8]) {
    const seeds = Array.from({ length: n }, (_, i) => i + 1);
    assert.strictEqual(championOf(seeds, alwaysBetter, Math.random), 1,
      `with ${n} teams and no upsets the 1 seed must win`);
  }
});

test('the same league produces the same number twice', () => {
  // A percentage that drifts on refresh is one nobody can act on.
  const a = simulate(league(10), 1500);
  const b = simulate(league(10), 1500);
  assert.deepStrictEqual(a.map(t => t.playoffOdds), b.map(t => t.playoffOdds));
});

test('standings break ties on points, because the league does', () => {
  const out = rank([
    { rosterId: 1, wins: 5, pf: 900 },
    { rosterId: 2, wins: 5, pf: 1100 },
    { rosterId: 3, wins: 6, pf: 100 },
  ]);
  assert.deepStrictEqual(out.map(t => t.rosterId), [3, 2, 1]);
});

test('one week of football is not sold as a forecast', () => {
  // The backtest is unambiguous: at week 1 the simulator scores 0.265 against
  // the base rate's 0.240 — worse than assuming everyone is 60%. It is the only
  // week that loses, and a model that prints a confident number there is
  // charging the reader for its own constants.
  const { reliability } = require('../lib/playoffs');
  assert.strictEqual(reliability(0).reliable, false, 'an unplayed season has nothing to forecast from');
  assert.strictEqual(reliability(1).reliable, false, 'one game is measurably worse than the base rate');
  assert.strictEqual(reliability(2).reliable, true);
  assert.ok(reliability(3).note, 'an early forecast still has to admit it is mostly shrinkage');
  assert.strictEqual(reliability(8).note, null, 'by midseason it can stand on its own');
});

test('the run carries its own caveat', () => {
  const out = simulate(league(10, { weeksLeft: 8 }), 800);
  assert.ok(out.meta, 'a forecast that travels without its caveat will be quoted without it');
  assert.strictEqual(out.meta.weeksPlayed, 0);
  assert.strictEqual(out.meta.reliable, false);
});

test('equal odds are ordered the way the league orders them', () => {
  // A finished season leaves everyone who made it at 100%. Breaking that tie on
  // title odds put a 10-4 team above a 13-1 team with a "1" beside it — and the
  // badge reads as a seed no matter what it is called.
  const st = league(10, {
    weeksLeft: 0,
    wins: [10, 13, 9, 6, 7, 7, 6, 4, 5, 4],
    pf: [2020, 1990, 1855, 1749, 1660, 1642, 1601, 1659, 1691, 1500],
  });
  const out = simulate(st, 500);
  const top2 = out.slice(0, 2).map(t => t.rosterId);
  assert.strictEqual(top2[0], 2, 'the 13-1 team must be first once the season is decided');
  assert.strictEqual(top2[1], 1, 'the 10-4 team second');
});
