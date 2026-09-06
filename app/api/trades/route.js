// Trade finder — deals nobody has proposed yet.
//
// Server-side because it needs The Signal's published values, which the browser
// cannot fetch (another origin, and this app's CSP allows connect-src to itself
// and Sleeper only) — the same reason /api/values exists. The search itself is
// ~10k lineup evaluations and belongs off the phone.
export const dynamic = 'force-dynamic';

import { valueTable } from '../../../lib/values.js';
import { findTrades } from '../../../lib/trades.js';

const ID = /^[0-9]{6,25}$/;
const API = 'https://api.sleeper.app/v1';

async function j(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url.replace(API, '')} → HTTP ${r.status}`);
  return r.json();
}

export async function GET(request) {
  const url = new URL(request.url);
  const leagueId = url.searchParams.get('league');
  const forParam = url.searchParams.get('roster');
  if (!leagueId || !ID.test(leagueId)) {
    return Response.json({ error: 'a numeric Sleeper league id is required' },
      { status: 400, headers: { 'Cache-Control': 'no-store' } });
  }
  const forRoster = forParam && /^[0-9]{1,3}$/.test(forParam) ? Number(forParam) : null;

  try {
    const [league, rosters, users, vt] = await Promise.all([
      j(`${API}/league/${leagueId}`),
      j(`${API}/league/${leagueId}/rosters`),
      j(`${API}/league/${leagueId}/users`),
      valueTable(),
    ]);
    const nameOf = new Map(users.map(u => [u.user_id,
      (u.metadata && u.metadata.team_name) || u.display_name || 'Unknown']));
    const teams = rosters.map(r => ({
      rosterId: r.roster_id,
      name: nameOf.get(r.owner_id) || `Roster ${r.roster_id}`,
      players: r.players || [],
    }));

    const trades = findTrades(teams, vt.players, league.roster_positions, {},
      { forRoster, limit: 24, perPair: 2 });

    const pricedOn = (t) => t.players.filter(id => vt.players[id] && vt.players[id].vorp != null).length;

    return Response.json({
      season: league.season,
      teams: teams.map(t => ({ rosterId: t.rosterId, name: t.name, priced: pricedOn(t), rostered: t.players.length })),
      forRoster,
      // THE COVERAGE TRAVELS WITH THE ANSWER. 88 of the pool carry a published
      // value and the rest are named, never estimated — a reader looking at an
      // empty result deserves to know whether that means "no trade" or "no
      // numbers".
      coverage: vt.coverage,
      unrankedCeiling: vt.unrankedCeiling,
      trades,
    }, { headers: { 'Cache-Control': 'public, max-age=0, s-maxage=900, stale-while-revalidate=3600' } });
  } catch (e) {
    return Response.json({ error: 'trade finder unavailable', detail: e.message },
      { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }
}
