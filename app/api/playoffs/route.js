// Playoff and championship odds for a Sleeper league.
//
// Server-side because the simulation is ten thousand seasons of arithmetic and
// because the page's own CSP allows connect-src to itself and Sleeper only —
// the same reason /api/values exists. Running it here also means the answer is
// computed once per league per cache window rather than once per open tab.
export const dynamic = 'force-dynamic';

import { leagueState } from '../../../lib/league-state.js';
import { simulate } from '../../../lib/playoffs.js';

const ID = /^[0-9]{6,25}$/;   // a Sleeper league id, and nothing else

export async function GET(request) {
  const leagueId = new URL(request.url).searchParams.get('league');
  if (!leagueId || !ID.test(leagueId)) {
    return Response.json({ error: 'a numeric Sleeper league id is required' },
      { status: 400, headers: { 'Cache-Control': 'no-store' } });
  }

  try {
    const state = await leagueState(leagueId);
    const table = simulate(state, 10000);
    const byId = new Map(state.teams.map(t => [t.rosterId, t]));

    return Response.json({
      season: state.season,
      leagueName: state.name,
      playoffTeams: state.playoffTeams,
      weeksPlayed: state.weeksPlayed,
      weeksLeft: state.remaining.length,
      leagueMean: Math.round(state.leagueMean * 10) / 10,
      leagueMeanFrom: state.meanFrom,
      // THE CAVEAT SHIPS WITH THE NUMBERS. A forecast quoted without the note
      // that produced it is a forecast quoted wrongly, and week 1 is measurably
      // worse than the base rate — see lib/playoffs.js.
      reliable: table.meta.reliable,
      note: table.meta.note,
      teams: table.map(t => {
        const base = byId.get(t.rosterId);
        return {
          rosterId: t.rosterId,
          name: base.name, avatar: base.avatar,
          record: `${base.wins}-${base.losses}${base.ties ? '-' + base.ties : ''}`,
          pf: Math.round(base.pf * 10) / 10,
          playoffOdds: t.playoffOdds,
          titleOdds: t.titleOdds,
          projectedWins: Math.round(t.projectedWins * 10) / 10,
          expectedScore: Math.round(t.expectedScore * 10) / 10,
          seedOdds: t.seedOdds.map(v => Math.round(v * 1000) / 1000),
        };
      }),
    }, {
      headers: {
        // Nothing here changes until a game is played.
        'Cache-Control': 'public, max-age=0, s-maxage=900, stale-while-revalidate=3600',
      },
    });
  } catch (e) {
    // No odds is a state the page can render. A zero is not.
    return Response.json({ error: 'odds unavailable', detail: e.message },
      { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }
}
