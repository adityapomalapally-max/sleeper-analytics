// ============================================================
// values.js — what a player is worth, and where the number came from
// ============================================================
//
// WHAT THIS REPLACES. `computeKTCValue` was ten hand-tuned constants and no
// source: points per game multiplied by 100, a 0.04-per-year youth premium, a
// 1.25x "young stud bonus", per-position scarcity multipliers, a floor of 0.15
// on the age penalty. Its caller then applied a SECOND undocumented positional
// weight (QB 1.30, RB 1.10, WR 1.00, TE 0.90) on top of the first, and a
// "rental value" of exactly 0.4x. The README called the result "KTC-style
// keeper values". Every verdict the trade calculator printed rested on them and
// not one could be checked by anybody, including the person who wrote them.
//
// THE RIGHT NUMBER IS ALREADY PUBLISHED, AND THERE ARE TWO OF THEM. VORP —
// points above the replacement player at the same position, over a stated
// baseline (QB12, RB30, WR40, TE12 in a 12-team 1QB/2RB/3WR/1TE/1FLEX league) —
// is the quantity a trade asks about, because it is ADDITIVE and comparable
// across positions: two receivers and a back can be summed against a
// quarterback without a fudge factor.
//
// BUT THE VORP ON THE POSITIONAL TABS IS NOT THE ONE TO USE, and this is the
// trap. Those rows carry a VORP computed from each player's OWN projection, so
// they follow the projected order rather than the ranked one: De'Von Achane is
// ranked RB9 by hand and carries a higher VORP there than James Cook at RB5.
// Pricing trades off that would quietly hand the calculator an ordering the
// analyst has explicitly rejected — his ranks are his own call and the whole
// point of rankings-manual.json.
//
// The `overall` tab does it correctly and says how: "each player inherits the
// projected median of the SLOT he was ranked into, then VORP is taken against
// replacement". Cook, ranked RB5, inherits the RB5 slot's 290 rather than his
// own 254. That is the hand ordering expressed in points — the order is the
// analyst's, the scale is the projection set's, and neither is invented here.
//
// So this module applies that same published method per position. It is not a
// new method: it is the site's own overall-tab derivation, run over 84 ranked
// players instead of the 24 that tab happens to show. `verifyAgainstOverall`
// checks the reproduction against those 24 rows and the test fails on any
// disagreement, so if The Signal changes how it derives them, this goes red
// rather than drifting.
//
// It also makes the old positional multipliers visibly wrong rather than merely
// unsourced. VORP already prices scarcity — that is what measuring against
// replacement level MEANS — so multiplying it by a scarcity weight counts the
// same thing twice.
//
// THE JOIN IS ID TO ID. Every one of The Signal's 350 players carries the
// Sleeper id it was built from, so nothing here matches on a name. That matters
// more here than anywhere else in this app: a wrong match does not produce a
// wrong fact, it produces a wrong TRADE.
//
// AND IT DOES NOT REACH EVERYBODY, WHICH IS STATED RATHER THAN PAPERED OVER.
// Measured 2026-08-22: 84 players carry a published VORP, another 108 carry a
// consensus ADP and no VORP, and the rest of a roster carries neither. A player
// this cannot value gets NO value — not a zero, not an estimate from his points
// per game. The calculator says who it could not price and declines to name a
// winner when either side holds one of them, because an unpriced player can be
// anything and a verdict that ignores him is a verdict about a different trade.
//
// FANTASY DRAFT PICKS ARE NOT PRICED AT ALL. The old file carried a 14-number
// PICK_VALUES curve with no source. Nothing in the moat prices a fantasy pick:
// The Signal's draft-outcomes.json is about NFL draft rounds — hit rates by
// round and position — which is a different question from what a 2027 third
// is worth in a keeper league. So picks are listed, never summed.

const { file, normalize } = require('./moat');

const TTL_MS = 10 * 60 * 1000;
let cached = null;

// The baselines the VORP is measured against, restated here so a reader of this
// file does not have to go and find them. They live in The Signal's
// build-rankings.js and travel with the number in rankings.json's meta.
const FORMAT = '12-team, 1QB / 2RB / 3WR / 1TE / 1FLEX, Half-PPR';

// The replacement rank per position, in a 12-team 1QB/2RB/3WR/1TE/1FLEX league.
// Stated in The Signal's build-rankings.js and restated here because a number
// this load-bearing should not have to be looked up somewhere else: QB12 (12
// starting quarterbacks, so the 13th is free), RB30 (24 locked starters plus
// about half the flex), WR40, TE12.
const REPLACEMENT_RANK = { QB: 12, RB: 30, WR: 40, TE: 12 };

/** The projected median of the replacement player at each position. */
function replacementMedians(projections) {
  const out = {};
  for (const [pos, rank] of Object.entries(REPLACEMENT_RANK)) {
    const medians = (projections[pos.toLowerCase()] || [])
      .map((p) => p.median).filter((m) => typeof m === 'number').sort((a, b) => b - a);
    out[pos] = medians[rank - 1] ?? null;
  }
  return out;
}

/**
 * The hand order, priced. Each player inherits the projected median of the SLOT
 * he was ranked into — the site's own overall-tab method — and VORP is that
 * median above replacement.
 */
function slotValues(rankings, replacement) {
  const out = [];
  for (const tab of ['qb', 'rb', 'wr', 'te']) {
    const rows = rankings[tab] || [];
    const pos = tab.toUpperCase();
    // The medians available at this position, best first: slot N is worth the
    // Nth best of them, whoever the analyst put there.
    const slots = rows.map((r) => r.median).filter((m) => typeof m === 'number').sort((a, b) => b - a);
    const repl = replacement[pos];
    rows.forEach((row, i) => {
      const slotMedian = slots[i];
      if (slotMedian === undefined || repl == null) return;
      out.push({
        name: row.name, pos, team: row.team,
        posRank: i + 1,
        slotMedian,
        vorp: Math.round(slotMedian - repl),
      });
    });
  }
  return out;
}

/**
 * Reproduce the published overall tab and compare. If this disagrees, the
 * method here is not the method there any more, and the values in this app
 * would be quietly the app's own rather than the site's.
 */
function verifyAgainstOverall(rankings, priced) {
  const byName = new Map(priced.map((p) => [p.name, p]));
  const mismatches = [];
  for (const row of (rankings.overall || [])) {
    const mine = byName.get(row.name);
    if (!mine) { mismatches.push(`${row.name}: not priced here at all`); continue; }
    if (mine.vorp !== row.vorp) mismatches.push(`${row.name}: published ${row.vorp}, reproduced ${mine.vorp}`);
  }
  return mismatches;
}

/**
 * The value table, keyed by SLEEPER id.
 *
 * Shape per player: { name, pos, team, vorp, posRank, adp, source }
 *   vorp    — the hand-ranked slot's points above replacement, or null
 *   adp     — consensus ADP pick number, or null
 *   source  — 'ranked' | 'adp-only', which the UI prints
 */
async function valueTable() {
  if (cached && Date.now() - cached.at < TTL_MS) return cached.data;

  const [players, rankings, adp, projections] = await Promise.all([
    file('players'), file('rankings'), file('adp'), file('projections-2026'),
  ]);

  // name -> sleeper id, from the pool: the only file carrying the crosswalk, and
  // it carries it for all 350.
  //
  // NORMALISED, BECAUSE THE SUFFIX IS WRITTEN DIFFERENTLY IN EVERY FILE. An
  // exact-name join dropped 19 players, in both directions: the ranks say
  // "James Cook" where the pool says "James Cook III", and the ADP feed says
  // "Travis Etienne Jr." where the pool says "Travis Etienne". Cook is ranked
  // RB5 — losing him is losing one of the most tradeable players in the format.
  //
  // AND A COLLISION IS POISONED RATHER THAN GUESSED. Two pool players folding
  // to the same key would put one man's value on another's trade, so the key is
  // dropped instead. Measured today: zero collisions across the 350, which is
  // the reason this is safe and not the reason it is unnecessary — the pool
  // changes daily and the guard has to outlive the measurement.
  const idByName = new Map();
  const collided = new Set();
  for (const p of players) {
    if (!p.sleeperId) continue;
    const key = normalize(p.name);
    if (idByName.has(key)) { collided.add(key); continue; }
    idByName.set(key, { id: String(p.sleeperId), pos: p.pos, team: p.team });
  }
  for (const key of collided) idByName.delete(key);
  const lookup = (name) => idByName.get(normalize(name));

  const replacement = replacementMedians(projections.projections || projections);
  const priced = slotValues(rankings, replacement);
  const mismatches = verifyAgainstOverall(rankings, priced);

  const out = {};
  let ranked = 0, adpOnly = 0, unjoinable = 0;

  for (const row of priced) {
    const hit = lookup(row.name);
    if (!hit) { unjoinable++; continue; }          // never guessed at
    out[hit.id] = {
      name: row.name, pos: row.pos, team: row.team || hit.team,
      vorp: row.vorp, posRank: row.posRank, slotMedian: row.slotMedian,
      adp: null, source: 'ranked',
    };
    ranked++;
  }

  for (const row of (adp.players || [])) {
    const hit = lookup(row.name);
    if (!hit) { unjoinable++; continue; }
    if (out[hit.id]) { out[hit.id].adp = row.adp; continue; }   // ranked already: ADP is context
    out[hit.id] = {
      name: row.name, pos: row.pos || hit.pos, team: row.team || hit.team,
      vorp: null, posRank: null, adp: row.adp, source: 'adp-only',
    };
    adpOnly++;
  }

  const data = {
    generated: new Date().toISOString(),
    format: FORMAT,
    method: 'Value is VORP: the projected points of the slot he was RANKED into, above the replacement '
      + 'player at his position. The order is the analyst\'s hand ranking; the scale comes from the '
      + 'projection set. Positions are already priced by measuring against their own replacement level, '
      + 'so no positional multiplier is applied on top.',
    replacement,
    replacementRank: REPLACEMENT_RANK,
    reproducesOverall: mismatches.length === 0,
    mismatches,
    limits: [
      'A player with no published rank carries no value here. He is not worth zero and he is not estimated from his points per game; the site simply does not rank that deep.',
      'Fantasy draft picks are not priced. Nothing in this data prices one, and the number that used to be here was invented.',
      'The ranks are one analyst\'s order. They are a stated opinion with a method behind it, not a market price.',
    ],
    coverage: { ranked, adpOnly, pool: players.length, unjoinable, collisions: collided.size },
    players: out,
  };
  cached = { at: Date.now(), data };
  return data;
}

module.exports = { valueTable, FORMAT, slotValues, replacementMedians, verifyAgainstOverall, REPLACEMENT_RANK };
