// ============================================================
// /api/chat — grounded fantasy assistant
// ============================================================
//
// The model answers out of The Signal's data or it does not answer. The
// conversation itself lives in lib/gemini.js; this file is HTTP: origin, rate
// limit, payload shape, and turning a failure into something a reader can act on.

import { converse, MODEL } from '../../../lib/gemini.js';

const ALLOWED_ORIGINS = [
  'https://sleeper-analytics.vercel.app',
  'https://sleeper-analytics-4ddskoklr-adityapomalapally-maxs-projects.vercel.app',
];

if (process.env.NODE_ENV !== 'production') {
  ALLOWED_ORIGINS.push('http://localhost:3000', 'http://localhost:8000');
}

function isAllowedOrigin(origin) {
  if (!origin) return false;
  if (ALLOWED_ORIGINS.includes(origin)) return true;
  if (origin.match(/^https:\/\/sleeper-analytics[a-z0-9-]*\.vercel\.app$/)) return true;
  return false;
}

function corsHeaders(origin) {
  const headers = {
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };
  if (origin && isAllowedOrigin(origin)) headers['Access-Control-Allow-Origin'] = origin;
  return headers;
}

// --- Rate limiter ---
//
// KNOWN WEAK. This Map lives in one serverless instance's memory: it resets on
// every cold start and is not shared across instances or regions, so the real
// ceiling is well above RATE_LIMIT. It is a courtesy brake, not a control.
// A grounded turn is now worth more than it used to be — up to MAX_ROUNDS
// upstream calls — so this wants Vercel KV or Upstash before the tool is shared
// anywhere public.
const rateMap = new Map();
const RATE_LIMIT = 30;
const RATE_WINDOW = 24 * 60 * 60 * 1000;

function getClientIP(req) {
  const forwarded = req.headers.get('x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0].trim();
  const realIp = req.headers.get('x-real-ip');
  if (realIp) return realIp.trim();
  return 'unknown';
}

function checkRateLimit(ip) {
  const now = Date.now();
  const entry = rateMap.get(ip);
  if (entry && now - entry.start > RATE_WINDOW) rateMap.delete(ip);

  const current = rateMap.get(ip);
  if (!current) {
    rateMap.set(ip, { start: now, count: 1 });
    return { ok: true, remaining: RATE_LIMIT - 1 };
  }
  if (current.count >= RATE_LIMIT) {
    const resetIn = Math.ceil((current.start + RATE_WINDOW - now) / 60000);
    return { ok: false, remaining: 0, resetIn };
  }
  current.count++;
  return { ok: true, remaining: RATE_LIMIT - current.count };
}

if (typeof globalThis.__rateLimitCleanup === 'undefined') {
  globalThis.__rateLimitCleanup = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of rateMap) {
      if (now - entry.start > RATE_WINDOW) rateMap.delete(key);
    }
  }, 10 * 60 * 1000);
}

const MAX_MESSAGE = 2000;      // a question, not a document
const MAX_LEAGUE = 12000;      // the roster/standings dump the client assembles
const MAX_HISTORY_TURNS = 12;

function clean(raw, max) {
  if (typeof raw !== 'string') return '';
  let s = raw.replace(/\0/g, '').trim();
  if (s.length > max) s = s.slice(0, max);
  return s;
}

export async function OPTIONS(req) {
  return new Response(null, { status: 204, headers: corsHeaders(req.headers.get('origin')) });
}

export async function GET() {
  return Response.json({ error: 'Method not allowed. Use POST.' },
    { status: 405, headers: { Allow: 'POST, OPTIONS' } });
}

export async function POST(req) {
  const origin = req.headers.get('origin');
  const cors = corsHeaders(origin);

  if (origin && !isAllowedOrigin(origin)) {
    return Response.json({ error: 'Origin not allowed.' }, { status: 403, headers: cors });
  }

  const contentType = req.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) {
    return Response.json({ error: 'Content-Type must be application/json.' }, { status: 415, headers: cors });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error('GEMINI_API_KEY not set in environment.');
    return Response.json({ error: 'AI assistant is not configured.' }, { status: 503, headers: cors });
  }

  const ip = getClientIP(req);
  const limit = checkRateLimit(ip);
  if (!limit.ok) {
    return Response.json(
      { error: `Rate limit reached (${RATE_LIMIT}/day). Resets in ~${limit.resetIn} minutes.` },
      { status: 429, headers: { ...cors, 'Retry-After': String(limit.resetIn * 60), 'X-RateLimit-Limit': String(RATE_LIMIT), 'X-RateLimit-Remaining': '0' } }
    );
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'Invalid JSON in request body.' }, { status: 400, headers: cors });
  }

  // `prompt` is the old single-blob shape. Accepting it keeps a cached copy of
  // the previous client working through a deploy; new clients send `message`.
  const message = clean(body?.message ?? body?.prompt, MAX_MESSAGE);
  if (!message) {
    return Response.json({ error: 'Missing or empty "message" field.' }, { status: 400, headers: cors });
  }

  const league = clean(body?.league, MAX_LEAGUE) || undefined;
  const history = Array.isArray(body?.history)
    ? body.history
        .slice(-MAX_HISTORY_TURNS)
        .filter(t => t && (t.role === 'user' || t.role === 'assistant'))
        .map(t => ({ role: t.role, text: clean(t.text, MAX_MESSAGE) }))
        .filter(t => t.text)
    : [];

  try {
    const out = await converse({ history, message, league, apiKey });
    return Response.json(
      { reply: out.reply, toolsUsed: out.toolsUsed, grounded: out.toolsUsed.length > 0, model: MODEL },
      { headers: { ...cors, 'X-RateLimit-Limit': String(RATE_LIMIT), 'X-RateLimit-Remaining': String(limit.remaining) } }
    );
  } catch (e) {
    // The upstream detail goes to the log, never to the reader — but the reader
    // gets something better than "an error occurred": what to do about it.
    console.error('chat failed:', e.kind || 'fatal', e.message, e.upstream ? JSON.stringify(e.upstream) : '');

    // The free Gemini tier allows about 5 requests a MINUTE across the whole
    // project, and one grounded answer costs two or three of them. That ceiling
    // is far lower than this app's own 30-a-day-per-IP limit, so it is the one
    // real users will actually hit — and "try again" is useless advice unless we
    // say how long. The retry delay comes back in the upstream message.
    if (e.kind === 'quota') {
      const wait = /retry in ([\d.]+)s/i.exec(e.message);
      const secs = wait ? Math.ceil(Number(wait[1])) : 60;
      return Response.json(
        { error: `The free Gemini tier is rate-limited and we've just hit it. Try again in about ${secs} seconds.`, retryAfter: secs },
        { status: 429, headers: { ...cors, 'Retry-After': String(secs) } }
      );
    }

    if (e.kind === 'overloaded') {
      return Response.json(
        { error: 'Google\'s models are busy right now — every fallback was overloaded. Try again in a moment; the data pages all still work.' },
        { status: 503, headers: cors }
      );
    }

    const misconfigured = e.upstream
      && /API key|PERMISSION|INVALID_ARGUMENT|NOT_FOUND/i.test(e.upstream.status || e.upstream.message || '');
    return Response.json(
      { error: misconfigured
        ? 'The AI assistant is not configured correctly right now. The data pages all still work.'
        : 'The assistant could not reach the model. Try again in a moment.' },
      { status: misconfigured ? 503 : 502, headers: cors }
    );
  }
}
