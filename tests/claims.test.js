/**
 * The claims scorecard.
 *
 * THE GAP EVERY OTHER TEST LEAVES. Unit tests check a number is computed as
 * intended. Invariants check it is internally consistent. Mutation testing
 * checks the tests would notice a change. None of them can tell you a number is
 * computed perfectly and MEANS SOMETHING ELSE.
 *
 * Lineup efficiency is the worked example, and it is in this repo: it
 * correlates 0.450 with winning, passes every check, and persists at -0.036. It
 * describes the season, not the manager. The only thing that catches that is
 * asking what the number CLAIMS and testing the claim.
 *
 * The rule: a number about a SITUATION must predict; a number about a PERSON
 * must persist.
 *
 *   node --test 'tests/*.test.js'
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { CLAIMS } = require('../lib/claims');

test('every claim says what it is about and how it is checked', () => {
  for (const c of CLAIMS) {
    assert.ok(c.id && c.metric && c.claim, `a claim is missing its text: ${JSON.stringify(c)}`);
    assert.ok(['situation', 'person'].includes(c.about), `${c.id}: "about" must be situation or person`);
    assert.ok(['predicts', 'persists'].includes(c.test), `${c.id}: "test" must be predicts or persists`);
    assert.ok(c.published, `${c.id}: nothing records where a reader meets this number`);
  }
});

test('a number about a person is tested for persistence, not prediction', () => {
  // THE WHOLE RULE. Testing a person-metric by correlating it with winning is
  // how lineup efficiency became a Manager Rating on half the sites that have
  // one: it correlates 0.450 and repeats at -0.036.
  for (const c of CLAIMS) {
    if (c.about === 'person') {
      assert.strictEqual(c.test, 'persists',
        `${c.id} describes a person but is checked by prediction — a good season would pass that test`);
    }
  }
});

test('a claim published as unsupported says so in its own text', () => {
  for (const c of CLAIMS.filter(c => c.expectFail)) {
    assert.match(c.claim, /NOT |never/i,
      `${c.id} is expected to fail its test, so the sentence the page may say has to admit it`);
    assert.strictEqual(c.floor, null, `${c.id}: an unsupported claim cannot also carry a floor`);
  }
});

test('the scorecard on disk still supports every claim the site makes', () => {
  // data/claims-score.json is written by scripts/score-claims.js. This reads
  // the last real scoring, so a claim that stopped holding fails here rather
  // than whenever somebody next looks at the page.
  const p = path.join(__dirname, '..', 'data', 'claims-score.json');
  if (!fs.existsSync(p)) {
    assert.fail('data/claims-score.json is missing — run: node scripts/score-claims.js --write');
  }
  const score = JSON.parse(fs.readFileSync(p, 'utf8'));
  const broken = score.claims.filter(c => String(c.verdict).startsWith('FAILS') || String(c.verdict).startsWith('NOW'));
  assert.deepStrictEqual(broken.map(c => `${c.id}: ${c.verdict}`), [],
    'a published number no longer supports what the page says about it');

  // And every claim in the registry has actually been scored.
  const scored = new Set(score.claims.map(c => c.id));
  for (const c of CLAIMS) {
    assert.ok(scored.has(c.id), `${c.id} is published but never scored`);
  }
});

test('the added-in-season metric excludes kept players', () => {
  // The bug this replaced: in a keeper league a kept player never appears in
  // the draft picks, so "not drafted" counted every keeper as an acquisition —
  // and the metric reported wire work as a skill worth 0.912 when it was
  // largely roster continuity. Separated properly it is 0.895 persistence and
  // 0.021 with winning.
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'manager.js'), 'utf8');
  const fn = src.slice(src.indexOf('function managerProfiles'));
  assert.match(fn, /keptBy/, 'managerProfiles no longer takes the kept-player set');
  assert.match(fn, /else if \(kept\.has\(id\)\)/,
    'kept players must be counted separately from added ones, or a keeper league reads every keeper as an acquisition');
});
