// Manager profiles — the person, separated from the roster.
//
// Leads on what a manager ADDED in-season, because that is the only candidate
// that persists as a description of a person (r = 0.895 across halves) — and it
// is presented as an identity rather than a rating, because it correlates 0.021
// with winning. Lineup efficiency is included and explicitly disqualified
// (0.450 with winning, -0.036 persistence). See lib/manager.js and the live
// scorecard in data/claims-score.json.
export const dynamic = 'force-dynamic';

import { managerProfiles } from '../../../lib/manager.js';

const ID = /^[0-9]{6,25}$/;
const API = 'https://api.sleeper.app/v1';

async function j(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url.replace(API, '')} → HTTP ${r.status}`);
  return r.json();
}

export async function GET(request) {
  const leagueId = new URL(request.url).searchParams.get('league');
  if (!leagueId || !ID.test(leagueId)) {
    return Response.json({ error: 'a numeric Sleeper league id is required' },
      { status: 400, headers: { 'Cache-Control': 'no-store' } });
  }
  try {
    const league = await j(`${API}/league/${leagueId}`);
    const last = (league.settings.playoff_week_start || 15) - 1;
    const [rosters, users, players, drafts, ...weeks] = await Promise.all([
      j(`${API}/league/${leagueId}/rosters`),
      j(`${API}/league/${leagueId}/users`),
      j(`${API}/players/nfl`),
      j(`${API}/league/${leagueId}/drafts`).catch(() => []),
      ...Array.from({ length: last }, (_, i) => j(`${API}/league/${leagueId}/matchups/${i + 1}`)),
    ]);

    const played = weeks.filter(rows => rows.some(m => (m.points || 0) > 0));
    if (!played.length) {
      return Response.json({
        weeksPlayed: 0,
        note: 'Nothing has been played, so there is nothing to separate. A manager profile '
            + 'needs weeks: it is built from what was started against what could have been.',
        managers: [],
      }, { headers: { 'Cache-Control': 'public, max-age=0, s-maxage=900' } });
    }

    const picks = drafts.length ? await j(`${API}/draft/${drafts[0].draft_id}/picks`).catch(() => []) : [];

    // KEPT PLAYERS ARE INVISIBLE IN THE DRAFT. This is a keeper league and a
    // kept player simply does not appear in the picks, so without last
    // season's rosters every keeper counts as something the manager went and
    // got — which is how the first version of this concluded that acquisition
    // was a skill when it was mostly measuring continuity.
    let keptBy = new Map();
    if (league.previous_league_id) {
      const [prevRosters] = await Promise.all([
        j(`${API}/league/${league.previous_league_id}/rosters`).catch(() => []),
      ]);
      // Matched on OWNER, not roster_id, which is not guaranteed stable across
      // seasons.
      const prevByOwner = new Map(prevRosters.map(r => [r.owner_id, new Set(r.players || [])]));
      keptBy = new Map(rosters.map(r => [r.roster_id, prevByOwner.get(r.owner_id) || new Set()]));
    }
    const drafted = new Map();
    for (const pk of picks) {
      if (!drafted.has(pk.roster_id)) drafted.set(pk.roster_id, new Set());
      drafted.get(pk.roster_id).add(pk.player_id);
    }
    const nameOf = new Map(users.map(u => [u.user_id, (u.metadata && u.metadata.team_name) || u.display_name || 'Unknown']));
    const teams = rosters.map(r => ({
      rosterId: r.roster_id,
      name: nameOf.get(r.owner_id) || `Roster ${r.roster_id}`,
      avatar: (users.find(u => u.user_id === r.owner_id) || {}).avatar || null,
    }));

    const rows = managerProfiles({
      weeks: played, teams, slots: league.roster_positions, drafted, keptBy,
      positionOf: (id) => (players[id] || {}).position || null,
    });

    return Response.json({
      season: league.season,
      weeksPlayed: played.length,
      // THE EVIDENCE TRAVELS WITH THE NUMBERS, so the page can say which of
      // these is a skill and which is a description without anyone looking it up.
      // Measured over 30 team-seasons that have a previous roster to compare
      // against; 2022 has no predecessor in this chain.
      keepersKnown: !!league.previous_league_id,
      evidence: {
        added: { predicts: 0.021, persists: 0.895, verdict: 'who you are, not why you win' },
        kept: { predicts: 0.470, persists: 0.867, verdict: 'last year\'s roster, not this year\'s management' },
        efficiency: { predicts: 0.450, persists: -0.036, verdict: 'not a skill' },
        teamSeasons: 30,
      },
      managers: rows.map(r => ({
        ...r,
        addedPerWeek: Math.round(r.addedPerWeek * 10) / 10,
        addedShare: Math.round(r.addedShare * 1000) / 1000,
        keptPerWeek: Math.round(r.keptPerWeek * 10) / 10,
        draftedPerWeek: Math.round(r.draftedPerWeek * 10) / 10,
        rosterQuality: Math.round(r.rosterQuality * 10) / 10,
        efficiency: Math.round(r.efficiency * 1000) / 1000,
        pointsLeftPerWeek: Math.round(r.pointsLeftPerWeek * 10) / 10,
      })),
    }, { headers: { 'Cache-Control': 'public, max-age=0, s-maxage=900, stale-while-revalidate=3600' } });
  } catch (e) {
    return Response.json({ error: 'manager profiles unavailable', detail: e.message },
      { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }
}
