// ============================================================
// trades.js — finding trades, not just grading them
// ============================================================
//
// The Trade tab already GRADES a trade somebody has thought of. ffwrapped's
// base set has the other half, and it is the harder one: proposing trades
// nobody has thought of yet.
//
// THE IDEA IS THAT VORP IS ADDITIVE AND LINEUPS ARE NOT. A team's strength is
// not the sum of its roster, it is the sum of the eleven it can start. That is
// what makes a trade possible at all: a third good running back is worth a lot
// on paper and nothing on Sunday, because only two of them start. So the value
// of a roster here is the value of its BEST LEGAL LINEUP, and a trade is worth
// proposing when that number goes up for both teams at once.
//
// WHAT COUNTS, AND WHAT HONESTLY CANNOT. lib/values.js prices 88 players; 101
// more are known only by ADP and the rest not at all, because The Signal ranks
// a top-N and does not rank deeper. Its rule is that an unpriced player is
// named, never estimated, and that rule is kept here:
//
//   - only PRICED players are ever proposed in a trade. A suggestion built on
//     a number nobody has is not a suggestion, it is a guess with a UI.
//   - an unpriced player filling a lineup slot contributes 0. That is not a
//     claim that he is worthless; it is the measured ceiling. The published
//     unrankedCeiling is QB 0, RB 18, WR 4, TE 0 — exactly zero at two
//     positions, and small at the others — because an unranked player is by
//     construction below the last man ranked at his spot.
//   - the RB and WR ceilings are not zero, so a proposal that depends on an
//     unpriced player entering or leaving a starting lineup is FLAGGED rather
//     than quietly counted.
//
// The output is a candidate list, not a verdict. The Trade tab is where a
// specific deal gets judged with its bounds; this is the thing that puts the
// deal in front of you.

const FLEX = {
  FLEX: ['RB', 'WR', 'TE'],
  SUPER_FLEX: ['QB', 'RB', 'WR', 'TE'],
  REC_FLEX: ['WR', 'TE'],
  WRRB_FLEX: ['WR', 'RB'],
};

/**
 * The best legal starting lineup, by VORP.
 *
 * Locked slots are filled first and flex slots afterwards, both greedily. That
 * is optimal here and not in general: a greedy fill can be beaten when a flex
 * is more valuable than a locked slot's best option, but every flex here draws
 * from a SUPERSET of some locked slot's position, so taking the best at each
 * locked slot first can never strand a better flex option. The SUPER_FLEX case
 * is the one to watch if the slot list ever gains an exotic position.
 */
function bestLineup(playerIds, valueOf, slots) {
  const pool = playerIds
    .map(id => ({ id, ...valueOf(id) }))
    .filter(p => p.pos);

  const byPos = {};
  for (const p of pool) (byPos[p.pos] ||= []).push(p);
  for (const arr of Object.values(byPos)) arr.sort((a, b) => b.vorp - a.vorp);

  const used = new Set();
  let total = 0;
  const starters = [];
  // Counted BY POSITION, because the uncertainty is not uniform. The published
  // unrankedCeiling is QB 0, RB 18, WR 4, TE 0 — an unpriced quarterback or
  // tight end starting is exactly zero and carries no doubt at all, so counting
  // "unpriced starters" as one number flagged every proposal in the league and
  // a flag that is always on is not a flag.
  const unpricedByPos = {};

  const take = (positions) => {
    let best = null;
    for (const pos of positions) {
      for (const p of (byPos[pos] || [])) {
        if (used.has(p.id)) continue;
        if (!best || p.vorp > best.vorp) best = p;
        break;   // the list is sorted, so the first unused is the best at that position
      }
    }
    if (!best) return;
    used.add(best.id);
    total += best.vorp;
    starters.push(best);
    if (!best.priced) unpricedByPos[best.pos] = (unpricedByPos[best.pos] || 0) + 1;
  };

  for (const slot of slots) { if (!FLEX[slot]) take([slot]); }
  for (const slot of slots) { if (FLEX[slot]) take(FLEX[slot]); }

  return { total, starters, unpricedByPos };
}

/** Look up a player's position and VORP, with unpriced treated as 0. */
function makeValueOf(values, playerMeta) {
  return (id) => {
    const v = values[id];
    if (v && v.vorp != null) return { pos: v.pos, vorp: v.vorp, priced: true, name: v.name };
    const meta = (v || playerMeta[id] || {});
    return { pos: meta.pos || null, vorp: 0, priced: false, name: meta.name || meta.full || String(id) };
  };
}

/**
 * Every one-for-one and two-for-one between priced players that makes BOTH
 * teams' starting lineup better.
 *
 * @param teams  [{ rosterId, name, players: [id] }]
 * @param values the players map from lib/values.js
 * @param slots  league roster_positions
 */
function findTrades(teams, values, slots, playerMeta = {}, opts = {}) {
  const minGain = opts.minGain ?? 1;      // a VORP point is noise; ask for more
  const limit = opts.limit ?? 40;
  const valueOf = makeValueOf(values, playerMeta);
  const startingSlots = slots.filter(s => s !== 'BN' && s !== 'IR' && s !== 'TAXI');

  const base = new Map();
  for (const t of teams) base.set(t.rosterId, bestLineup(t.players, valueOf, startingSlots));

  // Only priced players are ever offered. An unpriced player has no number to
  // trade on, and inventing one is the thing this codebase already removed.
  const tradeable = new Map();
  for (const t of teams) {
    tradeable.set(t.rosterId, t.players.filter(id => values[id] && values[id].vorp != null));
  }

  const out = [];
  const evaluate = (A, B, give, get) => {
    const aAfter = bestLineup(
      A.players.filter(id => !give.includes(id)).concat(get), valueOf, startingSlots);
    const bAfter = bestLineup(
      B.players.filter(id => !get.includes(id)).concat(give), valueOf, startingSlots);
    const gainA = aAfter.total - base.get(A.rosterId).total;
    const gainB = bAfter.total - base.get(B.rosterId).total;
    if (gainA < minGain || gainB < minGain) return;
    out.push({
      a: { rosterId: A.rosterId, name: A.name, gives: give.map(id => valueOf(id)), gain: gainA },
      b: { rosterId: B.rosterId, name: B.name, gives: get.map(id => valueOf(id)), gain: gainB },
      // The side that gains least is the side that says no. Ranking on it finds
      // deals that are actually balanced rather than lopsided ones that happen
      // to clear the bar twice.
      balance: Math.min(gainA, gainB),
      // Only where it can actually change the answer: a slot whose unranked
      // ceiling is zero cannot move a total, however many of them there are.
      uncertain: movedWhereItMatters(base.get(A.rosterId), aAfter)
              || movedWhereItMatters(base.get(B.rosterId), bAfter),
    });
  };

  // A FINDER IS FOR SOMEBODY. Ranked league-wide, the team holding the most
  // priced players owns every row — it has the deepest surplus, so its trades
  // clear the bar most often. That is a true fact and a useless page. The
  // question a reader has is "what can I do", so one roster is fixed and the
  // other nine are searched against it.
  const forRoster = opts.forRoster ?? null;

  for (let i = 0; i < teams.length; i++) {
    for (let jj = i + 1; jj < teams.length; jj++) {
      const A = teams[i], B = teams[jj];
      if (forRoster != null && A.rosterId !== forRoster && B.rosterId !== forRoster) continue;
      const aList = tradeable.get(A.rosterId), bList = tradeable.get(B.rosterId);
      for (const x of aList) {
        for (const y of bList) {
          evaluate(A, B, [x], [y]);
          // Two-for-one, one direction only per pair of A's players — the
          // mirror is generated when the loops reach it from B's side.
          for (const x2 of aList) {
            if (x2 <= x) continue;
            evaluate(A, B, [x, x2], [y]);
          }
        }
      }
    }
  }

  out.sort((p, q) => q.balance - p.balance);

  // ONE IDEA PER PAIR OF TEAMS, and one per player coming back. Without this the
  // list is the same trade eight times with the filler swapped — "give two of
  // your five receivers for their tight end" is one idea, not eight, and a page
  // of near-identical rows reads as a bug.
  const perPair = opts.perPair ?? 2;
  const pairCount = new Map();
  const seenTarget = new Set();
  const kept = [];
  for (const t of out) {
    const pair = [t.a.rosterId, t.b.rosterId].sort().join('-');
    const target = pair + '|' + t.b.gives.map(g => g.name).sort().join('+');
    if ((pairCount.get(pair) || 0) >= perPair) continue;
    if (seenTarget.has(target)) continue;
    pairCount.set(pair, (pairCount.get(pair) || 0) + 1);
    seenTarget.add(target);
    kept.push(t);
    if (kept.length >= limit) break;
  }
  return kept;
}

// Positions where an unranked player's ceiling is high enough to move a total.
// From lib/values.js: QB 0, RB 18, WR 4, TE 0.
const CEILING_MATTERS = ['RB', 'WR'];

function movedWhereItMatters(before, after) {
  for (const pos of CEILING_MATTERS) {
    if ((before.unpricedByPos[pos] || 0) !== (after.unpricedByPos[pos] || 0)) return true;
  }
  return false;
}

module.exports = { findTrades, bestLineup, makeValueOf, movedWhereItMatters, FLEX };
