// Health check — for uptime monitoring.
//
// force-dynamic is load-bearing. Without it Next prerenders this route at build
// time and serves a frozen snapshot: the deployed endpoint was returning a
// timestamp from the June build in the middle of August, and reporting
// gemini_configured from build-time env rather than runtime env. A health check
// that answers from a cache is worse than no health check, because it answers
// "ok" while the thing it monitors is down.
export const dynamic = 'force-dynamic';

import { freshness } from '../../../lib/moat.js';

export async function GET() {
  const out = {
    status: 'ok',
    timestamp: new Date().toISOString(),
    gemini_configured: !!process.env.GEMINI_API_KEY,
  };

  // The assistant is only as live as the data behind it, so the check that
  // matters is whether the moat is reachable and current — not whether this
  // process is running.
  try {
    const f = await freshness();
    const ageHours = (Date.now() - new Date(f.lastUpdate).getTime()) / 3.6e6;
    out.moat = {
      reachable: true,
      lastUpdate: f.lastUpdate,
      ageHours: Number(ageHours.toFixed(1)),
      stale: ageHours > 36,
      fetchFailures: f.fetchFailures,
    };
    if (out.moat.stale) out.status = 'degraded';
  } catch (e) {
    out.moat = { reachable: false, error: e.message };
    out.status = 'degraded';
  }

  return Response.json(out, {
    status: out.status === 'ok' ? 200 : 503,
    headers: { 'Cache-Control': 'no-store' },
  });
}
