/**
 * The trade finder.
 *
 * Grading a trade somebody thought of is the easy half; proposing one is where
 * a tool can quietly start inventing. lib/values.js prices 88 players and names
 * the rest rather than estimating them, and the whole risk here is that a
 * finder papers over that gap to fill a page.
 *
 *   node --test 'tests/*.test.js'
 */

const test = require('node:test');
const assert = require('node:assert');
const { findTrades, bestLineup, makeValueOf } = require('../lib/trades');

const SLOTS = ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX', 'BN', 'BN'];

// id -> value row, in the shape lib/values.js produces
function values(spec) {
  const out = {};
  for (const [id, pos, vorp, name] of spec) out[id] = { pos, vorp, name: name || id };
  return out;
}

test('a lineup is the best eleven, not the whole roster', () => {
  const v = values([
    ['qb1', 'QB', 100], ['rb1', 'RB', 90], ['rb2', 'RB', 80], ['rb3', 'RB', 70],
    ['wr1', 'WR', 60], ['wr2', 'WR', 50], ['te1', 'TE', 40],
  ]);
  const lu = bestLineup(Object.keys(v), makeValueOf(v, {}), SLOTS.filter(s => s !== 'BN'));
  // QB100 + RB90 + RB80 + WR60 + WR50 + TE40 + FLEX(RB70) = 490
  assert.strictEqual(lu.total, 490);
  assert.strictEqual(lu.starters.length, 7);
});

test('a third good back is worth nothing until somebody else needs him', () => {
  // The whole basis of the finder: surplus at one position and a hole at
  // another is what makes a trade possible.
  // The roster needs ANOTHER flex-eligible body, or removing rb3 empties the
  // flex and he really is worth all 75 — which is a true result and not the one
  // this test is about.
  const roster = values([
    ['qb1', 'QB', 100], ['rb1', 'RB', 90], ['rb2', 'RB', 80], ['rb3', 'RB', 75],
    ['wr1', 'WR', 60], ['wr2', 'WR', 10], ['wr3', 'WR', 70], ['te1', 'TE', 40],
  ]);
  const vo = makeValueOf(roster, {});
  const slots = SLOTS.filter(s => s !== 'BN');
  const withRb3 = bestLineup(Object.keys(roster), vo, slots).total;
  const withoutRb3 = bestLineup(Object.keys(roster).filter(id => id !== 'rb3'), vo, slots).total;
  const marginal = withRb3 - withoutRb3;
  // He displaces wr2 in the flex, so he is worth 75 - 10, not 75. That gap is
  // the entire reason a surplus can be traded for something a team needs.
  assert.strictEqual(marginal, 65);
  assert.ok(marginal < 75, 'the third back cannot be worth his full value');
});

test('it only proposes players that carry a published value', () => {
  const v = values([['a1', 'RB', 90], ['a2', 'RB', 85], ['b1', 'WR', 95]]);
  v.ghost = { pos: 'WR', vorp: null, name: 'Unpriced Guy' };
  const teams = [
    { rosterId: 1, name: 'A', players: ['a1', 'a2', 'ghost'] },
    { rosterId: 2, name: 'B', players: ['b1'] },
  ];
  const found = findTrades(teams, v, SLOTS, {}, { minGain: 0.01 });
  for (const t of found) {
    for (const p of [...t.a.gives, ...t.b.gives]) {
      assert.notStrictEqual(p.name, 'Unpriced Guy',
        'an unpriced player was offered in a trade — he has no number to trade on');
    }
  }
});

test('both sides have to gain, or it is not a trade', () => {
  const v = values([['a1', 'RB', 100], ['a2', 'RB', 95], ['b1', 'WR', 5]]);
  const teams = [
    { rosterId: 1, name: 'A', players: ['a1', 'a2'] },
    { rosterId: 2, name: 'B', players: ['b1'] },
  ];
  // Nothing here helps A: they would be handing over a starter for a scrub.
  const found = findTrades(teams, v, SLOTS, {}, { minGain: 1 });
  for (const t of found) {
    assert.ok(t.a.gain > 0 && t.b.gain > 0, 'a proposal that helps one side is not a trade');
  }
});

test('the same idea is not listed eight times', () => {
  // Surplus receivers for one tight end is ONE idea, however many ways the
  // filler can be swapped. A page of near-identical rows reads as a bug.
  const spec = [['te', 'TE', 200]];
  for (let i = 0; i < 6; i++) spec.push([`wr${i}`, 'WR', 90 - i]);
  const v = values(spec);
  const teams = [
    { rosterId: 1, name: 'A', players: ['wr0', 'wr1', 'wr2', 'wr3', 'wr4', 'wr5'] },
    { rosterId: 2, name: 'B', players: ['te'] },
  ];
  const found = findTrades(teams, v, SLOTS, {}, { minGain: 0.01, perPair: 2 });
  assert.ok(found.length <= 2, `one pair of teams should not fill the page, got ${found.length}`);
});

test('a finder is for somebody', () => {
  const v = values([['a1', 'RB', 90], ['b1', 'WR', 95], ['c1', 'TE', 92], ['c2', 'TE', 80]]);
  const teams = [
    { rosterId: 1, name: 'A', players: ['a1'] },
    { rosterId: 2, name: 'B', players: ['b1'] },
    { rosterId: 3, name: 'C', players: ['c1', 'c2'] },
  ];
  const found = findTrades(teams, v, SLOTS, {}, { minGain: 0.01, forRoster: 1 });
  for (const t of found) {
    assert.ok(t.a.rosterId === 1 || t.b.rosterId === 1,
      'a search for team 1 returned a trade team 1 is not in');
  }
});
