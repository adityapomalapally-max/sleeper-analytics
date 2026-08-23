/**
 * The palette carries text, so it is measured rather than picked.
 *
 * MEASURED BEFORE THIS EXISTED (2026-08-22): `--muted` #64748b was 3.73:1 on
 * the card surface and carried 134 usages — most of the secondary text in the
 * app. `--purple` was 4.48. Four of the seven position and injury badges failed,
 * because a 20% tint lightens the backdrop enough to eat the contrast the token
 * had. And white text on a filled accent button was 2.80:1, the worst number in
 * the app: white is not a text colour on a bright fill.
 *
 * The arithmetic is re-derived here rather than imported, so this has no
 * dependency and cannot be satisfied by a library that changes its mind. It is
 * the same bargain The Signal's field-palette test makes.
 *
 *   node --test tests/
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

// ---- WCAG 2.1 relative luminance and contrast ----
const hex = (h) => {
  const s = h.replace('#', '');
  const full = s.length === 3 ? s.split('').map((c) => c + c).join('') : s;
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16));
};
const chan = (c) => { const v = c / 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
const lum = (rgb) => 0.2126 * chan(rgb[0]) + 0.7152 * chan(rgb[1]) + 0.0722 * chan(rgb[2]);
const ratio = (a, b) => {
  const [l1, l2] = [lum(a), lum(b)];
  const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
};
// A translucent fill over an opaque surface.
const over = (rgb, alpha, bg) => rgb.map((c, i) => c * alpha + bg[i] * (1 - alpha));

const AA = 4.5;

// ---- the tokens, read out of :root so the test cannot drift from the file ----
const root = HTML.slice(HTML.indexOf(':root{'), HTML.indexOf('}', HTML.indexOf(':root{')));
const tokens = Object.fromEntries([...root.matchAll(/--([a-z-]+):(#[0-9a-fA-F]{3,6})/g)].map((m) => [m[1], m[2]]));

const SURFACES = ['bg', 'surface', 'card'];
// Tokens that are never text: surfaces, borders, and the ink that goes ON a fill.
const NOT_TEXT = new Set([...SURFACES, 'border', 'subtle', 'ink']);

test('every token used as text clears AA on every surface', () => {
  const failures = [];
  for (const [name, value] of Object.entries(tokens)) {
    if (NOT_TEXT.has(name)) continue;
    for (const s of SURFACES) {
      const r = ratio(hex(value), hex(tokens[s]));
      if (r < AA) failures.push(`--${name} ${value} on --${s}: ${r.toFixed(2)}`);
    }
  }
  assert.deepStrictEqual(failures, [], 'these carry text and cannot be read:\n  ' + failures.join('\n  '));
});

test('every token used as a fill can carry --ink', () => {
  // A filled badge or button needs a text colour that works ON it. White does
  // not: it was 2.80 on the accent. --ink is the near-black that does.
  assert.ok(tokens.ink, '--ink is gone, so filled controls have nothing readable to put on them');
  const failures = [];
  for (const [name, value] of Object.entries(tokens)) {
    if (NOT_TEXT.has(name) || name === 'text') continue;
    const r = ratio(hex(tokens.ink), hex(value));
    if (r < AA) failures.push(`--ink on --${name} ${value}: ${r.toFixed(2)}`);
  }
  assert.deepStrictEqual(failures, [], 'these fills cannot carry readable text:\n  ' + failures.join('\n  '));
});

test('no white text sits on a coloured fill', () => {
  // The rule that produced the app's worst number. Caught by shape rather than
  // by listing the offenders, so a new one goes red on the day it is written.
  const offenders = [];
  const rules = [...HTML.matchAll(/\.([\w.-]+)\s*\{([^}]*)\}/g)];
  for (const [, sel, body] of rules) {
    if (!/color:\s*(white|#fff\b|#ffffff)/i.test(body)) continue;
    if (/background:[^;]*(var\(--(accent|purple|green|red|blue|yellow|cyan|pink|emerald)\)|linear-gradient)/.test(body)) {
      offenders.push(sel);
    }
  }
  assert.deepStrictEqual(offenders, [], 'white text on a bright fill: ' + offenders.join(', '));
});

test('a tinted badge still clears AA once the tint is blended in', () => {
  // The subtle one. `background:rgba(168,85,247,.2)` over the card lightens the
  // backdrop, so a token that passes on the card alone can still fail here —
  // four of seven badges did, and dropping the tint from .20 to .12 is what
  // fixed them rather than changing the text colour again.
  const failures = [];
  const rules = [...HTML.matchAll(/\.([\w.-]+)\s*\{([^}]*)\}/g)];
  for (const [, sel, body] of rules) {
    const bg = body.match(/background:\s*rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)/);
    const fg = body.match(/color:\s*var\(--([a-z-]+)\)/);
    if (!bg || !fg || !tokens[fg[1]]) continue;
    const tint = [Number(bg[1]), Number(bg[2]), Number(bg[3])];
    const alpha = Number(bg[4]);
    // Blended over the darkest surface a badge can sit on.
    for (const s of ['card', 'surface']) {
      const blended = over(tint, alpha, hex(tokens[s]));
      const r = ratio(hex(tokens[fg[1]]), blended);
      if (r < AA) failures.push(`.${sel}: --${fg[1]} on rgba(${tint},${alpha}) over --${s} = ${r.toFixed(2)}`);
    }
  }
  assert.deepStrictEqual(failures, [], 'tinted badges that cannot be read:\n  ' + failures.join('\n  '));
});
