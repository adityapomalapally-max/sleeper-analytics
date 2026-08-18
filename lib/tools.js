// ============================================================
// Tools — what the assistant is allowed to look up
// ============================================================
//
// The assistant has no football knowledge of its own that it may state. Every
// number it gives has to come back from one of these calls, and every one of
// them returns a `source` alongside the value so citing is mechanical rather
// than a favour the model does us.
//
// The declarations are Gemini's functionDeclarations shape. The executors are
// plain async functions, so the whole layer is testable without an LLM — which
// is the half that decides whether an answer is true.

const moat = require('./moat.js');

const declarations = [
  {
    name: 'find_player',
    description:
      "Resolve a player name, nickname, surname or Sleeper roster id to a player in The Signal's 350-player pool. "
      + 'ALWAYS call this before any other player tool. If it returns candidates, ask the user which one — never pick.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'A name, surname, or numeric Sleeper player id' },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_player',
    description:
      'Everything The Signal holds on one player, by the id returned from find_player. '
      + 'Ask only for the sections you need. Sections with no rows come back named in `missing` — '
      + 'that means the data does not have it, and you must say so rather than estimating.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The player id from find_player' },
        sections: {
          type: 'array',
          description: 'status = availability today; projection = rank, points, floor/ceiling; adp = where the room drafts him; '
            + 'stats = season totals; ngs = Next Gen Stats and snap share; usage = which personnel packages he plays in; '
            + 'medical = sourced injury narratives (only 31 of 350 players); injuryHistory = official weekly report history; '
            + 'advanced = yards before/after the catch, drops, broken tackles, pressure faced; '
            + 'charting = whether he is the quarterback\'s FIRST READ or a checkdown — the best single answer to '
            + 'whether an offence is actually built around him; context = where he is listed on his own depth chart '
            + 'and how he tested athletically',
          items: {
            type: 'string',
            enum: ['status', 'projection', 'adp', 'stats', 'ngs', 'usage', 'medical', 'injuryHistory',
                   'advanced', 'charting', 'context'],
          },
        },
      },
      required: ['id'],
    },
  },
  {
    name: 'get_team_scheme',
    description:
      'What an offence is trying to be: personnel mix, how heavy a box it draws, explosive rate, EPA per play, '
      + "head coach, and the defence's coverage and pressure rates. Use this to explain WHY a player's volume looks how it does.",
    parameters: {
      type: 'object',
      properties: {
        team: { type: 'string', description: 'Team code, e.g. SF, LAR, KC' },
        season: { type: 'string', description: 'Season year; defaults to the most recent charted season' },
      },
      required: ['team'],
    },
  },
  {
    name: 'get_rankings',
    description: "The Signal's ranked board for a position or overall, with the method it was built by.",
    parameters: {
      type: 'object',
      properties: {
        position: { type: 'string', enum: ['overall', 'qb', 'rb', 'wr', 'te'] },
        limit: { type: 'integer', description: 'How many to return, default 20' },
      },
      required: ['position'],
    },
  },
  {
    name: 'get_value_board',
    description:
      "Where The Signal's ranks disagree with consensus ADP. A positive edge means the room lets him fall past where "
      + 'these ranks have him. Both sides are positional ranks. This is a disagreement, never a claim about who is right.',
    parameters: {
      type: 'object',
      properties: {
        position: { type: 'string', enum: ['all', 'qb', 'rb', 'wr', 'te'] },
        limit: { type: 'integer', description: 'How many to return, default 20' },
      },
      required: ['position'],
    },
  },
  {
    name: 'get_strength_of_schedule',
    description: 'How hard a team\'s schedule is for a given position, by segment (season, early, playoffs).',
    parameters: {
      type: 'object',
      properties: {
        team: { type: 'string', description: 'Team code' },
        position: { type: 'string', enum: ['QB', 'RB', 'WR', 'TE'] },
      },
      required: ['team'],
    },
  },
  {
    name: 'get_injury_curve',
    description:
      'Aggregate return-to-play history for an injury type — how long players at this position have historically '
      + 'taken, and how they performed on return. Call with no type to list the types available.',
    parameters: {
      type: 'object',
      properties: {
        type: { type: 'string', description: 'e.g. Hamstring, Knee, Ankle, Concussion' },
      },
    },
  },
  {
    name: 'get_player_trend',
    description:
      'How a player has MOVED — his draft position, his rank, and any status changes over the last N days. '
      + 'The Signal keeps a daily record, so this answers questions no other fantasy tool can: whether the room '
      + 'is coming around on him, and exactly when his status changed. Use it for "is he rising", "what changed", '
      + '"should I still be worried about that injury".',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The player id from find_player' },
        days: { type: 'integer', description: 'How far back to look, default 30' },
      },
      required: ['id'],
    },
  },
  {
    name: 'get_biggest_movers',
    description:
      'Who moved most across the whole board over the last N days, by draft position or by rank. '
      + 'Use for "who is rising", "who is falling", "who is the market changing its mind about".',
    parameters: {
      type: 'object',
      properties: {
        series: { type: 'string', enum: ['adp', 'rankings'], description: 'adp = the market, rankings = our board' },
        days: { type: 'integer', description: 'Window in days, default 14' },
        limit: { type: 'integer', description: 'How many to return, default 15' },
      },
      required: ['series'],
    },
  },
  {
    name: 'get_data_freshness',
    description: 'When the data was last rebuilt, and whether any feed failed. Use when asked how current something is.',
    parameters: { type: 'object', properties: {} },
  },
];

const executors = {
  async find_player({ query }) {
    const r = await moat.resolvePlayer(query);
    // Hand back identity only. The raw pool row carries join keys and internal
    // fields the model has no use for, and every extra field in a tool result
    // is another thing it can decide to quote at the reader.
    return r.found ? { found: true, matchedOn: r.matchedOn, player: moat.identity(r.player) } : r;
  },
  async get_player({ id, sections }) {
    return moat.playerProfile(id, sections);
  },
  async get_team_scheme({ team, season }) {
    return moat.teamScheme(team, season);
  },
  async get_rankings({ position, limit }) {
    return moat.rankingBoard(position, limit);
  },
  async get_value_board({ position, limit }) {
    return moat.valueBoard(position, limit);
  },
  async get_strength_of_schedule({ team, position }) {
    return moat.strengthOfSchedule(team, position);
  },
  async get_injury_curve({ type }) {
    return moat.injuryCurve(type);
  },
  async get_player_trend({ id, days }) {
    return moat.playerTrend(id, days);
  },
  async get_biggest_movers({ series, days, limit }) {
    return moat.biggestMovers(series, days, limit);
  },
  async get_data_freshness() {
    return moat.freshness();
  },
};

/**
 * Run one tool call. A thrown executor must come back as data, not as a 500:
 * the model can recover from "that lookup failed" and cannot recover from the
 * conversation ending.
 */
async function runTool(name, args) {
  const fn = executors[name];
  if (!fn) return { error: `no tool named "${name}"` };
  try {
    return await fn(args || {});
  } catch (e) {
    return { error: `${name} failed: ${e.message}` };
  }
}

// The contract the model works under. The rules are not stylistic — each one
// stands in for a way a fantasy assistant is normally wrong.
function systemInstruction(leagueContext) {
  const cov = Object.entries(moat.COVERAGE)
    .map(([k, v]) => `  ${k}: ${v.rows} of ${v.of} players — ${v.note}`)
    .join('\n');

  return `You are the fantasy football analyst for The Signal, a site whose whole promise is that it publishes no data without a source.

HOW YOU ANSWER

Every football number you state must come from a tool call in this conversation. You have no statistics of your own. If you did not look it up, you do not know it — say so and offer to look up what you can.

Never estimate, extrapolate, or fill a gap. When a tool returns a section under "missing", that means The Signal has no rows for it. Say "The Signal doesn't have X for him" and move on. A confident guess is the single worst thing you can do here, because the reader came to this site specifically to avoid them.

Cite as you go, in plain language, not footnotes: "he's RB4 on The Signal's board" or "per the official injury reports". Every tool result carries a \`source\` field — use it.

Call find_player before any other player tool. If it returns candidates, ask which one. Never pick the most famous. Getting this wrong attributes one man's torn ACL to another.

WHAT THE DATA REACHES

The pool is 350 players deep. Anyone outside it — a deep-league streamer, a kicker, a defence — is simply not covered, and the honest answer is that he is not in the pool. Within it, layers run to different depths:
${cov}

So a question about a 31-player medical narrative is well-grounded; the same question about the 320th player is not, and you should say which situation you are in.

READING THE NUMBERS HONESTLY

Projected floors and ceilings are the 15th and 85th percentile of year-over-year change, per game. The median is the analyst's own call, not a generated number — say so when it matters.

The value board is a disagreement with the market, never a claim to be right. Phrase it that way.

Personnel usage is a share of the player's OWN snaps. It only means something against how often that offence called the package, which the tool returns beside it. A tight end at 68% in 12 personnel on an offence that runs it 21% has a ceiling capped by play-calling, not by talent.

Appearing on an injury report is not the same as missing a game. Severity is how bad an injury was; impact is what it still costs him. They are different axes.

ADP is one site's mock drafts, and mock drafters are not the user's league. A LOWER pick number is EARLIER, so a falling ADP number means the room likes him MORE, not less — say which way it moved in words, never just the number.

Being the quarterback's first read is not the same as being targeted a lot. Ninety targets of which sixty are first reads is the centre of an offence; ninety of which forty-five are checkdowns is a safety valve who happens to be on the field when plays break down. When charting is available, that distinction is usually the most useful thing you can tell someone.

A depth chart is what a team publishes, not what it does. Read it beside usage, never instead of it.

The daily history only began on 2026-05-27, and some series later than that. If someone asks about movement before then, say the record does not go back that far rather than implying nothing happened.

YOUR TONE

Direct and specific. Lead with the answer, then the evidence. No hedging padding, no "as an AI". Short paragraphs. You are talking to someone who is about to make a real decision with real money on it, and who will find out whether you were right.${leagueContext ? `\n\nTHE USER'S LEAGUE\n\n${leagueContext}\n\nThis league context comes from the user's own Sleeper account. It is reliable for rosters, scoring and standings, but it carries no NFL statistics — use the tools for those.` : ''}`;
}

module.exports = { declarations, executors, runTool, systemInstruction };
