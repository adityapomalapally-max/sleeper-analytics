/**
 * Power rankings and strength of schedule.
 *
 * What was here before: `winPct*40 + avg*35 + consistency*15 + recent3*10`,
 * four weights with no source, printed to the reader as if they meant
 * something. scripts/calibrate-power.js measured all four against the only
 * thing a power ranking can be checked against — what happened next — and two
 * of them were worth nothing: consistency correlates -0.016 with future wins,
 * and recent form fits NEGATIVE once you know a team's shrunk scoring average.
 *
 * A fitted replacement was tried and declined; the per-season table in
 * lib/power.js is the argument. These tests hold the shape that survived.
 *
 *   node --test 'tests/*.test.js'
 */

const test = require('node:test');
const assert = require('node:assert');
const { powerRankings, allPlayRecord, strengthOfSchedule } = require('../lib/power');

function team(id, scores, wins = 0, losses = 0) {
  return { rosterId: id, name: `T${id}`, avatar: null, wins, losses, ties: 0, pf: scores.reduce((a, b) => a + b, 0), scores };
}

test('all-play is a record against everyone, every week', () => {
  const teams = [team(1, [100, 100]), team(2, [90, 90]), team(3, [80, 80])];
  const ap = allPlayRecord(teams);
  // Top scorer beats both others in both weeks: 4 of 4.
  assert.strictEqual(ap.get(1).pct, 1);
  assert.strictEqual(ap.get(3).pct, 0);
  assert.strictEqual(ap.get(2).pct, 0.5);
});

test('a tie counts as half a win, not a loss', () => {
  const ap = allPlayRecord([team(1, [100]), team(2, [100])]);
  assert.strictEqual(ap.get(1).pct, 0.5);
  assert.strictEqual(ap.get(2).pct, 0.5);
});

test('the schedule cannot flatter you past the scoreboard', () => {
  // THE CASE THE OLD FORMULA GOT WRONG. A team can be 3-4 and be the worst
  // team in the league; the standings cannot tell you, all-play can. At week 7
  // of 2025 this was babushka: 3-4, 25% all-play, and they won 14% of what
  // was left.
  const teams = [
    team(1, [150, 150, 150], 0, 3),   // huge scores, lost every week
    team(2, [80, 80, 80], 3, 0),      // tiny scores, won every week
  ];
  const rows = powerRankings({
    teams, remaining: [], playedPairs: [], leagueMean: 115, weeksPlayed: 3,
  });
  assert.strictEqual(rows[0].rosterId, 1, 'the team that outscores everyone is not third');
  assert.ok(rows[1].luck > 0.4, "a 3-0 record on the league's worst scoring is luck, and should say so");
  assert.ok(rows[0].luck < -0.4, 'and the opposite for the team that lost every week scoring most');
});

test('strength of schedule reads both directions and in points', () => {
  const teams = [team(1, [140, 140]), team(2, [100, 100]), team(3, [120, 120]), team(4, [120, 120])];
  const sos = strengthOfSchedule(
    teams,
    [{ week: 3, pairs: [[1, 2], [3, 4]] }],           // still to come
    [{ week: 1, pairs: [[1, 3], [2, 4]] },            // already played
     { week: 2, pairs: [[1, 4], [2, 3]] }],
    120);
  // Team 1 played 3 and 4 (both mid), and has 2 (the weakest) left.
  assert.ok(sos.get(1).faced > sos.get(1).left, 'team 1 has already played the harder half');
  assert.ok(sos.get(2).left > sos.get(2).faced, 'and team 2 has the hardest game still in front of it');
});

test('nothing played is not a ranking', () => {
  const teams = [team(1, []), team(2, []), team(3, [])];
  const rows = powerRankings({ teams, remaining: [], playedPairs: [], leagueMean: 120, weeksPlayed: 0 });
  assert.strictEqual(rows.meta.reliable, false);
  for (const r of rows) {
    assert.strictEqual(r.allPlayPct, 0.5, 'with no games, everyone is exactly average');
    assert.strictEqual(r.sosFacedDelta, null, 'and nobody has faced anybody');
  }
});

test('the discredited ingredients are not resurrected', () => {
  // consistency r = -0.016, recent form fits negative. If either reappears in
  // the shipped score, calibrate-power.js has to say why first.
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'lib', 'power.js'), 'utf8');
  const body = src.slice(src.indexOf('function powerRankings'));
  assert.ok(!/consistency|recent3|stddev/i.test(body),
    'an ingredient measured as worthless is back in the power score');
});
