// ============================================================
// playoffs.js — playoff and championship odds, and where they come from
// ============================================================
//
// This is the number ffwrapped puts behind its paywall, and it is computable
// from Sleeper's free API, because Sleeper publishes the remaining SCHEDULE:
// /league/{id}/matchups/{week} returns the pairings for a week nobody has
// played yet, with points 0.0. So the rest of the season does not have to be
// approximated as "eight more games" — it can be simulated against the actual
// opponents, which is most of the difference between a real forecast and a
// power ranking with a percent sign on it.
//
// TWO NUMBERS DECIDE EVERYTHING HERE, and they are the exact kind that killed
// `computeKTCValue`: ten hand-tuned constants with no source, on which every
// trade verdict rested. So neither is a guess. Both come from
// scripts/calibrate-playoffs.js, fitted over 520 team-splits across the four
// completed seasons of this league (2022-2025, 10 teams, weeks 1-14):
//
//   K = 6.5      RMSE 12.957, against 15.275 for trusting a team's own average
//                completely and 14.009 for ignoring it completely. Shrinkage
//                beats the better of those by 7.5%.
//
//   SIGMA = 22.26  points, the within-team week-to-week spread. Within-team on
//                purpose: the spread BETWEEN teams is signal, and pooling the
//                two would widen every forecast with the thing it is trying to
//                measure.
//
// THE UNCOMFORTABLE RESULT IS WORTH READING TWICE. The league average alone
// (14.009) predicts a team's remaining schedule BETTER than that team's own
// scoring average does (15.275). In a ten-team league over fourteen weeks, most
// of what looks like a hot team is noise, and that is why K is so large: after
// three weeks a team's own scoring is trusted 32%, and it does not cross half
// until week seven. Anyone reporting confident odds in September is reporting
// the constant they chose, not the season.
//
// Re-run the calibration when a season completes; if K moves, move it here.

const K = 6.5;
const SIGMA = 22.26;

// WHAT THE BACKTEST SAYS, and the one line of it worth acting on.
// scripts/backtest-playoffs.js replays all four completed seasons week by week
// and scores the forecast with Brier against two baselines:
//
//   always 60% (the base rate, six of ten)   0.2400
//   today's top six, as 1 and 0              0.2192
//   this simulator                           0.1436   — 40% better than the
//                                                       base rate, 34% better
//                                                       than the standings
//
// Calibration holds across the range: said 31% happened 35%, said 50% happened
// 47%, said 94% happened 94%.
//
// AND IN WEEK ONE IT IS WORSE THAN SAYING NOTHING — 0.265 against the base
// rate's 0.240, the only week it loses. One game is not evidence, and dressing
// it as a percentage makes it look like evidence. The model does not get to
// hide that, so it reports it: `reliable` is false until there is enough season
// to beat the number a reader could have guessed, and the UI is expected to say
// so rather than print a confident figure over one week of football.
const RELIABLE_FROM_WEEK = 2;

function reliability(weeksPlayed) {
  if (weeksPlayed >= 6) return { reliable: true, note: null };
  if (weeksPlayed >= RELIABLE_FROM_WEEK) {
    return { reliable: true, note: `${weeksPlayed} weeks in — the shrinkage is still doing most of the work, `
      + `so these move a lot week to week.` };
  }
  return { reliable: false, note: weeksPlayed === 0
    ? 'Nothing has been played. Every team is six-of-ten because that is all anyone knows.'
    : 'One week is not evidence. Measured over four seasons, a forecast from one game is worse than '
      + 'assuming every team is 60% — so this is the schedule and the base rate, not a read on anybody.' };
}

// Box-Muller. Weekly fantasy scores are not exactly normal — they are mildly
// right-skewed — but the tail that matters for a win/loss is the middle, and a
// normal is honest about being an approximation in a way a bespoke curve fitted
// to 560 observations would not be.
function normal(mean, sd, rng) {
  let u = 0, v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// Deterministic generator so a reported percentage does not move when nothing
// about the league has. mulberry32.
function seeded(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * What we think a team scores in a week it has not played.
 * Shrunk toward the league, hard, for the reason set out above.
 */
function expectedScore(ownScores, leagueMean) {
  const k = ownScores.length;
  if (!k) return leagueMean;
  const own = ownScores.reduce((s, x) => s + x, 0) / k;
  const w = k / (k + K);
  return w * own + (1 - w) * leagueMean;
}

/**
 * Standings order. Sleeper's default is wins, then points-for, and points-for
 * is a real tiebreak rather than a formality — it is why a team can win the
 * same number of games and miss.
 */
function rank(teams) {
  return [...teams].sort((a, b) =>
    (b.wins - a.wins) || (b.pf - a.pf) || (a.rosterId - b.rosterId));
}

/**
 * A re-seeding bracket with byes, which is what playoff_type 0 means: the
 * highest remaining seed always plays the lowest remaining seed. Six teams
 * gives byes to 1 and 2, then 3v6 and 4v5 — the common case here — but this
 * derives it rather than hard-coding six, so a league that moves to four or
 * eight does not silently keep the old shape.
 */
function championOf(seeds, scoreOf, rng) {
  let alive = [...seeds];
  const size = 2 ** Math.ceil(Math.log2(alive.length));
  let byes = size - alive.length;

  while (alive.length > 1) {
    const advancing = alive.slice(0, byes);   // top seeds sit this round out
    let playing = alive.slice(byes);
    const winners = [];
    while (playing.length > 1) {
      const hi = playing.shift();
      const lo = playing.pop();
      winners.push(scoreOf(hi, rng) >= scoreOf(lo, rng) ? hi : lo);
    }
    if (playing.length) winners.push(playing[0]);
    // Re-seed: everyone still alive is reordered by their original seed.
    alive = [...advancing, ...winners].sort((a, b) => seeds.indexOf(a) - seeds.indexOf(b));
    byes = 0;
  }
  return alive[0];
}

/**
 * @param state.teams      [{ rosterId, wins, losses, ties, pf, scores: [] }]
 * @param state.remaining  [{ week, pairs: [[rosterIdA, rosterIdB], ...] }]
 * @param state.playoffTeams  how many make it
 * @param state.leagueMean    points per team per week, this season if it has
 *                            any and last season's if it does not
 * @param runs            simulations; 10k is stable to about a tenth of a point
 */
function simulate(state, runs = 10000, seed = 12345) {
  const rng = seeded(seed);
  const base = state.teams;
  const strength = new Map(base.map(t => [t.rosterId, expectedScore(t.scores || [], state.leagueMean)]));

  const madePlayoffs = new Map(base.map(t => [t.rosterId, 0]));
  const wonTitle = new Map(base.map(t => [t.rosterId, 0]));
  const seedCounts = new Map(base.map(t => [t.rosterId, new Array(base.length).fill(0)]));
  const winTotal = new Map(base.map(t => [t.rosterId, 0]));

  const drawFor = (id, r) => normal(strength.get(id), SIGMA, r);

  for (let i = 0; i < runs; i++) {
    const sim = new Map(base.map(t => [t.rosterId, { rosterId: t.rosterId, wins: t.wins, pf: t.pf }]));

    for (const wk of state.remaining) {
      for (const [a, b] of wk.pairs) {
        const A = sim.get(a), B = sim.get(b);
        if (!A || !B) continue;
        const sa = drawFor(a, rng), sb = drawFor(b, rng);
        A.pf += sa; B.pf += sb;
        if (sa > sb) A.wins += 1; else if (sb > sa) B.wins += 1;
        else { A.wins += 0.5; B.wins += 0.5; }
      }
    }

    const order = rank([...sim.values()]);
    order.forEach((t, idx) => {
      seedCounts.get(t.rosterId)[idx]++;
      winTotal.set(t.rosterId, winTotal.get(t.rosterId) + t.wins);
    });

    const seeds = order.slice(0, state.playoffTeams).map(t => t.rosterId);
    for (const id of seeds) madePlayoffs.set(id, madePlayoffs.get(id) + 1);
    const champ = championOf(seeds, drawFor, rng);
    wonTitle.set(champ, wonTitle.get(champ) + 1);
  }

  const byRoster = new Map(base.map(t => [t.rosterId, t]));
  const weeksPlayed = Math.max(0, ...base.map(t => (t.scores || []).length));
  const conf = reliability(weeksPlayed);

  const table = base.map(t => ({
    rosterId: t.rosterId,
    playoffOdds: madePlayoffs.get(t.rosterId) / runs,
    titleOdds: wonTitle.get(t.rosterId) / runs,
    projectedWins: winTotal.get(t.rosterId) / runs,
    seedOdds: seedCounts.get(t.rosterId).map(c => c / runs),
    expectedScore: strength.get(t.rosterId),
  // ORDER BY ODDS, THEN BY THE LEAGUE'S OWN ORDER. Breaking the tie on title
  // odds instead put a 10-4 team above a 13-1 team with a "1" beside it, on a
  // finished season where both were already in at 100%. The badge reads as a
  // seed whatever it is labelled, so ties fall back to wins and points — which
  // IS the seed — and the title column is left to say the more interesting
  // thing on its own.
  })).sort((a, b) => {
    const A = byRoster.get(a.rosterId), B = byRoster.get(b.rosterId);
    return (b.playoffOdds - a.playoffOdds) || (B.wins - A.wins) || (B.pf - A.pf);
  });

  table.meta = { weeksPlayed, runs, ...conf };
  return table;
}

module.exports = { simulate, expectedScore, championOf, rank, seeded, reliability, K, SIGMA };
