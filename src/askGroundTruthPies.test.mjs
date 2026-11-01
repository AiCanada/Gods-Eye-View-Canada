// The two pies of the Country Ground Truth Assessment: the slices, what each
// pie says, and the block drawn into the panel (a small document stands in
// for the browser's).
import test from 'node:test';
import assert from 'node:assert/strict';
import { compareGroundTruthAgainstBaseline } from './askGroundTruthBaseline.js';
import {
  GROUND_TRUTH_PIE_COLORS,
  groundTruthPieModel,
  groundTruthPieSlices,
  renderGroundTruthPies,
} from './askGroundTruthPies.js';

const check = (found, checked) => ({
  found,
  checked,
  findings: Array.from({ length: found }, (_, i) => ({ category: `c${i}` })),
});
const notes = (found) => ({
  found,
  findings: Array.from({ length: found }, () => ({ note: 'n' })),
});
const notPublished = () => ({
  checked: 0,
  found: 0,
  findings: [],
  notPublished: true,
});
const evidence = (country, countryCode, checks) => ({
  status: 'ready',
  country,
  countryCode,
  source: 's',
  year: 2025,
  checks,
});
const UNITED_STATES = evidence('United States', 'US', {
  totalsAgainstParts: check(0, 2),
  coverage: check(8, 41),
  unfounded: notPublished(),
  exclusionNotes: notes(2),
  otherCategories: check(1, 1),
  movedToOtherNotes: notes(1),
  lateStarts: check(0, 10),
  comparabilityNotes: notes(8),
  arithmetic: check(0, 20),
  corrections: notPublished(),
});
const CANADA = evidence('Canada', 'CA', {
  totalsAgainstParts: check(2, 35),
  unfounded: check(15, 276),
  exclusionNotes: notes(5),
  otherCategories: check(11, 27),
  movedToOtherNotes: notes(1),
  lateStarts: check(65, 177),
  comparabilityNotes: notes(20),
  arithmetic: check(0, 182),
  corrections: notes(1),
});
const BRITAIN = evidence('United Kingdom', 'GB', {
  totalsAgainstParts: check(0, 5),
  unfounded: notPublished(),
  exclusionNotes: notes(0),
  otherCategories: notPublished(),
  movedToOtherNotes: notes(0),
  lateStarts: check(0, 1),
  comparabilityNotes: notes(2),
  arithmetic: check(0, 20),
  corrections: notPublished(),
});

const METHODS = [
  'Incidents left out of totals',
  'Use of "other"',
  'New categories and partial data',
  'Incorrect numbers',
];
const entries = (findings) =>
  findings.map((count, i) => ({
    number: i + 1,
    label: METHODS[i],
    findings: count,
  }));

/** Just enough of a document for the block. */
class FakeNode {
  constructor(doc, tag, ns = null) {
    this.ownerDocument = doc;
    this.tag = tag;
    this.ns = ns;
    this.attrs = {};
    this.children = [];
    this.className = '';
    this.hidden = false;
    this._text = '';
  }
  setAttribute(key, value) {
    this.attrs[key] = String(value);
  }
  appendChild(child) {
    this.children.push(child);
    return child;
  }
  get textContent() {
    return this.children.length
      ? this.children.map((child) => child.textContent).join('')
      : this._text;
  }
  set textContent(value) {
    this.children = [];
    this._text = String(value);
  }
  all(where, out = []) {
    for (const child of this.children) {
      if (where(child)) out.push(child);
      child.all(where, out);
    }
    return out;
  }
  byClass(name) {
    return this.all((node) => node.className.split(' ').includes(name));
  }
}
const fakeDocument = () => {
  const doc = {};
  doc.createElement = (tag) => new FakeNode(doc, tag);
  doc.createElementNS = (ns, tag) => new FakeNode(doc, tag, ns);
  return doc;
};

test('slices: every method with a finding, in order, clockwise from the top, labelled where they fit', () => {
  const { total, slices } = groundTruthPieSlices(entries([8, 1, 0, 0]));
  assert.equal(total, 9);
  assert.deepEqual(
    slices.map((s) => [s.number, s.findings, s.pct, s.color, s.ink]),
    [
      [1, 8, 89, GROUND_TRUTH_PIE_COLORS[0], '#ffffff'],
      [2, 1, 11, GROUND_TRUTH_PIE_COLORS[1], '#ffffff'],
    ],
  );
  assert.match(
    slices[0].path,
    /^M 60 60 L 60 6 A 54 54 0 1 1 /,
    'over half: the large arc',
  );
  assert.match(
    slices[1].path,
    /^M 60 60 L .* A 54 54 0 0 1 60 6 Z$/,
    'and back to the top',
  );
  assert.ok(
    slices.every((s) => s.labelAt),
    'both a tenth or more',
  );
  assert.equal(
    slices[0].title,
    '1. Incidents left out of totals: 8 findings, 89% of 9 findings',
  );
  assert.equal(
    slices[1].title,
    '2. Use of "other": 1 finding, 11% of 9 findings',
  );

  const one = groundTruthPieSlices(entries([0, 0, 5, 0])).slices;
  assert.equal(one.length, 1);
  assert.equal(one[0].whole, true, 'a single method is the whole circle');
  assert.equal(one[0].path, null);
  assert.equal(one[0].ink, '#ffffff');

  const sliver = groundTruthPieSlices(entries([99, 1, 0, 0])).slices;
  assert.equal(
    sliver[1].labelAt,
    null,
    'a sliver keeps its share for the title',
  );
  assert.equal(groundTruthPieSlices(entries([0, 0, 0, 0])).slices.length, 0);
  assert.equal(
    groundTruthPieSlices(entries([0, 0, 0, 3])).slices[0].ink,
    '#0b0b0b',
    'near-black on yellow',
  );
});

test('the model: the baseline first, the selected country beside it, the index under each', () => {
  const model = groundTruthPieModel(
    compareGroundTruthAgainstBaseline(CANADA, UNITED_STATES),
  );
  assert.equal(model.title, 'AGAINST THE UNITED STATES · BASELINE 100');
  assert.equal(model.subtitle, 'FINDINGS PER 100 FIGURES CHECKED, BY METHOD');
  assert.deepEqual(
    model.pies.map((pie) => [
      pie.which,
      pie.country,
      pie.headline,
      pie.figures,
    ]),
    [
      [
        'baseline',
        'United States',
        'BASELINE 100',
        '9 findings in 74 figures checked · 12.2 per 100',
      ],
      [
        'country',
        'Canada',
        'INDEX 109',
        '93 findings in 697 figures checked · 13.3 per 100',
      ],
    ],
  );
  assert.deepEqual(
    model.pies[1].slices.map((s) => [s.number, s.pct]),
    [
      [1, 18],
      [2, 12],
      [3, 70],
    ],
    'Canada: nothing in method 4, so three slices',
  );
  assert.equal(
    model.pies[0].ariaLabel,
    'United States: 9 findings in 74 figures checked, by method: 1. Incidents left out of totals: 8 findings, 89% of 9 findings; 2. Use of "other": 1 finding, 11% of 9 findings',
  );
  assert.deepEqual(
    model.legend.map((entry) => [entry.label, entry.color]),
    METHODS.map((label, i) => [
      `${i + 1}. ${label}`,
      GROUND_TRUTH_PIE_COLORS[i],
    ]),
  );
  assert.equal(model.note, '');

  const own = groundTruthPieModel(
    compareGroundTruthAgainstBaseline(UNITED_STATES, null),
  );
  assert.equal(own.pies.length, 1);
  assert.deepEqual(
    [own.pies[0].which, own.pies[0].headline],
    ['country', 'BASELINE 100'],
  );
  assert.equal(own.note, 'The United States is the baseline.');

  const alone = groundTruthPieModel(
    compareGroundTruthAgainstBaseline(CANADA, {
      status: 'unavailable',
      error: 'x',
    }),
  );
  assert.equal(alone.pies.length, 1);
  assert.equal(alone.pies[0].headline, 'NO INDEX');
  assert.match(
    alone.note,
    /could not be read, so there is no baseline this time/,
  );

  const thin = groundTruthPieModel(
    compareGroundTruthAgainstBaseline(BRITAIN, UNITED_STATES),
  );
  assert.deepEqual(
    [thin.pies[1].headline, thin.pies[1].figures, thin.pies[1].slices.length],
    ['INDEX 0', '0 findings in 26 figures checked · 0 per 100', 0],
  );
  assert.equal(groundTruthPieModel(null), null);
});

test('drawn into the panel: two figures, their slices and labels, the legend; hidden with nothing to compare', () => {
  const doc = fakeDocument();
  const host = doc.createElement('div');
  host.hidden = true;
  const model = renderGroundTruthPies(
    host,
    compareGroundTruthAgainstBaseline(CANADA, UNITED_STATES),
  );
  assert.equal(host.hidden, false);
  assert.equal(model.pies.length, 2);
  assert.equal(
    host.byClass('ask-gt-pies-title')[0].textContent,
    'AGAINST THE UNITED STATES · BASELINE 100',
  );
  const figures = host.byClass('ask-gt-pie');
  assert.equal(figures.length, 2);
  assert.deepEqual(
    figures.map((figure) => figure.className),
    ['ask-gt-pie ask-gt-pie-baseline', 'ask-gt-pie ask-gt-pie-country'],
  );
  const [us, ca] = figures.map((figure) => figure.children[0]);
  assert.equal(us.tag, 'svg');
  assert.equal(us.attrs.role, 'img');
  assert.match(
    us.attrs['aria-label'],
    /^United States: 9 findings in 74 figures checked, by method: /,
  );
  const marks = (svg) =>
    svg.children.filter((node) => node.attrs.class === 'ask-gt-slice');
  assert.equal(marks(us).length, 2);
  assert.equal(marks(ca).length, 3);
  assert.deepEqual(
    marks(ca).map((mark) => [
      mark.tag,
      mark.attrs.fill,
      mark.attrs['stroke-width'],
      mark.attrs.tabindex,
    ]),
    [
      ['path', GROUND_TRUTH_PIE_COLORS[0], '2', '0'],
      ['path', GROUND_TRUTH_PIE_COLORS[1], '2', '0'],
      ['path', GROUND_TRUTH_PIE_COLORS[2], '2', '0'],
    ],
  );
  assert.equal(marks(ca)[2].children[0].tag, 'title');
  assert.equal(
    marks(ca)[2].children[0].textContent,
    '3. New categories and partial data: 65 findings, 70% of 93 findings',
  );
  const labels = (svg) => svg.children.filter((node) => node.tag === 'text');
  assert.deepEqual(
    labels(ca).map((label) => label.textContent),
    ['18%', '12%', '70%'],
  );
  assert.deepEqual(
    figures[1].children[1].children.map((span) => span.textContent),
    [
      'Canada',
      'INDEX 109',
      '93 findings in 697 figures checked · 13.3 per 100',
    ],
  );
  const legend = host.byClass('ask-gt-legend')[0];
  assert.equal(legend.children.length, 4);
  assert.equal(
    legend.children[3].children[0].attrs.style,
    `background: ${GROUND_TRUTH_PIE_COLORS[3]}`,
  );
  assert.equal(
    legend.children[3].children[1].textContent,
    '4. Incorrect numbers',
  );
  assert.equal(host.byClass('ask-gt-pies-note').length, 0);

  // Nothing found: the empty ring and a zero.
  renderGroundTruthPies(
    host,
    compareGroundTruthAgainstBaseline(BRITAIN, UNITED_STATES),
  );
  const thin = host.byClass('ask-gt-pie')[1].children[0];
  assert.deepEqual(
    thin.children.map((node) => [
      node.tag,
      node.attrs['stroke-dasharray'] ?? node.textContent,
    ]),
    [
      ['circle', '3 3'],
      ['text', '0'],
    ],
  );

  // The United States itself: one pie and the note; the block is redrawn, not added to.
  renderGroundTruthPies(
    host,
    compareGroundTruthAgainstBaseline(UNITED_STATES, null),
  );
  assert.equal(host.byClass('ask-gt-pie').length, 1);
  assert.equal(host.byClass('ask-gt-pies-title').length, 1);
  assert.equal(
    host.byClass('ask-gt-pies-note')[0].textContent,
    'The United States is the baseline.',
  );

  renderGroundTruthPies(host, null);
  assert.equal(host.hidden, true);
  assert.equal(host.children.length, 0);
  assert.equal(renderGroundTruthPies(null, null), null);
});
