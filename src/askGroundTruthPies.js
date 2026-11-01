/**
 * The two pies of the Country Ground Truth Assessment (owner request
 * 2026-10-30: "use pie chart for display of baseline and additional pie chart
 * for selected country"): the United States, the baseline at 100, and the
 * selected country, each split by method into the findings among the figures
 * its checks examined (askGroundTruthBaseline.js), the index under each.
 *
 * Colours: the data-viz palette's first four dark-surface slots in its own
 * order, validated as a closed ring on the panel's surface (every pair of
 * slices that can touch when all four are drawn clears the colour-blind and
 * the normal-vision floors). A method that found nothing draws no slice, which
 * can put orange beside yellow, so every slice also carries its share as a
 * label where it fits, a gap of the surface, a hover title and a legend row;
 * identity never rests on hue alone. Nothing here is a grade.
 */
import { localSay } from './i18n/index.js';

/** Methods 1 to 4: blue, orange, aqua, yellow. */
export const GROUND_TRUTH_PIE_COLORS = Object.freeze([
  '#3987e5',
  '#d95926',
  '#199e70',
  '#c98500',
]);
/** The label inside each slice: white, near-black on yellow. */
const SLICE_INK = Object.freeze(['#ffffff', '#ffffff', '#ffffff', '#0b0b0b']);
/** The panel's own dark surface, drawn as the gap between slices. */
export const GROUND_TRUTH_PIE_SURFACE = '#0b141a';
const SIZE = 120;
const RADIUS = 54;
const LABEL_RADIUS = 33;
/** A slice narrower than a tenth keeps its share for the title and the log. */
const LABEL_MIN_SHARE = 0.1;
const SVG_NS = 'http://www.w3.org/2000/svg';

const round2 = (value) => Math.round(value * 100) / 100;
const point = (angle, radius) => [
  round2(SIZE / 2 + radius * Math.cos(angle)),
  round2(SIZE / 2 + radius * Math.sin(angle)),
];

/**
 * The slices of one pie: every method with a finding, in method order,
 * clockwise from the top.
 * @param {Array<{number: number, label: string, findings: number}>} entries
 * @param {{tl: Function, tln: Function, digits: Function}} say
 */
export function groundTruthPieSlices(entries, say = localSay) {
  const total = entries.reduce((sum, entry) => sum + entry.findings, 0);
  const totalText = say.tln(total, '{count} finding', '{count} findings');
  let angle = -Math.PI / 2;
  const slices = [];
  for (const entry of entries) {
    if (!(entry.findings > 0)) continue;
    const share = entry.findings / total;
    const start = angle;
    const end = angle + share * 2 * Math.PI;
    angle = end;
    const pct = Math.round(share * 100);
    const at = entry.number - 1;
    const [x0, y0] = point(start, RADIUS);
    const [x1, y1] = point(end, RADIUS);
    const [lx, ly] = point((start + end) / 2, LABEL_RADIUS);
    slices.push({
      number: entry.number,
      label: entry.label,
      findings: entry.findings,
      share,
      pct,
      color: GROUND_TRUTH_PIE_COLORS[at],
      ink: SLICE_INK[at],
      whole: share >= 0.9999,
      path:
        share >= 0.9999
          ? null
          : `M ${SIZE / 2} ${SIZE / 2} L ${x0} ${y0} A ${RADIUS} ${RADIUS} 0 ${share > 0.5 ? 1 : 0} 1 ${x1} ${y1} Z`,
      labelAt: share >= LABEL_MIN_SHARE ? { x: lx, y: ly } : null,
      title: say.tl('{number}. {method}: {findings}, {pct}% of {total}', {
        number: entry.number,
        method: say.tl(entry.label),
        findings: say.tln(
          entry.findings,
          '{count} finding',
          '{count} findings',
        ),
        pct,
        total: totalText,
      }),
    });
  }
  return { total, totalText, slices };
}

function pieOf(compared, which, say) {
  const counts = compared[which];
  if (!counts) return null;
  const entries = compared.methods.map((method) => ({
    number: method.number,
    label: method.label,
    findings: method[which].findings,
  }));
  const { total, slices } = groundTruthPieSlices(entries, say);
  const country = say.tl(counts.country);
  const findings = say.tln(
    counts.findings,
    '{count} finding',
    '{count} findings',
  );
  const checked = say.tln(
    counts.figuresChecked,
    '{count} figure checked',
    '{count} figures checked',
  );
  const figures =
    counts.rate === null
      ? say.tl('{findings} in {checked}', { findings, checked })
      : say.tl('{findings} in {checked} · {rate} per 100', {
          findings,
          checked,
          rate: say.digits(String(counts.rate)),
        });
  const baseline = which === 'baseline' || compared.status === 'baseline';
  const headline = baseline
    ? say.tl('BASELINE 100')
    : compared.index === null
      ? say.tl('NO INDEX')
      : say.tl('INDEX {index}', { index: compared.index });
  return {
    which,
    country,
    headline,
    figures,
    total,
    slices,
    ariaLabel: say.tl(
      '{country}: {findings} in {checked}, by method: {slices}',
      {
        country,
        findings,
        checked,
        slices: slices.map((slice) => slice.title).join('; ') || say.tl('n/a'),
      },
    ),
  };
}

/**
 * Everything the block shows, as data: the title, the pies (the baseline
 * first, then the selected country; one pie when they are the same country or
 * the baseline could not be read), the legend and the note.
 * @param {object} compared From compareGroundTruthAgainstBaseline().
 */
export function groundTruthPieModel(compared, say = localSay) {
  if (!compared) return null;
  const pies =
    compared.status === 'compared'
      ? [pieOf(compared, 'baseline', say), pieOf(compared, 'country', say)]
      : [pieOf(compared, 'country', say)];
  return {
    title: say.tl('AGAINST THE UNITED STATES · BASELINE 100'),
    subtitle: say.tl('FINDINGS PER 100 FIGURES CHECKED, BY METHOD'),
    pies: pies.filter(Boolean),
    legend: compared.methods.map((method) => ({
      number: method.number,
      label: `${method.number}. ${say.tl(method.label)}`,
      color: GROUND_TRUTH_PIE_COLORS[method.number - 1],
    })),
    note:
      compared.status === 'baseline'
        ? say.tl('The United States is the baseline.')
        : compared.status === 'unavailable'
          ? say.tl(
              'The United States’ table could not be read, so there is no baseline this time.',
            )
          : '',
  };
}

/**
 * Draw the block into `host` (emptied first), or hide it when there is
 * nothing to compare. Returns the model drawn.
 * @param {HTMLElement|null} host
 * @param {object|null} compared
 */
export function renderGroundTruthPies(host, compared, say = localSay) {
  if (!host) return null;
  const model = groundTruthPieModel(compared, say);
  host.textContent = '';
  if (!model) {
    host.hidden = true;
    return null;
  }
  const doc = host.ownerDocument;
  const el = (tag, className, text) => {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const svgEl = (tag, attrs) => {
    const node = doc.createElementNS(SVG_NS, tag);
    for (const [key, value] of Object.entries(attrs))
      node.setAttribute(key, String(value));
    return node;
  };

  host.appendChild(el('div', 'ask-gt-pies-title', model.title));
  host.appendChild(el('div', 'ask-gt-pies-subtitle', model.subtitle));
  const row = el('div', 'ask-gt-pies-row');
  for (const pie of model.pies) {
    const figure = el('figure', `ask-gt-pie ask-gt-pie-${pie.which}`);
    const svg = svgEl('svg', {
      viewBox: `0 0 ${SIZE} ${SIZE}`,
      role: 'img',
      'aria-label': pie.ariaLabel,
    });
    if (!pie.slices.length) {
      svg.appendChild(
        svgEl('circle', {
          cx: SIZE / 2,
          cy: SIZE / 2,
          r: RADIUS - 1,
          fill: 'none',
          stroke: 'rgba(127, 231, 255, 0.35)',
          'stroke-width': 1,
          'stroke-dasharray': '3 3',
        }),
      );
      const zero = svgEl('text', {
        x: SIZE / 2,
        y: SIZE / 2,
        'text-anchor': 'middle',
        'dominant-baseline': 'central',
        'font-size': 14,
        fill: 'rgba(220, 245, 255, 0.85)',
      });
      zero.textContent = say.digits('0');
      svg.appendChild(zero);
    }
    for (const slice of pie.slices) {
      const mark = slice.whole
        ? svgEl('circle', {
            cx: SIZE / 2,
            cy: SIZE / 2,
            r: RADIUS,
            fill: slice.color,
          })
        : svgEl('path', {
            d: slice.path,
            fill: slice.color,
            stroke: GROUND_TRUTH_PIE_SURFACE,
            'stroke-width': 2,
            'stroke-linejoin': 'round',
          });
      mark.setAttribute('class', 'ask-gt-slice');
      mark.setAttribute('tabindex', '0');
      const title = svgEl('title', {});
      title.textContent = slice.title;
      mark.appendChild(title);
      svg.appendChild(mark);
    }
    for (const slice of pie.slices) {
      if (!slice.labelAt) continue;
      const label = svgEl('text', {
        x: slice.labelAt.x,
        y: slice.labelAt.y,
        'text-anchor': 'middle',
        'dominant-baseline': 'central',
        'font-size': 10,
        'font-weight': 600,
        fill: slice.ink,
        'pointer-events': 'none',
      });
      label.textContent = say.digits(`${slice.pct}%`);
      svg.appendChild(label);
    }
    figure.appendChild(svg);
    const caption = el('figcaption');
    caption.appendChild(el('span', 'ask-gt-pie-country', pie.country));
    caption.appendChild(el('span', 'ask-gt-pie-index', pie.headline));
    caption.appendChild(el('span', 'ask-gt-pie-figures', pie.figures));
    figure.appendChild(caption);
    row.appendChild(figure);
  }
  host.appendChild(row);
  const legend = el('ul', 'ask-gt-legend');
  for (const entry of model.legend) {
    const item = el('li');
    const swatch = el('span', 'ask-gt-swatch');
    swatch.setAttribute('style', `background: ${entry.color}`);
    item.appendChild(swatch);
    item.appendChild(el('span', 'ask-gt-legend-label', entry.label));
    legend.appendChild(item);
  }
  host.appendChild(legend);
  if (model.note) host.appendChild(el('div', 'ask-gt-pies-note', model.note));
  host.hidden = false;
  return model;
}
