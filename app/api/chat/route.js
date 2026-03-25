// Rate limiter — in-memory store (resets on deploy, good enough for free tier)
const rateMap = new Map();
const RATE_LIMIT = 30; // requests per day per IP
const RATE_WINDOW = 24 * 60 * 60 * 1000; // 24 hours

function getRateKey(req) {
  const forwarded = req.headers.get('x-forwarded-for');
  const ip = forwarded ? forwarded.split(',')[0].trim() : 'unknown';
  return ip;
}

function checkRateLimit(key) {
  const now = Date.now();
  const entry = rateMap.get(key);
  
  if (!entry || now - entry.start > RATE_WINDOW) {
    rateMap.set(key, { start: now, count: 1 });
    return { ok: true, remaining: RATE_LIMIT - 1 };
  }
  
  if (entry.count >= RATE_LIMIT) {
    const resetIn = Math.ceil((entry.start + RATE_WINDOW - now) / 60000);
    return { ok: false, remaining: 0, resetIn };
  }
  
  entry.count++;
  return { ok: true, remaining: RATE_LIMIT - entry.count };
}

// Clean up old entries every 10 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of rateMap) {
    if (now - entry.start > RATE_WINDOW) rateMap.delete(key);
  }
}, 10 * 60 * 1000);

export async function POST(req) {
  // Check API key is configured
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return Response.json(
      { error: 'AI assistant is not configured. Server missing API key.' },
      { status: 503 }
    );
  }

  // Rate limiting
  const ip = getRateKey(req);
  const limit = checkRateLimit(ip);
  if (!limit.ok) {
    return Response.json(
      { error: `Rate limit reached (${RATE_LIMIT}/day). Resets in ${limit.resetIn} minutes.` },
      { status: 429, headers: { 'X-RateLimit-Remaining': '0' } }
    );
  }

  // Parse request
  let body;
  try {
    body = await req.json();
  } catch (e) {
    return Response.json({ error: 'Invalid request body.' }, { status: 400 });
  }

  const { prompt } = body;
  if (!prompt || typeof prompt !== 'string') {
    return Response.json({ error: 'Missing prompt.' }, { status: 400 });
  }

  // Truncate overly long prompts (protect against abuse)
  const maxLen = 12000;
  const truncated = prompt.length > maxLen ? prompt.slice(0, maxLen) + '\n\n[Context truncated]' : prompt;

  // Call Gemini
  try {
    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`;
    
    const geminiResp = await fetch(geminiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: truncated }] }],
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
      console.error('Gemini API error:', data.error);
      return Response.json(
        { error: 'AI service error. Please try again.' },
        { status: 502 }
      );
    }

    const reply = data.candidates?.[0]?.content?.parts?.[0]?.text || 'No response generated.';

    return Response.json(
      { reply },
      { headers: { 'X-RateLimit-Remaining': String(limit.remaining) } }
    );
  } catch (e) {
    console.error('Gemini fetch error:', e);
    return Response.json(
      { error: 'Failed to reach AI service. Please try again.' },
      { status: 502 }
    );
  }
}
