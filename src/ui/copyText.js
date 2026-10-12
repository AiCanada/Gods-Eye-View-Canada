/**
 * Copy text the way every browser this app runs on can.
 *
 * 1. `navigator.clipboard.writeText` (secure pages: the PC on localhost, or a
 *    phone that allows the mirror under chrome://flags).
 * 2. A hidden, read-only textarea and `document.execCommand('copy')`, which
 *    still works on a plain http page such as the phone mirror.
 * 3. `navigator.share({ text })`, the phone's share sheet, as a last resort.
 *
 * Answers true only when one of them took the text; never throws.
 *
 * @param {string} text
 * @param {{clipboard?: {writeText: Function} | null, document?: Document | null, navigator?: Navigator | null}} [options]
 *   Injected for tests; each defaults to the browser's own.
 * @returns {Promise<boolean>}
 */
export async function copyText(text, options = {}) {
  const value = String(text ?? '');
  const nav =
    options.navigator !== undefined ? options.navigator : globalThis.navigator;
  const clipboard =
    options.clipboard !== undefined ? options.clipboard : nav?.clipboard;
  const doc =
    options.document !== undefined ? options.document : globalThis.document;
  if (typeof clipboard?.writeText === 'function') {
    try {
      await clipboard.writeText(value);
      return true;
    } catch {
      /* fall through: an http page or a denied permission */
    }
  }
  if (copyWithTextarea(value, doc)) return true;
  if (typeof nav?.share === 'function') {
    try {
      await nav.share({ text: value });
      return true;
    } catch {
      /* cancelled or not allowed */
    }
  }
  return false;
}

function copyWithTextarea(value, doc) {
  if (
    !doc ||
    typeof doc.createElement !== 'function' ||
    typeof doc.execCommand !== 'function' ||
    !doc.body
  )
    return false;
  const previous = doc.activeElement;
  let area = null;
  try {
    area = doc.createElement('textarea');
    area.value = value;
    area.setAttribute('readonly', '');
    area.setAttribute('aria-hidden', 'true');
    area.tabIndex = -1;
    // Off screen and invisible; it exists only for the copy.
    Object.assign(area.style, {
      position: 'fixed',
      top: '0',
      left: '-9999px',
      opacity: '0',
      pointerEvents: 'none',
    });
    doc.body.appendChild(area);
    area.focus?.();
    area.select?.();
    area.setSelectionRange?.(0, value.length);
    return doc.execCommand('copy') === true;
  } catch {
    return false;
  } finally {
    try {
      area?.remove?.();
    } catch {
      /* already gone */
    }
    try {
      if (previous && previous !== area)
        previous.focus?.({ preventScroll: true });
    } catch {
      /* focus is best effort */
    }
  }
}
