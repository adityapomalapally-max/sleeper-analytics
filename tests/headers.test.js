/**
 * The security headers, and the fact that nothing was asserting them.
 *
 * middleware.js is the only thing standing between this app and being framed,
 * sniffed, or having an injected string run as script. It is also a file people
 * edit while debugging something else — a directive gets loosened to make a
 * console error go away, the app works perfectly either way, and the loosening
 * ships. There is no symptom. That is the entire failure mode.
 *
 * These tests do not check that the policy is GOOD. They check that the
 * specific decisions someone made on purpose are still there.
 *
 *   node --test tests/
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'middleware.js'), 'utf8');

test('every security header is still being set', () => {
  for (const h of ['X-Frame-Options', 'X-Content-Type-Options', 'Referrer-Policy',
                   'Permissions-Policy', 'Content-Security-Policy', 'Strict-Transport-Security']) {
    assert.match(SRC, new RegExp(`set\\(\\s*'${h}'`, 'i'), `${h} is no longer being set`);
  }
});

test('the CSP keeps the directives that do the work', () => {
  for (const d of ["default-src 'self'", "object-src 'none'", "base-uri 'self'",
                   "form-action 'self'", "frame-ancestors 'self'", 'upgrade-insecure-requests']) {
    assert.ok(SRC.includes(d), `the CSP has lost: ${d}`);
  }
});

test('the browser still has no business talking to Gemini', () => {
  // The key lives on the server and the model is only spoken to through
  // /api/chat. A connect-src that names the Google endpoint would mean somebody
  // put the conversation back in the browser, which is where the key leaks.
  const connect = SRC.match(/"connect-src[^"]*"/);
  assert.ok(connect, 'connect-src is gone entirely');
  assert.ok(!/googleapis|generativelanguage/i.test(connect[0]),
    'connect-src names Google again — the model must only be reachable through /api/chat');
});

test('the legacy XSS auditor stays off', () => {
  // Deliberate: the filter it enables has been used to CREATE injections by
  // stripping parts of a response. Off is the safe value, so a well-meaning
  // change back to "1; mode=block" should fail here rather than look tidy.
  assert.match(SRC, /'X-XSS-Protection',\s*'0'/,
    "X-XSS-Protection must be '0' — the legacy auditor is a liability, not a defence");
});
