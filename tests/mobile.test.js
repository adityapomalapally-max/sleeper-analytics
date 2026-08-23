/**
 * The phone.
 *
 * Measured against a real 10-team league at a 390px viewport. The layout held
 * up better than the audit implied — no document overflow on any of the eleven
 * tabs, because the cards are flex and grid rather than fixed widths. What did
 * not hold up:
 *
 *   - every form control was 14.4px or 13.1px, and mobile Safari zooms the
 *     viewport when a field under 16px takes focus and does not zoom back. The
 *     smallest of them was the league-ID field: the first thing anybody
 *     touches, on the only screen that exists before the app has any data;
 *   - eight controls were under the 44px touch floor, including the week
 *     buttons and the My Team sub-tabs;
 *   - the landing page scrolled sideways by 105px, because a decorative 600px
 *     radial glow is centred with translateX(-50%) and nothing clipped it;
 *   - the trade calculator squeezed two columns into 366px, so every player
 *     name truncated to "J. Gib..." on the one tool that is entirely about
 *     comparing named players.
 *
 * These are source assertions; the measurements behind them were taken in a
 * browser against the live league and are quoted above rather than re-run here.
 *
 *   node --test tests/
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const CODE = HTML.replace(/\/\*[\s\S]*?\*\//g, '').replace(/<!--[\s\S]*?-->/g, '');

// Everything inside a max-width media query, which is what a phone gets.
function mobileCss() {
  const out = [];
  const re = /@media\s*\((?:pointer:coarse\)|max-width:\s*\d+px\))[^{]*\{/g;
  let m;
  while ((m = re.exec(CODE))) {
    let depth = 1, i = re.lastIndex;
    for (; i < CODE.length && depth; i++) {
      if (CODE[i] === '{') depth++;
      else if (CODE[i] === '}') depth--;
    }
    out.push(CODE.slice(re.lastIndex, i));
  }
  return out.join('\n');
}
const MOBILE = mobileCss();

test('form controls are 16px on a phone, or iOS zooms and never comes back', () => {
  const rule = MOBILE.match(/([^{}]*)\{[^}]*font-size:\s*16px[^}]*\}/);
  assert.ok(rule, 'nothing sets a 16px font size on a phone');
  for (const sel of ['input', 'select', 'textarea']) {
    assert.match(rule[1], new RegExp(`\\b${sel}\\b`), `${sel} is not covered by the 16px rule`);
  }
  assert.match(rule[1], /input\.inp/, 'the league-ID field is not covered, and it is the first thing anyone touches');
});

test('no control carries an inline font-size that beats the stylesheet', () => {
  // The trap: an inline style wins from anywhere, so the pick selector stayed
  // at 11.5px while every other control moved to 16 — which is exactly the
  // size that makes iOS zoom.
  const inlineOnControls = [...CODE.matchAll(/el\('(select|input|textarea)',\s*\{([^}]*)\}/g)]
    .filter(([, , attrs]) => /fontSize/.test(attrs));
  assert.deepStrictEqual(inlineOnControls.map((m) => m[0].slice(0, 60)), [],
    'a form control sets its own font size inline, which the phone rule cannot override');
});

test('anything a thumb hits is at least 44px', () => {
  const rule = MOBILE.match(/([^{}]*)\{[^}]*min-height:\s*44px[^}]*\}/);
  assert.ok(rule, 'nothing sets a 44px touch floor');
  for (const sel of ['.season-btn', '.new-btn', '.team-select', '.tab', '.week-btn']) {
    assert.match(rule[1], new RegExp(sel.replace('.', '\\.')), `${sel} is under the touch floor on a phone`);
  }
});

test('the trade calculator stacks rather than squeezing two columns', () => {
  assert.match(CODE, /class:'trade-grid'/, 'the trade grid lost the class the breakpoint reaches');
  assert.match(MOBILE, /\.trade-grid\{grid-template-columns:1fr!important\}/,
    'the trade grid no longer stacks on a phone — each side goes back to 149px and every name truncates');
});

test('decoration cannot set the page width', () => {
  // A 600px glow centred with translateX(-50%) hung 105px past a 390px screen
  // and scrolled the whole document — on the landing page, which is the only
  // screen that exists before a league is loaded.
  assert.ok(!/width:600px;height:400px;background:radial-gradient/.test(HTML),
    'the hero glow is back to a fixed 600px and will scroll the landing page sideways');
  assert.match(HTML, /width:min\(600px,100%\)/, 'the hero glow is no longer capped to the space available');
});

test('the tab strip scrolls, and the selected tab is brought into view', () => {
  // Eleven tabs measure 1,185px against a 366px strip, so most of it is off
  // screen. A selection you cannot see reads as nothing having happened.
  assert.match(MOBILE, /#tabs\{[^}]*overflow-x:auto/, 'the tab strip no longer scrolls on a phone');
  assert.match(CODE, /scrollIntoView\(\{inline:'center'/,
    'the selected tab is no longer scrolled into view');
});
