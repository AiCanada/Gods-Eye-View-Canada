import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  createUiControlRegistry,
  listUiControls,
  normalizeControlLabel,
  useUiControl,
} from './uiControls.js';
import { watchOwnerRemoval } from '../ui/ownerRemoval.js';
import { responseInstructionForToolResult } from './realtimeProtocol.js';

// A small DOM: enough elements, attributes and selectors for the module.
class FakeEvent {
  constructor(type) {
    this.type = type;
  }
}

function matchesOne(el, selector) {
  const not = [];
  let rest = selector.replace(/:not\(([^)]*)\)/g, (_, inner) => {
    not.push(inner);
    return '';
  });
  for (const inner of not) if (matchesOne(el, inner)) return false;
  const tag = rest.match(/^[a-z]+/)?.[0];
  if (tag && el.tagName.toLowerCase() !== tag) return false;
  rest = rest.slice(tag?.length || 0);
  for (const [, kind, name, value] of rest
    .matchAll(/([#.])([\w-]+)|\[([\w-]+)(?:="([^"]*)")?\]/g)
    .map((m) => (m[1] ? [null, m[1], m[2]] : [null, '[', m[3], m[4]]))) {
    if (kind === '#' && el.getAttribute('id') !== name) return false;
    if (kind === '.' && !el.classList.contains(name)) return false;
    if (kind === '[') {
      const actual = el.getAttribute(name);
      if (actual === null) return false;
      if (value !== undefined && actual !== value) return false;
    }
  }
  return true;
}

const matches = (el, selectors) =>
  selectors.split(',').some((selector) => matchesOne(el, selector.trim()));

class FakeElement {
  constructor(doc, tagName, attrs = {}, text = '') {
    this.ownerDocument = doc;
    this.tagName = tagName.toUpperCase();
    this.attrs = new Map(Object.entries(attrs));
    this.children = [];
    this.parent = null;
    this.ownText = text;
    this.clicks = 0;
    this.events = [];
    this.value = attrs.value ?? '';
    this.type = attrs.type ?? (tagName === 'button' ? 'submit' : 'text');
    this.checked = false;
    this.disabled = 'disabled' in attrs;
    this.onClick = null;
    const el = this;
    this.classList = {
      contains: (name) => el.classes().includes(name),
      add: (name) =>
        el.setAttribute('class', [...el.classes(), name].join(' ')),
      remove: (name) =>
        el.setAttribute(
          'class',
          el
            .classes()
            .filter((one) => one !== name)
            .join(' '),
        ),
    };
  }
  classes() {
    return String(this.getAttribute('class') || '')
      .split(/\s+/)
      .filter(Boolean);
  }
  get hidden() {
    return this.attrs.has('hidden');
  }
  get isConnected() {
    return true;
  }
  get textContent() {
    return [this.ownText, ...this.children.map((child) => child.textContent)]
      .filter(Boolean)
      .join(' ');
  }
  get options() {
    return this.children.filter((child) => child.tagName === 'OPTION');
  }
  get selectedIndex() {
    return Math.max(
      0,
      this.options.findIndex((option) => option.value === this.value),
    );
  }
  getAttribute(name) {
    return this.attrs.has(name) ? String(this.attrs.get(name)) : null;
  }
  setAttribute(name, value) {
    this.attrs.set(name, value);
  }
  append(...children) {
    for (const child of children) {
      child.parent = this;
      this.children.push(child);
    }
    return this;
  }
  closest(selectors) {
    for (let el = this; el; el = el.parent)
      if (el.tagName && matches(el, selectors)) return el;
    return null;
  }
  descendants() {
    return this.children.flatMap((child) => [child, ...child.descendants()]);
  }
  querySelectorAll(selectors) {
    return this.descendants().filter((el) => matches(el, selectors));
  }
  querySelector(selectors) {
    return this.querySelectorAll(selectors)[0] || null;
  }
  getClientRects() {
    // Laid out unless something above is a collapsed panel.
    return this.closest('.collapsed') ? [] : [{}];
  }
  click() {
    this.clicks += 1;
    if (this.tagName === 'INPUT' && ['checkbox', 'radio'].includes(this.type))
      this.checked = this.type === 'radio' ? true : !this.checked;
    this.onClick?.();
  }
  dispatchEvent(event) {
    this.events.push(event.type);
  }
  focus() {}
}

// The Outbreak box's epidemic-model controls (docs/outbreak-epidemic-model.md)
// with the id and label the markup gives each: [id, label, kind, extra], the
// extra being a menu's options (the model's) or a number's [min, max].
const NEW_OUTBREAK_CONTROLS = [
  ['outbreak-hospital-days', 'Hospital stay (days)', 'number', [1, 60]],
  ['outbreak-icu', 'Intensive care (% of hospitalised)', 'number', [0, 100]],
  ['outbreak-admit-delay', 'Admission delay (days)', 'number', [0, 14]],
  ['outbreak-waning', 'Immunity wanes after (days)', 'number', [0, 3650]],
  [
    'outbreak-variants',
    'Variant emergence',
    'select',
    [
      ['drift', 'Steady drift'],
      ['takeover', 'A fitter strain takes over'],
      ['two-strain', 'Second strain (set below)'],
    ],
  ],
  ['outbreak-strain2-day', 'Second strain starts (day)', 'number', [0, 40]],
  ['outbreak-strain2-cases', 'Second strain seed cases', 'number', [1, 100000]],
  ['outbreak-strain2-place', 'Second strain airport code', 'text'],
  [
    'outbreak-strain2-spread',
    'Second strain transmissibility (% of first)',
    'number',
    [10, 300],
  ],
  [
    'outbreak-strain2-severity',
    'Second strain severity (% of first)',
    'number',
    [10, 500],
  ],
  [
    'outbreak-cross-immunity',
    'Cross-immunity (% of first-strain immunity kept)',
    'number',
    [0, 100],
  ],
  [
    'outbreak-heterogeneity',
    'Susceptibility variation',
    'select',
    [
      ['none', 'None (everyone alike)'],
      ['moderate', 'Moderate (CV 1)'],
      ['high', 'High (CV 2)'],
    ],
  ],
  [
    'outbreak-mixing',
    'Commuting mixing',
    'select',
    [
      ['home', 'Home only (one way)'],
      ['daytime', 'Daytime two-way'],
    ],
  ],
  [
    'outbreak-commute-day',
    'Commuting concentrated in daytime',
    'number',
    [0.5, 1],
  ],
  [
    'outbreak-clock',
    'Departure clock',
    'select',
    [
      ['utc', 'UTC hours'],
      ['local', 'Local hours'],
    ],
  ],
  [
    'outbreak-transfers',
    'Airport transfers',
    'select',
    [
      ['none', 'None'],
      ['some', 'Some connecting passengers'],
      ['hub-heavy', 'Hub heavy'],
    ],
  ],
  [
    'outbreak-response-signal',
    'Response signal',
    'select',
    [
      ['reported', 'Reported cases'],
      ['deaths', 'Deaths'],
      ['both', 'Both'],
    ],
  ],
  [
    'outbreak-response-reach',
    'Response reach',
    'select',
    [
      ['local', 'Own place'],
      ['mixed', 'Mixed'],
      ['global', 'Everywhere'],
    ],
  ],
  [
    'outbreak-response-fatigue',
    'Awareness fatigue (days to halve)',
    'number',
    [0, 180],
  ],
  ['outbreak-vaccinated', 'Vaccinated at the start (%)', 'number', [0, 100]],
  ['outbreak-vaccine-efficacy', 'Vaccine protection (%)', 'number', [0, 100]],
  [
    'outbreak-travel-domestic',
    'Domestic flights (% of normal)',
    'number',
    [0, 300],
  ],
  [
    'outbreak-travel-intl',
    'International flights (% of normal)',
    'number',
    [0, 300],
  ],
  [
    'outbreak-intervention-days',
    'Interventions end after (days)',
    'number',
    [0, 40],
  ],
  [
    'outbreak-trigger-mode',
    'Local trigger',
    'select',
    [
      ['everywhere', 'Everywhere at the start hour'],
      ['reported', 'Reported cases per 100,000'],
      ['hospital', 'Hospital load'],
    ],
  ],
  [
    'outbreak-trigger-level',
    'Case trigger (reported per 100,000 in 7 days)',
    'number',
    [0, 500],
  ],
  ['outbreak-trigger-beds', 'Bed trigger (% of beds full)', 'number', [0, 100]],
  ['outbreak-min-lock-days', 'Minimum restriction (days)', 'number', [1, 28]],
  [
    'outbreak-restriction-fatigue',
    'Restriction fatigue (days to halve compliance)',
    'number',
    [0, 180],
  ],
  [
    'outbreak-lockdown-scope',
    'Lockdown reach',
    'select',
    [
      ['all', 'Everyone (household too)'],
      ['community', 'Outside the home only'],
    ],
  ],
  [
    'outbreak-border-policy',
    'Border policy',
    'select',
    [
      ['none', 'Every flight'],
      ['origin', 'Flights out of the outbreak countries'],
      ['reported', 'Flights out of countries reaching the trigger'],
      ['all', 'Every international flight'],
    ],
  ],
  [
    'outbreak-border-trigger',
    'Border trigger (reported cases in the country)',
    'number',
    [1, 100000],
  ],
  [
    'outbreak-import-detection',
    'Detection of arriving cases',
    'select',
    [
      ['off', 'Off'],
      ['low', 'Low'],
      ['medium', 'Medium'],
      ['high', 'High'],
    ],
  ],
  [
    'outbreak-test-capacity',
    'Testing capacity (tests per 1,000 people a day)',
    'number',
    [0, 50],
  ],
  ['outbreak-vaccine-start', 'Vaccination starts (day)', 'number', [0, 40]],
  [
    'outbreak-vaccine-pace',
    'Vaccination pace (doses per 1,000 people a day)',
    'number',
    [0, 50],
  ],
  ['outbreak-vaccine-cap', 'Vaccination cap (% of people)', 'number', [0, 95]],
  [
    'outbreak-vaccine-priority',
    'Vaccination priority',
    'select',
    [
      ['everywhere', 'Everywhere'],
      ['origin-first', 'Outbreak places first'],
    ],
  ],
  [
    'outbreak-compare',
    'Compare against',
    'select',
    [
      ['none', 'Nothing'],
      ['all', 'No interventions'],
      ['travel', 'No travel measures'],
      ['distancing', 'No lockdown or tracing'],
      ['vaccination', 'No vaccination campaign'],
    ],
  ],
  ['outbreak-epi-seed', 'Random seed', 'number', [0, 4294967295]],
  ['outbreak-epi-download', 'DOWNLOAD RESULTS', 'button'],
  ['outbreak-epi-csv', 'DOWNLOAD CSV', 'button'],
];

/** A labelled field or menu as the Outbreak box lays one out. */
function fieldOf(make, [id, label, kind, extra = []]) {
  if (kind === 'button') return [make('button', { id, type: 'button' }, label)];
  const el = make(kind === 'select' ? 'select' : 'input', {
    id,
    ...(kind === 'number'
      ? { type: 'number', min: String(extra[0]), max: String(extra[1]) }
      : {}),
    ...(kind === 'text' ? { type: 'text' } : {}),
    'aria-label': label,
  });
  if (kind === 'select') {
    el.append(
      make('option', { value: '' }, 'Not set'),
      ...extra.map(([value, text]) => make('option', { value }, text)),
    );
  }
  return [make('label', { for: id }, label), el];
}

function page() {
  const doc = {
    defaultView: { Event: FakeEvent, KeyboardEvent: FakeEvent },
  };
  const make = (tag, attrs, text) => new FakeElement(doc, tag, attrs, text);
  const body = make('body');
  doc.body = body;
  doc.getElementById = (id) =>
    body.descendants().find((el) => el.getAttribute('id') === id) || null;
  doc.querySelector = (selectors) => body.querySelector(selectors);
  doc.querySelectorAll = (selectors) => body.querySelectorAll(selectors);

  const panel = (id, title, collapsed = false) =>
    make('div', {
      id,
      'data-panel-id': id,
      class: `panel-collapsible${collapsed ? ' collapsed' : ''}`,
    }).append(
      make(
        'span',
        {
          class: 'panel-title',
          'data-collapsed-title': title,
        },
        title,
      ),
    );

  const outbreak = panel('outbreak-panel', 'OUTBREAK', true);
  const runModel = make(
    'button',
    { id: 'outbreak-epi-run' },
    'RUN EPIDEMIC MODEL',
  );
  const clearMap = make('button', {}, 'CLEAR MAP');
  const preset = make('select', { id: 'outbreak-preset' });
  preset.append(
    make('option', { value: 'custom' }, 'Custom'),
    make('option', { value: 'covid-2020' }, 'COVID-19 2020'),
    make('option', { value: 'measles' }, 'Measles'),
  );
  preset.value = 'custom';
  outbreak.append(
    runModel,
    clearMap,
    make('label', { for: 'outbreak-preset' }, 'Pathogen preset'),
    preset,
    ...fieldOf(make, [
      'outbreak-age',
      'Age structure',
      'select',
      [
        ['young', 'Young'],
        ['mixed', 'Mixed'],
        ['old', 'Old'],
      ],
    ]),
    ...NEW_OUTBREAK_CONTROLS.flatMap((control) => fieldOf(make, control)),
  );

  const ultra = panel('ultra-panel', 'ULTRA');
  const ultraScan = make('button', {}, 'SCAN');
  const sendHelp = make('button', {}, 'SEND HELP');
  const keyField = make('input', {
    id: 'ultra-token',
    type: 'text',
    'aria-label': 'Ultra token',
  });
  const photos = make('input', { id: 'ultra-show-photos', type: 'checkbox' });
  photos.checked = true;
  ultra.append(
    ultraScan,
    sendHelp,
    keyField,
    make('label', {}, 'Show photos on map').append(photos),
  );

  const social = panel('social-panel', 'SOCIAL MEDIA');
  const socialScan = make('button', {}, 'SCAN');
  const search = make('input', {
    id: 'social-query',
    placeholder: 'Search posts',
  });
  const range = make('input', {
    id: 'social-hours',
    type: 'range',
    min: '1',
    max: '72',
    'aria-label': 'Hours',
  });
  range.value = '24';
  social.append(socialScan, search, range);

  const voice = make('div', { id: 'gev-voice-control' }).append(
    make('button', { id: 'gev-voice-button' }, 'VOICE'),
  );
  const greyed = make('button', { disabled: '' }, 'EXPORT');
  const symbolOnly = make('button', { class: 'panel-collapse-btn' }, '+');
  body.append(outbreak, ultra, social, voice, greyed, symbolOnly);
  return {
    byId: (id) => doc.getElementById(id),
    doc,
    outbreak,
    runModel,
    clearMap,
    preset,
    ultraScan,
    sendHelp,
    keyField,
    photos,
    socialScan,
    search,
    range,
    greyed,
  };
}

const open = (p) => (panelId) => {
  assert.equal(panelId, 'outbreak-panel');
  p.outbreak.classList.remove('collapsed');
};

test('spoken and written labels compare as plain words', () => {
  assert.equal(
    normalizeControlLabel('  RUN Epidemic-Model! '),
    'run epidemic model',
  );
  assert.equal(
    normalizeControlLabel('Outbreak &amp; spread'),
    'outbreak & spread',
  );
});

test('the list is what is on screen, with panels, kinds and values; never the voice button', () => {
  const p = page();
  const registry = createUiControlRegistry({ root: p.doc });
  const listed = listUiControls(registry);
  assert.equal(listed.ok, true);
  const labels = listed.controls.map((control) => control.label);
  assert.ok(labels.includes('SEND HELP'));
  assert.ok(labels.includes('Show photos on map'));
  assert.ok(!labels.includes('VOICE'), 'the voice control is out of reach');
  assert.ok(
    !labels.includes('RUN EPIDEMIC MODEL'),
    'collapsed panels are not on screen',
  );
  assert.ok(!labels.includes('+'), 'a lone symbol is no label');
  const hours = listed.controls.find((control) => control.label === 'Hours');
  assert.deepEqual(
    {
      kind: hours.kind,
      value: hours.value,
      min: hours.min,
      max: hours.max,
      panelId: hours.panelId,
    },
    {
      kind: 'range',
      value: '24',
      min: '1',
      max: '72',
      panelId: 'social-panel',
    },
  );
  const token = listed.controls.find(
    (control) => control.label === 'Ultra token',
  );
  assert.equal(token.typeYourself, true);
  assert.equal(token.value, undefined, 'a key field never reports its value');
  assert.equal(
    listed.controls.find((c) => c.label === 'EXPORT').disabled,
    true,
  );

  // Asking for a panel includes its controls while it is collapsed.
  const outbreak = registry.list({ panelId: 'outbreak-panel' });
  const preset = outbreak.controls.find(
    (control) => control.label === 'Pathogen preset',
  );
  assert.equal(preset.kind, 'select');
  assert.equal(preset.inCollapsedPanel, 'outbreak-panel');
  assert.deepEqual(preset.options, ['Custom', 'COVID-19 2020', 'Measles']);
  assert.equal(
    registry.list({ query: 'epidemic' }).controls[0].ref,
    '#outbreak-epi-run',
  );
});

test('a spoken label presses its button, opening the collapsed panel first', async () => {
  const p = page();
  const registry = createUiControlRegistry({ root: p.doc });
  const result = await useUiControl(
    registry,
    { label: 'run the epidemic model', action: 'press' },
    { openPanel: open(p) },
  );
  assert.equal(result.ok, true, result.error);
  assert.equal(p.runModel.clicks, 1);
  assert.equal(result.say, 'Pressed RUN EPIDEMIC MODEL.');
  assert.ok(!p.outbreak.classList.contains('collapsed'));
});

test('without a way to open it, a control in a closed box is not pressed', async () => {
  const p = page();
  const result = await useUiControl(createUiControlRegistry({ root: p.doc }), {
    label: 'RUN EPIDEMIC MODEL',
    action: 'press',
  });
  assert.equal(result.ok, false);
  assert.equal(p.runModel.clicks, 0);
});

test('a label in two panels asks which; the panel or a ref settles it', async () => {
  const p = page();
  const registry = createUiControlRegistry({ root: p.doc });
  const both = await useUiControl(registry, { label: 'scan', action: 'press' });
  assert.equal(both.ok, false);
  assert.deepEqual(both.candidates.map((control) => control.panelId).sort(), [
    'social-panel',
    'ultra-panel',
  ]);
  assert.equal(p.ultraScan.clicks + p.socialScan.clicks, 0);
  assert.equal(
    (await useUiControl(registry, { label: 'ultra scan', action: 'press' })).ok,
    true,
  );
  assert.equal(p.ultraScan.clicks, 1);
  const social = both.candidates.find((c) => c.panelId === 'social-panel');
  assert.equal(
    (await useUiControl(registry, { ref: social.ref, action: 'press' })).ok,
    true,
  );
  assert.equal(p.socialScan.clicks, 1);
});

test("risky buttons wait for the user's yes", async () => {
  const p = page();
  const registry = createUiControlRegistry({ root: p.doc });
  const asked = await useUiControl(registry, {
    label: 'send help',
    action: 'press',
  });
  assert.equal(asked.ok, false);
  assert.equal(asked.needsConfirmation, true);
  assert.match(asked.say, /SEND HELP\?$/);
  assert.equal(p.sendHelp.clicks, 0);
  const done = await useUiControl(registry, {
    label: 'send help',
    action: 'press',
    confirmed: true,
  });
  assert.equal(done.ok, true);
  assert.equal(p.sendHelp.clicks, 1);
});

test('key and password fields are never filled by voice', async () => {
  const p = page();
  const result = await useUiControl(createUiControlRegistry({ root: p.doc }), {
    label: 'ultra token',
    action: 'set',
    value: 'abc123',
  });
  assert.equal(result.ok, false);
  assert.equal(result.typeYourself, true);
  assert.equal(p.keyField.value, '');
  assert.deepEqual(p.keyField.events, []);
});

test('menus, ticks, sliders and text fields take values', async () => {
  const p = page();
  const registry = createUiControlRegistry({ root: p.doc });
  const preset = await useUiControl(
    registry,
    { label: 'pathogen preset', action: 'set', value: 'covid 19 2020' },
    { openPanel: open(p) },
  );
  assert.equal(preset.ok, true, preset.error);
  assert.equal(p.preset.value, 'covid-2020');
  assert.deepEqual(p.preset.events, ['input', 'change']);
  assert.equal(preset.say, 'Pathogen preset set to COVID-19 2020.');
  const missing = await useUiControl(registry, {
    label: 'pathogen preset',
    action: 'set',
    value: 'plague',
  });
  assert.equal(missing.ok, false);

  const off = await useUiControl(registry, {
    label: 'show photos on map',
    action: 'set',
    value: 'off',
  });
  assert.equal(off.ok, true);
  assert.equal(p.photos.checked, false);
  await useUiControl(registry, {
    label: 'show photos on map',
    action: 'set',
    value: 'off',
  });
  assert.equal(p.photos.clicks, 1, 'already off: not clicked again');
  await useUiControl(registry, {
    label: 'show photos on map',
    action: 'toggle',
  });
  assert.equal(p.photos.checked, true);

  const hours = await useUiControl(registry, {
    label: 'hours',
    action: 'set',
    value: '500',
  });
  assert.equal(hours.ok, true);
  assert.equal(p.range.value, '72', 'a slider stays inside its range');

  const typed = await useUiControl(registry, {
    label: 'search posts',
    action: 'set',
    value: 'flooding Calgary',
    pressEnter: true,
  });
  assert.equal(typed.ok, true);
  assert.equal(p.search.value, 'flooding Calgary');
  assert.deepEqual(p.search.events, ['input', 'change', 'keydown', 'keyup']);
});

test('greyed-out and unknown controls fail plainly', async () => {
  const p = page();
  const registry = createUiControlRegistry({ root: p.doc });
  const greyed = await useUiControl(registry, {
    label: 'export',
    action: 'press',
  });
  assert.equal(greyed.ok, false);
  assert.match(greyed.say, /greyed out/);
  assert.equal(p.greyed.clicks, 0);
  const none = await useUiControl(registry, {
    label: 'launch rocket',
    action: 'press',
  });
  assert.equal(none.ok, false);
  assert.match(none.error, /No "launch rocket" control/);
  const buttonSet = await useUiControl(registry, {
    label: 'send help',
    action: 'set',
    value: 'x',
  });
  assert.equal(buttonSet.ok, false);
  assert.equal(p.sendHelp.clicks, 0);
});

test('the epidemic-model controls answer to their labels, and only one each', async () => {
  const p = page();
  const registry = createUiControlRegistry({ root: p.doc });
  const options = { openPanel: open(p) };

  const variation = await useUiControl(
    registry,
    { label: 'susceptibility variation', action: 'set', value: 'high' },
    options,
  );
  assert.equal(variation.ok, true, variation.error);
  assert.equal(p.byId('outbreak-heterogeneity').value, 'high');
  assert.equal(variation.say, 'Susceptibility variation set to High (CV 2).');
  assert.equal(
    registry.find({ label: 'age structure' }).control.ref,
    '#outbreak-age',
    'Age structure is still its own control',
  );

  const stay = await useUiControl(
    registry,
    { label: 'hospital stay', action: 'set', value: '12' },
    options,
  );
  assert.equal(stay.ok, true, stay.error);
  assert.equal(p.byId('outbreak-hospital-days').value, '12');

  // The two triggers were renamed so a spoken "trigger level" cannot tie.
  const level = await useUiControl(registry, {
    label: 'trigger level',
    action: 'set',
    value: '5',
  });
  assert.equal(level.ok, false);
  assert.match(level.error, /No "trigger level" control/);
  assert.equal(
    registry.find({ label: 'case trigger' }).control.ref,
    '#outbreak-trigger-level',
  );
  assert.equal(
    registry.find({ label: 'bed trigger' }).control.ref,
    '#outbreak-trigger-beds',
  );
  assert.match(
    registry.find({ label: 'trigger' }).error,
    /More than one "trigger" control/,
  );

  // Awareness fatigue and restriction fatigue are two controls.
  assert.equal(
    registry.find({ label: 'awareness fatigue' }).control.ref,
    '#outbreak-response-fatigue',
  );
  assert.equal(
    registry.find({ label: 'restriction fatigue' }).control.ref,
    '#outbreak-restriction-fatigue',
  );

  // A seed is not a key: voice may type it.
  const seed = await useUiControl(
    registry,
    { label: 'random seed', action: 'set', value: '7' },
    options,
  );
  assert.equal(seed.ok, true, seed.error);
  assert.equal(seed.typeYourself, undefined);
  assert.equal(p.byId('outbreak-epi-seed').value, '7');

  // Every new control resolves to its own id by its full label.
  for (const [id, label] of NEW_OUTBREAK_CONTROLS) {
    const found = registry.find({ label });
    assert.equal(found.control?.ref, `#${id}`, found.error);
  }

  // The second strain and the comparison are set by their spoken labels.
  const variant = await useUiControl(
    registry,
    { label: 'variant emergence', action: 'set', value: 'second strain' },
    options,
  );
  assert.equal(variant.ok, true, variant.error);
  assert.equal(p.byId('outbreak-variants').value, 'two-strain');
  const compare = await useUiControl(
    registry,
    { label: 'compare against', action: 'set', value: 'no interventions' },
    options,
  );
  assert.equal(compare.ok, true, compare.error);
  assert.equal(p.byId('outbreak-compare').value, 'all');
  const place = await useUiControl(
    registry,
    { label: 'second strain airport code', action: 'set', value: 'LHR' },
    options,
  );
  assert.equal(place.ok, true, place.error);
  assert.equal(place.typeYourself, undefined);
  assert.equal(p.byId('outbreak-strain2-place').value, 'LHR');

  // "Second strain" alone names five controls: the voice asks which.
  assert.match(
    registry.find({ label: 'second strain' }).error,
    /More than one "second strain" control/,
  );
});

/** A page of `count` buttons, in one panel when `panelId` is given. */
function manyControls(count, panelId = '') {
  const doc = {
    defaultView: { Event: FakeEvent, KeyboardEvent: FakeEvent },
  };
  const make = (tag, attrs, text) => new FakeElement(doc, tag, attrs, text);
  const body = make('body');
  doc.body = body;
  doc.querySelector = (selectors) => body.querySelector(selectors);
  doc.querySelectorAll = (selectors) => body.querySelectorAll(selectors);
  const buttons = Array.from({ length: count }, (_, i) =>
    make('button', { id: `control-${i}` }, `Control number ${i + 1}`),
  );
  if (panelId) {
    body.append(
      make('div', {
        id: panelId,
        'data-panel-id': panelId,
        class: 'panel-collapsible',
      }).append(...buttons),
    );
  } else body.append(...buttons);
  return createUiControlRegistry({ root: doc });
}

test('a whole-page listing keeps its cap of 60, and 120 at most', () => {
  const seventy = manyControls(70);
  const listed = seventy.list();
  assert.equal(listed.total, 70);
  assert.equal(listed.controls.length, 60);
  assert.equal(listed.truncated, true);
  const asked = seventy.list({ limit: 200 });
  assert.equal(asked.controls.length, 70);
  assert.equal(asked.truncated, undefined);
  const many = manyControls(130).list({ limit: 200 });
  assert.equal(many.controls.length, 120);
  assert.equal(many.truncated, true);
});

test('a one-panel listing shows up to 150, and an asked-for limit still holds', () => {
  const registry = manyControls(160, 'big-panel');
  const listed = registry.list({ panelId: 'big-panel' });
  assert.equal(listed.total, 160);
  assert.equal(listed.controls.length, 150);
  assert.equal(listed.truncated, true);
  const sixty = registry.list({ panelId: 'big-panel', limit: 60 });
  assert.equal(sixty.controls.length, 60);
  assert.equal(sixty.truncated, true);
  const most = registry.list({ panelId: 'big-panel', limit: 500 });
  assert.equal(most.controls.length, 150);
});

/* ── The real Outbreak box, read from the markup ───────────────────────── */

const TEMPLATE = new URL('../ui/templates/layer-panels.html', import.meta.url);
const decode = (text) => String(text ?? '').replace(/&amp;/g, '&');

function attributesOf(text) {
  const attrs = {};
  for (const [, name, value] of text.matchAll(/([\w-]+)(?:="([^"]*)")?/g))
    attrs[name] = decode(value ?? '');
  return attrs;
}

/**
 * The Outbreak box as layer-panels.html lays it out: every button, input and
 * select in document order, with its attributes, options and <label for>.
 * The box is the last panel in the file.
 */
function outbreakBoxFromMarkup(make) {
  const html = readFileSync(TEMPLATE, 'utf8');
  const start = html.indexOf('<div id="outbreak-panel"');
  assert.ok(start >= 0, 'the Outbreak box is in the markup');
  const part = html.slice(start);
  const box = make('div', {
    id: 'outbreak-panel',
    'data-panel-id': 'outbreak-panel',
    class: 'panel-collapsible collapsed',
  }).append(
    make(
      'span',
      {
        class: 'panel-title',
        'data-collapsed-title': 'OUTBREAK LOCATIONS & PREDICTED SPREAD',
      },
      'OUTBREAK LOCATIONS & PREDICTED SPREAD',
    ),
  );
  const labels = new Map();
  for (const [, id, text] of part.matchAll(
    /<label for="([^"]+)"[^>]*>([^<]*)<\/label>/g,
  ))
    labels.set(id, decode(text).trim());
  const controls = [];
  for (const m of part.matchAll(/<(input|select|button)\b([^>]*?)\/?>/g)) {
    const [tag, attrs] = [m[1], attributesOf(m[2])];
    const after = m.index + m[0].length;
    const label = attrs.id && labels.get(attrs.id);
    if (label) box.append(make('label', { for: attrs.id }, label));
    let el;
    if (tag === 'button') {
      const text = part.slice(after, part.indexOf('</button>', after));
      el = make('button', attrs, decode(text.replace(/<[^>]+>/g, '')).trim());
    } else {
      el = make(tag, attrs);
      if (tag === 'select') {
        const inner = part.slice(after, part.indexOf('</select>', after));
        for (const [, value, text] of inner.matchAll(
          /<option value="([^"]*)"[^>]*>([^<]*)<\/option>/g,
        ))
          el.append(make('option', { value }, decode(text)));
      }
      if ('checked' in attrs) el.checked = true;
    }
    box.append(el);
    controls.push(el);
  }
  return { box, controls };
}

test('the real Outbreak box: every new control answers to its label, past the 60th', async () => {
  const doc = {
    defaultView: { Event: FakeEvent, KeyboardEvent: FakeEvent },
  };
  const make = (tag, attrs, text) => new FakeElement(doc, tag, attrs, text);
  const body = make('body');
  doc.body = body;
  doc.getElementById = (id) =>
    body.descendants().find((el) => el.getAttribute('id') === id) || null;
  doc.querySelector = (selectors) => body.querySelector(selectors);
  doc.querySelectorAll = (selectors) => body.querySelectorAll(selectors);
  const { box, controls } = outbreakBoxFromMarkup(make);
  body.append(box);
  const registry = createUiControlRegistry({ root: doc });
  const openBox = (panelId) => {
    assert.equal(panelId, 'outbreak-panel');
    box.classList.remove('collapsed');
  };

  // The box holds more controls than one listing shows.
  const listed = registry.list({ panelId: 'outbreak-panel', limit: 60 });
  assert.ok(controls.length > 60, `${controls.length} controls`);
  assert.equal(listed.total, controls.length);
  assert.equal(listed.controls.length, 60);
  assert.equal(listed.truncated, true);
  const shown = new Set(listed.controls.map((control) => control.ref));

  // Every new control has the designed label, resolves alone, and no label in
  // the box is a prefix of it or it of another (the find() prefix rule).
  const every = registry.list({ panelId: 'outbreak-panel', limit: 120 });
  assert.equal(every.truncated, undefined);
  const words = every.controls.map((control) => ({
    ref: control.ref,
    label: normalizeControlLabel(control.label),
  }));
  let beyond = 0;
  for (const [id, label] of NEW_OUTBREAK_CONTROLS) {
    const found = registry.find({ label });
    assert.equal(found.control?.ref, `#${id}`, found.error);
    assert.equal(found.control.label, label);
    const mine = normalizeControlLabel(label);
    for (const other of words) {
      if (other.ref === `#${id}`) continue;
      const shorter = Math.min(mine.length, other.label.length);
      assert.ok(
        !(
          shorter >= 3 &&
          (mine.startsWith(other.label) || other.label.startsWith(mine))
        ),
        `"${label}" and ${other.ref} "${other.label}" overlap`,
      );
    }
    if (!shown.has(`#${id}`)) beyond += 1;
  }
  assert.ok(beyond > 0, 'some new controls sit past the 60th');

  // One past the 60th is set by label like any other.
  assert.ok(!shown.has('#outbreak-vaccine-cap'));
  const cap = await useUiControl(
    registry,
    { label: 'vaccination cap', action: 'set', value: '50' },
    { openPanel: openBox },
  );
  assert.equal(cap.ok, true, cap.error);
  assert.equal(doc.getElementById('outbreak-vaccine-cap').value, '50');
  assert.equal(cap.say, 'Vaccination cap (% of people) set to 50.');

  // "Trigger level" is gone; the two triggers each resolve.
  assert.match(
    registry.find({ label: 'trigger level' }).error,
    /No "trigger level" control/,
  );
  assert.equal(
    registry.find({ label: 'case trigger' }).control.ref,
    '#outbreak-trigger-level',
  );
  assert.equal(
    registry.find({ label: 'bed trigger' }).control.ref,
    '#outbreak-trigger-beds',
  );

  // The seed is typed by voice; the downloads press without a yes once a
  // result has enabled them.
  const seed = await useUiControl(registry, {
    label: 'random seed',
    action: 'set',
    value: '12345',
  });
  assert.equal(seed.ok, true, seed.error);
  assert.equal(seed.typeYourself, undefined);
  for (const [id, label] of [
    ['outbreak-epi-download', 'DOWNLOAD RESULTS'],
    ['outbreak-epi-csv', 'DOWNLOAD CSV'],
  ]) {
    const button = doc.getElementById(id);
    assert.equal(button.disabled, true, `${label} waits for a result`);
    button.disabled = false;
    const pressed = await useUiControl(registry, { label, action: 'press' });
    assert.equal(pressed.ok, true, pressed.error);
    assert.equal(pressed.needsConfirmation, undefined);
    assert.equal(button.clicks, 1);
  }

  // Asked for one panel without a limit, the whole box comes back.
  const whole = registry.list({ panelId: 'outbreak-panel' });
  assert.equal(whole.total, controls.length);
  assert.equal(whole.controls.length, controls.length);
  assert.equal(whole.truncated, undefined);
});

test('every keyboard shortcut has a spoken way in, so a phone without keys loses none', async () => {
  const { GEV_ACTION_SCHEMAS } = await import('./actionSchemas.js');
  const shortcuts = readFileSync(
    new URL('../ui/applicationShortcuts.js', import.meta.url),
    'utf8',
  );
  const styles = [...shortcuts.matchAll(/^\s+\d: '([a-z]+)',$/gm)].map(
    (m) => m[1],
  );
  const letters = [...shortcuts.matchAll(/key === '([a-z])'/g)].map(
    (m) => m[1],
  );
  assert.equal(styles.length, 7, 'keys 1 to 7');
  assert.deepEqual(
    letters.sort(),
    ['c', 'd', 'f', 'h', 'o', 'v'],
    'a new shortcut needs a spoken way in here too',
  );
  const tool = (name) => {
    const schema = GEV_ACTION_SCHEMAS.find((one) => one.name === name);
    assert.ok(schema, name);
    return schema.parameters.properties;
  };
  // 1-7: the visual styles.
  for (const style of styles)
    assert.ok(tool('set_visual_style').style.enum.includes(style), style);
  // H: the HUD. O: orbit. D: detection. C: CCTV. F: the data layers box.
  assert.deepEqual(tool('set_hud').visible.enum, ['on', 'off', 'auto']);
  assert.ok(tool('move_camera').motion.enum.includes('orbit'));
  assert.ok(tool('move_camera').motion.enum.includes('stop'));
  assert.ok(tool('set_detection').mode.enum.length > 1);
  assert.ok(tool('control_cctv').action.enum.includes('enable'));
  assert.ok(tool('control_cctv').action.enum.includes('disable'));
  assert.ok(tool('set_panel_open').panelId.enum.includes('data-panel'));

  // V: clean view has no tool of its own; its buttons answer to their labels.
  const markup = readFileSync(
    new URL('../ui/templates/display-controls.html', import.meta.url),
    'utf8',
  );
  const toggle = markup.match(
    /<button[^>]*id="clean-view-toggle"[^>]*title="([^"]+)"[^>]*>[\s\S]*?<span class="pp-label">([^<]+)<\/span>/,
  );
  const exit = markup.match(/<button id="clean-view-exit"[^>]*>([^<]+)</);
  assert.ok(toggle && exit, 'both clean-view buttons are in the markup');
  const doc = { defaultView: { Event: FakeEvent, KeyboardEvent: FakeEvent } };
  const make = (tag, attrs, text) => new FakeElement(doc, tag, attrs, text);
  const body = make('body');
  doc.querySelectorAll = (selectors) => body.querySelectorAll(selectors);
  const display = make('div', {
    id: 'pp-toggles',
    'data-panel-id': 'pp-toggles',
    class: 'panel-collapsible collapsed',
  });
  const cleanView = make('button', {
    id: 'clean-view-toggle',
    title: toggle[1],
  }).append(make('span', {}, toggle[2]));
  display.append(cleanView);
  const exitButton = make('button', { id: 'clean-view-exit' }, exit[1]);
  body.append(display, exitButton);
  const registry = createUiControlRegistry({ root: doc });
  const opened = [];
  const on = await useUiControl(
    registry,
    { label: 'clean UI', action: 'press' },
    {
      openPanel: (panelId) => {
        opened.push(panelId);
        display.classList.remove('collapsed');
      },
    },
  );
  assert.equal(on.ok, true, on.error);
  assert.equal(cleanView.clicks, 1);
  assert.deepEqual(opened, ['pp-toggles']);
  const off = await useUiControl(registry, {
    label: 'exit clean view',
    action: 'press',
  });
  assert.equal(off.ok, true, off.error);
  assert.equal(exitButton.clicks, 1);
});

test('a removal the PC refuses on the owner phone gets no spoken or written reply', async () => {
  const p = page();
  const registry = createUiControlRegistry({ root: p.doc });
  const pcOnly = () =>
    new Response(JSON.stringify({ removal: 'pc-only' }), {
      status: 403,
      headers: {
        'Content-Type': 'application/json',
        'X-GEV-Removal': 'pc-only',
      },
    });
  // The page's handler starts its request on the click; it answers later.
  let answer = pcOnly;
  p.sendHelp.onClick = () => {
    void watchOwnerRemoval(
      new Promise((resolve) => setTimeout(() => resolve(answer()), 5)),
    );
  };
  const quiet = await useUiControl(registry, {
    label: 'send help',
    action: 'press',
    confirmed: true,
  });
  assert.equal(p.sendHelp.clicks, 1);
  assert.equal(quiet.ok, true);
  assert.equal(quiet.say, null, 'nothing is spoken');
  assert.equal(quiet.schedule, 'silent', 'no card');
  assert.equal(quiet.quiet, true);
  assert.equal('error' in quiet, false);
  assert.doesNotMatch(JSON.stringify(quiet), /Removing is done|403|refused/i);
  // The follow-up asks the voice model to say nothing about it.
  assert.match(
    responseInstructionForToolResult(quiet),
    /do not confirm, refuse or explain it.*otherwise say nothing/,
  );
  // Any other answer keeps the usual reply.
  answer = () => new Response('{}', { status: 200 });
  const done = await useUiControl(registry, {
    label: 'send help',
    action: 'press',
    confirmed: true,
  });
  assert.equal(done.say, 'Pressed SEND HELP.');
  assert.equal(done.quiet, undefined);
  // A press that starts no request is not held up.
  p.sendHelp.onClick = null;
  const plain = await useUiControl(registry, {
    label: 'ultra scan',
    action: 'press',
  });
  assert.equal(plain.say, 'Pressed SCAN.');
});
