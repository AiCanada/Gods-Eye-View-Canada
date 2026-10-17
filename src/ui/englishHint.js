import {
  ENGLISH_HINT_LOCALES,
  englishSingular,
  getCatalog,
  getLocale,
  shownEnglish,
} from '../i18n/index.js';
import { createBackTranslator, hasHintScript } from '../i18n/backToEnglish.js';

/**
 * Hover help for the scripts few readers know. In Ancient Egyptian and
 * Inuktitut, a mouse that rests two seconds on hieroglyphs or syllabics shows
 * the English the text was translated from, in a small box by the pointer.
 * Mouse only: touch has no hover, so the phone page is unchanged.
 */

/** How long the mouse rests on the text before the English shows. */
export const ENGLISH_HINT_DELAY_MS = 2000;
/** A resting hand's jitter; a longer move starts the wait again. */
export const ENGLISH_HINT_REST_PX = 6;
const BOX_GAP_PX = 14;
const EDGE_PX = 8;
/** Text longer than this belongs to a panel, not to one line. */
const LINE_MAX_CHARS = 400;
const ANCESTOR_STEPS = 3;
/** Attributes whose text is on screen: a tooltip and a collapsed tab's name. */
const SHOWN_ATTRIBUTES = Object.freeze(['title', 'data-collapsed-title']);

/**
 * The hover help's state without a DOM: where the pointer rests, the wait,
 * the box. `textsAt` lists the text under a point, the whole line first.
 * @param {object} input
 * @param {(x: number, y: number, target: unknown) => string[]} input.textsAt
 * @param {(text: string) => string|undefined} input.englishFor
 * @param {(hint: {x: number, y: number, english: string}) => void} input.show
 * @param {() => void} input.hide
 */
export function createEnglishHintModel({
  textsAt,
  englishFor,
  show,
  hide,
  delayMs = ENGLISH_HINT_DELAY_MS,
  restPx = ENGLISH_HINT_REST_PX,
  setTimer = (callback, ms) => setTimeout(callback, ms),
  clearTimer = (timer) => clearTimeout(timer),
}) {
  let timer = null;
  let rest = null;
  let visible = false;

  function cancel() {
    if (timer !== null) clearTimer(timer);
    timer = null;
  }

  function dismiss() {
    cancel();
    rest = null;
    if (!visible) return;
    visible = false;
    hide();
  }

  function settle(x, y, target) {
    timer = null;
    for (const text of textsAt(x, y, target)) {
      if (!hasHintScript(text)) continue;
      const english = englishFor(text);
      if (!english) continue;
      visible = true;
      show({ x, y, english });
      return;
    }
  }

  return {
    get visible() {
      return visible;
    },
    /** A pointer move; a mouse at rest long enough shows the English. */
    pointerMove({ x, y, pointerType, target }) {
      if (pointerType !== 'mouse') {
        dismiss();
        return;
      }
      if (
        rest &&
        rest.target === target &&
        Math.hypot(x - rest.x, y - rest.y) <= restPx
      )
        return;
      dismiss();
      rest = { x, y, target };
      timer = setTimer(() => settle(x, y, target), delayMs);
    },
    dismiss,
  };
}

/** The text node whose letters are under the point, or null. */
function textNodeAt(doc, x, y) {
  let node = null;
  if (typeof doc.caretPositionFromPoint === 'function')
    node = doc.caretPositionFromPoint(x, y)?.offsetNode ?? null;
  else if (typeof doc.caretRangeFromPoint === 'function')
    node = doc.caretRangeFromPoint(x, y)?.startContainer ?? null;
  if (node?.nodeType !== 3 || typeof doc.createRange !== 'function')
    return null;
  // The caret snaps to the nearest text; only text actually under the
  // pointer counts.
  const range = doc.createRange();
  range.selectNodeContents(node);
  for (const box of range.getClientRects())
    if (
      x >= box.left - 2 &&
      x <= box.right + 2 &&
      y >= box.top - 2 &&
      y <= box.bottom + 2
    )
      return node;
  return null;
}

/**
 * The text under a point: the line it belongs to, then the text itself, then
 * what its element shows another way (a selected option, an empty field's
 * placeholder, a tooltip, a collapsed tab's name).
 * @returns {string[]}
 */
export function textsAt(doc, x, y, target) {
  const texts = [];
  const add = (value) => {
    if (typeof value !== 'string') return;
    const text = value.replace(/\s+/g, ' ').trim();
    if (text && text.length <= LINE_MAX_CHARS && !texts.includes(text))
      texts.push(text);
  };
  const node = textNodeAt(doc, x, y);
  if (node) {
    add(node.parentElement?.textContent);
    add(node.data);
  }
  let element = target?.nodeType === 1 ? target : null;
  for (let step = 0; element && step <= ANCESTOR_STEPS; step += 1) {
    if (step === 0 && !node) add(element.textContent);
    if (element.tagName === 'SELECT')
      add(element.selectedOptions?.[0]?.textContent);
    if (
      (element.tagName === 'INPUT' || element.tagName === 'TEXTAREA') &&
      !element.value
    )
      add(element.getAttribute('placeholder'));
    for (const name of SHOWN_ATTRIBUTES) add(element.getAttribute(name));
    element = element.parentElement;
  }
  return texts;
}

/** Beside the pointer, above it unless that leaves the window. */
function place(box, win, x, y) {
  const width = box.offsetWidth;
  const height = box.offsetHeight;
  const left = Math.max(
    EDGE_PX,
    Math.min(x + BOX_GAP_PX, win.innerWidth - width - EDGE_PX),
  );
  let top = y - BOX_GAP_PX - height;
  if (top < EDGE_PX)
    top = Math.max(
      EDGE_PX,
      Math.min(y + BOX_GAP_PX * 1.5, win.innerHeight - height - EDGE_PX),
    );
  box.style.left = `${Math.round(left)}px`;
  box.style.top = `${Math.round(top)}px`;
}

/**
 * Turn the hover help on for this page when its locale is one of
 * ENGLISH_HINT_LOCALES; null elsewhere.
 * @returns {{model: ReturnType<typeof createEnglishHintModel>, destroy: () => void}|null}
 */
export function installEnglishHint({
  doc = globalThis.document,
  win = globalThis.window,
  locale = getLocale(),
} = {}) {
  if (!ENGLISH_HINT_LOCALES.includes(locale) || !doc?.body || !win) return null;
  const translator = createBackTranslator(getCatalog(locale), {
    recorded: shownEnglish,
    singular: englishSingular,
  });
  const box = doc.createElement('div');
  box.className = 'english-hint';
  box.setAttribute('role', 'tooltip');
  box.lang = 'en';
  box.hidden = true;
  doc.body.append(box);
  const model = createEnglishHintModel({
    textsAt: (x, y, target) => textsAt(doc, x, y, target),
    englishFor: translator.englishFor,
    show: ({ x, y, english }) => {
      box.textContent = english;
      box.hidden = false;
      place(box, win, x, y);
    },
    hide: () => {
      box.hidden = true;
      box.textContent = '';
    },
  });
  const onMove = (event) =>
    model.pointerMove({
      x: event.clientX,
      y: event.clientY,
      pointerType: event.pointerType,
      target: event.target,
    });
  const onDismiss = () => model.dismiss();
  const listeners = [
    [doc, 'pointermove', onMove, { capture: true, passive: true }],
    [doc, 'pointerdown', onDismiss, { capture: true, passive: true }],
    [doc, 'keydown', onDismiss, { capture: true }],
    [doc, 'wheel', onDismiss, { capture: true, passive: true }],
    [doc.documentElement, 'pointerleave', onDismiss, undefined],
    [win, 'scroll', onDismiss, { capture: true, passive: true }],
    [win, 'blur', onDismiss, undefined],
  ];
  for (const [where, type, handler, options] of listeners)
    where.addEventListener(type, handler, options);
  return {
    model,
    destroy() {
      model.dismiss();
      for (const [where, type, handler, options] of listeners)
        where.removeEventListener(type, handler, options);
      box.remove();
    },
  };
}
