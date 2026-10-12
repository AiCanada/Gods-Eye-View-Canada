/**
 * The owner's phone may not remove anything: removing is done on the PC.
 * The dev server (and the tailnet mirror in front of it) answers such a
 * request with 403, the header `X-GEV-Removal: pc-only` and the body
 * `{"removal":"pc-only"}`, and no error text. On the phone that removal is a
 * quiet no-op: no status line, no toast, no spoken reply, and the item stays
 * exactly as it was, since the PC still has it.
 *
 * This module recognises that answer and tells the voice layer about it, so
 * a spoken press of a REMOVE button does not answer "Pressed REMOVE".
 */

export const OWNER_REMOVAL_HEADER = 'x-gev-removal';
export const OWNER_REMOVAL_VALUE = 'pc-only';
export const OWNER_REMOVAL_EVENT = 'gev:owner-removal-refused';

function headerValue(response) {
  try {
    return String(response?.headers?.get?.(OWNER_REMOVAL_HEADER) ?? '')
      .trim()
      .toLowerCase();
  } catch {
    return '';
  }
}

/**
 * True when this answer is the PC refusing a removal from the owner's phone:
 * status 403 and the pc-only header or body.
 * @param {{status?: number, headers?: {get?: Function}} | null | undefined} response
 * @param {unknown} [body] The parsed JSON body, when the caller has read it.
 * @returns {boolean}
 */
export function isOwnerRemovalRefusal(response, body) {
  if (Number(response?.status) !== 403) return false;
  if (headerValue(response) === OWNER_REMOVAL_VALUE) return true;
  return (
    Boolean(body) &&
    typeof body === 'object' &&
    /** @type {{removal?: unknown}} */ (body).removal === OWNER_REMOVAL_VALUE
  );
}

/* Removal requests still waiting for an answer, and how many pc-only
 * refusals this page has had. Both live on the page's global object so every
 * module copy (and the voice layer) shares them. */
const STATE_KEY = Symbol.for('gev.ownerRemoval');

function state() {
  const root = /** @type {any} */ (globalThis);
  if (!root[STATE_KEY]) root[STATE_KEY] = { pending: 0, refused: 0 };
  return root[STATE_KEY];
}

/** Count one pc-only refusal and tell any listener (the voice layer). */
export function noteOwnerRemovalRefusal() {
  const current = state();
  current.refused += 1;
  try {
    const Event = globalThis.CustomEvent;
    if (typeof globalThis.dispatchEvent === 'function' && Event)
      globalThis.dispatchEvent(new Event(OWNER_REMOVAL_EVENT));
  } catch {
    /* No event target here; the count still moves. */
  }
}

/** How many pc-only refusals this page has had so far. */
export function ownerRemovalRefusalCount() {
  return state().refused;
}

/** How many watched removal requests are still waiting for an answer. */
export function pendingOwnerRemovals() {
  return state().pending;
}

/**
 * Watch one request that may remove something. Answers the same promise
 * result; a pc-only answer (by its header) is counted as soon as it lands.
 * @template T
 * @param {Promise<T>} request
 * @returns {Promise<T>}
 */
export async function watchOwnerRemoval(request) {
  const current = state();
  current.pending += 1;
  try {
    const response = await request;
    if (isOwnerRemovalRefusal(/** @type {any} */ (response)))
      noteOwnerRemovalRefusal();
    return response;
  } finally {
    current.pending = Math.max(0, current.pending - 1);
  }
}

/**
 * After a press: wait until the watched removal requests have their answers
 * (or `timeoutMs` passes), then say whether a pc-only refusal came in since
 * `since` (a count read before the press).
 * @param {number} since
 * @param {{timeoutMs?: number, pollMs?: number}} [options]
 * @returns {Promise<boolean>}
 */
export async function ownerRemovalRefusedSince(since, options = {}) {
  const timeoutMs = Number.isFinite(options.timeoutMs)
    ? Number(options.timeoutMs)
    : 8000;
  const pollMs = Number.isFinite(options.pollMs) ? Number(options.pollMs) : 25;
  const current = state();
  const until = Date.now() + timeoutMs;
  while (
    current.pending > 0 &&
    current.refused === since &&
    Date.now() < until
  ) {
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  // A body-only answer is counted after its JSON is read: give it a turn.
  if (current.refused === since)
    await new Promise((resolve) => setTimeout(resolve, 0));
  return current.refused !== since;
}
