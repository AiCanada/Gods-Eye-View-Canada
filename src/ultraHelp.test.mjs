import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { expandApplicationHtml } from '../build/application-html.js';
import {
  ULTRA_PHONE_MODELS,
  classifyUltraIncident,
  ultraCameraButtons,
  ultraCameraRole,
  ultraPhoneModel,
  ultraHelpMessage,
  normalizeUltraNumber,
} from './ultraHelp.mjs';

test('each handset offers only its own cameras, and a generic cell stops at four', () => {
  const ids = (modelId) => ultraCameraButtons(modelId).map((role) => role.id);
  assert.deepEqual(ids('generic-cell'), [
    'front',
    'rear',
    'rear-ultrawide',
    'rear-tele',
  ]);
  assert.equal(ids('generic-cell').length, 4);
  assert.deepEqual(ids('motorola'), ['front', 'rear', 'rear-ultrawide']);
  // iPhones are no longer listed: one saved before reads as the generic cell.
  assert.deepEqual(ids('apple-iphone-17'), ids('generic-cell'));
  assert.equal(ultraCameraRole('motorola', 'rear-tele'), null);
  assert.deepEqual(ids('motorola'), ['front', 'rear', 'rear-ultrawide']);
  assert.deepEqual(ids('google-pixel'), ids('generic-cell'));
  assert.deepEqual(ids('oppo'), ids('vivo'));
  assert.deepEqual(ids('xiaomi'), ids('samsung-s26'));
  assert.equal(ultraCameraRole('samsung-s22-ultra', 'inner'), null);
  assert.deepEqual(ids('samsung-z8'), [
    'front',
    'rear',
    'rear-ultrawide',
    'inner',
  ]);
  assert.equal(ultraCameraRole('samsung-z8', 'rear-tele'), null);
  assert.ok(
    ids('samsung-z3').includes('inner') &&
      ids('samsung-z3').includes('rear-tele'),
  );
  assert.deepEqual(ids('samsung-z-fold'), ids('samsung-z8'));
  assert.equal(ultraPhoneModel('missing').id, 'generic-cell');
  assert.equal(ultraPhoneModel('samsung-s3').id, 'samsung-z3');
  assert.equal(ultraPhoneModel('samsung-s6').id, 'generic-cell');
});

test('only a known class is an incident; panic and a bare word are rejected', () => {
  assert.equal(classifyUltraIncident('fire'), 'fire');
  assert.equal(classifyUltraIncident('Assault'), 'threat');
  assert.equal(classifyUltraIncident('panic'), null);
  assert.equal(classifyUltraIncident(''), null);
});

test('the SMS sentence names the place and the class', () => {
  assert.equal(
    ultraHelpMessage('Saint John (45.2700, -66.0600)', 'threat'),
    'Please HELP you are close by, to Saint John (45.2700, -66.0600) of victim in progress, threat thank you.',
  );
  assert.equal(normalizeUltraNumber('+1 (506) 555-0100'), '+15065550100');
  assert.equal(normalizeUltraNumber('5065550100'), null);
});

test('the Ultra box is a collapsed left-stack panel and the help module does not import CCTV', () => {
  const html = expandApplicationHtml(
    fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8'),
  );
  const panel = html.slice(
    html.indexOf('id="ultra-panel"'),
    html.indexOf('id="ultra-panel"') + 400,
  );
  assert.match(panel, /panel-collapsible collapsed/);
  assert.match(panel, /ULTRA SECURITY PACKAGE/);
  assert.match(html, /Activate Front Cell Cam/);
  assert.match(html, /Activate Rear Cell Cam/);
  assert.match(html, /Activate Inside Fold Cell Cam/);
  assert.doesNotMatch(html, /Activate Ultra /);
  // Find Ultra Help is under development: one disabled button, and no
  // search list, message box or Send Ultra Help.
  assert.match(
    html,
    /<button id="ultra-find"[^>]*\bdisabled\b[^>]*>Find Ultra Help \(under development\)<\/button>/,
  );
  assert.doesNotMatch(html, /id="ultra-(?:send|message|help-list)"/);
  assert.doesNotMatch(html, /Send Ultra Help|victim in progress/);
  // Share help tokens live in the same box: the inbox under the status line
  // and the token tools after the predefined helpers.
  const box = html.slice(
    html.indexOf('id="ultra-panel"'),
    html.indexOf('id="right-context-rail"'),
  );
  for (const id of [
    'ultra-inbox-count',
    'ultra-inbox',
    'ultra-read-aloud',
    'ultra-outbound-note',
    'ultra-token-note',
    'ultra-number-input',
    'ultra-number-clear',
    'ultra-token-label',
    'ultra-token-encrypt',
    'ultra-token-skills',
    'ultra-skill-dr',
    'ultra-skill-pm',
    'ultra-skill-fr',
    'ultra-skill-lg',
    'ultra-skill-ff',
    'ultra-skill-sr',
    'ultra-skill-br',
    'ultra-skill-st',
    'ultra-skill-cc',
    'ultra-skill-en',
    'ultra-skill-ac',
    'ultra-skill-hz',
    'ultra-skill-rg',
    'ultra-skill-custom-1',
    'ultra-skill-custom-2',
    'ultra-skill-custom-3',
    'ultra-skill-custom-4',
    'ultra-skill-custom-5',
    'ultra-skill-custom-preview',
    'ultra-token-network',
    'ultra-token-package',
    'ultra-token-reveal',
    'ultra-token-link',
    'ultra-token-copy-address',
    'ultra-token-copy',
    'ultra-token-hide',
    'ultra-tokens',
    // SEND HELP sits first under the status line; HELP NETWORK closes the box.
    'ultra-release-state',
    'ultra-release',
    'ultra-release-send',
    'ultra-release-stand-down',
    'ultra-release-note',
    'ultra-release-plea',
    'ultra-network-count',
    'ultra-network-note',
    'ultra-network-me',
    'ultra-network-me-name',
    'ultra-directory',
    'ultra-directory-url',
    'ultra-directory-token',
    'ultra-publish-token',
    'ultra-network-publish',
    'ultra-network-update',
    'ultra-network-poll',
    'ultra-network-entry',
    'ultra-network-entry-text',
    'ultra-network-entry-note',
    'ultra-network-entry-copy',
    'ultra-network-entry-mail',
    'ultra-network-entry-hide',
    'ultra-network-add',
    'ultra-network-address',
    'ultra-network-token',
    'ultra-network-link-name',
    'ultra-network-list',
    'ultra-sms-relay',
    'ultra-sms-test',
  ]) {
    assert.match(
      box,
      new RegExp(`id="${id}"`),
      `#${id} belongs to the Ultra box`,
    );
  }
  assert.match(box, /HELP MESSAGES/);
  assert.match(box, /SHARE ENCRYPTED ULTRA TOKENS/);
  for (const label of [
    'SEND HELP',
    'STAND DOWN',
    'HELP NETWORK',
    'PUBLISH MY TOKEN',
    'UPDATE HOME LIST',
    'ADD TO HOME LIST',
    'TEST SMS',
  ]) {
    assert.ok(box.includes(label), `${label} is in the Ultra box`);
  }
  assert.ok(
    box.indexOf('id="ultra-release"') < box.indexOf('HELP MESSAGES'),
    'SEND HELP sits before the help messages',
  );
  assert.ok(
    box.indexOf('id="ultra-inbox"') < box.indexOf('id="ultra-model"'),
    'help messages sit above the camera controls',
  );
  assert.ok(
    box.indexOf('id="ultra-contacts"') < box.indexOf('id="ultra-token-note"'),
    'token tools follow the predefined helpers',
  );
  assert.ok(
    box.indexOf('id="ultra-help-store-note"') <
      box.indexOf('id="ultra-outbound-note"') &&
      box.indexOf('id="ultra-outbound-note"') <
        box.indexOf('id="ultra-contacts"'),
    'the outbound note sits with the helpers note, ahead of the helpers',
  );
  assert.doesNotMatch(
    box.slice(
      box.indexOf('id="ultra-outbound-note"'),
      box.indexOf('id="ultra-contacts"'),
    ),
    /LAN/,
    'the outbound note does not say LAN',
  );
  assert.ok(
    box.indexOf('id="ultra-tokens"') < box.indexOf('id="ultra-network-note"'),
    'the help network follows the token rows',
  );
  for (const file of [
    './ultraHelp.mjs',
    '../server/shared/ultraTokens.mjs',
    '../server/shared/ultraNetwork.mjs',
    '../server/shared/ultraSmsRelay.mjs',
  ]) {
    const source = fs.readFileSync(new URL(file, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /cctv/i, `${file} does not import CCTV`);
  }
});

test('the plea names the items or the skill a call needs', async () => {
  const { ultraHelpMessage, ultraNeeds, ultraNeedsSkill, ultraNeedsSummary } =
    await import('./ultraHelp.mjs');
  const plain = ultraHelpMessage('1 Placeholder Road', 'fire');
  assert.equal(
    ultraHelpMessage('1 Placeholder Road', 'fire', null),
    plain,
    'no needs: the plea is unchanged',
  );
  assert.equal(
    ultraHelpMessage('1 Placeholder Road', 'fire', {
      kind: 'medicine',
      items: ['Insulin', 'Ventolin'],
    }),
    `${plain} Needed: Medicine: Insulin, Ventolin.`,
  );
  // Transportation is a skill, not an item.
  const ride = { kind: 'transportation', destination: 'hospital' };
  assert.equal(ultraNeedsSkill(ride), 'tr');
  assert.equal(ultraNeedsSkill({ kind: 'food', items: ['Bread'] }), '');
  assert.equal(
    ultraHelpMessage('1 Placeholder Road', 'fire', ride),
    `${plain} Skill needed: Transportation: from current location to Hospital.`,
  );
  // Anything else a stranger could send is dropped.
  assert.equal(ultraNeeds({ kind: 'weapons', items: ['x'] }), null);
  assert.equal(
    ultraNeeds({ kind: 'transportation', destination: 'mars' }),
    null,
  );
  assert.equal(ultraNeeds({ kind: 'items', items: ['x'.repeat(81)] }), null);
  assert.deepEqual(
    ultraNeeds({
      kind: 'items',
      items: ['Heart\nDefib', ' ', 'Spare', 'Third'],
      extra: 1,
    }),
    { kind: 'items', items: ['Heart Defib'], destination: '' },
  );
  assert.equal(ultraNeedsSummary(null), '');
});

test('needs never coerce a JSON object, and hidden characters are dropped from items', async () => {
  const {
    ULTRA_HIDDEN_TEXT,
    ultraHiddenText,
    normalizeUltraNeeds,
    ultraNeeds,
  } = await import('./ultraHelp.mjs');
  // {"toString": null} is reachable from JSON; String() on it would throw.
  const hostile = JSON.parse('{"toString":null}');
  assert.equal(
    normalizeUltraNeeds({ kind: 'transportation', destination: hostile }).ok,
    false,
  );
  assert.equal(
    ultraNeeds({ kind: 'transportation', destination: hostile }),
    null,
  );
  assert.equal(
    normalizeUltraNeeds({ kind: 'food', items: [hostile] }).ok,
    false,
  );
  assert.equal(ultraNeeds({ kind: 'food', items: [hostile] }), null);
  assert.equal(normalizeUltraNeeds({ kind: 'food', items: hostile }).ok, false);
  assert.equal(ultraNeeds({ kind: 'food', items: hostile }), null);
  // A non-string item is an empty box; a string beside it still counts.
  assert.deepEqual(ultraNeeds({ kind: 'food', items: [hostile, 'Bread'] }), {
    kind: 'food',
    items: ['Bread'],
    destination: '',
  });
  assert.deepEqual(ultraNeeds({ kind: 'food', items: [12, 'Bread'] }), {
    kind: 'food',
    items: ['Bread'],
    destination: '',
  });
  // Nothing hostile throws out of ultraNeeds.
  const trap = new Proxy(
    {},
    {
      get() {
        throw new Error('trap');
      },
    },
  );
  assert.equal(ultraNeeds(trap), null);
  assert.equal(ultraNeeds({ kind: 'food', items: trap }), null);
  // Bidi override, zero-width space, isolates and the byte-order mark go.
  assert.deepEqual(
    ultraNeeds({
      kind: 'medicine',
      items: ['\u202eIns\u200bulin\u2066 2\u2069 mg\ufeff', '\u202e\u200b'],
    }),
    { kind: 'medicine', items: ['Insulin 2 mg'], destination: '' },
  );
  // The exported class is a plain string; the factory is a fresh global RegExp.
  assert.equal(typeof ULTRA_HIDDEN_TEXT, 'string');
  const first = ultraHiddenText();
  assert.notEqual(first, ultraHiddenText());
  assert.ok(first.global);
  for (const hidden of ['\u202e', '\u200b', '\u2066', '\u2069', '\ufeff']) {
    assert.ok(
      ultraHiddenText().test(hidden),
      `hides U+${hidden.codePointAt(0).toString(16)}`,
    );
  }
  assert.ok(!ultraHiddenText().test('a\tb\n'));
  // The same set ultraTokens.mjs strips from help text.
  const tokens = fs.readFileSync(
    new URL('../server/shared/ultraTokens.mjs', import.meta.url),
    'utf8',
  );
  assert.ok(
    tokens.includes('[' + ULTRA_HIDDEN_TEXT + ']') ||
      tokens.includes('ULTRA_HIDDEN_TEXT'),
    'ultraTokens.mjs uses the same hidden-character set',
  );
  // Sanity: the Mr./Mrs. Nice Guy skill label has nothing to strip.
  const niceGuy = 'Mr./Mrs. Nice Guy';
  assert.equal(niceGuy.replace(ultraHiddenText(), ''), niceGuy);
  assert.deepEqual(ultraNeeds({ kind: 'items', items: [niceGuy] }), {
    kind: 'items',
    items: [niceGuy],
    destination: '',
  });
  assert.match(tokens, /code: 'ng', label: 'Mr\.\/Mrs\. Nice Guy'/);
});
