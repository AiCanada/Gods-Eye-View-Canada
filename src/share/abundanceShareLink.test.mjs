// God's Eye View Canada: where the GLOBAL ABUNDANCE MAP box and the share-link
// manager meet (src/share/abundanceShareLink.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  abundanceShareState,
  connectAbundanceShare,
  noteAbundanceShareChange,
  resetAbundanceShare,
  restoreAbundanceShare,
  setAbundanceShareManager,
} from './abundanceShareLink.js';

test('the box and the manager meet: the state read, changes noted, a link’s state kept for the box', () => {
  resetAbundanceShare();
  assert.equal(abundanceShareState(), null);
  assert.equal(restoreAbundanceShare(null), false);
  assert.equal(restoreAbundanceShare('city'), false);
  assert.equal(restoreAbundanceShare({ level: 'city' }), true, 'kept until the box comes');
  const applied = [];
  const box = {
    shareState: () => ({ level: 'region' }),
    applyShareState: (state) => {
      applied.push(state);
      return true;
    },
  };
  const disconnect = connectAbundanceShare(box);
  assert.deepEqual(applied, [{ level: 'city' }], 'the waiting state is applied on connection');
  assert.deepEqual(abundanceShareState(), { level: 'region' });
  const notes = [];
  setAbundanceShareManager({ onAbundanceStateChange: () => notes.push(1) });
  noteAbundanceShareChange();
  assert.equal(notes.length, 1);
  assert.equal(restoreAbundanceShare({ level: 'country' }), true, 'applied at once with a box');
  assert.equal(applied.length, 2);
  disconnect();
  assert.equal(abundanceShareState(), null);
  assert.equal(typeof connectAbundanceShare(null), 'function', 'nothing to connect, nothing to undo');
  resetAbundanceShare();
  noteAbundanceShareChange();
  assert.equal(notes.length, 1, 'no manager after a reset');
});
