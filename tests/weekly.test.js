/**
 * The weekly report's arithmetic.
 *
 * The Recap tab is a SEASON recap. This is the other thing — one week, and the
 * awards a scoreboard cannot give you: a win is only "lucky" relative to what
 * the rest of the league scored that week, and points left on the bench need
 * the optimal lineup, not the actual one.
 *
 * The two pieces worth pinning are the ones that are easy to get subtly wrong
 * and impossible to eyeball: the normal CDF behind the next-week preview, and
 * the beat-count behind the luck awards.
 *
 *   node --test 'tests/*.test.js'
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const erf = new Function('return ' + HTML.match(/function erf\(x\)\{[\s\S]*?\n\}/)[0])();
const phi = (z) => 0.5 * (1 + erf(z / Math.SQRT2));

test('the normal CDF behind the preview is actually normal', () => {
  assert.ok(Math.abs(phi(0) - 0.5) < 1e-6, 'a coin flip is a coin flip');
  assert.ok(Math.abs(phi(1.96) - 0.975) < 1e-4, '1.96 sigma is the 97.5th percentile');
  assert.ok(Math.abs(phi(-1.96) - 0.025) < 1e-4);
  assert.ok(Math.abs(phi(1) - 0.8413) < 1e-4);
  assert.ok(Math.abs(phi(-1) - 0.1587) < 1e-4);
  assert.ok(Math.abs((phi(2) + phi(-2)) - 1) < 1e-9, 'the tails have to sum to one');
});

test('two evenly matched teams are a coin flip, and a gap moves it the right way', () => {
  const SIG = 22.26;
  const p = (a, b) => phi((a - b) / (SIG * Math.SQRT2));
  assert.ok(Math.abs(p(120, 120) - 0.5) < 1e-9);
  assert.ok(p(130, 110) > 0.5, 'the higher projection must be favoured');
  assert.ok(p(110, 130) < 0.5);
  assert.ok(Math.abs(p(130, 110) + p(110, 130) - 1) < 1e-9, 'somebody wins');
  // A 20-point edge is real but not decisive — a week is one game.
  const edge = p(130, 110);
  assert.ok(edge > 0.6 && edge < 0.85, `a 20-point projection edge should read 60-85%, got ${(edge * 100).toFixed(0)}%`);
});

test('the weekly report reuses the calibrated spread, it does not invent one', () => {
  // If someone types a different sigma here than lib/playoffs.js draws with,
  // the preview and the playoff odds start disagreeing about the same teams.
  const fn = HTML.slice(HTML.indexOf('function fillWeekly'), HTML.indexOf('function erf'));
  assert.match(fn, /SIG\s*=\s*22\.26/, 'the weekly preview must use the fitted sigma');
  assert.match(fn, /K\s*=\s*6\.5/, 'and the fitted shrinkage');
  const lib = fs.readFileSync(path.join(__dirname, '..', 'lib', 'playoffs.js'), 'utf8');
  assert.match(lib, /SIGMA\s*=\s*22\.26/);
  assert.match(lib, /const K = 6\.5/);
});

test('only played weeks are offered', () => {
  // Sleeper answers for every week of the season from day one, all zeros.
  // Offering week 12 in September gives the reader a page of dashes.
  const fn = HTML.slice(HTML.indexOf('function fillWeekly'), HTML.indexOf('function erf'));
  assert.match(fn, /\.some\(m=>\(m\.points\|\|0\)>0\)/,
    'the week picker must filter to weeks somebody actually scored in');
});
