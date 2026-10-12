import assert from 'node:assert/strict';
import test from 'node:test';
import {
  OWNER_REMOVAL_EVENT,
  isOwnerRemovalRefusal,
  noteOwnerRemovalRefusal,
  ownerRemovalRefusalCount,
  ownerRemovalRefusedSince,
  pendingOwnerRemovals,
  watchOwnerRemoval,
} from './ownerRemoval.js';

const pcOnly = ({ header = true, body = true } = {}) =>
  new Response(JSON.stringify(body ? { removal: 'pc-only' } : {}), {
    status: 403,
    headers: {
      'Content-Type': 'application/json',
      ...(header ? { 'X-GEV-Removal': 'pc-only' } : {}),
    },
  });

test('a 403 with the pc-only header or body is the PC refusing a removal', async () => {
  assert.equal(isOwnerRemovalRefusal(pcOnly()), true);
  assert.equal(isOwnerRemovalRefusal(pcOnly({ body: false })), true);
  const bodyOnly = pcOnly({ header: false });
  assert.equal(isOwnerRemovalRefusal(bodyOnly), false, 'body not read yet');
  assert.equal(isOwnerRemovalRefusal(bodyOnly, await bodyOnly.json()), true);
  // A plain object with a headers map works too (test doubles, old fetches).
  assert.equal(
    isOwnerRemovalRefusal({
      status: 403,
      headers: { get: (name) => (name === 'x-gev-removal' ? 'PC-ONLY' : null) },
    }),
    true,
  );
});

test('every other answer keeps its own message', () => {
  assert.equal(isOwnerRemovalRefusal(null), false);
  assert.equal(isOwnerRemovalRefusal(undefined, { removal: 'pc-only' }), false);
  // Not a 403: never the quiet refusal, whatever it says.
  assert.equal(
    isOwnerRemovalRefusal({ status: 401 }, { removal: 'pc-only' }),
    false,
  );
  assert.equal(
    isOwnerRemovalRefusal(
      new Response('{}', {
        status: 200,
        headers: { 'X-GEV-Removal': 'pc-only' },
      }),
    ),
    false,
  );
  // A 403 with an error text is an ordinary refusal.
  assert.equal(
    isOwnerRemovalRefusal({ status: 403 }, { error: 'Forbidden' }),
    false,
  );
  assert.equal(
    isOwnerRemovalRefusal({ status: 403 }, { removal: 'somewhere-else' }),
    false,
  );
  // A headers object that throws is no refusal, not a crash.
  assert.equal(
    isOwnerRemovalRefusal({
      status: 403,
      headers: {
        get() {
          throw new Error('gone');
        },
      },
    }),
    false,
  );
});

test('a watched removal counts the pc-only answer and the voice layer hears it', async () => {
  const heard = [];
  const listener = () => heard.push(OWNER_REMOVAL_EVENT);
  globalThis.addEventListener?.(OWNER_REMOVAL_EVENT, listener);
  try {
    const since = ownerRemovalRefusalCount();
    let answer;
    const request = watchOwnerRemoval(
      new Promise((resolve) => {
        answer = resolve;
      }),
    );
    assert.equal(pendingOwnerRemovals(), 1);
    const refused = ownerRemovalRefusedSince(since, { pollMs: 1 });
    answer(pcOnly());
    const response = await request;
    assert.equal(response.status, 403, 'the same answer comes back');
    assert.equal(pendingOwnerRemovals(), 0);
    assert.equal(await refused, true);
    if (globalThis.addEventListener)
      assert.deepEqual(heard, [OWNER_REMOVAL_EVENT]);
  } finally {
    globalThis.removeEventListener?.(OWNER_REMOVAL_EVENT, listener);
  }
});

test('an ordinary answer, or no removal at all, is not a refusal', async () => {
  const since = ownerRemovalRefusalCount();
  await watchOwnerRemoval(Promise.resolve(new Response('{}', { status: 200 })));
  assert.equal(await ownerRemovalRefusedSince(since), false);
  await assert.rejects(
    watchOwnerRemoval(Promise.reject(new TypeError('offline'))),
    /offline/,
  );
  assert.equal(
    pendingOwnerRemovals(),
    0,
    'a failed request is not left pending',
  );
  assert.equal(await ownerRemovalRefusedSince(since), false);
  // A refusal noted from a read body counts as well.
  noteOwnerRemovalRefusal();
  assert.equal(await ownerRemovalRefusedSince(since), true);
});

test('a removal with no answer stops being waited on after the timeout', async () => {
  const since = ownerRemovalRefusalCount();
  let answer;
  const request = watchOwnerRemoval(
    new Promise((resolve) => {
      answer = resolve;
    }),
  );
  assert.equal(
    await ownerRemovalRefusedSince(since, { timeoutMs: 20, pollMs: 5 }),
    false,
  );
  answer(new Response('{}', { status: 200 }));
  await request;
});
