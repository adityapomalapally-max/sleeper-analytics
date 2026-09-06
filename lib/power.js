// ============================================================
// power.js — power rankings, and strength of schedule
// ============================================================
//
// WHAT THIS REPLACES:
//
//     power = winPct*40 + (avg/maxAvg)*35 + (consistency/maxC)*15 + (recent3/maxAvg)*10
//
// and the tab printed those weights to the reader as if they meant something:
// "Record (40%) + Avg Scoring (35%) + Consistency (15%) + Recent Form (10%)".
// Four numbers, no source — the same shape as computeKTCValue, which this
// codebase already had to remove once.
//
// A POWER RANKING IS A FORWARD-LOOKING CLAIM, so scripts/calibrate-power.js
// measured every candidate ingredient on one question: computed from weeks
// 1..k, how well does it predict a team's win rate over the REST of the regular
// season? 440 team-splits across four completed seasons.
//
// TWO OF THE FOUR SHIPPED INGREDIENTS WERE WORTH NOTHING, and they are gone:
//
//   consistency  r = -0.016 on its own; dropping it from the full model moves
//                RMSE by 0.0001. It was 15% of the score. Scoring the same
//                every week does not make a team good, it makes them legible.
//   recent3      r = 0.211 alone, but it fits NEGATIVE beside a shrunk scoring
//                average — once you know how good a team is, "hot" is the part
//                of the last three weeks that was noise. It was 10% of the score.
//
// WHAT THE SCORE IS NOW: ALL-PLAY, and nothing else. A team's record against
// every other team every week — the standings with the schedule's luck taken
// out. Losing 130-140 and winning 90-80 are the same line in the standings and
// opposite weeks here.
//
// A FITTED BLEND WAS TRIED AND DECLINED, which is the part worth not
// rediscovering. Schedule-adjusted scoring plus all-play beat everything in
// sample (r = 0.367 against 0.256 for the old formula) and survived
// leave-one-season-out at 0.279. Then the same thing broken out per held-out
// season:
//
//     season   allPlay only   adjMean+allPlay   40/35/15/10
//     2025        0.615            0.457           0.524
//     2024        0.360            0.432           0.340
//     2023        0.302            0.381           0.250
//     2022       -0.244           -0.183          -0.257
//
// Each wins two of four, the spread BETWEEN seasons (0.615 to -0.244) is several
// times the spread between models, and 2022 is negative for every one of them —
// a season in which whatever looked good at week k did worse afterwards. With
// four seasons of one ten-team league that difference is noise, and a fitted
// blend would be four more unsourced constants wearing a lab coat.
//
// It also produced an ordering nobody would accept: at week 7 of 2025 it put a
// 4-3 team above the 7-0 team, and the 7-0 team went on to win 86% of what was
// left. All-play puts them first, which is both simpler and right.
//
// DO NOT REBUILD THE BLEND WITHOUT RE-RUNNING scripts/calibrate-power.js on more
// seasons. If the per-season table stops disagreeing with itself, it earns its
// place; until then this stays one honest number.
//
// STRENGTH OF SCHEDULE IS REPORTED, NOT BAKED IN. It is a fact about the
// fixtures — how far the opponents faced, and the ones still to come, sit from
// the league average, in points per week. Folding it into the score meant
// choosing a weight, and the measurement above says the data cannot choose one.
// Remaining schedule especially: it correlates -0.132 with future wins alone and
// fits POSITIVE beside the other terms, and a ranking must never tell somebody a
// harder run-in makes them better.

const { expectedScore, K } = require('./playoffs');

const mean = (a) => a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0;

function zscores(values) {
  const m = mean(values);
  const sd = Math.sqrt(mean(values.map(v => (v - m) ** 2))) || 1;
  return values.map(v => (v - m) / sd);
}

/**
 * All-play: this team's score against every other score, every week. The
 * standings with the schedule's luck taken out — losing 130-140 and winning
 * 90-80 are the same week in the standings and opposite weeks here.
 */
function allPlayRecord(teams) {
  const out = new Map();
  const weeks = Math.max(0, ...teams.map(t => (t.scores || []).length));
  for (const t of teams) {
    let w = 0, n = 0;
    for (let i = 0; i < weeks; i++) {
      const p = (t.scores || [])[i];
      if (!(p > 0)) continue;
      for (const o of teams) {
        if (o.rosterId === t.rosterId) continue;
        const q = (o.scores || [])[i];
        if (!(q > 0)) continue;
        n++;
        if (p > q) w++; else if (p === q) w += 0.5;
      }
    }
    out.set(t.rosterId, { wins: w, games: n, pct: n ? w / n : 0.5 });
  }
  return out;
}

/**
 * Strength of schedule, both directions, in points per week — the average
 * SHRUNK strength of the opponents a team has faced and has left. Shrunk
 * rather than raw so a team is not credited for beating someone who happened
 * to have two hot weeks in a four-week sample.
 */
function strengthOfSchedule(teams, remaining, playedPairs, leagueMean) {
  const strength = new Map(teams.map(t => [t.rosterId, expectedScore(t.scores || [], leagueMean)]));
  const faced = new Map(teams.map(t => [t.rosterId, []]));
  const left = new Map(teams.map(t => [t.rosterId, []]));

  for (const wk of playedPairs || []) {
    for (const [a, b] of wk.pairs) {
      if (faced.has(a)) faced.get(a).push(strength.get(b));
      if (faced.has(b)) faced.get(b).push(strength.get(a));
    }
  }
  for (const wk of remaining || []) {
    for (const [a, b] of wk.pairs) {
      if (left.has(a)) left.get(a).push(strength.get(b));
      if (left.has(b)) left.get(b).push(strength.get(a));
    }
  }
  const out = new Map();
  for (const t of teams) {
    out.set(t.rosterId, {
      strength: strength.get(t.rosterId),
      faced: faced.get(t.rosterId).length ? mean(faced.get(t.rosterId)) : null,
      left: left.get(t.rosterId).length ? mean(left.get(t.rosterId)) : null,
    });
  }
  return out;
}

/**
 * @param state  as produced by lib/league-state.js
 * @returns rows sorted best first, each carrying the ingredients that made it
 *          so the page can show its working
 */
function powerRankings(state) {
  const teams = state.teams;
  const ap = allPlayRecord(teams);
  const sos = strengthOfSchedule(teams, state.remaining, state.playedPairs, state.leagueMean);

  const ids = teams.map(t => t.rosterId);

  const rows = ids.map((id) => {
    const t = teams.find(x => x.rosterId === id);
    const s = sos.get(id);
    return {
      rosterId: id,
      name: t.name, avatar: t.avatar,
      record: `${t.wins}-${t.losses}${t.ties ? '-' + t.ties : ''}`,
      // THE SCORE. A rate, not an index — "you would have won 64% of all the
      // games played this season" is a sentence; "power score 87.3" is not.
      allPlayPct: ap.get(id).pct,
      allPlay: ap.get(id),
      expectedScore: s.strength,
      // The gap between what the standings say and what all-play says: the
      // schedule's luck, in win-rate terms. Positive means the fixtures have
      // flattered them.
      luck: (t.wins + t.losses + (t.ties || 0)) > 0
        ? (t.wins / (t.wins + t.losses + (t.ties || 0))) - ap.get(id).pct
        : 0,
      sosFaced: s.faced,
      sosLeft: s.left,
      // Points per week away from the league average — the number a reader
      // actually wants: "you have played the hard half".
      sosFacedDelta: s.faced == null ? null : s.faced - state.leagueMean,
      sosLeftDelta: s.left == null ? null : s.left - state.leagueMean,
    };
  }).sort((a, b) => (b.allPlayPct - a.allPlayPct) || (b.expectedScore - a.expectedScore));

  rows.meta = {
    weeksPlayed: state.weeksPlayed,
    leagueMean: state.leagueMean,
    // Same threshold and the same reason as the playoff odds: one week of
    // football is not a ranking, it is a scoreboard.
    reliable: state.weeksPlayed >= 2,
  };
  return rows;
}

module.exports = { powerRankings, allPlayRecord, strengthOfSchedule, zscores };
