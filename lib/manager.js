// ============================================================
// manager.js — the manager, separated from the roster
// ============================================================
//
// ffwrapped's analytics guide names this and never defines it: "manager
// performance vs. roster quality — distinguishing decision-making ability from
// draft luck". It is the most interesting thing on their site and the one thing
// they do not publish.
//
// Sleeper makes it computable, because every week carries starters AND bench:
//
//   optimal      the best legal lineup available — what the ROSTER was worth
//   actual       what was started
//   efficiency   actual / optimal
//   added        started points from players neither drafted NOR kept
//
// AND THE OBVIOUS ONE IS THE WRONG ONE. Efficiency looks exactly like a manager
// rating and correlates 0.450 with winning. It is not a skill: split-half
// correlation over four seasons is -0.036. A manager efficient in the first half
// of a season is no more likely to be efficient in the second. It tracks winning
// because looking efficient and winning are the same weeks — your best players
// boom, so you win AND your lineup looks optimal in hindsight.
//
// AND THE FIRST ANSWER WAS WRONG TOO, which is worth keeping in the file. The
// first version counted "points started from players you did not draft" and
// found it persisted at 0.912 — a skill, apparently. This is a KEEPER league
// (max_keepers 6), and a kept player never appears in the draft picks at all,
// so that number was mostly measuring keepers. A kept player is the opposite of
// an acquisition: it is the most deliberate form of standing still.
//
// Separating the three sources changes the conclusion completely. Per week, of
// the points actually started:
//
//     drafted this year   42.0
//     kept from last year 55.7
//     added in-season     27.3
//
//     candidate            predicts wins   persists
//     added in-season          0.021          0.895
//     kept from last year      0.470          0.867
//     lineup efficiency        0.450         -0.036
//
// SO WIRE ACTIVITY IS REAL AND DOES NOT WIN GAMES. Points started from players
// a manager went and got in-season persist at 0.895 across the halves of a
// season — one of the most stable things in the league, and a genuine
// description of a person. It correlates 0.021 with winning, and -0.034 out of
// sample. Some managers work the wire relentlessly, every year, and it does not
// show up in their record.
//
// That is the honest profile: this is WHO YOU ARE, and it is not WHY YOU WIN.
// The number that predicts winning is what you kept — which is last year's
// roster, not this year's management.
//
// Requires the previous season's rosters, so it is only computed where the
// league chain has one (30 of 40 team-seasons; 2022 has no predecessor here).
//
// Re-derive with scripts/calibrate-manager.js; the claims are scored
// continuously by scripts/score-claims.js.

const FLEX = { FLEX: ['RB','WR','TE'], SUPER_FLEX: ['QB','RB','WR','TE'], REC_FLEX: ['WR','TE'], WRRB_FLEX: ['WR','RB'] };

/** The best legal lineup from everyone rostered that week. */
function optimalLineup(entry, slots, positionOf) {
  const pts = entry.players_points || {};
  const pool = (entry.players || [])
    .map(id => ({ id, pts: pts[id] || 0, pos: positionOf(id) }))
    .filter(p => p.pos);
  const byPos = {};
  for (const p of pool) (byPos[p.pos] ||= []).push(p);
  for (const a of Object.values(byPos)) a.sort((x, y) => y.pts - x.pts);

  const used = new Set();
  let total = 0;
  const starters = [];
  const take = (positions) => {
    let best = null;
    for (const pos of positions) {
      for (const p of (byPos[pos] || [])) { if (used.has(p.id)) continue; if (!best || p.pts > best.pts) best = p; break; }
    }
    if (!best) return;
    used.add(best.id); total += best.pts; starters.push(best);
  };
  for (const s of slots) if (!FLEX[s]) take([s]);
  for (const s of slots) if (FLEX[s]) take(FLEX[s]);
  return { total, starters };
}

/**
 * @param weeks      [[matchup rows]] for the regular season, in order
 * @param teams      [{ rosterId, name, avatar }]
 * @param slots      roster_positions
 * @param drafted    Map rosterId -> Set of drafted player ids
 * @param positionOf id -> position
 */
function managerProfiles({ weeks, teams, slots, drafted, keptBy, positionOf }) {
  const starting = slots.filter(s => s !== 'BN' && s !== 'IR' && s !== 'TAXI');
  const acc = new Map(teams.map(t => [t.rosterId, {
    ...t, actual: 0, optimal: 0, added: 0, kept: 0, drafted: 0, weeks: 0,
    worstCall: null,   // the single most expensive bench decision of the season
  }]));

  for (const rows of weeks) {
    for (const m of rows) {
      const t = acc.get(m.roster_id);
      if (!t) continue;
      const actual = m.points || 0;
      if (actual <= 0) continue;
      const { total: optimal } = optimalLineup(m, starting, positionOf);
      // THREE SOURCES, NOT TWO. Collapsing kept into added is what produced
      // the wrong answer the first time.
      const mine = drafted.get(m.roster_id) || new Set();
      const kept = (keptBy && keptBy.get(m.roster_id)) || new Set();
      const pp = m.players_points || {};
      let added = 0, keptPts = 0, draftedPts = 0;
      for (const id of (m.starters || [])) {
        if (!id) continue;
        const v = pp[id] || 0;
        if (mine.has(id)) draftedPts += v;
        else if (kept.has(id)) keptPts += v;
        else added += v;
      }

      t.actual += actual; t.optimal += optimal; t.weeks++;
      t.added += added; t.kept += keptPts; t.drafted += draftedPts;
      const left = optimal - actual;
      if (!t.worstCall || left > t.worstCall.left) t.worstCall = { week: t.weeks, left };
    }
  }

  const rows = [...acc.values()].map(t => ({
    rosterId: t.rosterId, name: t.name, avatar: t.avatar,
    weeks: t.weeks,
    // THE HEADLINE, because it is the one that persists — and it is presented
    // as an identity rather than a rating, because it does not predict winning.
    addedPerWeek: t.weeks ? t.added / t.weeks : 0,
    addedShare: t.actual ? t.added / t.actual : 0,
    keptPerWeek: t.weeks ? t.kept / t.weeks : 0,
    draftedPerWeek: t.weeks ? t.drafted / t.weeks : 0,
    rosterQuality: t.weeks ? t.optimal / t.weeks : 0,
    efficiency: t.optimal ? t.actual / t.optimal : 0,
    pointsLeftPerWeek: t.weeks ? (t.optimal - t.actual) / t.weeks : 0,
    worstCall: t.worstCall,
  })).sort((a, b) => b.addedPerWeek - a.addedPerWeek);

  // An identity, from the two numbers that survived, relative to this league.
  const mean = (f) => rows.reduce((s, r) => s + f(r), 0) / (rows.length || 1);
  const mAdd = mean(r => r.addedPerWeek), mKept = mean(r => r.keptPerWeek);
  for (const r of rows) {
    const a = r.addedPerWeek >= mAdd, k = r.keptPerWeek >= mKept;
    // Two axes, both measured: how much you work the wire, and how much of your
    // team you inherited. Neither is a compliment or an insult — the wire axis
    // does not predict winning at all.
    r.identity = a && k ? 'Restless — a strong core, and still always on the wire'
               : a && !k ? 'Streamer — most of this team was found, not kept'
               : !a && k ? 'Standpat — inherited a roster and left it alone'
               : 'Quiet — little kept, little added';
  }
  return rows;
}

module.exports = { managerProfiles, optimalLineup };
