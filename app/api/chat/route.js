// ============================================================
// /api/chat — Gemini Proxy with Security Hardening
// ============================================================

// --- CORS Configuration ---
// Add your production domain(s) here. Vercel preview URLs are
// allowed in development but NOT in production.
const ALLOWED_ORIGINS = [
  'https://sleeper-analytics.vercel.app',
  'https://sleeper-analytics-4ddskoklr-adityapomalapally-maxs-projects.vercel.app',
  // Add custom domain when you have one, e.g.:
  // 'https://sleeper-analytics.com',
];

// In development, also allow localhost
if (process.env.NODE_ENV !== 'production') {
  ALLOWED_ORIGINS.push('http://localhost:3000', 'http://localhost:8000');
}

function isAllowedOrigin(origin) {
  if (!origin) return false;
  // Allow exact matches
  if (ALLOWED_ORIGINS.includes(origin)) return true;
  // Allow any Vercel preview URL for your project
  if (origin.match(/^https:\/\/sleeper-analytics[a-z0-9-]*\.vercel\.app$/)) return true;
  return false;
}

function corsHeaders(origin) {
  const headers = {
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };
  if (origin && isAllowedOrigin(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
  }
  return headers;
}

// --- Rate Limiter (in-memory, resets on cold start) ---
const rateMap = new Map();
const RATE_LIMIT = 30; // requests per day per IP
const RATE_WINDOW = 24 * 60 * 60 * 1000; // 24 hours

function getClientIP(req) {
  // Vercel sets x-forwarded-for; use first IP (client)
  const forwarded = req.headers.get('x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0].trim();
  // Vercel also sets x-real-ip
  const realIp = req.headers.get('x-real-ip');
  if (realIp) return realIp.trim();
  return 'unknown';
}

function checkRateLimit(ip) {
  const now = Date.now();
  const entry = rateMap.get(ip);

  // Clean expired entry
  if (entry && now - entry.start > RATE_WINDOW) {
    rateMap.delete(ip);
  }

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

// Periodic cleanup every 10 minutes
if (typeof globalThis.__rateLimitCleanup === 'undefined') {
  globalThis.__rateLimitCleanup = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of rateMap) {
      if (now - entry.start > RATE_WINDOW) rateMap.delete(key);
    }
  }, 10 * 60 * 1000);
}

// --- Input Sanitization ---
const MAX_PROMPT_LENGTH = 12000;

function sanitizePrompt(raw) {
  if (typeof raw !== 'string') return null;

  // Trim whitespace
  let cleaned = raw.trim();

  // Reject empty
  if (cleaned.length === 0) return null;

  // Truncate if too long
  if (cleaned.length > MAX_PROMPT_LENGTH) {
    cleaned = cleaned.slice(0, MAX_PROMPT_LENGTH) + '\n\n[Context truncated for length]';
  }

  // Strip any null bytes (can cause issues downstream)
  cleaned = cleaned.replace(/\0/g, '');

  return cleaned;
}

// --- Preflight handler ---
export async function OPTIONS(req) {
  const origin = req.headers.get('origin');
  return new Response(null, {
    status: 204,
    headers: corsHeaders(origin),
  });
}

// --- Reject non-POST methods ---
export async function GET() {
  return Response.json(
    { error: 'Method not allowed. Use POST.' },
    { status: 405, headers: { Allow: 'POST, OPTIONS' } }
  );
}

// --- Main handler ---
export async function POST(req) {
  const origin = req.headers.get('origin');
  const cors = corsHeaders(origin);

  // 1. CORS check — reject requests from disallowed origins
  //    (origin can be null for same-origin requests, which is fine)
  if (origin && !isAllowedOrigin(origin)) {
    return Response.json(
      { error: 'Origin not allowed.' },
      { status: 403, headers: cors }
    );
  }

  // 2. Content-Type validation
  const contentType = req.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) {
    return Response.json(
      { error: 'Content-Type must be application/json.' },
      { status: 415, headers: cors }
    );
  }

  // 3. Check API key is configured
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error('GEMINI_API_KEY not set in environment.');
    return Response.json(
      { error: 'AI assistant is not configured.' },
      { status: 503, headers: cors }
    );
  }

  // 4. Rate limiting
  const ip = getClientIP(req);
  const limit = checkRateLimit(ip);
  if (!limit.ok) {
    return Response.json(
      { error: `Rate limit reached (${RATE_LIMIT}/day). Resets in ~${limit.resetIn} minutes.` },
      {
        status: 429,
        headers: {
          ...cors,
          'Retry-After': String(limit.resetIn * 60),
          'X-RateLimit-Limit': String(RATE_LIMIT),
          'X-RateLimit-Remaining': '0',
        },
      }
    );
  }

  // 5. Parse and validate request body
  let body;
  try {
    body = await req.json();
  } catch {
    return Response.json(
      { error: 'Invalid JSON in request body.' },
      { status: 400, headers: cors }
    );
  }

  const prompt = sanitizePrompt(body?.prompt);
  if (!prompt) {
    return Response.json(
      { error: 'Missing or empty "prompt" field.' },
      { status: 400, headers: cors }
    );
  }

  // 6. Call Gemini
  try {
    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`;

    const geminiResp = await fetch(geminiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: {
          maxOutputTokens: 1024,
          temperature: 0.7,
        },
        safetySettings: [
          { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_ONLY_HIGH' },
          { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_ONLY_HIGH' },
          { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_ONLY_HIGH' },
          { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_ONLY_HIGH' },
        ],
      }),
    });

    const data = await geminiResp.json();

    if (data.error) {
      // Log for your Vercel dashboard, but don't leak details to client
      console.error('Gemini API error:', JSON.stringify(data.error));
      return Response.json(
        { error: 'AI service returned an error. Please try again.' },
        { status: 502, headers: cors }
      );
    }

    const reply =
      data.candidates?.[0]?.content?.parts?.[0]?.text || 'No response generated.';

    return Response.json(
      { reply },
      {
        headers: {
          ...cors,
          'X-RateLimit-Limit': String(RATE_LIMIT),
          'X-RateLimit-Remaining': String(limit.remaining),
        },
      }
    );
  } catch (e) {
    console.error('Gemini fetch error:', e.message);
    return Response.json(
      { error: 'Failed to reach AI service. Please try again.' },
      { status: 502, headers: cors }
    );
  }
}
