#!/usr/bin/env node
/**
 * health-report.js — is the app actually answering?
 *
 * The Signal has had a monitor since the eleven-day outage. This app had
 * nothing: 96 tests that ran when somebody typed the command, and seven live
 * endpoints nobody watched. Every failure here was a failure you found by
 * opening the site.
 *
 * The same rule applies as over there: ASK FROM OUTSIDE. These endpoints all
 * reach Sleeper and one of them reaches The Signal, so they can go down without
 * a single line of this repository changing — a deploy is not the only way this
 * app breaks, and a check that only runs on deploy cannot see the other ways.
 *
 * It also checks the ANSWERS, not just the status codes. A 200 carrying odds
 * that do not sum to the number of playoff seats is worse than a 503, because
 * nothing about it looks wrong.
 *
 *   node scripts/health-report.js
 *   BASE=http://localhost:3000 node scripts/health-report.js
 */

const BASE = process.env.BASE || 'https://sleeper-analytics.vercel.app';
const LEAGUE = process.env.LEAGUE_ID || '1312177397189062656';

const results = [];
const ok = (a, l, d) => results.push({ level: 'ok', area: a, line: l, detail: d });
const warn = (a, l, d) => results.push({ level: 'warn', area: a, line: l, detail: d });
const fail = (a, l, d) => results.push({ level: 'fail', area: a, line: l, detail: d });

async function get(path, opts = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 25000);
  try { return await fetch(`${BASE}${path}`, { signal: ctl.signal, ...opts }); }
  finally { clearTimeout(t); }
}

async function json(path) {
  const res = await get(path);
  const body = await res.text();
  let parsed = null;
  try { parsed = JSON.parse(body); } catch { /* left null */ }
  return { res, parsed, body };
}

/* ── the page itself ────────────────────────────────────────────────────── */
async function checkPage() {
  try {
    // THE FRONT DOOR, FETCHED THE WAY A CRAWLER FETCHES IT. Every manual test
    // of this app has used /index.html directly, so for months nobody
    // exercised "/" — which was answering 307 with no Location and Next's
    // error shell as the body, completing the hop client-side. Browsers got
    // there; anything without JavaScript did not.
    const res = await get('/');
    if (!res.ok) {
      return fail('page', `the front door answers ${res.status}, not 200`,
        res.status >= 300 && res.status < 400
          ? 'A redirect here means "/" only resolves for a client that follows it. '
            + 'Serve the app at "/" with a rewrite instead of a hop.'
          : undefined);
    }
    const html = await res.text();
    if (!/Sleeper Analytics/i.test(html)) {
      return fail('page', '"/" returned 200 but the body is not the app',
        html.includes('__next_error__') ? 'It is Next\'s error shell.' : undefined);
    }
    ok('page', '"/" serves the app directly, with no redirect and no JavaScript needed');

    // The headers are the whole browser-side defence and nothing else asserts
    // them against the LIVE response — middleware.js can be right while the
    // deploy serving it is old.
    const need = ['content-security-policy', 'x-frame-options', 'x-content-type-options',
                  'referrer-policy', 'strict-transport-security'];
    const missing = need.filter(h => !res.headers.get(h));
    if (missing.length) fail('headers', `${missing.length} security header(s) missing live`, missing.join('\n'));
    else {
      const csp = (res.headers.get('content-security-policy') || '').toLowerCase();
      const connect = (csp.split(';').map(s => s.trim()).find(s => s.startsWith('connect-src')) || '');
      if (/googleapis|generativelanguage/.test(connect)) {
        fail('headers', 'connect-src names Google again',
          'The model must only be reachable through /api/chat. In the browser, the key leaks.');
      } else ok('headers', 'all 5 security headers present, and the browser still cannot reach the model');
    }
  } catch (e) {
    fail('page', `the site did not answer — ${e.message}`);
  }
}

/* ── every endpoint answers, and rejects rubbish ────────────────────────── */
async function checkEndpoints() {
  const eps = [
    ['/api/health', null],
    ['/api/values', null],
    [`/api/playoffs?league=${LEAGUE}`, 'playoffs'],
    [`/api/power?league=${LEAGUE}`, 'power'],
    [`/api/trades?league=${LEAGUE}`, 'trades'],
    [`/api/draft?league=${LEAGUE}`, 'draft'],
  ];
  const down = [];
  for (const [path] of eps) {
    try {
      const res = await get(path);
      if (!res.ok) down.push(`${path.split('?')[0]} → ${res.status}`);
    } catch (e) { down.push(`${path.split('?')[0]} → ${e.message}`); }
  }
  if (down.length) fail('endpoints', `${down.length} of ${eps.length} endpoints are not answering`, down.join('\n'));
  else ok('endpoints', `all ${eps.length} endpoints answered`);

  // A league id is the only user input these take. If validation ever comes
  // off, they start making Sleeper requests for whatever is in the query
  // string — and a 200 on rubbish is how that looks from outside.
  const bad = [];
  for (const p of ['/api/playoffs?league=abc', '/api/power?league=../x', '/api/draft?league=', '/api/trades']) {
    try {
      const res = await get(p);
      if (res.status !== 400) bad.push(`${p} → ${res.status}, expected 400`);
    } catch (e) { bad.push(`${p} → ${e.message}`); }
  }
  if (bad.length) fail('validation', `${bad.length} endpoint(s) accept an invalid league id`, bad.join('\n'));
  else ok('validation', 'every endpoint rejects a malformed league id with a 400');
}

/* ── the answers are answers, not just 200s ─────────────────────────────── */
// THE CHECK THAT MATTERS. Every one of these is an arithmetic invariant that
// cannot be true by accident, so a wrong unit, a flipped sign or a broken join
// shows up here rather than on the page.
async function checkAnswers() {
  try {
    const { parsed: p } = await json(`/api/playoffs?league=${LEAGUE}`);
    if (!p || !p.teams) return fail('answers', 'the playoff endpoint returned no teams');
    const berths = p.teams.reduce((s, t) => s + t.playoffOdds, 0);
    const titles = p.teams.reduce((s, t) => s + t.titleOdds, 0);
    if (Math.abs(berths - p.playoffTeams) > 0.02) {
      fail('answers', `playoff odds sum to ${berths.toFixed(3)}, not the ${p.playoffTeams} seats available`);
    } else if (Math.abs(titles - 1) > 0.02) {
      fail('answers', `championship odds sum to ${titles.toFixed(3)}, not 1`);
    } else ok('answers', `playoff odds fill ${p.playoffTeams} seats and crown exactly one champion`);

    // The caveat has to survive the trip. A forecast quoted without it is a
    // forecast quoted wrongly, and week 1 is measurably worse than the base rate.
    if (p.weeksPlayed <= 1 && p.reliable) {
      fail('answers', `week ${p.weeksPlayed} is being reported as a reliable forecast`);
    }
  } catch (e) { fail('answers', `playoff odds unreadable — ${e.message}`); }

  try {
    const { parsed: p } = await json(`/api/power?league=${LEAGUE}`);
    if (!p || !p.teams) return fail('answers', 'the power endpoint returned no teams');
    const bad = p.teams.filter(t => t.allPlayPct < 0 || t.allPlayPct > 1);
    if (bad.length) fail('answers', `${bad.length} team(s) have an all-play rate outside 0-1`);
    else {
      // All-play is zero-sum across the league: every game one team wins,
      // another loses, so the mean is 0.5 whatever the season looks like.
      const mean = p.teams.reduce((s, t) => s + t.allPlayPct, 0) / p.teams.length;
      if (Math.abs(mean - 0.5) > 0.02) {
        fail('answers', `all-play averages ${mean.toFixed(3)} across the league, and it has to be 0.5`,
          'Every all-play win is somebody else\'s loss. A mean off 0.5 means the join or the count is wrong.');
      } else ok('answers', 'all-play is zero-sum across the league, as it must be');
    }
  } catch (e) { fail('answers', `power rankings unreadable — ${e.message}`); }

  try {
    const { parsed: d } = await json(`/api/draft?league=${LEAGUE}`);
    if (!d || !d.teams) return fail('answers', 'the draft endpoint returned no teams');
    const key = d.mode === 'production' ? 'relative' : 'relative';
    const mean = d.teams.reduce((s, t) => s + (t[key] || 0), 0) / d.teams.length;
    // "vs room" is measured against the room, so it centres on zero by
    // construction. This is the invariant that would have caught the 12-team
    // ADP scale being compared against a 10-team draft, where every manager in
    // the league came out between -289 and -695.
    if (Math.abs(mean) > 1) {
      fail('answers', `draft grades average ${mean.toFixed(1)} against the room, and must average 0`,
        'A whole league grading the same way is a scale or sign error, not ten bad drafts.');
    } else ok('answers', `draft grades centre on the room (mean ${mean.toFixed(2)})`);
  } catch (e) { fail('answers', `draft grades unreadable — ${e.message}`); }
}

/* ── the values this app borrows from The Signal ────────────────────────── */
async function checkValues() {
  try {
    const { res, parsed } = await json('/api/values');
    if (!res.ok || !parsed) return fail('values', `the value table did not load (${res.status})`);
    if (parsed.reproducesOverall === false) {
      fail('values', 'the derivation no longer reproduces The Signal\'s published board',
        'Trades would be priced by a variant nobody published. See lib/values.js.');
    } else if (!parsed.coverage || !parsed.coverage.ranked) {
      warn('values', 'the value table carries no coverage figure');
    } else {
      ok('values', `${parsed.coverage.ranked} players priced, and the derivation still reproduces the published board`);
    }
  } catch (e) { fail('values', `values unreadable — ${e.message}`); }
}

function render() {
  const icon = { ok: '✅', warn: '⚠️', fail: '❌' };
  const fails = results.filter(r => r.level === 'fail');
  const warns = results.filter(r => r.level === 'warn');
  const head = fails.length ? `❌ ${fails.length} problem${fails.length > 1 ? 's' : ''}`
             : warns.length ? `⚠️ ${warns.length} to look at` : '✅ all clear';
  const out = [`## ${head}`, '', `_${new Date().toISOString().replace('T', ' ').slice(0, 16)} UTC · [${BASE.replace(/^https:\/\//, '')}](${BASE})_`, ''];
  for (const r of [...fails, ...warns]) {
    out.push(`${icon[r.level]} **${r.area}** — ${r.line}`);
    if (r.detail) out.push('', '```', r.detail, '```');
    out.push('');
  }
  const passed = results.filter(r => r.level === 'ok');
  if (passed.length) {
    out.push(`<details><summary>${passed.length} checks passed</summary>`, '');
    for (const r of passed) out.push(`- ✅ **${r.area}** — ${r.line}`);
    out.push('', '</details>');
  }
  return out.join('\n');
}

async function main() {
  await checkPage();
  await checkEndpoints();
  await checkAnswers();
  await checkValues();
  console.log(render());
  return results.some(r => r.level === 'fail') ? 1 : 0;
}

main().then(c => process.exit(c)).catch(e => { console.error(e.stack); process.exit(1); });
