import assert from 'node:assert/strict';
import test from 'node:test';
import { copyText } from './copyText.js';

function fakeDocument({ copies = true, throws = false } = {}) {
  const appended = [];
  const focused = [];
  const previous = { focus: () => focused.push('previous') };
  const doc = {
    activeElement: previous,
    copied: [],
    appended,
    focused,
    body: {
      appendChild(node) {
        appended.push(node);
        node.parent = this;
      },
    },
    createElement(tag) {
      return {
        tag,
        value: '',
        style: {},
        attributes: {},
        removed: false,
        setAttribute(name, value) {
          this.attributes[name] = value;
        },
        focus() {},
        select() {
          doc.selected = this.value;
        },
        setSelectionRange() {},
        remove() {
          this.removed = true;
        },
      };
    },
    execCommand(command) {
      if (throws) throw new Error('blocked');
      if (command !== 'copy') return false;
      if (copies) doc.copied.push(doc.selected);
      return copies;
    },
  };
  return doc;
}

test('copyText uses the Clipboard API when it is there', async () => {
  const written = [];
  const doc = fakeDocument();
  const ok = await copyText('hello', {
    clipboard: { writeText: async (text) => written.push(text) },
    document: doc,
    navigator: {},
  });
  assert.equal(ok, true);
  assert.deepEqual(written, ['hello']);
  assert.deepEqual(
    doc.copied,
    [],
    'no textarea copy when the clipboard took it',
  );
});

test('copyText falls back to a hidden textarea and execCommand when the Clipboard API is missing', async () => {
  // A plain http page (the phone mirror) has no navigator.clipboard.
  const doc = fakeDocument();
  const ok = await copyText('http://100.64.0.1:4173/#v=2', {
    navigator: {},
    document: doc,
  });
  assert.equal(ok, true);
  assert.deepEqual(doc.copied, ['http://100.64.0.1:4173/#v=2']);
  assert.equal(doc.appended.length, 1);
  const [area] = doc.appended;
  assert.equal(area.tag, 'textarea');
  assert.equal(area.attributes.readonly, '');
  assert.equal(area.removed, true, 'the textarea is taken out again');
  assert.deepEqual(doc.focused, ['previous'], 'focus goes back where it was');
});

test('copyText falls back to the textarea when the Clipboard API refuses', async () => {
  const doc = fakeDocument();
  const ok = await copyText('task', {
    clipboard: {
      writeText: async () => {
        throw new Error('NotAllowedError');
      },
    },
    navigator: {},
    document: doc,
  });
  assert.equal(ok, true);
  assert.deepEqual(doc.copied, ['task']);
});

test('copyText offers the share sheet when nothing else copies, and answers false when nothing took it', async () => {
  const shared = [];
  const viaShare = await copyText('link', {
    clipboard: null,
    document: fakeDocument({ copies: false }),
    navigator: { share: async (data) => shared.push(data) },
  });
  assert.equal(viaShare, true);
  assert.deepEqual(shared, [{ text: 'link' }]);

  const cancelled = await copyText('link', {
    clipboard: null,
    document: fakeDocument({ throws: true }),
    navigator: {
      share: async () => {
        throw new Error('AbortError');
      },
    },
  });
  assert.equal(cancelled, false);

  // No document at all (a worker or Node): still no throw, just false.
  assert.equal(
    await copyText('link', { clipboard: null, document: null, navigator: {} }),
    false,
  );
});
