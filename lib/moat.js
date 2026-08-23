// ============================================================
// The moat — The Signal's data, read server-side
// ============================================================
//
// Everything the assistant is allowed to state as fact comes from here. The
// files are generated daily by The Signal's Action and served as static JSON,
// so this module is a reader and a cache, never a source: nothing in here
// computes a football number, and nothing here should start.
//
// Two rules carried over from The Signal, because they are what make the answers
// worth trusting:
//
//   EMPTY BEATS WRONG. A player with no usage rows gets no usage section, not a
//   zero. The assistant is told to say "not in the data" and that only works if
//   this layer actually returns nothing rather than a plausible default.
//
//   NEVER GUESS AN AMBIGUOUS NAME MATCH. resolvePlayer returns every candidate
//   and lets the caller ask, because a wrong match writes one player's medical
//   history onto another's answer.
//
// Files are fetched lazily and cached per file: a scheme question should not
// pay for the 679KB of season stats.

const BASE = process.env.SIGNAL_DATA_BASE || 'https://the-signal-gamma.vercel.app';

// The pool is 350 players deep, and the moat's layers do not all reach the whole
// pool. These are measured, not estimated (2026-08-18), and they are handed to
// the model so it can say how thin the ground is instead of implying it is solid.
const COVERAGE = {
  players: { rows: 350, of: 350, note: 'the whole pool: identity, team, age, live status' },
  stats: { rows: 289, of: 350, note: 'season totals from nflverse' },
  ngs: { rows: 294, of: 350, note: 'Next Gen Stats and snap share' },
  injuries: { rows: 269, of: 350, note: 'official weekly injury-report history' },
  medicals: { rows: 31, of: 350, note: 'hand-written sourced medical narratives' },
  usage: { rows: 245, of: 350, note: 'personnel usage, 2025, 100+ charted snaps' },
  rankings: { rows: 92, of: 350, note: 'ranked with a projection' },
  adp: { rows: 185, of: 350, note: 'consensus ADP, Half-PPR 12-team' },
  advstats: { rows: 288, of: 350, note: 'PFR advanced splits — yards before/after the catch, drops, broken tackles, pressure faced' },
  charting: { rows: 226, of: 350, note: 'FTN charting — whether he was the quarterback\'s first read or a checkdown' },
  depthChart: { rows: 343, of: 350, note: 'where he is listed on his own team' },
  combine: { rows: 243, of: 350, note: 'combine testing with percentiles against his position' },
};

// How each file should be described when a number from it is cited.
const SOURCES = {
  players: 'The Signal player pool (Sleeper feed, daily)',
  rankings: "The Signal's rankings + projections",
  'projections-2026': "The Signal's 2026 projections",
  adp: 'consensus ADP (Half-PPR, 12-team)',
  medicals: "The Signal's sourced medical profiles",
  injuries: 'official NFL weekly injury reports',
  ngs: 'Next Gen Stats + snap counts',
  'player-usage': 'personnel usage from charted participation',
  scheme: 'team scheme and identity from charted participation',
  sos: 'strength of schedule',
  'injury-curves': 'aggregate return-to-play curves',
  advstats: 'Pro Football Reference advanced splits',
  charting: 'FTN play-by-play charting',
  context: 'published depth charts and combine testing',
  stats: 'season stat totals (nflverse)',
  teams: 'team pages and schedule',
  playcallers: 'hand-kept play-caller layer',
};

const TTL_MS = 15 * 60 * 1000;
const cache = new Map(); // file -> { at, data }

async function file(name) {
  const hit = cache.get(name);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.data;
  const res = await fetch(`${BASE}/data/${name}.json`, { cache: 'no-store' });
  if (!res.ok) {
    // A stale answer beats a wrong one, but a silent failure beats neither:
    // serve what we already had and let the caller know it is old.
    if (hit) return hit.data;
    throw new Error(`moat: ${name}.json returned ${res.status}`);
  }
  const data = await res.json();
  cache.set(name, { at: Date.now(), data });
  return data;
}

// ---------- identity ----------

// Matches the spirit of The Signal's normalizers: fold case and accents, drop
// the punctuation that feeds spell them differently, and strip a suffix wherever
// it appears. Deliberately NOT shared with that repo's lib/match.js — that one
// is tuned for joining feeds to each other, this one for reading what a person
// typed, and pretending they are the same function is how a matcher goes wrong.
const SUFFIXES = /\b(jr|sr|ii|iii|iv)\b/g;
function normalize(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[.'’-]/g, '')
    .replace(SUFFIXES, '')
    .replace(/\s+/g, ' ')
    .trim();
}

let indexAt = 0;
let index = null;

async function playerIndex() {
  if (index && Date.now() - indexAt < TTL_MS) return index;
  const pool = await file('players');
  const byId = new Map();
  const bySleeper = new Map();
  const byName = new Map();
  for (const p of pool) {
    byId.set(p.id, p);
    if (p.sleeperId) bySleeper.set(String(p.sleeperId), p);
    const n = normalize(p.name);
    if (!byName.has(n)) byName.set(n, []);
    byName.get(n).push(p);
  }
  index = { pool, byId, bySleeper, byName };
  indexAt = Date.now();
  return index;
}

/**
 * Resolve whatever the caller has — a Sleeper id, a slug, a full name, a
 * surname — to a player in the pool.
 *
 * Never picks between equals. Two Browns in the pool come back as two
 * candidates and the model has to ask which, because the alternative is
 * confidently answering about the wrong man.
 */
async function resolvePlayer(query) {
  const idx = await playerIndex();
  const q = String(query || '').trim();
  if (!q) return { found: false, reason: 'empty query' };

  // A Sleeper id is numeric and unique, so it can be trusted outright.
  if (idx.bySleeper.has(q)) return { found: true, player: idx.bySleeper.get(q), matchedOn: 'sleeperId' };

  const n = normalize(q);
  const parts = n.split(' ').filter(Boolean);

  // Name candidates are gathered BEFORE the internal id is consulted, and this
  // ordering is the whole point. The Signal's slugs are surnames — Bijan
  // Robinson's id is literally "robinson" — so an id lookup placed first
  // silently answered "robinson" with Bijan while the pool also held Brian
  // Robinson and Wan'Dale Robinson. An exact hit on an internal key is not
  // evidence about which player a person meant.
  const exact = idx.byName.get(n) || [];
  const hits = exact.length ? exact : idx.pool.filter(p => {
    const pn = normalize(p.name);
    return pn.includes(n) || parts.every(part => pn.includes(part));
  });

  if (hits.length === 1) return { found: true, player: hits[0], matchedOn: exact.length ? 'name' : 'partial name' };
  if (hits.length > 1) {
    if (hits.length > 12) return { found: false, reason: 'too many players match; ask for a full name' };
    return {
      found: false,
      ambiguous: true,
      candidates: hits.map(identity),
      reason: `${hits.length} players match "${q}" — ask which one`,
    };
  }

  // Only once no human-readable name matched is the internal id worth trying.
  // This is the path a follow-up call takes after the model has been handed an
  // id by an earlier resolve.
  if (idx.byId.has(q)) return { found: true, player: idx.byId.get(q), matchedOn: 'id' };
  return {
    found: false,
    reason: hits.length > 12
      ? 'too many players match; ask for a full name'
      : `"${q}" is not in The Signal's 350-player pool`,
  };
}

function identity(p) {
  return { id: p.id, name: p.name, pos: p.pos, team: p.team, age: p.age, sleeperId: p.sleeperId };
}

// ---------- sections ----------
// Each returns undefined when it has nothing, so the caller can drop the key
// entirely. A section present but empty reads as "we looked and he has none",
// which is a different claim from "we have no rows".

async function statusOf(p) {
  return {
    status: p.status,
    severity: p.statusClass === 'status-healthy' ? 'healthy' : p.statusClass === 'status-quest' ? 'questionable' : 'out',
    provenance: p.statusSource === 'override' ? 'hand-entered with a source and an expiry' : 'live Sleeper injury feed',
    source: SOURCES.players,
  };
}

async function projectionOf(p) {
  const r = await file('rankings');
  const pos = String(p.pos || '').toLowerCase();
  const board = r[pos];
  if (!Array.isArray(board)) return undefined;
  const row = board.find(x => normalize(x.name) === normalize(p.name));
  if (!row) return undefined;
  const overall = (r.overall || []).find(x => normalize(x.name) === normalize(p.name));
  return {
    positionalRank: `${p.pos}${row.rank}`,
    overallRank: overall ? overall.rank : undefined,
    projectedPoints: row.median,
    pointsPerGame: row.ppg,
    floor: row.floor,
    ceiling: row.ceiling,
    vorp: row.vorp,
    availability: row.availability,
    format: r.meta && r.meta.format,
    bandMeaning: r.meta && r.meta.bandCaveat,
    medianIs: 'the analyst\'s call, not a generated number',
    source: SOURCES.rankings,
  };
}

async function adpOf(p) {
  const a = await file('adp');
  const row = (a.players || []).find(x => normalize(x.name) === normalize(p.name));
  if (!row) return undefined;
  return {
    averagePick: row.adp,
    stdev: row.stdev,
    timesDrafted: row.timesDrafted,
    format: `${a.meta.format}, ${a.meta.teams}-team`,
    sampleNote: `${a.meta.source} consensus over ${a.meta.totalDrafts} drafts since ${a.meta.windowStart}; mock drafters are not your league`,
    source: SOURCES.adp,
  };
}

async function statsOf(p, seasons) {
  const s = await file('stats');
  const row = s[p.id];
  if (!row || !row.seasons) return undefined;
  const years = Object.keys(row.seasons).sort();
  const want = seasons && seasons.length ? years.filter(y => seasons.includes(Number(y)) || seasons.includes(y)) : years.slice(-3);
  if (!want.length) return undefined;
  const out = {};
  for (const y of want) out[y] = row.seasons[y];
  return { seasons: out, source: SOURCES.stats };
}

async function ngsOf(p) {
  const n = await file('ngs');
  const row = n[p.id];
  if (!row) return undefined;
  const years = Object.keys(row).filter(k => /^\d{4}$/.test(k)).sort();
  if (!years.length) return undefined;
  const latest = years[years.length - 1];
  return { season: latest, ...row[latest], source: SOURCES.ngs };
}

async function usageOf(p) {
  const u = await file('player-usage');
  const years = (u.meta.seasons || []).slice().sort();
  const out = {};
  for (const y of years) {
    const row = u.seasons[y] && u.seasons[y][p.id];
    if (row) out[y] = row;
  }
  if (!Object.keys(out).length) return undefined;
  const latest = Object.keys(out).sort().pop();
  const row = out[latest];
  // The comparison is the whole point: a share of his own snaps means nothing
  // without the offence's own rate beside it.
  let offence;
  try {
    const scheme = await file('scheme');
    const teamRow = scheme.seasons && scheme.seasons[latest] && scheme.seasons[latest][row.team];
    if (teamRow && teamRow.personnel) {
      offence = {};
      for (const g of Object.keys(row.mix)) {
        if (teamRow.personnel[g]) offence[g] = teamRow.personnel[g].rate;
      }
    }
  } catch (e) { /* the comparison is a bonus, never a blocker */ }
  return {
    season: latest,
    team: row.team,
    snaps: row.snaps,
    personnelMix: row.mix,
    offenceRateSameSeason: offence,
    reading: 'his share of his OWN snaps, against how often that offence called the package',
    qualifier: u.meta.qualifier,
    source: SOURCES['player-usage'],
  };
}

async function medicalOf(p) {
  const m = await file('medicals');
  const row = m[p.id];
  if (!row) return undefined;
  return {
    currentStatus: row.currentStatus,
    injuries: (row.injuries || []).map(i => ({
      title: i.title,
      severity: i.severity,
      severityLabel: i.severityLabel,
      impact: i.impact,
      detail: i.detail,
      source: i.source,
    })),
    note: 'severity is how bad the injury was; impact is what it still costs him. Different axes.',
    source: SOURCES.medicals,
  };
}

async function injuryHistoryOf(p) {
  const inj = await file('injuries');
  const row = inj[p.id];
  if (!row) return undefined;
  const out = {};
  for (const [year, v] of Object.entries(row)) {
    if (!/^\d{4}$/.test(year)) continue;
    out[year] = { weeksListed: v.weeksListed, gamesOut: v.gamesOut, episodes: v.episodes };
  }
  if (!Object.keys(out).length) return undefined;
  return {
    seasons: out,
    caveat: 'appearing on a report is not the same as missing a game; IR entries can outlast the injury',
    source: SOURCES.injuries,
  };
}

async function advstatsOf(p) {
  const a = await file('advstats');
  const row = a.players && a.players[p.id];
  if (!row || !row.seasons) return undefined;
  const years = Object.keys(row.seasons).sort();
  if (!years.length) return undefined;
  const latest = years[years.length - 1];
  return {
    season: latest,
    ...row.seasons[latest],
    reading: 'yards before the catch belong to the quarterback and yards after belong to the '
      + 'receiver; drops and broken tackles are the player\'s own',
    caveats: a.meta.caveats,
    source: SOURCES.advstats,
  };
}

/**
 * The layer that separates volume from intent. Ninety targets of which sixty
 * are first reads is the centre of an offence; ninety of which forty-five are
 * checkdowns is a safety valve. No volume stat can tell those apart.
 */
async function chartingOf(p) {
  const c = await file('charting');
  const years = (c.meta.seasons || []).slice().sort();
  const latest = years[years.length - 1];
  const row = c.seasons[latest] && c.seasons[latest].players[p.id];
  if (!row) return undefined;
  const team = c.seasons[latest].teams[p.team];
  return {
    season: latest,
    chartedTargets: row.chartedTargets,
    firstReadRate: row.firstReadRate,
    checkdownRate: row.checkdownRate,
    catchableRate: row.catchableRate,
    contestedRate: row.contestedRate,
    drops: row.drops,
    createdReceptions: row.created,
    offenceContext: team ? { playActionRate: team.playActionRate, screenRate: team.screenRate } : undefined,
    reading: c.meta.readValues,
    caveats: c.meta.caveats,
    source: SOURCES.charting,
  };
}

async function contextOf(p) {
  const c = await file('context');
  const depth = c.depthChart && c.depthChart[p.id];
  const combine = c.combine && c.combine[p.id];
  if (!depth && !combine) return undefined;
  return {
    depthChart: depth,
    combine: combine,
    caveats: c.meta.caveats,
    source: SOURCES.context,
  };
}

/**
 * A player dossier. `sections` keeps the payload to what was asked for — the
 * full thing is large and a model given everything cites the wrong half.
 */
async function playerProfile(id, sections) {
  const idx = await playerIndex();
  const p = idx.byId.get(id);
  if (!p) return { found: false, reason: `no player with id "${id}"` };

  const want = new Set(sections && sections.length ? sections : ['status', 'projection', 'adp', 'stats']);
  const out = { player: identity(p), sections: {}, missing: [] };

  const jobs = {
    status: () => statusOf(p),
    projection: () => projectionOf(p),
    adp: () => adpOf(p),
    stats: () => statsOf(p),
    ngs: () => ngsOf(p),
    usage: () => usageOf(p),
    medical: () => medicalOf(p),
    injuryHistory: () => injuryHistoryOf(p),
    advanced: () => advstatsOf(p),
    charting: () => chartingOf(p),
    context: () => contextOf(p),
  };

  for (const key of want) {
    const fn = jobs[key];
    if (!fn) continue;
    const val = await fn();
    if (val === undefined) out.missing.push(key);   // say nothing, loudly
    else out.sections[key] = val;
  }
  return out;
}

// ---------- team-level ----------

async function teamScheme(team, season) {
  const scheme = await file('scheme');
  const years = (scheme.meta.seasons || []).slice().sort();
  const year = String(season || years[years.length - 1]);
  const cur = scheme.seasons && scheme.seasons[year];
  if (!cur) return { found: false, reason: `no scheme data for ${year}` };
  const key = String(team || '').toUpperCase();
  const row = cur[key];
  if (!row) return { found: false, reason: `no scheme rows for "${team}" in ${year}`, teamsAvailable: Object.keys(cur).sort() };

  const prevYear = String(Number(year) - 1);
  const prev = scheme.seasons[prevYear] && scheme.seasons[prevYear][key];
  const shifts = [];
  if (prev && prev.personnel && row.personnel) {
    for (const g of Object.keys(row.personnel)) {
      if (!prev.personnel[g]) continue;
      const delta = +(row.personnel[g].rate - prev.personnel[g].rate).toFixed(1);
      if (Math.abs(delta) >= 5) shifts.push({ grouping: g, from: prev.personnel[g].rate, to: row.personnel[g].rate, delta });
    }
  }

  return {
    found: true,
    team: key,
    season: year,
    headCoach: row.coach,
    personnelMix: row.personnel,
    heavyBoxRate: row.heavyBoxRate,
    explosiveRate: row.explosiveRate,
    epaPerPlay: row.epaPerPlay,
    defense: row.defense,
    shiftsFromLastSeason: shifts.length ? shifts : undefined,
    causalChain: 'heavier personnel draws more defenders into the box, which lightens the secondary. Show the chain, never assert the last link alone.',
    source: SOURCES.scheme,
  };
}

async function strengthOfSchedule(team, pos) {
  const s = await file('sos');
  const key = String(team || '').toUpperCase();
  const row = s.teams && s.teams[key];
  if (!row) return { found: false, reason: `no schedule rows for "${team}"` };
  const p = String(pos || '').toUpperCase();
  const picked = p && row[p] ? { [p]: row[p] } : row;
  return {
    found: true, team: key, season: s.meta.season,
    scale: s.meta.scale, byPosition: picked,
    caveats: s.meta.caveats, source: SOURCES.sos,
  };
}

async function injuryCurve(type) {
  const c = await file('injury-curves');
  const types = Object.keys(c.types || {});
  if (!type) return { types, method: c.meta.method, source: SOURCES['injury-curves'] };
  const key = types.find(t => normalize(t) === normalize(type)) || types.find(t => normalize(t).includes(normalize(type)));
  if (!key) return { found: false, reason: `no curve for "${type}"`, types };
  return { found: true, type: key, curve: c.types[key], method: c.meta.method, caveats: c.meta.caveats, source: SOURCES['injury-curves'] };
}

async function rankingBoard(pos, limit) {
  const r = await file('rankings');
  const key = String(pos || 'overall').toLowerCase();
  const board = r[key];
  if (!Array.isArray(board)) return { found: false, reason: `no board for "${pos}"`, boards: ['overall', 'qb', 'rb', 'wr', 'te'] };
  return {
    found: true, board: key,
    players: board.slice(0, Math.min(limit || 20, board.length)),
    method: key === 'overall' ? r.meta.overallMethod : r.meta.method,
    format: r.meta.format,
    source: SOURCES.rankings,
  };
}

/**
 * Where the ranks disagree with the room. Both sides are POSITIONAL ranks —
 * comparing an overall rank to a pick number is a scale error that makes every
 * deep player look like a bargain.
 */
async function valueBoard(pos, limit) {
  const [r, a] = await Promise.all([file('rankings'), file('adp')]);
  const adpByPos = {};
  for (const row of a.players) {
    const key = String(row.pos || '').toLowerCase();
    (adpByPos[key] = adpByPos[key] || []).push(row);
  }
  for (const k of Object.keys(adpByPos)) adpByPos[k].sort((x, y) => x.adp - y.adp);

  const positions = pos && pos !== 'all' ? [String(pos).toLowerCase()] : ['qb', 'rb', 'wr', 'te'];
  const rows = [];
  for (const k of positions) {
    const board = r[k];
    if (!Array.isArray(board)) continue;
    for (const player of board) {
      const list = adpByPos[k] || [];
      const i = list.findIndex(x => normalize(x.name) === normalize(player.name));
      if (i < 0) continue;
      rows.push({
        name: player.name, pos: player.pos, team: player.team,
        signalPositionalRank: player.rank,
        adpPositionalRank: i + 1,
        averagePick: list[i].adp,
        edge: (i + 1) - player.rank,
      });
    }
  }
  rows.sort((x, y) => y.edge - x.edge);
  return {
    players: rows.slice(0, Math.min(limit || 20, rows.length)),
    reading: 'a positive edge means the room lets him fall past where these ranks have him',
    warning: 'the edge is a disagreement, not a projection: it says where we differ from the room, never who is right',
    format: `${a.meta.format}, ${a.meta.teams}-team`,
    source: `${SOURCES.rankings} vs ${SOURCES.adp}`,
  };
}

/**
 * MOVEMENT — the one question no other fantasy tool can answer about this pool.
 *
 * Every other layer here describes a state: what a player is today. The history
 * series records what he WAS, every day, because the daily build stopped
 * overwriting itself. So "who is falling in drafts" and "whose status changed
 * this week" become answerable, and they are answerable nowhere else, because
 * nobody else kept the days.
 *
 * The series are JSONL — one line per day — so they are read differently from
 * the rest of the moat and cached separately.
 */
const historyCache = new Map();

async function historyLines(name) {
  const hit = historyCache.get(name);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.rows;
  const res = await fetch(`${BASE}/data/history/${name}.jsonl`, { cache: 'no-store' });
  if (!res.ok) {
    if (hit) return hit.rows;
    throw new Error(`moat: history/${name}.jsonl returned ${res.status}`);
  }
  const text = await res.text();
  const rows = text.trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
  historyCache.set(name, { at: Date.now(), rows });
  return rows;
}

async function playerTrend(id, days) {
  const idx = await playerIndex();
  const p = idx.byId.get(id);
  if (!p) return { found: false, reason: `no player with id "${id}"` };

  const window = Math.min(Math.max(days || 30, 3), 400);
  const cutoff = new Date(Date.now() - window * 86400000).toISOString().slice(0, 10);
  const out = { player: identity(p), windowDays: window, series: {} };

  const [adp, ranks, statuses] = await Promise.all([
    historyLines('adp').catch(() => []),
    historyLines('rankings').catch(() => []),
    historyLines('status').catch(() => []),
  ]);

  const pointsOf = (rows, pick) => rows
    .filter(r => r.date >= cutoff && r.values && r.values[id] !== undefined)
    .map(r => ({ date: r.date, value: pick(r.values[id]) }));

  const adpPoints = pointsOf(adp, v => v);
  if (adpPoints.length >= 2) {
    const first = adpPoints[0], last = adpPoints[adpPoints.length - 1];
    out.series.averageDraftPosition = {
      points: adpPoints, from: first.value, to: last.value,
      // A LOWER pick number is earlier, so a fall in ADP is a RISE in the room's
      // opinion. Reporting the raw delta without saying this inverts the story.
      change: +(last.value - first.value).toFixed(2),
      direction: last.value < first.value ? 'being drafted EARLIER than before'
        : last.value > first.value ? 'falling — being drafted LATER than before' : 'unchanged',
      source: SOURCES.adp,
    };
  }

  const rankPoints = pointsOf(ranks, v => (Array.isArray(v) ? v[0] : null));
  if (rankPoints.length >= 2) {
    const first = rankPoints[0], last = rankPoints[rankPoints.length - 1];
    out.series.positionalRank = {
      points: rankPoints, from: first.value, to: last.value,
      change: last.value - first.value,
      direction: last.value < first.value ? 'ranked higher than before'
        : last.value > first.value ? 'ranked lower than before' : 'unchanged',
      source: SOURCES.rankings,
    };
  }

  const changes = statuses
    .filter(s => s.id === id && s.date >= cutoff && !s.first && s.to !== '__left__')
    .map(s => ({ date: s.date, from: s.from, to: s.to, provenance: s.provenance }));
  if (changes.length) out.series.statusChanges = { changes, source: SOURCES.players };

  if (!Object.keys(out.series).length) {
    out.nothingRecorded = `no movement recorded for him in the last ${window} days — the series `
      + 'only began on 2026-05-27 and only covers players the board carries';
  }
  return out;
}

/** Who moved most across the pool — the market-wide version of the same question. */
async function biggestMovers(series, days, limit) {
  const name = series === 'rankings' ? 'rankings' : 'adp';
  const rows = await historyLines(name);
  const window = Math.min(Math.max(days || 14, 2), 400);
  const cutoff = new Date(Date.now() - window * 86400000).toISOString().slice(0, 10);
  const inWindow = rows.filter(r => r.date >= cutoff);
  if (inWindow.length < 2) {
    return { movers: [], reason: `only ${inWindow.length} day(s) on file inside a ${window}-day window` };
  }
  const first = inWindow[0].values, last = inWindow[inWindow.length - 1].values;
  const idx = await playerIndex();
  const movers = [];
  for (const [id, lastVal] of Object.entries(last)) {
    if (first[id] === undefined) continue;
    const a = Array.isArray(first[id]) ? first[id][0] : first[id];
    const b = Array.isArray(lastVal) ? lastVal[0] : lastVal;
    const p = idx.byId.get(id);
    if (!p || a === b) continue;
    movers.push({ id, name: p.name, pos: p.pos, team: p.team, from: a, to: b, change: +(b - a).toFixed(2) });
  }
  movers.sort((x, y) => Math.abs(y.change) - Math.abs(x.change));
  return {
    series: name, windowDays: window,
    from: inWindow[0].date, to: inWindow[inWindow.length - 1].date,
    movers: movers.slice(0, Math.min(limit || 15, movers.length)),
    reading: name === 'adp'
      ? 'a NEGATIVE change means he is being drafted earlier — the room likes him more'
      : 'a NEGATIVE change means he moved up the board',
    source: name === 'adp' ? SOURCES.adp : SOURCES.rankings,
  };
}

async function freshness() {
  const m = await file('meta');
  return { lastUpdate: m.lastUpdate, fetchFailures: m.fetchFailures };
}

module.exports = {
  BASE, COVERAGE, SOURCES, file,
  normalize, resolvePlayer, identity, playerIndex,
  playerProfile, teamScheme, strengthOfSchedule,
  playerTrend, biggestMovers,
  injuryCurve, rankingBoard, valueBoard, freshness,
};
