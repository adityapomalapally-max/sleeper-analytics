// Draft grades.
//
// Two different questions depending on whether the season has been played, and
// the page is told which one it is looking at:
//
//   after games   what did the draft actually RETURN, against what a pick at
//                 that slot returns on average across every completed season in
//                 this league's history
//   before games  did the picks beat the MARKET — taken at 40, went at 25 on
//                 average. A different claim, labelled as one.
//
// The grade does not predict winning (r = -0.045 over 40 team-seasons; see
// lib/draft.js) and that number travels with the response so the page can say
// so rather than let an A- read as a forecast.
export const dynamic = 'force-dynamic';

import { valueTable } from '../../../lib/values.js';
import { expectedCurve, gradeDraft, gradeAgainstMarket } from '../../../lib/draft.js';

const ID = /^[0-9]{6,25}$/;
const API = 'https://api.sleeper.app/v1';

async function j(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url.replace(API, '')} → HTTP ${r.status}`);
  return r.json();
}

async function seasonProduction(league) {
  const last = (league.settings.playoff_week_start || 15) - 1;
  const weeks = await Promise.all(
    Array.from({ length: last }, (_, i) => j(`${API}/league/${league.league_id}/matchups/${i + 1}`)));
  const points = {};
  let played = 0;
  for (const rows of weeks) {
    if (rows.some(m => (m.points || 0) > 0)) played++;
    for (const m of rows) {
      for (const [pid, pts] of Object.entries(m.players_points || {})) {
        points[pid] = (points[pid] || 0) + (pts || 0);
      }
    }
  }
  return { points, played };
}

async function picksOf(leagueId) {
  const drafts = await j(`${API}/league/${leagueId}/drafts`);
  if (!drafts.length) return [];
  return j(`${API}/draft/${drafts[0].draft_id}/picks`);
}

export async function GET(request) {
  const leagueId = new URL(request.url).searchParams.get('league');
  if (!leagueId || !ID.test(leagueId)) {
    return Response.json({ error: 'a numeric Sleeper league id is required' },
      { status: 400, headers: { 'Cache-Control': 'no-store' } });
  }

  try {
    const league = await j(`${API}/league/${leagueId}`);
    const [rosters, users, picks, prod] = await Promise.all([
      j(`${API}/league/${leagueId}/rosters`),
      j(`${API}/league/${leagueId}/users`),
      picksOf(leagueId),
      seasonProduction(league),
    ]);
    const nameOf = new Map(users.map(u => [u.user_id,
      (u.metadata && u.metadata.team_name) || u.display_name || 'Unknown']));
    const teams = rosters.map(r => ({
      rosterId: r.roster_id, name: nameOf.get(r.owner_id) || `Roster ${r.roster_id}`,
    }));

    if (!picks.length) {
      return Response.json({ error: 'this league has no draft on record' },
        { status: 404, headers: { 'Cache-Control': 'no-store' } });
    }

    // ---- before a ball is kicked: grade against the market ---------------
    if (prod.played === 0) {
      const vt = await valueTable();
      const rows = gradeAgainstMarket(picks, vt.players, teams);
      return Response.json({
        mode: 'market', season: league.season, weeksPlayed: 0,
        note: 'Nothing has been played, so there is no production to grade. This is value against '
            + 'the draft market only: how far each pick fell past where it usually goes.',
        coverage: vt.coverage,
        teams: rows,
      }, { headers: { 'Cache-Control': 'public, max-age=0, s-maxage=900, stale-while-revalidate=3600' } });
    }

    // ---- after games: grade against what picks actually return -----------
    // The expectation curve pools every COMPLETED season in this league's
    // history. One draft is ten observations per pick number; four is forty.
    const picksBySeason = [picks];
    const pointsBySeason = [prod.points];
    let cursor = league.previous_league_id, guard = 0;
    while (cursor && guard++ < 8) {
      const prev = await j(`${API}/league/${cursor}`);
      if (prev.status === 'complete') {
        const [pp, ppr] = await Promise.all([picksOf(cursor), seasonProduction(prev)]);
        if (pp.length) { picksBySeason.push(pp); pointsBySeason.push(ppr.points); }
      }
      cursor = prev.previous_league_id;
    }

    const curve = expectedCurve(picksBySeason, pointsBySeason);
    const rows = gradeDraft(picks, prod.points, curve, teams);

    return Response.json({
      mode: 'production',
      season: league.season,
      weeksPlayed: prod.played,
      seasonsPooled: picksBySeason.length,
      // THE MEASUREMENT TRAVELS WITH THE GRADE.
      predictiveness: { r: -0.045, n: 40, bySeason: { 2025: -0.673, 2024: -0.129, 2023: 0.435, 2022: 0.281 } },
      leagueMeanGrade: Math.round(rows.leagueMeanGrade),
      curveSample: [1, 10, 20, 40, 60, 80, 100].filter(n => n <= curve.maxPick)
        .map(n => ({ pick: n, expected: Math.round(curve.at(n)) })),
      teams: rows.map(t => ({
        ...t,
        actual: Math.round(t.actual), expected: Math.round(t.expected), grade: Math.round(t.grade),
        relative: Math.round(t.relative),
        z: Math.round(t.z * 100) / 100,
        picks: t.picks.map(p => ({ ...p, points: Math.round(p.points), expected: Math.round(p.expected), surplus: Math.round(p.surplus) })),
        best: t.best && { ...t.best, points: Math.round(t.best.points), expected: Math.round(t.best.expected), surplus: Math.round(t.best.surplus) },
        worst: t.worst && { ...t.worst, points: Math.round(t.worst.points), expected: Math.round(t.worst.expected), surplus: Math.round(t.worst.surplus) },
      })),
    }, { headers: { 'Cache-Control': 'public, max-age=0, s-maxage=900, stale-while-revalidate=3600' } });
  } catch (e) {
    return Response.json({ error: 'draft grades unavailable', detail: e.message },
      { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }
}
