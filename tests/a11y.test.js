/**
 * Reaching this app without a mouse.
 *
 * MEASURED BEFORE THIS EXISTED (2026-08-22): one aria attribute and zero `alt`
 * attributes in 3,277 lines, and the live DOM carried ZERO roles. In practice
 * that meant three separate things:
 *
 *   - the eleven tabs are the site's navigation and announced nothing. They
 *     were buttons with a class that happened to mean "selected", so a screen
 *     reader user could hear every label and never learn which one they were on;
 *   - the only control on the landing page was an unnamed text box. Its heading
 *     was styled text with no relationship to the field, and a placeholder is
 *     not a name because it disappears the moment anyone types;
 *   - most of the app renders through el(), and a clickable <div> has no role,
 *     no tab stop and no Enter key.
 *
 * These are source assertions. What they cannot check — that Enter actually
 * fires the click, that the promoter does not double-bind across a re-render —
 * was checked against the running app with the real league.
 *
 *   node --test tests/
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
// Comments explain the rules and quote them; a grep over the raw file passes on
// the paragraph describing a rule that has been deleted.
const CODE = HTML.replace(/\/\*[\s\S]*?\*\//g, '').replace(/<!--[\s\S]*?-->/g, '');

test('every image is given an alt, and the decorative ones are hidden', () => {
  // Avatars and headshots all sit beside the name they belong to, so the
  // correct treatment is alt="" — announcing "Trainer Red's avatar" next to
  // "Trainer Red" reads the name twice.
  const imgs = [...CODE.matchAll(/el\('img',\s*\{([^}]*)\}/g)].map((m) => m[1]);
  assert.ok(imgs.length >= 2, `only ${imgs.length} img constructions found — has the helper moved?`);
  for (const attrs of imgs) {
    assert.match(attrs, /alt:/, `an image is built with no alt: ${attrs.slice(0, 60)}`);
    assert.match(attrs, /'aria-hidden':\s*'true'/, `a decorative image is not hidden from the reader: ${attrs.slice(0, 60)}`);
  }
});

test('the tab strip is a tablist and says which tab is current', () => {
  assert.match(CODE, /setAttribute\('role','tablist'\)/, 'the tab strip is no longer a tablist');
  assert.match(CODE, /role:'tab'/, 'the tabs are no longer tabs');
  assert.match(CODE, /'aria-selected',String\(on\)/,
    'aria-selected is not kept in step with the class — a reader would hear no current tab, or eleven of them');
  assert.match(CODE, /setAttribute\('role','tabpanel'\)/, 'the panel is not a tabpanel');
  assert.match(CODE, /'aria-labelledby','tab-'\+name/, 'the panel is not tied to the tab that opened it');
});

test('the league field has a real label, not a placeholder', () => {
  assert.match(HTML, /<label[^>]*for="league-input"/, 'the league field lost its label');
  assert.ok(!/<div class="bb"[^>]*>ENTER LEAGUE ID<\/div>/.test(HTML),
    'the label went back to being a styled div, which names nothing');
  assert.match(HTML, /id="error-box"[^>]*role="alert"/,
    'the error box is painted red and announced to nobody');
});

test('a clickable div is promoted to something a keyboard can reach', () => {
  const fn = CODE.slice(CODE.indexOf('function promoteClickables'), CODE.indexOf('function promoteClickables') + 900);
  assert.ok(fn, 'promoteClickables is gone');
  assert.match(fn, /setAttribute\('role','button'\)/);
  assert.match(fn, /setAttribute\('tabindex','0'\)/);
  assert.match(fn, /'Enter'/, 'Enter no longer activates a promoted control');
  assert.match(fn, /' '/, 'Space no longer activates a promoted control');
  assert.match(fn, /preventDefault/,
    'Space is not prevented, so it scrolls the page instead of pressing the button');
  // Idempotent: renders happen constantly and a second pass must not re-bind.
  assert.match(fn, /getAttribute\('role'\)==='button'\)return/,
    'the promoter no longer skips what it already promoted, so handlers stack up on every render');
});

test('the promoter runs on the chrome as well as the panel', () => {
  // The saved-league card lives outside #tab-content and is the first thing a
  // returning reader clicks.
  assert.match(CODE, /promoteClickables\(c\)/, 'the tab panel is no longer promoted');
  assert.match(CODE, /promoteClickables\(container\)/, 'the saved-league cards are no longer promoted');
});
