// Find in the LLM output box: the matching, the stepping and the count line.
// The field itself is checked in a browser (it needs ranges and a layout).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  findCountLabel,
  findTextMatches,
  stepFindIndex,
} from './askOutputFind.js';

test('every occurrence, ignoring case, never overlapping', () => {
  const log = 'Other assaults\nTotal other assaults\nOTHER violent violations';
  assert.deepEqual(findTextMatches(log, 'other'), [
    [0, 5],
    [21, 26],
    [36, 41],
  ]);
  assert.deepEqual(
    findTextMatches(log, 'other').map(([start, end]) => log.slice(start, end)),
    ['Other', 'other', 'OTHER'],
  );
  assert.deepEqual(findTextMatches('aaaa', 'aa'), [
    [0, 2],
    [2, 4],
  ]);
  assert.deepEqual(findTextMatches(log, 'unfounded'), []);
  assert.deepEqual(findTextMatches(log, ''), []);
  assert.deepEqual(findTextMatches('', 'x'), []);
  assert.deepEqual(findTextMatches(null, undefined), []);
  assert.deepEqual(
    findTextMatches('10% (2025)', '(2025)'),
    [[4, 10]],
    'a query is text, never a pattern',
  );
});

test('a letter whose lower case is longer does not shift the offsets', () => {
  const text = 'İstanbul total';
  const [[start, end]] = findTextMatches(text, 'total');
  assert.equal(text.slice(start, end), 'total');
});

test('stepping wraps at both ends', () => {
  assert.equal(stepFindIndex(-1, 3, 1), 0);
  assert.equal(stepFindIndex(-1, 3, -1), 2);
  assert.equal(stepFindIndex(2, 3, 1), 0);
  assert.equal(stepFindIndex(0, 3, -1), 2);
  assert.equal(stepFindIndex(1, 3, 1), 2);
  assert.equal(stepFindIndex(0, 0, 1), -1);
});

test('the count line', () => {
  assert.equal(findCountLabel('', -1, 0), '');
  assert.equal(findCountLabel('zebra', -1, 0), 'No matches');
  assert.equal(findCountLabel('other', 2, 17), '3 of 17');
});
