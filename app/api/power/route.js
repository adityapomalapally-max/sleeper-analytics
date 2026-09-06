// Power rankings and strength of schedule.
//
// Server-side for the same reason as /api/playoffs and /api/values: the maths
// lives in lib/, the page's CSP allows connect-src to itself and Sleeper only,
// and computing it once per league per cache window beats once per open tab.
export const dynamic = 'force-dynamic';

import { leagueState } from '../../../lib/league-state.js';
import { powerRankings } from '../../../lib/power.js';

const ID = /^[0-9]{6,25}$/;

export async function GET(request) {
  const leagueId = new URL(request.url).searchParams.get('league');
  if (!leagueId || !ID.test(leagueId)) {
    return Response.json({ error: 'a numeric Sleeper league id is required' },
      { status: 400, headers: { 'Cache-Control': 'no-store' } });
  }
  try {
    const state = await leagueState(leagueId);
    const rows = powerRankings(state);
    return Response.json({
      season: state.season,
      weeksPlayed: state.weeksPlayed,
      weeksLeft: state.remaining.length,
      leagueMean: Math.round(state.leagueMean * 10) / 10,
      reliable: rows.meta.reliable,
      teams: rows.map(r => ({
        ...r,
        allPlayPct: Math.round(r.allPlayPct * 1000) / 1000,
        luck: Math.round(r.luck * 1000) / 1000,
        expectedScore: Math.round(r.expectedScore * 10) / 10,
        allPlay: { ...r.allPlay, pct: Math.round(r.allPlay.pct * 1000) / 1000 },
        sosFaced: r.sosFaced == null ? null : Math.round(r.sosFaced * 10) / 10,
        sosLeft: r.sosLeft == null ? null : Math.round(r.sosLeft * 10) / 10,
        sosFacedDelta: r.sosFacedDelta == null ? null : Math.round(r.sosFacedDelta * 10) / 10,
        sosLeftDelta: r.sosLeftDelta == null ? null : Math.round(r.sosLeftDelta * 10) / 10,
      })),
    }, { headers: { 'Cache-Control': 'public, max-age=0, s-maxage=900, stale-while-revalidate=3600' } });
  } catch (e) {
    return Response.json({ error: 'power rankings unavailable', detail: e.message },
      { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }
}
