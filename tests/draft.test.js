/**
 * Draft grades.
 *
 * The easiest number on a fantasy site to fake — pick some weights, sum
 * something, print a letter. Two things are measured instead of chosen: what a
 * pick at slot N returns, and whether the resulting grade means anything.
 *
 * It does not. Over 40 team-seasons the grade correlates -0.045 with actual win
 * rate, with the sign flapping season to season, and the worst draft on record
 * belonged to a team that won 93% of its games. That is not a reason to hide the
 * number; it is a reason to print the correlation beside it. These tests hold
 * the honest shape.
 *
 *   node --test 'tests/*.test.js'
 */

const test = require('node:test');
const assert = require('node:assert');
const { monotoneDecreasing, expectedCurve, gradeDraft, gradeAgainstMarket } = require('../lib/draft');

test('the expectation curve cannot say a later pick is better', () => {
  // The raw, smoothed data does say exactly that — pooled over four seasons,
  // pick 70 came out ahead of pick 50 on the back of a couple of late hits.
  // An expectation curve with a bump in it grades everyone drafting near the
  // bump too harshly and everyone before it too kindly.
  const out = monotoneDecreasing([10, 8, 9, 7, 5, 6, 3]);
  for (let i = 1; i < out.length; i++) {
    assert.ok(out[i - 1] >= out[i] - 1e-9, `the curve rises at ${i}: ${out[i - 1]} then ${out[i]}`);
  }
});

test('smoothing moves value around without creating or destroying it', () => {
  const input = [10, 8, 9, 7, 5, 6, 3];
  const out = monotoneDecreasing(input);
  const sum = (a) => a.reduce((x, y) => x + y, 0);
  assert.ok(Math.abs(sum(out) - sum(input)) < 1e-9,
    'pool-adjacent-violators must preserve the total, or every grade shifts');
});

test('a grade is production minus what the slot usually returns', () => {
  const picks = [
    { pick_no: 1, round: 1, roster_id: 1, player_id: 'a', metadata: { first_name: 'A', last_name: 'One', position: 'RB' } },
    { pick_no: 2, round: 1, roster_id: 2, player_id: 'b', metadata: { first_name: 'B', last_name: 'Two', position: 'WR' } },
  ];
  const points = { a: 300, b: 50 };
  const curve = expectedCurve([picks], [points], 6);
  const rows = gradeDraft(picks, points, curve, [{ rosterId: 1, name: 'A' }, { rosterId: 2, name: 'B' }]);

  assert.strictEqual(rows[0].rosterId, 1, 'the team that got 300 from its pick drafted better');
  assert.ok(rows[0].grade > 0 && rows[1].grade < 0);
  // Two picks, one curve: the surpluses are symmetric around it.
  assert.ok(Math.abs(rows[0].grade + rows[1].grade) < 1e-9,
    'value taken from the pool has to come from somewhere');
});

test('a keeper is not a pick anybody made this year', () => {
  const picks = [
    { pick_no: 1, round: 1, roster_id: 1, player_id: 'a', is_keeper: true, metadata: {} },
    { pick_no: 2, round: 1, roster_id: 1, player_id: 'b', metadata: {} },
  ];
  const points = { a: 999, b: 10 };
  const curve = expectedCurve([picks], [points], 6);
  const rows = gradeDraft(picks, points, curve, [{ rosterId: 1, name: 'A' }]);
  assert.strictEqual(rows[0].picks.length, 1, 'a kept player was graded as a draft pick');
  assert.strictEqual(rows[0].picks[0].pickNo, 2, 'the wrong pick survived');
  assert.ok(!rows[0].picks.some(p => p.points === 999), 'the keeper\'s production leaked into the grade');
});

test('before any football, a pick with no published ADP is not graded', () => {
  const picks = [
    { pick_no: 1, round: 1, roster_id: 1, player_id: 'known', metadata: { first_name: 'K', last_name: 'Nown' } },
    { pick_no: 2, round: 1, roster_id: 1, player_id: 'ghost', metadata: { first_name: 'G', last_name: 'Host' } },
  ];
  const values = { known: { adp: 1, pos: 'RB' }, ghost: { adp: null, pos: 'WR' } };
  const rows = gradeAgainstMarket(picks, values, [{ rosterId: 1, name: 'A' }]);
  assert.strictEqual(rows[0].graded, 1);
  assert.strictEqual(rows[0].skipped, 1, 'a player with no ADP must be skipped, not scored as zero');
  assert.strictEqual(rows[0].surplus, 0, 'taken at 1 with an ADP of 1 is exactly par');
});

test('a reach is not scored as a steal', () => {
  // THE SIGN THAT WAS BACKWARDS. Value is getting a player LATER than the market
  // does. Inverted, the biggest reaches in the draft came out as the best picks
  // and one team's total reached +695.
  const reach = [{ pick_no: 5, round: 1, roster_id: 1, player_id: 'x', metadata: { first_name: 'R', last_name: 'Each' } }];
  const steal = [{ pick_no: 140, round: 12, roster_id: 1, player_id: 'x', metadata: { first_name: 'S', last_name: 'Teal' } }];
  const v = { x: { adp: 70, pos: 'WR' } };
  const asReach = gradeAgainstMarket(reach, v, [{ rosterId: 1, name: 'A' }])[0];
  const asSteal = gradeAgainstMarket(steal, v, [{ rosterId: 1, name: 'A' }])[0];
  assert.ok(asReach.surplus < 0, 'taking a pick-70 player at 5 is a reach, not value');
  assert.ok(asSteal.surplus > 0, 'getting a pick-70 player at 140 is a steal');
  assert.strictEqual(asReach.surplus, -65);
  assert.strictEqual(asSteal.surplus, 70);
});

test('the letter is graded on the curve of this draft', () => {
  // The absolute scale means nothing across leagues or seasons — 400 points of
  // surplus is an A in a shallow league and a C in a deep one.
  const teams = [], picks = [], points = {};
  for (let i = 1; i <= 6; i++) {
    teams.push({ rosterId: i, name: 'T' + i });
    picks.push({ pick_no: i, round: 1, roster_id: i, player_id: 'p' + i, metadata: {} });
    points['p' + i] = i * 100;
  }
  const curve = expectedCurve([picks], [points], 6);
  const rows = gradeDraft(picks, points, curve, teams);
  assert.match(rows[0].letter, /^A/, 'the best draft in the room should read as an A');
  assert.match(rows[rows.length - 1].letter, /^[DF]/, 'and the worst as a D or an F');
});
