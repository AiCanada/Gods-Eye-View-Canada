import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GROK_BOT_GATEWAY_DEFAULT_AGENT,
  gatewayAgentAwaitingUser,
  gatewayAgentBusy,
  gatewayAgentId,
  gatewayErrorText,
  grokBotGatewayOrigin,
  listGatewayAgents,
  pickGatewayAgent,
  readGatewayReply,
  sendPromptAccepted,
} from './grokBotGateway.mjs';

test('the gateway origin is host and port only', () => {
  assert.equal(
    grokBotGatewayOrigin('http://127.0.0.1:1340'),
    'http://127.0.0.1:1340',
  );
  assert.equal(
    grokBotGatewayOrigin('http://127.0.0.1:1340/'),
    'http://127.0.0.1:1340',
  );
  assert.equal(grokBotGatewayOrigin('not a url'), '');
});

test('pickGatewayAgent prefers the named bot, then Chief of Staff, then the first', () => {
  const agents = [
    { id: 'aaa', name: 'Scout' },
    { id: 'bbb', name: 'Chief of Staff' },
    { id: 'ccc', name: 'News' },
  ];
  assert.equal(GROK_BOT_GATEWAY_DEFAULT_AGENT, 'Chief of Staff');
  assert.equal(pickGatewayAgent(agents, 'News').id, 'ccc');
  assert.equal(pickGatewayAgent(agents, 'bbb').id, 'bbb');
  assert.equal(pickGatewayAgent(agents, '').id, 'bbb');
  assert.equal(pickGatewayAgent([{ id: 'only', name: 'Ada' }], '').id, 'only');
  assert.equal(pickGatewayAgent([], 'Chief of Staff'), null);
  // A named bot that is not there is a miss, never another bot.
  assert.equal(pickGatewayAgent(agents, 'Nobody'), null);
  assert.equal(pickGatewayAgent(agents, 'chief of staff').id, 'bbb');
  // POWER UP saves no spaces: the placeholder Chief-of-Staff still finds it.
  assert.equal(pickGatewayAgent(agents, 'Chief-of-Staff').id, 'bbb');
  assert.equal(gatewayAgentId({ agentId: 'from-alias' }), 'from-alias');
});

test('listGatewayAgents accepts a bare array or { agents }', () => {
  assert.equal(listGatewayAgents([{ id: 'a' }]).length, 1);
  assert.equal(listGatewayAgents({ agents: [{ id: 'a' }, null] }).length, 1);
  assert.deepEqual(listGatewayAgents(null), []);
});

test('busy and awaiting-user flags, and sendPrompt accepted', () => {
  assert.equal(gatewayAgentBusy({ isRunning: true }), true);
  assert.equal(gatewayAgentBusy({ isComposingMessage: true }), true);
  assert.equal(gatewayAgentBusy({ id: 'a' }), false);
  assert.equal(gatewayAgentAwaitingUser({ awaitingUserResponse: true }), true);
  assert.equal(sendPromptAccepted({ accepted: true }), true);
  assert.equal(sendPromptAccepted({ accepted: false }), false);
  assert.equal(sendPromptAccepted({}), true);
});

test('readGatewayReply takes the last assistant line and ignores the user', () => {
  assert.equal(
    readGatewayReply({
      messages: [
        { role: 'user', text: 'run the sweep' },
        { role: 'assistant', text: 'X:\nNOTHING FOUND' },
      ],
    }),
    'X:\nNOTHING FOUND',
  );
  assert.equal(
    readGatewayReply({
      tail: [
        { type: 'send-message', content: 'first' },
        { type: 'send-message', content: 'second' },
      ],
    }),
    'second',
  );
  assert.equal(readGatewayReply({ reply: '  from helper  ' }), 'from helper');
  assert.equal(readGatewayReply(null), '');
});

test('a gateway refusal never carries the token', () => {
  const token = 'sand-secret-token';
  const text = gatewayErrorText(`Invalid token ${token}`, 401, token);
  assert.match(text, /HTTP 401/);
  assert.equal(text.includes(token), false);
  assert.match(text, /\[key\]/);
});

test('a refusal cut at 200 characters never leaves part of the token', () => {
  const token = 'tok-' + 'x'.repeat(60);
  const raw = 'y'.repeat(180) + token;
  const text = gatewayErrorText(raw, 401, token);
  assert.equal(text.includes('tok-'), false);
  assert.equal(text.includes('xxxx'), false);
});
