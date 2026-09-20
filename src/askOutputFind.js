/**
 * Find in the LLM output box (Ctrl+F / Cmd+F while the LLM panel has the
 * pointer or the focus).
 *
 * A Ground Truth report runs to a hundred lines and more inside a box a few
 * lines tall. The browser's own find searches the whole page and cannot scroll
 * a match inside the box into view reliably, so the panel answers the keys
 * itself: a small search field over the box, every match marked, the current
 * one scrolled to, Enter / Shift+Enter to step, Escape to close.
 *
 * Matches are marked with the CSS Custom Highlight API: ranges over the box's
 * own text, no markup added, so the log stays plain text that can be selected
 * and copied. Where the API is missing the search still counts and scrolls.
 */

const HIGHLIGHT_ALL = 'ask-find';
const HIGHLIGHT_CURRENT = 'ask-find-current';
/** A search this long is a paste accident, not a search. */
const FIND_QUERY_MAX = 200;

/**
 * Every place `query` occurs in `text`, ignoring case. Offsets are into `text`
 * as given. Matches do not overlap.
 * @param {string} text
 * @param {string} query
 * @returns {Array<[number, number]>} [start, end) pairs in order.
 */
export function findTextMatches(text, query) {
  const haystack = String(text ?? '');
  const needle = String(query ?? '').slice(0, FIND_QUERY_MAX);
  if (!needle || !haystack) return [];
  // Lower-casing can change a string's length ("İ"); compare code unit by
  // code unit only when it did not, otherwise fall back to an exact search.
  const lowerHaystack = haystack.toLowerCase();
  const lowerNeedle = needle.toLowerCase();
  const foldable =
    lowerHaystack.length === haystack.length &&
    lowerNeedle.length === needle.length;
  const source = foldable ? lowerHaystack : haystack;
  const target = foldable ? lowerNeedle : needle;
  const matches = [];
  for (
    let at = source.indexOf(target);
    at !== -1;
    at = source.indexOf(target, at + target.length)
  ) {
    matches.push([at, at + target.length]);
  }
  return matches;
}

/** The index after `current` going forward or back, wrapping at the ends. */
export function stepFindIndex(current, count, direction) {
  if (!Number.isFinite(count) || count <= 0) return -1;
  const from = Number.isFinite(current) && current >= 0 ? current : -1;
  if (from < 0) return direction < 0 ? count - 1 : 0;
  return (from + (direction < 0 ? -1 : 1) + count) % count;
}

/** "3 of 17", "No matches", or nothing while the field is empty. */
export function findCountLabel(query, index, count) {
  if (!String(query ?? '')) return '';
  if (!count) return 'No matches';
  return `${index + 1} of ${count}`;
}

/**
 * The search field of one output box.
 * @param {{output: HTMLElement, documentRef?: Document, windowRef?: Window}} options
 * @returns {{element: HTMLElement, open: () => void, close: () => void, refresh: () => void, isOpen: () => boolean, destroy: () => void}}
 */
export function createOutputFind({
  output,
  documentRef = globalThis.document,
  windowRef = globalThis.window,
}) {
  const bar = documentRef.createElement('div');
  bar.className = 'ask-find';
  bar.hidden = true;
  bar.setAttribute('role', 'search');

  const input = documentRef.createElement('input');
  input.type = 'text';
  input.className = 'ask-find-input';
  input.placeholder = 'Find in output...';
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.setAttribute('aria-label', 'Find in the LLM output');

  const count = documentRef.createElement('span');
  count.className = 'ask-find-count';
  count.setAttribute('aria-live', 'polite');

  const button = (text, title) => {
    const element = documentRef.createElement('button');
    element.type = 'button';
    element.className = 'scene-btn ask-find-btn';
    element.textContent = text;
    element.title = title;
    element.setAttribute('aria-label', title);
    return element;
  };
  const previous = button('<', 'Previous match (Shift+Enter)');
  const next = button('>', 'Next match (Enter)');
  const closeButton = button('x', 'Close find (Escape)');
  bar.append(input, count, previous, next, closeButton);

  let matches = [];
  let index = -1;
  const highlights = windowRef?.CSS?.highlights;
  const HighlightCtor = windowRef?.Highlight;

  const clearMarks = () => {
    highlights?.delete?.(HIGHLIGHT_ALL);
    highlights?.delete?.(HIGHLIGHT_CURRENT);
  };

  /** The box holds one text node: the panel writes its log with textContent. */
  const textNode = () => {
    for (const node of output.childNodes) if (node.nodeType === 3) return node;
    return null;
  };

  const rangeOf = (node, [start, end]) => {
    const range = documentRef.createRange();
    range.setStart(node, start);
    range.setEnd(node, end);
    return range;
  };

  const show = () => {
    count.textContent = findCountLabel(input.value, index, matches.length);
    clearMarks();
    const node = textNode();
    if (!node || !matches.length) return;
    const ranges = matches.map((match) => rangeOf(node, match));
    if (highlights && HighlightCtor) {
      highlights.set(HIGHLIGHT_ALL, new HighlightCtor(...ranges));
      if (index >= 0)
        highlights.set(HIGHLIGHT_CURRENT, new HighlightCtor(ranges[index]));
    }
    if (index < 0) return;
    // Scroll the box, never the page: bring the match a third of the way down.
    const box = output.getBoundingClientRect();
    const hit = ranges[index].getBoundingClientRect();
    output.scrollTop += hit.top - box.top - box.height / 3;
  };

  const search = ({ keepPlace = false } = {}) => {
    const node = textNode();
    matches = findTextMatches(node ? node.data : '', input.value);
    index = matches.length
      ? keepPlace && index >= 0
        ? Math.min(index, matches.length - 1)
        : 0
      : -1;
    show();
  };

  const step = (direction) => {
    if (!matches.length) return;
    index = stepFindIndex(index, matches.length, direction);
    show();
  };

  const close = () => {
    if (bar.hidden) return;
    bar.hidden = true;
    matches = [];
    index = -1;
    clearMarks();
    count.textContent = '';
  };

  const open = () => {
    bar.hidden = false;
    input.focus();
    input.select();
    search();
  };

  const onInput = () => search();
  const onKeyDown = (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      step(event.shiftKey ? -1 : 1);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      // The application's own Escape (dismiss search) is not meant for this.
      event.stopPropagation();
      close();
      output.focus?.();
    }
  };
  input.addEventListener('input', onInput);
  input.addEventListener('keydown', onKeyDown);
  previous.addEventListener('click', () => step(-1));
  next.addEventListener('click', () => step(1));
  closeButton.addEventListener('click', close);

  return {
    element: bar,
    open,
    close,
    isOpen: () => !bar.hidden,
    /** The log changed under an open search: search it again, keep the place. */
    refresh() {
      if (!bar.hidden) search({ keepPlace: true });
    },
    destroy() {
      close();
      input.removeEventListener('input', onInput);
      input.removeEventListener('keydown', onKeyDown);
      bar.remove();
    },
  };
}
