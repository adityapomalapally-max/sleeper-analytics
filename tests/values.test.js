/**
 * The trade calculator's numbers.
 *
 * What was here before: `computeKTCValue`, ten hand-tuned constants with no
 * source — points per game times 100, a 0.04-per-year youth premium, a 1.25x
 * "young stud bonus", position scarcity multipliers — and a caller that applied
 * a second undocumented positional weight on top, then called 40% of the result
 * a rental value. The README described the output as "KTC-style keeper values".
 * Every verdict rested on them and none could be checked.
 *
 * What is here now is The Signal's VORP, and the reason this file exists is
 * that "sourced" is a claim like any other. These tests check the claim:
 *
 *   - the derivation REPRODUCES the board The Signal publishes for the same
 *     method, so the numbers are the site's and not this app's;
 *   - it prices the RANKED slot rather than the player's own projection, which
 *     is the difference between the analyst's order and one he has rejected;
 *   - a player it cannot price gets nothing rather than a zero.
 *
 *   node --test tests/
 */

const test = require('node:test');
const assert = require('node:assert');
const {
  slotValues, replacementMedians, verifyAgainstOverall, REPLACEMENT_RANK,
} = require('../lib/values');

// A miniature of the real shape: three ranked backs whose hand order does NOT
// match their own projections, which is the case that matters.
const RANKINGS = {
  rb: [
    { name: 'Hand One', pos: 'RB', median: 300 },   // ranked 1st, projected 2nd
    { name: 'Hand Two', pos: 'RB', median: 320 },   // ranked 2nd, projected 1st
    { name: 'Hand Three', pos: 'RB', median: 250 },
  ],
  qb: [], wr: [], te: [],
  overall: [],
};
const PROJECTIONS = {
  rb: Array.from({ length: 30 }, (_, i) => ({ median: 320 - i * 5 })),   // RB30 = 175
  qb: Array.from({ length: 12 }, (_, i) => ({ median: 400 - i * 5 })),   // QB12 = 345
  wr: Array.from({ length: 40 }, (_, i) => ({ median: 300 - i * 3 })),   // WR40 = 183
  te: Array.from({ length: 12 }, (_, i) => ({ median: 200 - i * 4 })),   // TE12 = 156
};

test('replacement is the projected median at the stated rank', () => {
  const r = replacementMedians(PROJECTIONS);
  assert.strictEqual(r.RB, 320 - 29 * 5, 'RB30 is the 30th best projected back');
  assert.strictEqual(r.QB, 400 - 11 * 5);
  assert.strictEqual(r.WR, 300 - 39 * 3);
  assert.strictEqual(r.TE, 200 - 11 * 4);
  assert.deepStrictEqual(REPLACEMENT_RANK, { QB: 12, RB: 30, WR: 40, TE: 12 },
    'the baselines moved — they are the ones The Signal states, not ours to pick');
});

test('a player is priced by the SLOT he was ranked into, not by his own projection', () => {
  // The whole point. Hand One is ranked first and therefore inherits the best
  // median at the position (320), even though his own projection is 300. Using
  // his own number would rank the board by the projection instead of by the
  // analyst — the exact ordering he does not agree with.
  const priced = slotValues(RANKINGS, replacementMedians(PROJECTIONS));
  const one = priced.find(p => p.name === 'Hand One');
  const two = priced.find(p => p.name === 'Hand Two');
  assert.strictEqual(one.slotMedian, 320, 'the top-ranked player should inherit the top slot');
  assert.strictEqual(two.slotMedian, 300);
  assert.ok(one.vorp > two.vorp, 'the hand ordering must survive into the values');
  assert.strictEqual(one.vorp, 320 - 175);
});

test('the value is above replacement, so a replacement-level player is worth about nothing', () => {
  const priced = slotValues(RANKINGS, replacementMedians(PROJECTIONS));
  const three = priced.find(p => p.name === 'Hand Three');
  assert.strictEqual(three.vorp, 250 - 175);
  assert.ok(three.vorp < priced.find(p => p.name === 'Hand One').vorp);
});

test('no positional multiplier is applied on top of VORP', () => {
  // VORP already prices scarcity: that is what measuring against a position's
  // own replacement level means. The old code multiplied by QB 1.30 / TE 0.90
  // afterwards, counting it twice.
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'lib', 'values.js'), 'utf8');
  assert.ok(!/1\.30|1\.15|0\.90|scarcity/i.test(src.replace(/\/\/.*$/gm, '')),
    'a positional weight has reappeared in the value derivation');
});

test('the derivation reproduces the board The Signal publishes', () => {
  // The claim this whole file rests on. If our slot inheritance ever stops
  // matching the site's overall tab, these are our numbers wearing its name.
  const rankings = {
    ...RANKINGS,
    overall: [
      { name: 'Hand One', vorp: 320 - 175 },
      { name: 'Hand Two', vorp: 300 - 175 },
    ],
  };
  const priced = slotValues(rankings, replacementMedians(PROJECTIONS));
  assert.deepStrictEqual(verifyAgainstOverall(rankings, priced), []);

  // And it has to actually notice a disagreement.
  const wrong = { ...rankings, overall: [{ name: 'Hand One', vorp: 999 }] };
  assert.strictEqual(verifyAgainstOverall(wrong, priced).length, 1,
    'the self-check passes a board it does not reproduce');
  const missing = { ...rankings, overall: [{ name: 'Nobody At All', vorp: 5 }] };
  assert.match(verifyAgainstOverall(missing, priced)[0], /not priced here/);
});

test('a player with no ranked slot is absent, never zero', () => {
  const priced = slotValues({ qb: [], rb: [], wr: [], te: [], overall: [] }, replacementMedians(PROJECTIONS));
  assert.deepStrictEqual(priced, [], 'an empty board should price nobody rather than pricing everybody at zero');

  // A ranked row with no median cannot be given a slot either.
  const noMedian = { ...RANKINGS, te: [{ name: 'No Projection', pos: 'TE' }] };
  const out = slotValues(noMedian, replacementMedians(PROJECTIONS));
  assert.ok(!out.some(p => p.name === 'No Projection'),
    'a player with no projected median was priced anyway');
});
