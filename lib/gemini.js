// ============================================================
// The grounded conversation loop
// ============================================================
//
// Separated from the route so the orchestration can be tested against a fake
// transport. The route's job is HTTP; this file's job is the conversation.
//
// What changed from the version this replaces, and why each mattered:
//
//   The whole transcript used to be flattened into ONE user message with
//   "user:" / "assistant:" prefixes. The model could not tell the user's words
//   from its own or from the pasted-in roster dump, which is both a quality
//   problem and a prompt-injection surface. Turns are real turns now.
//
//   There was no system role, so the instructions were just more user text the
//   model could be talked out of. They are systemInstruction now.
//
//   maxOutputTokens was 1024, which truncated real analysis mid-sentence.
//
//   And there were no tools, so the model answered fantasy questions out of
//   its own training data — the exact thing this whole layer exists to stop.

const { declarations, runTool, systemInstruction } = require('./tools.js');

// gemini-2.0-flash, which this app shipped on, HAS BEEN RETIRED — it is no
// longer in the models list at all. That is why the live chat was failing with
// an upstream error while /api/health cheerfully reported the key was
// configured: the key was fine, the model was gone. A pinned model name is a
// dependency with an expiry date on it, so this is a chain, not a constant.
//
// Order is deliberate. 2.5-flash answered every grounding probe correctly and in
// under 5s; the 3.x flash models are newer and returned better prose but are
// frequently overloaded on this tier. First one that responds wins.
const MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const FALLBACKS = (process.env.GEMINI_FALLBACKS || 'gemini-3.5-flash,gemini-3.6-flash')
  .split(',').map(s => s.trim()).filter(Boolean);
const API_ROOT = 'https://generativelanguage.googleapis.com/v1beta/models';

// Google returns 503 "high demand" often enough on the free tier that treating
// it as fatal makes the assistant look broken when it is only busy.
const OVERLOADED = /high demand|unavailable|overloaded|try again later/i;
const QUOTA = /quota|rate.?limit|RESOURCE_EXHAUSTED/i;

function classify(err) {
  const msg = (err && (err.message || '')) + ' ' + ((err && err.status) || '');
  if (QUOTA.test(msg)) return 'quota';
  if (OVERLOADED.test(msg)) return 'overloaded';
  return 'fatal';
}

// A grounded answer needs several lookups — resolve a player, pull his profile,
// pull his offence — but a runaway loop burns quota and wall-clock. Six rounds
// is enough for a comparison of two players across three layers each.
const MAX_ROUNDS = 6;
const MAX_TOOLS_PER_ROUND = 8;

const SAFETY = [
  { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_ONLY_HIGH' },
  { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_ONLY_HIGH' },
  { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_ONLY_HIGH' },
  { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_ONLY_HIGH' },
];

/**
 * @param {object}   opts
 * @param {Array}    opts.history  [{role:'user'|'assistant', text}] oldest first
 * @param {string}   opts.message  the new user turn
 * @param {string}   opts.league   optional league context from the client
 * @param {string}   opts.apiKey
 * @param {function} opts.transport  injectable fetch, for tests
 */
async function converse({ history = [], message, league, apiKey, transport = fetch }) {
  const contents = [];
  for (const turn of history) {
    const role = turn.role === 'assistant' ? 'model' : 'user';
    const text = String(turn.text || '').trim();
    if (text) contents.push({ role, parts: [{ text }] });
  }
  contents.push({ role: 'user', parts: [{ text: message }] });

  const body = {
    systemInstruction: { parts: [{ text: systemInstruction(league) }] },
    contents,
    tools: [{ functionDeclarations: declarations }],
    generationConfig: { maxOutputTokens: 4096, temperature: 0.4 },
    safetySettings: SAFETY,
  };

  const toolsUsed = [];
  const chain = [MODEL, ...FALLBACKS];
  let modelUsed = MODEL;
  // Tracked because the free tier is counted in REQUESTS, not tokens, and one
  // grounded answer costs several requests. Knowing the token cost of an answer
  // is the difference between "we cannot afford this" and "this is cents".
  const usage = { promptTokens: 0, outputTokens: 0, requests: 0 };

  // One model for the whole exchange once it answers: switching mid-conversation
  // would hand a half-built transcript to a model that never made those calls.
  async function ask() {
    let lastErr;
    for (const model of chain) {
      for (let attempt = 0; attempt < 2; attempt++) {
        const res = await transport(`${API_ROOT}/${model}:generateContent?key=${apiKey}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const data = await res.json();
        usage.requests++;
        if (!data.error) {
          modelUsed = model;
          const u = data.usageMetadata || {};
          usage.promptTokens += u.promptTokenCount || 0;
          usage.outputTokens += u.candidatesTokenCount || 0;
          return data;
        }

        const e = new Error(data.error.message || 'Gemini error');
        e.upstream = data.error;
        e.status = data.error.status;
        const kind = classify(e);
        lastErr = e;
        // Quota is per-project and per-minute: another model does not help, and
        // hammering it makes the wait longer. Surface it and let the caller wait.
        if (kind === 'quota') { e.kind = 'quota'; throw e; }
        if (kind === 'fatal') { e.kind = 'fatal'; throw e; }
        if (attempt === 0) await new Promise(r => setTimeout(r, 700));
      }
    }
    lastErr.kind = 'overloaded';
    throw lastErr;
  }

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const data = await ask();

    const candidate = data.candidates && data.candidates[0];
    if (!candidate) throw new Error('Gemini returned no candidate');

    const parts = (candidate.content && candidate.content.parts) || [];
    const calls = parts.filter(p => p.functionCall).map(p => p.functionCall);

    if (!calls.length) {
      const text = parts.filter(p => p.text).map(p => p.text).join('').trim();
      if (!text) {
        // A finishReason of MAX_TOKENS or SAFETY with no text is a real outcome
        // and must not be reported as an empty success.
        throw new Error(`Gemini produced no text (finishReason: ${candidate.finishReason || 'unknown'})`);
      }
      return { reply: text, toolsUsed, rounds: round + 1, model: modelUsed, usage };
    }

    // The model's tool-call turn has to go back into the transcript verbatim,
    // or the function responses have nothing to attach to.
    body.contents.push({ role: 'model', parts });

    const responses = [];
    for (const call of calls.slice(0, MAX_TOOLS_PER_ROUND)) {
      const result = await runTool(call.name, call.args);
      toolsUsed.push({ name: call.name, args: call.args });
      responses.push({ functionResponse: { name: call.name, response: { result } } });
    }
    body.contents.push({ role: 'user', parts: responses });
  }

  // Out of rounds with the model still asking for data. Saying so is better
  // than letting it answer from whatever it happens to have.
  return {
    reply: "I couldn't finish looking that up — it needed more lookups than I'm allowed in one turn. Try asking about one player or one team at a time.",
    toolsUsed,
    rounds: MAX_ROUNDS,
    exhausted: true,
    model: modelUsed,
  };
}

module.exports = { converse, MODEL, FALLBACKS, MAX_ROUNDS };
