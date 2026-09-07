// ============================================================
// draft.js — grading a draft, and saying what the grade is worth
// ============================================================
//
// A draft grade is the easiest number on a fantasy site to fake: choose a few
// weights, sum something, print a letter. So this one is built out of two
// measured things and ships with the measurement that matters most.
//
// WHAT A PICK IS WORTH comes from the drafts themselves. Pooled over four
// completed seasons, the points a pick at slot N actually returned, smoothed and
// then forced to decrease — an expectation curve that says pick 70 is worth more
// than pick 50 is reporting a couple of late hits, not a fact about drafting.
// The monotone fit is pool-adjacent-violators, which assumes only the thing
// everybody already believes: later picks are not better.
//
// AND THE GRADE DOES NOT PREDICT WINNING. Measured in
// scripts/calibrate-draft.js over 40 team-seasons:
//
//     draft grade vs regular-season win rate:  r = -0.045
//     by season:  2025 -0.673   2024 -0.129   2023 +0.435   2022 +0.281
//
// Zero, with the sign flapping season to season. The team with the WORST draft
// on record (2025 roster 5, -655 points of value) went 93%. In a ten-team league
// with a deep waiver wire, the draft is one input among many and it washes out
// by November.
//
// That is not a reason to withhold the number — "how much production did I
// draft" is a fair question and a good story. It is a reason to print it as a
// DESCRIPTION rather than a verdict, and to put the correlation next to it, so
// nobody reads an A- as a forecast. A site that grades your draft and lets you
// believe it predicts your season is selling something it measured as worthless.
//
// PRODUCTION IS POINTS SCORED WHILE ROSTERED IN THIS LEAGUE, summed from the
// weekly rows. A player dropped in October and never picked up stops counting.
// That is a real limitation, it is stated on the page, and it is the only
// per-player total the league API actually contains.

const mean = (a) => a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0;

/**
 * Pool-adjacent-violators: the closest non-increasing sequence to the input.
 * Wherever the raw curve goes up, the offending run is replaced by its mean.
 */
function monotoneDecreasing(values) {
  const v = values.slice();
  const w = new Array(v.length).fill(1);
  let i = 0;
  while (i < v.length - 1) {
    if (v[i] >= v[i + 1]) { i++; continue; }
    // merge i and i+1 into their weighted mean, then walk back
    const total = v[i] * w[i] + v[i + 1] * w[i + 1];
    const weight = w[i] + w[i + 1];
    v.splice(i, 2, total / weight);
    w.splice(i, 2, weight);
    if (i > 0) i--;
  }
  // expand back out
  const out = [];
  for (let k = 0; k < v.length; k++) for (let n = 0; n < w[k]; n++) out.push(v[k]);
  return out;
}

/**
 * Expected return by overall pick number.
 * @param picksBySeason  [[{pick_no, player_id, is_keeper}], ...]
 * @param pointsBySeason [{playerId: points}, ...] aligned with the above
 */
function expectedCurve(picksBySeason, pointsBySeason, window = 6) {
  const byPick = {};
  picksBySeason.forEach((picks, i) => {
    for (const p of picks) {
      if (p.is_keeper) continue;
      (byPick[p.pick_no] ||= []).push(pointsBySeason[i][p.player_id] || 0);
    }
  });
  const maxPick = Math.max(0, ...Object.keys(byPick).map(Number));
  const raw = [];
  for (let n = 1; n <= maxPick; n++) {
    const vals = [];
    for (let k = n - window; k <= n + window; k++) if (byPick[k]) vals.push(...byPick[k]);
    raw.push(mean(vals));
  }
  const smoothed = monotoneDecreasing(raw);
  return {
    at: (n) => smoothed[Math.min(Math.max(1, n), smoothed.length) - 1] ?? 0,
    maxPick,
    curve: smoothed,
  };
}

/**
 * Grade one draft against that curve.
 *
 * @param picks    the season's picks
 * @param points   {playerId: realized points}
 * @param expected an expectedCurve()
 * @param teams    [{rosterId, name}]
 */
function gradeDraft(picks, points, expected, teams) {
  const byRoster = new Map(teams.map(t => [t.rosterId, {
    rosterId: t.rosterId, name: t.name,
    actual: 0, expected: 0, picks: [],
  }]));

  for (const p of picks) {
    if (p.is_keeper) continue;
    const row = byRoster.get(p.roster_id);
    if (!row) continue;
    const got = points[p.player_id] || 0;
    const exp = expected.at(p.pick_no);
    const meta = p.metadata || {};
    row.actual += got;
    row.expected += exp;
    row.picks.push({
      pickNo: p.pick_no, round: p.round,
      name: [meta.first_name, meta.last_name].filter(Boolean).join(' ') || String(p.player_id),
      pos: meta.position || '',
      points: got, expected: exp, surplus: got - exp,
    });
  }

  const rows = [...byRoster.values()].map(r => ({
    ...r,
    grade: r.actual - r.expected,
    picks: r.picks.sort((a, b) => a.pickNo - b.pickNo),
    best: [...r.picks].sort((a, b) => b.surplus - a.surplus)[0] || null,
    worst: [...r.picks].sort((a, b) => a.surplus - b.surplus)[0] || null,
  })).sort((a, b) => b.grade - a.grade);

  // A LETTER, BECAUSE PEOPLE WANT ONE — and graded on the curve, within this
  // draft, since the absolute scale means nothing across leagues or seasons.
  const grades = rows.map(r => r.grade);
  const m = mean(grades);
  const sd = Math.sqrt(mean(grades.map(g => (g - m) ** 2))) || 1;
  const LETTERS = [[1.5, 'A+'], [1.0, 'A'], [0.5, 'B+'], [0.15, 'B'],
                   [-0.15, 'C+'], [-0.5, 'C'], [-1.0, 'D'], [-1.5, 'F'], [-Infinity, 'F']];
  for (const r of rows) {
    const z = (r.grade - m) / sd;
    r.z = z;
    r.letter = LETTERS.find(([cut]) => z >= cut)[1];
    // THE NUMBER TO SHOW A READER. `grade` is measured against a curve pooled
    // over every completed season, so it carries the whole season's scoring
    // environment in it — in 2025 every team in the league came out negative,
    // which says something true about the year and nothing about who drafted
    // well. `relative` takes that out: value against the other nine people in
    // the room, which is the draft they were actually in.
    r.relative = r.grade - m;
  }
  rows.leagueMeanGrade = m;
  return rows;
}

/**
 * Before a season is played there is no production to grade, so the only honest
 * question is whether a pick beat the market: taken at 40, went at 25 on
 * average, that is fifteen picks of value. It is a different claim from the
 * retrospective grade and is labelled as one.
 */
// The published ADP is measured in 12-TEAM drafts (lib/values.js FORMAT), and a
// pick number is not a portable unit: the same player goes at pick 60 of a
// twelve-team draft and pick 50 of a ten-team one, because a round is two picks
// shorter. Comparing raw pick numbers across the two made every manager in a
// ten-team league look like they reached, by about a sixth — measured, every
// team came out between -289 and -695. Rounds are the portable unit.
const ADP_FORMAT_TEAMS = 12;

function gradeAgainstMarket(picks, values, teams, numTeams = ADP_FORMAT_TEAMS) {
  const scale = numTeams / ADP_FORMAT_TEAMS;
  const byRoster = new Map(teams.map(t => [t.rosterId, {
    rosterId: t.rosterId, name: t.name, surplus: 0, graded: 0, skipped: 0, picks: [],
  }]));
  for (const p of picks) {
    if (p.is_keeper) continue;
    const row = byRoster.get(p.roster_id);
    if (!row) continue;
    const v = values[p.player_id];
    const meta = p.metadata || {};
    const name = [meta.first_name, meta.last_name].filter(Boolean).join(' ') || String(p.player_id);
    // No published ADP means no claim. Named, never estimated.
    if (!v || v.adp == null) { row.skipped++; continue; }
    // GETTING HIM LATER THAN THE MARKET IS THE VALUE, so it is pick minus ADP
    // and not the other way round. Inverted, this scored the biggest reaches in
    // the draft as the best picks — a player who normally goes at 140 taken at
    // 5 came out +135 — and one team's "value" summed to +695.
    const surplus = Math.round((p.pick_no - v.adp * scale) * 10) / 10;
    row.surplus += surplus;
    row.graded++;
    row.picks.push({ pickNo: p.pick_no, round: p.round, name, pos: v.pos || meta.position || '', adp: v.adp, surplus });
  }
  const rows = [...byRoster.values()].map(r => ({
    ...r,
    picks: r.picks.sort((a, b) => b.surplus - a.surplus),
    best: [...r.picks].sort((a, b) => b.surplus - a.surplus)[0] || null,
    worst: [...r.picks].sort((a, b) => a.surplus - b.surplus)[0] || null,
  })).sort((a, b) => b.surplus - a.surplus);

  // AND CENTRED ON THE ROOM, for the same reason the production grade is: the
  // absolute level carries how this league's board differs from the national
  // one, which is not a fact about any manager in it.
  const m = mean(rows.map(r => r.surplus));
  for (const r of rows) r.relative = Math.round((r.surplus - m) * 10) / 10;
  rows.leagueMeanSurplus = Math.round(m * 10) / 10;
  return rows;
}

module.exports = { expectedCurve, gradeDraft, gradeAgainstMarket, monotoneDecreasing };
