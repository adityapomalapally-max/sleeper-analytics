/**
 * The retrieval layer.
 *
 * This is the half of the assistant that can be tested without an LLM, and it
 * is the half that decides whether an answer is true. If a tool hands the model
 * a zero where the data has nothing, no amount of prompting will stop it saying
 * the player caught zero passes.
 *
 * Hits the live Signal deploy, so it needs a network. Run:
 *   node --test tests/
 */

const test = require('node:test');
const assert = require('node:assert');
const moat = require('../lib/moat.js');

// One shared warm-up so 20 tests do not refetch the pool 20 times.
test('the pool loads and every player carries the crosswalk', async () => {
  const idx = await moat.playerIndex();
  assert.ok(idx.pool.length >= 300, `pool is ${idx.pool.length}, expected the full board`);
  const missing = idx.pool.filter(p => !p.sleeperId);
  assert.strictEqual(missing.length, 0,
    `every player needs a sleeperId or a Sleeper roster cannot reach him: ${missing.slice(0, 3).map(p => p.name)}`);
});

test('a Sleeper roster id resolves to a Signal player', async () => {
  const idx = await moat.playerIndex();
  const sample = idx.pool[0];
  const r = await moat.resolvePlayer(String(sample.sleeperId));
  assert.strictEqual(r.found, true);
  assert.strictEqual(r.player.id, sample.id);
  assert.strictEqual(r.matchedOn, 'sleeperId');
});

test('names resolve through punctuation and suffixes', async () => {
  for (const q of ["Ja'Marr Chase", 'jamarr chase', 'JAMARR CHASE']) {
    const r = await moat.resolvePlayer(q);
    assert.strictEqual(r.found, true, `"${q}" should resolve`);
    assert.strictEqual(r.player.name, "Ja'Marr Chase");
  }
});

test('an ambiguous name is never guessed', async () => {
  // The rule that matters most: a wrong match writes one player's medical
  // history onto another man's answer. Surnames the pool holds more than once
  // must come back as candidates, not as a pick.
  const idx = await moat.playerIndex();
  const counts = {};
  for (const p of idx.pool) {
    const last = moat.normalize(p.name).split(' ').pop();
    (counts[last] = counts[last] || []).push(p.name);
  }
  const shared = Object.entries(counts).find(([, names]) => names.length > 1);
  assert.ok(shared, 'expected at least one surname shared by two players');
  const r = await moat.resolvePlayer(shared[0]);
  assert.strictEqual(r.found, false, `"${shared[0]}" is shared by ${shared[1].join(' / ')} and must not resolve to one of them`);
  assert.strictEqual(r.ambiguous, true);
  assert.ok(r.candidates.length > 1);
});

test('somebody outside the pool is refused, not approximated', async () => {
  const r = await moat.resolvePlayer('Zxqv Nonexistent');
  assert.strictEqual(r.found, false);
  assert.match(r.reason, /not in|no |match/i);
  assert.ok(!r.player, 'a miss must not carry a player');
});

test('a profile omits the sections it has nothing for, and says which', async () => {
  // Medicals reach 31 of 350. The other 319 must come back with the medical
  // key ABSENT and named in `missing` — not present and empty, which reads as
  // "we checked and he has no injury history".
  const idx = await moat.playerIndex();
  const withMedical = [];
  const withoutMedical = [];
  for (const p of idx.pool.slice(0, 60)) {
    const prof = await moat.playerProfile(p.id, ['medical']);
    if (prof.sections.medical) withMedical.push(p.id); else withoutMedical.push(p.id);
    assert.ok(!('medical' in prof.sections) || prof.sections.medical.injuries,
      'a medical section that exists must carry injuries');
  }
  assert.ok(withoutMedical.length > 0, 'expected some players with no medical profile');
  const prof = await moat.playerProfile(withoutMedical[0], ['medical']);
  assert.strictEqual(prof.sections.medical, undefined, 'no medical rows means no medical key');
  assert.ok(prof.missing.includes('medical'), 'and the gap has to be named');
});

test('every section that returns data names where it came from', async () => {
  // Citation cannot be left to the model's goodwill. If the payload carries the
  // source, citing is mechanical; if it does not, the model invents an
  // attribution or drops it.
  const idx = await moat.playerIndex();
  const all = ['status', 'projection', 'adp', 'stats', 'ngs', 'usage', 'medical', 'injuryHistory'];
  let checked = 0;
  for (const p of idx.pool.slice(0, 25)) {
    const prof = await moat.playerProfile(p.id, all);
    for (const [name, section] of Object.entries(prof.sections)) {
      assert.ok(section.source, `${p.id}.${name} came back with no source`);
      checked++;
    }
  }
  assert.ok(checked > 20, `expected to check a good number of sections, checked ${checked}`);
});

test('a profile for an unknown id fails cleanly', async () => {
  const prof = await moat.playerProfile('not-a-real-id', ['status']);
  assert.strictEqual(prof.found, false);
});

test('usage carries the offence rate beside the player rate', async () => {
  // A share of a player's own snaps means nothing alone. 68% of a tight end's
  // snaps in 12 personnel is only a finding against an offence that runs it 21%.
  const idx = await moat.playerIndex();
  let found = null;
  for (const p of idx.pool.slice(0, 40)) {
    const prof = await moat.playerProfile(p.id, ['usage']);
    if (prof.sections.usage && prof.sections.usage.offenceRateSameSeason) { found = prof.sections.usage; break; }
  }
  assert.ok(found, 'expected at least one player with usage and an offence comparison');
  assert.ok(found.personnelMix && Object.keys(found.personnelMix).length);
  assert.ok(found.qualifier, 'the snap qualifier has to travel with the rates');
  assert.ok(found.team, 'usage must record the team he played those snaps FOR');
});

test('team scheme returns the real board and flags the Rams correctly', async () => {
  // nflverse calls them LA and every other file calls them LAR. Unaliased, the
  // Rams silently render as nothing — so this is the canary.
  const lar = await moat.teamScheme('LAR');
  assert.strictEqual(lar.found, true, 'LAR must resolve');
  assert.ok(lar.personnelMix && Object.keys(lar.personnelMix).length);
  assert.ok(lar.headCoach, 'a scheme row without a coach is half an answer');
  assert.ok(lar.source);

  const lower = await moat.teamScheme('lar');
  assert.strictEqual(lower.found, true, 'team codes are case-insensitive');

  const bad = await moat.teamScheme('XXX');
  assert.strictEqual(bad.found, false);
  assert.ok(Array.isArray(bad.teamsAvailable) && bad.teamsAvailable.length === 32);
});

test('the value board compares like with like', async () => {
  // Both sides must be POSITIONAL ranks. Comparing an overall rank to a pick
  // number is a scale error that makes every deep player look like a bargain.
  const vb = await moat.valueBoard('all', 15);
  assert.ok(vb.players.length > 0);
  for (const row of vb.players) {
    assert.ok(Number.isFinite(row.signalPositionalRank), 'signal side must be a positional rank');
    assert.ok(Number.isFinite(row.adpPositionalRank), 'adp side must be a positional rank');
    assert.strictEqual(row.edge, row.adpPositionalRank - row.signalPositionalRank);
  }
  assert.ok(vb.warning, 'the board has to carry its own caveat');
});

test('the rankings board states its method', async () => {
  const rb = await moat.rankingBoard('rb', 5);
  assert.strictEqual(rb.found, true);
  assert.strictEqual(rb.players.length, 5);
  assert.ok(rb.method, 'a leaderboard without its method is a number with no meaning');
  const bad = await moat.rankingBoard('kicker');
  assert.strictEqual(bad.found, false);
});

test('injury curves list their types and refuse an unknown one', async () => {
  const list = await moat.injuryCurve();
  assert.ok(Array.isArray(list.types) && list.types.length > 0);
  const one = await moat.injuryCurve(list.types[0]);
  assert.strictEqual(one.found, true);
  assert.ok(one.method);
  const bad = await moat.injuryCurve('Sprained Ego');
  assert.strictEqual(bad.found, false);
  assert.ok(bad.types, 'a miss should still say what IS available');
});

test('strength of schedule resolves and carries its caveats', async () => {
  const sos = await moat.strengthOfSchedule('SF', 'RB');
  assert.strictEqual(sos.found, true);
  assert.ok(sos.byPosition.RB);
  assert.ok(sos.caveats, 'SOS without caveats invites more confidence than it earns');
});

test('freshness reports the last data build', async () => {
  const f = await moat.freshness();
  assert.ok(f.lastUpdate, 'the assistant has to be able to say how old the data is');
  const age = Date.now() - new Date(f.lastUpdate).getTime();
  assert.ok(age < 1000 * 60 * 60 * 72, `data is ${(age / 3.6e6).toFixed(1)}h old — the daily build may have stopped`);
});

test('the coverage table matches what the moat can actually answer', async () => {
  // The numbers handed to the model as "how thin the ground is" have to be the
  // real ones, or it will describe coverage it does not have.
  const idx = await moat.playerIndex();
  let medical = 0;
  for (const p of idx.pool) {
    const prof = await moat.playerProfile(p.id, ['medical']);
    if (prof.sections.medical) medical++;
  }
  const claimed = moat.COVERAGE.medicals.rows;
  assert.ok(Math.abs(medical - claimed) <= 5,
    `COVERAGE claims ${claimed} medical profiles, the data has ${medical} — update the table`);
});

// ===== The layers added 2026-08-18: advanced splits, charting, context, movement =====

test('the new sections carry their source like every other one', async () => {
  const idx = await moat.playerIndex();
  let seen = 0;
  for (const p of idx.pool.slice(0, 30)) {
    const prof = await moat.playerProfile(p.id, ['advanced', 'charting', 'context']);
    for (const [name, section] of Object.entries(prof.sections)) {
      assert.ok(section.source, `${p.id}.${name} has no source`);
      seen++;
    }
  }
  assert.ok(seen > 10, `expected the new layers to reach plenty of players, saw ${seen}`);
});

test('charting says which read, not just how many targets', async () => {
  // The distinction the layer exists for. Without the rates it is just another
  // target count and adds nothing to what stats already say.
  const idx = await moat.playerIndex();
  let found = null;
  for (const p of idx.pool.slice(0, 40)) {
    const prof = await moat.playerProfile(p.id, ['charting']);
    if (prof.sections.charting) { found = prof.sections.charting; break; }
  }
  assert.ok(found, 'expected somebody in the top 40 to be charted');
  assert.ok(typeof found.firstReadRate === 'number');
  assert.ok(typeof found.checkdownRate === 'number');
  assert.ok(found.reading && found.reading.firstRead, 'the vocabulary has to travel with the rates');
});

test('a falling ADP number is described as the room liking him MORE', async () => {
  // The single easiest thing to get backwards in the whole product: a lower pick
  // number is EARLIER. Reported as a raw delta it reads as the opposite of what
  // happened, so the direction is stated in words.
  const movers = await moat.biggestMovers('adp', 60, 30);
  if (!movers.movers.length) return;   // the series is young; nothing to assert yet
  assert.match(movers.reading, /NEGATIVE change means he is being drafted earlier/i);
  for (const m of movers.movers) {
    assert.strictEqual(m.change, +(m.to - m.from).toFixed(2), `${m.name}: change does not match from/to`);
  }
});

test('a trend for somebody with no recorded movement says so', async () => {
  const idx = await moat.playerIndex();
  const trend = await moat.playerTrend(idx.pool[0].id, 30);
  assert.ok(trend.player, 'a trend still identifies the player');
  if (!Object.keys(trend.series).length) {
    assert.ok(trend.nothingRecorded, 'no movement must be stated, not left as an empty object');
    assert.match(trend.nothingRecorded, /2026-05-27/, 'and it should say how far back the record goes');
  }
});

test('a trend for an unknown player fails cleanly', async () => {
  const trend = await moat.playerTrend('not-a-real-id', 30);
  assert.strictEqual(trend.found, false);
});

test('the coverage table includes the new layers and is honest about them', async () => {
  for (const key of ['advstats', 'charting', 'depthChart', 'combine']) {
    assert.ok(moat.COVERAGE[key], `COVERAGE is missing ${key}`);
    assert.ok(moat.COVERAGE[key].rows > 0 && moat.COVERAGE[key].rows <= moat.COVERAGE[key].of);
  }
  // Charting reaches fewer players than the pool, and the model has to be able
  // to say so rather than implying every player is covered.
  assert.ok(moat.COVERAGE.charting.rows < moat.COVERAGE.players.rows);
});
