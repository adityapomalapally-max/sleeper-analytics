/**
 * The conversation loop, against a fake Gemini.
 *
 * The transport is injected, so every branch that used to need a live key and a
 * lucky model response is now deterministic: turn structure, the tool round
 * trip, the runaway guard, and the failure modes that used to surface to the
 * reader as an empty bubble.
 *
 *   node --test tests/
 */

const test = require('node:test');
const assert = require('node:assert');
const { converse, MAX_ROUNDS } = require('../lib/gemini.js');

// Replays a scripted list of Gemini responses and records what was sent.
function fakeGemini(scripted) {
  const sent = [];
  let i = 0;
  const transport = async (url, opts) => {
    sent.push({ url, body: JSON.parse(opts.body) });
    const next = scripted[Math.min(i++, scripted.length - 1)];
    return { json: async () => next };
  };
  transport.sent = sent;
  return transport;
}

const say = text => ({ candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }] });
const call = (name, args) => ({ candidates: [{ content: { parts: [{ functionCall: { name, args } }] } }] });

test('the transcript is real turns, not one flattened blob', async () => {
  // The version this replaces concatenated the whole history into a single user
  // message with "user:"/"assistant:" prefixes, so the model could not tell the
  // reader's words from its own — a quality problem and an injection surface.
  const t = fakeGemini([say('ok')]);
  await converse({
    history: [
      { role: 'user', text: 'who is my best receiver' },
      { role: 'assistant', text: 'Chase.' },
    ],
    message: 'and my worst?',
    apiKey: 'k',
    transport: t,
  });
  const { contents } = t.sent[0].body;
  assert.deepStrictEqual(contents.map(c => c.role), ['user', 'model', 'user']);
  assert.strictEqual(contents[2].parts[0].text, 'and my worst?');
  for (const c of contents) {
    assert.ok(!/^(user|assistant):/i.test(c.parts[0].text || ''), 'no role prefixes should be baked into the text');
  }
});

test('the instructions travel as a system role, not as more user text', async () => {
  const t = fakeGemini([say('ok')]);
  await converse({ message: 'hi', apiKey: 'k', transport: t });
  const body = t.sent[0].body;
  assert.ok(body.systemInstruction, 'there must be a systemInstruction');
  const text = body.systemInstruction.parts[0].text;
  assert.match(text, /must come from a tool call/i, 'the grounding rule has to be in it');
  assert.match(text, /350/, 'the coverage numbers have to be in it');
});

test('the tools are offered every turn', async () => {
  const t = fakeGemini([say('ok')]);
  await converse({ message: 'hi', apiKey: 'k', transport: t });
  const names = t.sent[0].body.tools[0].functionDeclarations.map(d => d.name);
  assert.ok(names.includes('find_player'));
  assert.ok(names.includes('get_player'));
});

test('a tool call round-trips and the result reaches the model', async () => {
  const t = fakeGemini([
    call('find_player', { query: "Ja'Marr Chase" }),
    say('He is WR1 on The Signal board.'),
  ]);
  const out = await converse({ message: 'how good is chase', apiKey: 'k', transport: t });

  assert.strictEqual(out.reply, 'He is WR1 on The Signal board.');
  assert.strictEqual(out.toolsUsed.length, 1);
  assert.strictEqual(out.toolsUsed[0].name, 'find_player');

  // Second request must carry: the model's call turn, then the real result.
  const second = t.sent[1].body.contents;
  const modelTurn = second[second.length - 2];
  const resultTurn = second[second.length - 1];
  assert.strictEqual(modelTurn.role, 'model');
  assert.ok(modelTurn.parts[0].functionCall, 'the call turn goes back verbatim or the response has nothing to attach to');
  const fr = resultTurn.parts[0].functionResponse;
  assert.strictEqual(fr.name, 'find_player');
  assert.strictEqual(fr.response.result.player.name, "Ja'Marr Chase", 'a REAL lookup, not a stub');
});

test('several tools in one turn are all executed', async () => {
  const t = fakeGemini([
    { candidates: [{ content: { parts: [
      { functionCall: { name: 'find_player', args: { query: 'Chase' } } },
      { functionCall: { name: 'get_rankings', args: { position: 'wr', limit: 3 } } },
    ] } }] },
    say('done'),
  ]);
  const out = await converse({ message: 'compare', apiKey: 'k', transport: t });
  assert.strictEqual(out.toolsUsed.length, 2);
  const responses = t.sent[1].body.contents.pop().parts;
  assert.strictEqual(responses.length, 2);
  assert.ok(responses.every(p => p.functionResponse));
});

test('a failing tool comes back as data, not as a dead conversation', async () => {
  const t = fakeGemini([call('get_team_scheme', { team: 'NOT_A_TEAM' }), say('That team is not in the data.')]);
  const out = await converse({ message: 'scheme?', apiKey: 'k', transport: t });
  assert.strictEqual(out.reply, 'That team is not in the data.');
  const result = t.sent[1].body.contents.pop().parts[0].functionResponse.response.result;
  assert.strictEqual(result.found, false, 'the model should be told it missed, and told what IS available');
  assert.ok(result.teamsAvailable);
});

test('an unknown tool name does not throw', async () => {
  const t = fakeGemini([call('get_the_future', {}), say('I cannot do that.')]);
  const out = await converse({ message: 'x', apiKey: 'k', transport: t });
  assert.strictEqual(out.reply, 'I cannot do that.');
  const result = t.sent[1].body.contents.pop().parts[0].functionResponse.response.result;
  assert.match(result.error, /no tool named/);
});

test('a model that never stops calling tools is cut off honestly', async () => {
  const t = fakeGemini([call('find_player', { query: 'Chase' })]); // loops forever
  const out = await converse({ message: 'x', apiKey: 'k', transport: t });
  assert.strictEqual(out.exhausted, true);
  assert.strictEqual(out.rounds, MAX_ROUNDS);
  assert.match(out.reply, /couldn't finish/i, 'it has to say it ran out, not answer anyway');
});

test('an upstream error is raised, never returned as an answer', async () => {
  const t = fakeGemini([{ error: { message: 'API key not valid', status: 'INVALID_ARGUMENT' } }]);
  await assert.rejects(() => converse({ message: 'x', apiKey: 'bad', transport: t }), /API key not valid/);
});

test('an empty completion is an error, not an empty bubble', async () => {
  // A MAX_TOKENS or SAFETY stop with no text used to surface as a blank reply.
  const t = fakeGemini([{ candidates: [{ content: { parts: [] }, finishReason: 'MAX_TOKENS' }] }]);
  await assert.rejects(() => converse({ message: 'x', apiKey: 'k', transport: t }), /MAX_TOKENS/);
});

test('the output cap is big enough for real analysis', async () => {
  const t = fakeGemini([say('ok')]);
  await converse({ message: 'x', apiKey: 'k', transport: t });
  // 1024 truncated multi-player answers mid-sentence.
  assert.ok(t.sent[0].body.generationConfig.maxOutputTokens >= 4096);
});

test('league context is carried in the system role, and labelled as the user\'s own', async () => {
  const t = fakeGemini([say('ok')]);
  await converse({ message: 'x', league: 'TEAM: Bad News Bears (3-9)', apiKey: 'k', transport: t });
  const text = t.sent[0].body.systemInstruction.parts[0].text;
  assert.match(text, /Bad News Bears/);
  assert.match(text, /carries no NFL statistics/i, 'the model must not treat league data as a stat source');
});
