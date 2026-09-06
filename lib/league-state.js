// ============================================================
// league-state.js — the season so far, and the season still to come
// ============================================================
//
// THE PART THAT MAKES THE FORECAST REAL. Sleeper publishes the pairings for
// weeks nobody has played: /league/{id}/matchups/{week} answers for week 12 in
// September with matchup_id set and points 0.0. So the rest of the season can
// be simulated against the ACTUAL opponents each team has left, which is the
// difference between a forecast and a power ranking with a percent sign on it.
// A team sitting on 5-2 with the two best rosters left twice is not the same
// team as one on 5-2 who has played them both already, and only the schedule
// knows that.

const API = 'https://api.sleeper.app/v1';

async function j(url) {
  const r = await fetch(url, { headers: { 'User-Agent': 'sleeper-analytics' } });
  if (!r.ok) throw new Error(`${url.replace(API, '')} → HTTP ${r.status}`);
  return r.json();
}

// Two roster ids per matchup_id. A week with an odd roster out (a league mid
// re-shuffle) drops that entry rather than inventing an opponent for it.
function pairsOf(rows) {
  const by = {};
  for (const m of rows) if (m.matchup_id != null) (by[m.matchup_id] ||= []).push(m.roster_id);
  return Object.values(by).filter(p => p.length === 2);
}

/**
 * Everything the simulator needs, in one shape.
 * Weeks are fetched in parallel — fourteen sequential round trips is four
 * seconds of a reader looking at a spinner for no reason.
 */
async function leagueState(leagueId) {
  const league = await j(`${API}/league/${leagueId}`);
  const lastRegular = (league.settings.playoff_week_start || 15) - 1;
  const playoffTeams = league.settings.playoff_teams || 6;

  const [rosters, users, ...allWeeks] = await Promise.all([
    j(`${API}/league/${leagueId}/rosters`),
    j(`${API}/league/${leagueId}/users`),
    ...Array.from({ length: lastRegular }, (_, i) => j(`${API}/league/${leagueId}/matchups/${i + 1}`)),
  ]);

  const nameOf = new Map(users.map(u => [u.user_id,
    (u.metadata && u.metadata.team_name) || u.display_name || 'Unknown']));
  const avatarOf = new Map(users.map(u => [u.user_id, u.avatar || null]));

  const teams = rosters.map(r => ({
    rosterId: r.roster_id,
    name: nameOf.get(r.owner_id) || `Roster ${r.roster_id}`,
    avatar: avatarOf.get(r.owner_id) || null,
    wins: 0, losses: 0, ties: 0, pf: 0, scores: [],
  }));
  const byId = new Map(teams.map(t => [t.rosterId, t]));

  const remaining = [];
  let weeksPlayed = 0;

  allWeeks.forEach((rows, i) => {
    const pairs = pairsOf(rows);
    const pts = new Map(rows.map(m => [m.roster_id, m.points]));
    // A WEEK IS PLAYED WHEN SOMEBODY SCORED. Sleeper returns the fixture list
    // for the whole season from day one, all zeros, so "the endpoint answered"
    // is not the same question as "this has happened".
    const played = pairs.some(([a, b]) => (pts.get(a) || 0) > 0 || (pts.get(b) || 0) > 0);

    if (!played) { remaining.push({ week: i + 1, pairs }); return; }
    weeksPlayed++;
    for (const [a, b] of pairs) {
      const A = byId.get(a), B = byId.get(b);
      if (!A || !B) continue;
      const sa = pts.get(a) || 0, sb = pts.get(b) || 0;
      A.pf += sa; B.pf += sb;
      if (sa > 0) A.scores.push(sa);
      if (sb > 0) B.scores.push(sb);
      if (sa > sb) { A.wins++; B.losses++; }
      else if (sb > sa) { B.wins++; A.losses++; }
      else { A.ties++; B.ties++; A.wins += 0.5; B.wins += 0.5; }
    }
  });

  // The level the shrinkage pulls toward. With nothing played this season there
  // is no level to compute, so the previous season's is used and said so —
  // inventing one would put a made-up number underneath every percentage.
  const played = teams.flatMap(t => t.scores);
  let leagueMean = played.length ? played.reduce((s, x) => s + x, 0) / played.length : null;
  let meanFrom = 'this season';
  if (leagueMean == null && league.previous_league_id) {
    try {
      const prev = await leagueState(league.previous_league_id);
      leagueMean = prev.leagueMean; meanFrom = `${Number(league.season) - 1}`;
    } catch { /* fall through to the stated default */ }
  }
  if (leagueMean == null) { leagueMean = 110; meanFrom = 'a stated default, no history to read'; }

  return {
    leagueId, season: league.season, name: league.name,
    teams, remaining, playoffTeams, weeksPlayed, lastRegular,
    leagueMean, meanFrom,
  };
}

module.exports = { leagueState, pairsOf };
