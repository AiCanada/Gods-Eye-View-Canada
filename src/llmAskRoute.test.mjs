import test from 'node:test';
import assert from 'node:assert/strict';
import {
  admitLlmAskRequest,
  buildLlmAskCall,
  llmAnswerFromUpstream,
  llmAskTimeoutMs,
  llmMaxTokens,
  llmProviderRoster,
  parseLlmAskRequest,
  resolveLlmProvider,
} from '../server/providers/local.js';

// The Ask route's logic is pure and lives in these helpers; the middleware only
// wires them to req/res. Mirrors hudSummaryResponse.test.mjs for the sibling
// paid route.

const KEYED = { NVIDIA_API_KEY: 'nv-1', XAI_API_KEY: 'xai-1' };

test('admission: POST with JSON from this origin, or without an Origin, is allowed', () => {
  assert.equal(admitLlmAskRequest({ method: 'POST', contentType: 'application/json; charset=utf-8', origin: 'http://localhost:4173', host: 'localhost:4173' }).ok, true);
  assert.equal(admitLlmAskRequest({ method: 'POST', contentType: 'application/json', host: 'localhost:4173' }).ok, true, 'curl has no Origin');
});

test('admission: the cross-site simple-request shape is refused before any body is read', () => {
  assert.equal(admitLlmAskRequest({ method: 'GET', contentType: 'application/json', host: 'x' }).status, 405);
  assert.equal(admitLlmAskRequest({ method: 'POST', contentType: 'text/plain', origin: 'http://localhost:4173', host: 'localhost:4173' }).status, 415, 'no-preflight POST');
  assert.equal(admitLlmAskRequest({ method: 'POST', contentType: 'application/json', origin: 'https://evil.example', host: 'localhost:4173' }).status, 403);
  assert.equal(admitLlmAskRequest({ method: 'POST', contentType: 'application/json', origin: 'not a url', host: 'localhost:4173' }).status, 403);
});

test('provider lookup never resolves an inherited Object member', () => {
  assert.equal(resolveLlmProvider('nvidia').id, 'nvidia');
  assert.equal(resolveLlmProvider(undefined).id, 'nvidia', 'default provider');
  for (const bogus of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'nope']) {
    assert.equal(resolveLlmProvider(bogus), null, bogus);
  }
});

test('a body of null, an array, or malformed JSON is a 400, never a thrown TypeError', () => {
  for (const body of ['null', '[]', '"x"', '{', '']) {
    const parsed = parseLlmAskRequest(body, KEYED);
    assert.equal(parsed.ok, false, JSON.stringify(body));
    assert.equal(parsed.status, body === '' ? 400 : 400);
  }
  assert.equal(parseLlmAskRequest('', KEYED).payload.error, 'A question is required');
});

test('request validation: unknown provider, missing key, incomplete custom endpoint, empty question', () => {
  assert.equal(parseLlmAskRequest(JSON.stringify({ provider: 'constructor', question: 'hi' }), KEYED).status, 400);
  const keyless = parseLlmAskRequest(JSON.stringify({ provider: 'anthropic', question: 'hi' }), KEYED);
  assert.equal(keyless.status, 501);
  assert.equal(keyless.payload.unconfigured, true);
  const custom = parseLlmAskRequest(JSON.stringify({ provider: 'custom', question: 'hi' }), { CUSTOM_LLM_API_KEY: 'k' });
  assert.equal(custom.status, 501);
  assert.match(custom.payload.error, /CUSTOM_LLM_BASE_URL/);
  assert.equal(parseLlmAskRequest(JSON.stringify({ provider: 'xai', question: '   ' }), KEYED).status, 400);
  const ok = parseLlmAskRequest(JSON.stringify({ provider: 'xai', question: 'q'.repeat(5000), context: [1] }), KEYED);
  assert.equal(ok.ok, true);
  assert.equal(ok.question.length, 2000, 'question is capped');
  assert.deepEqual(ok.context, {}, 'a non-object context is dropped');
});

test('limits are read from the live environment, not at import', () => {
  assert.equal(llmMaxTokens({}), 2048);
  assert.equal(llmMaxTokens({ LLM_MAX_TOKENS: '8192' }), 8192);
  assert.equal(llmMaxTokens({ LLM_MAX_TOKENS: 'lots' }), 2048);
  assert.equal(llmAskTimeoutMs({}), 240000);
  assert.equal(llmAskTimeoutMs({ LLM_ASK_TIMEOUT_MS: '300000' }), 300000);
});

test('the upstream call is the shared chat-completions dialect, reasoning effort only where accepted', () => {
  const nvidia = parseLlmAskRequest(JSON.stringify({ provider: 'nvidia', question: 'What is here?' }), KEYED);
  const call = buildLlmAskCall(nvidia.provider, nvidia.settings, nvidia.question, { view: 1 }, { ...KEYED, LLM_MAX_TOKENS: '4096' });
  assert.equal(call.url, 'https://integrate.api.nvidia.com/v1/chat/completions');
  assert.equal(call.headers.Authorization, 'Bearer nv-1');
  assert.equal(call.payload.max_tokens, 4096);
  assert.equal(call.payload.reasoning_effort, 'low');
  assert.equal(call.payload.messages[0].role, 'system');
  assert.match(call.payload.messages[1].content, /"view":1[\s\S]*QUESTION:\nWhat is here\?/);

  const quiet = buildLlmAskCall(nvidia.provider, nvidia.settings, 'q', {}, { ...KEYED, NVIDIA_REASONING_EFFORT: 'none' });
  assert.equal('reasoning_effort' in quiet.payload, false, 'NVIDIA_REASONING_EFFORT=none omits the field');

  const xai = parseLlmAskRequest(JSON.stringify({ provider: 'xai', question: 'q' }), KEYED);
  const xaiCall = buildLlmAskCall(xai.provider, xai.settings, 'q', {}, KEYED);
  assert.equal('reasoning_effort' in xaiCall.payload, false, 'other providers reject the field');
});

test('upstream failures are reported as 502 with the message, never relayed verbatim', () => {
  const nvidia = parseLlmAskRequest(JSON.stringify({ provider: 'nvidia', question: 'q' }), KEYED);
  const unauthorised = llmAnswerFromUpstream({ ok: false, status: 401 }, { error: { message: 'bad key' } }, nvidia.provider, nvidia.settings);
  assert.equal(unauthorised.status, 502);
  assert.equal(unauthorised.payload.error, 'bad key');
  assert.equal(unauthorised.payload.upstreamStatus, 401);
  const notImplemented = llmAnswerFromUpstream({ ok: false, status: 501 }, {}, nvidia.provider, nvidia.settings);
  assert.equal(notImplemented.status, 502, 'an upstream 501 must not read as "add a key" in the panel');
  assert.equal(notImplemented.payload.unconfigured, undefined);
});

test('an empty answer distinguishes a spent token budget from a blank reply', () => {
  const nvidia = parseLlmAskRequest(JSON.stringify({ provider: 'nvidia', question: 'q' }), KEYED);
  const spent = llmAnswerFromUpstream({ ok: true, status: 200 }, { choices: [{ finish_reason: 'length', message: { content: '' } }] }, nvidia.provider, nvidia.settings);
  assert.equal(spent.status, 502);
  assert.match(spent.payload.error, /LLM_MAX_TOKENS/);
  const blank = llmAnswerFromUpstream({ ok: true, status: 200 }, { choices: [] }, nvidia.provider, nvidia.settings);
  assert.match(blank.payload.error, /returned no answer/);
  const good = llmAnswerFromUpstream({ ok: true, status: 200 }, { model: 'm', usage: { total_tokens: 9 }, choices: [{ message: { content: ' An answer. ' } }] }, nvidia.provider, nvidia.settings);
  assert.deepEqual(good, { status: 200, payload: { answer: 'An answer.', provider: 'nvidia', model: 'm', usage: { total_tokens: 9 } } });
});

test('the roster reports readiness per provider from the given environment', () => {
  const roster = llmProviderRoster({ XAI_API_KEY: 'x', CUSTOM_LLM_API_KEY: 'c' });
  const byId = Object.fromEntries(roster.map((p) => [p.id, p]));
  assert.equal(byId.xai.ready, true);
  assert.equal(byId.nvidia.ready, false);
  assert.equal(byId.custom.ready, false, 'a custom endpoint needs a base URL and model too');
  assert.equal(llmProviderRoster({ CUSTOM_LLM_API_KEY: 'c', CUSTOM_LLM_BASE_URL: 'http://localhost:11434/v1', CUSTOM_LLM_MODEL: 'llama' }).find((p) => p.id === 'custom').ready, true);
});
