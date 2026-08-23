// Sourced player values — the trade calculator's numbers, and where they came from.
//
// This exists because the values cannot be fetched from the browser: The
// Signal's data is served from another origin and this app's own CSP allows
// connect-src to itself and Sleeper only. Reading it server-side is also what
// lets the answer be cached once for everybody rather than re-fetched per tab.
export const dynamic = 'force-dynamic';

import { valueTable } from '../../../lib/values.js';

export async function GET() {
  try {
    const table = await valueTable();

    // THE SELF-CHECK TRAVELS WITH THE DATA. `reproducesOverall` is this app's
    // derivation compared against the 24 rows The Signal publishes for the same
    // method. If it ever goes false the numbers here have stopped being the
    // site's and started being ours, and the page says so rather than pricing a
    // trade off an unexplained variant.
    return Response.json(table, {
      headers: {
        // Ranks move rarely and the file behind them is rebuilt daily; a ten
        // minute cache is the same TTL the moat reader uses.
        'Cache-Control': 'public, max-age=0, s-maxage=600, stale-while-revalidate=3600',
      },
    });
  } catch (e) {
    // No values is a state the page knows how to render. A zero is not.
    return Response.json(
      { error: 'values unavailable', detail: e.message, players: {} },
      { status: 503, headers: { 'Cache-Control': 'no-store' } }
    );
  }
}
