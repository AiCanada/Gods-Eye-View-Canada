// GEV Arlo Feed Relay: pure logic shared by the content script (loaded first in
// the manifest) and the module service worker (side-effect import). It is a
// classic script with no import/export statements so both contexts can run it;
// it only ever defines globalThis.GevArloRelay. Nothing here touches the page's
// JavaScript, storage, cookies or the network.
(function defineGevArloRelay(root) {
  'use strict';

  if (root.GevArloRelay) return;

  const GEV_ORIGIN = 'http://localhost:4173';
  const ALLOWED_IMAGE_HOSTS = Object.freeze([
    'arlos3-prod-z1.s3.amazonaws.com',
    'arlos3-prod-z2.s3.amazonaws.com',
    'arlos3-prod-z3.s3.amazonaws.com',
    'arlos3-prod-z4.s3.amazonaws.com',
  ]);
  const SELECTORS = Object.freeze({
    item: 'div.feed-item-host',
    name: 'span.device-name',
    time: 'div.feed-item-time',
    type: 'div.feed-record-type',
    date: 'span.border-divider',
    image: 'img',
    feedContainer: 'div.feed-scroll-container, app-feed-scroll-container',
  });
  const FEED_STATES = Object.freeze(['feed', 'signed-out', 'no-cards', 'layout-unknown']);
  const PAIRING_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const PAIRING_CODE_LENGTH = 6;
  const CAMERA_NAME_MAX_LENGTH = 200;
  const CLIP_MAX_LENGTH = 80;
  const THUMBNAIL_MAX_BYTES = 8 * 1024 * 1024;
  const ARLO_PAGE_BASE = 'https://my.arlo.com/';
  const IMAGE_PATH = /\.(?:jpe?g|png|webp)$/i;
  const SIGNED_OUT_ROUTE = /^#\/(login|signin|signup|forgot)/i;
  const FEED_ROUTE = /^#\/feed(?![\w-])/i;
  const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/g;
  const BASE64URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

  function parseUrl(url, base) {
    let text = url;
    if (typeof text !== 'string') {
      if (!text || typeof text.href !== 'string') return null;
      text = text.href;
    }
    try {
      return base === undefined ? new URL(text) : new URL(text, base);
    } catch (_) {
      return null;
    }
  }

  /** Only https thumbnails on Arlo's four S3 recording hosts, with an image path. */
  function isAllowedThumbnailUrl(url) {
    const parsed = parseUrl(url);
    if (!parsed) return false;
    if (parsed.protocol !== 'https:') return false;
    if (!ALLOWED_IMAGE_HOSTS.includes(parsed.hostname)) return false;
    if (parsed.port !== '') return false;
    if (parsed.username || parsed.password) return false;
    if (!IMAGE_PATH.test(parsed.pathname)) return false;
    return !parsed.pathname.toLowerCase().includes('placeholder');
  }

  /** Same rules as normalizeRelayCameraName in src/privateCamerasCore.mjs. */
  function normalizeCameraName(text) {
    if (typeof text !== 'string') return '';
    return text.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
  }

  /** A presigned address without its query: stable for the same clip picture. */
  function urlKey(url) {
    const parsed = parseUrl(url);
    return parsed ? parsed.origin + parsed.pathname : '';
  }

  /** Plain one-line text: control characters dropped, whitespace collapsed, cut at max UTF-16 units without splitting a character. */
  function cleanLabel(text, max) {
    if (typeof text !== 'string') return '';
    // Lone surrogates would make encodeURIComponent throw in the service worker.
    const wellFormed = typeof text.toWellFormed === 'function' ? text.toWellFormed() : text;
    const clean = wellFormed.replace(CONTROL_CHARACTERS, ' ').replace(/\s+/g, ' ').trim();
    const limit = Number.isInteger(max) && max >= 0 ? max : clean.length;
    if (clean.length <= limit) return clean;
    let out = '';
    for (const character of clean) {
      if (out.length + character.length > limit) break;
      out += character;
    }
    return out.trim();
  }

  function textOf(element) {
    return element && typeof element.textContent === 'string' ? element.textContent : '';
  }

  /** Every feed card in document order (Arlo lists the newest clip first). */
  function readFeedItems(rootNode) {
    const items = [];
    if (!rootNode || typeof rootNode.querySelectorAll !== 'function') return items;
    const hosts = rootNode.querySelectorAll(SELECTORS.item);
    for (let index = 0; index < hosts.length; index += 1) {
      const host = hosts[index];
      if (!host || typeof host.querySelector !== 'function') continue;
      const name = cleanLabel(textOf(host.querySelector(SELECTORS.name)));
      const image = host.querySelector(SELECTORS.image);
      const rawSrc = image && typeof image.getAttribute === 'function' ? image.getAttribute('src') : null;
      if (!name || typeof rawSrc !== 'string' || !rawSrc.trim()) continue;
      const resolved = parseUrl(rawSrc.trim(), ARLO_PAGE_BASE);
      if (!resolved) continue;
      const clip = cleanLabel(
        [SELECTORS.type, SELECTORS.date, SELECTORS.time]
          .map((selector) => cleanLabel(textOf(host.querySelector(selector))))
          .filter(Boolean)
          .join(' · '),
        CLIP_MAX_LENGTH,
      );
      items.push({ name, src: resolved.href, clip });
    }
    return items;
  }

  /** normalized camera name -> newest item whose picture is an allowed thumbnail. */
  function pickNewestPerCamera(items) {
    const newest = new Map();
    if (!items || typeof items[Symbol.iterator] !== 'function') return newest;
    for (const item of items) {
      if (!item || typeof item.src !== 'string') continue;
      const key = normalizeCameraName(item.name);
      if (!key || newest.has(key) || !isAllowedThumbnailUrl(item.src)) continue;
      newest.set(key, item);
    }
    return newest;
  }

  function detectFeedState(doc, loc) {
    const hash = loc && typeof loc.hash === 'string' ? loc.hash : '';
    if (SIGNED_OUT_ROUTE.test(hash)) return 'signed-out';
    if (!doc || typeof doc.querySelector !== 'function') return 'layout-unknown';
    if (doc.querySelector('input[type=password]')) return 'signed-out';
    if (doc.querySelector(SELECTORS.item)) return 'feed';
    if (doc.querySelector(SELECTORS.feedContainer)) return 'no-cards';
    return 'layout-unknown';
  }

  /**
   * Whether a tab should report at all: one showing feed cards, or one on the
   * feed or a sign-in route. A tab on another Arlo page (devices, settings with
   * a change-password form, ...) says nothing, so it never contradicts the tab
   * that reads the feed.
   */
  function isReportablePage(state, loc) {
    const hash = loc && typeof loc.hash === 'string' ? loc.hash : '';
    return state === 'feed' || FEED_ROUTE.test(hash) || SIGNED_OUT_ROUTE.test(hash);
  }

  /**
   * Whether text is a pairing code as Gods Eye View issues it: six characters
   * from the 32-letter alphabet. GEV picks the code, never the extension, so no
   * other extension can put the same code on a request of its own.
   */
  function isPairingCode(text) {
    if (typeof text !== 'string' || text.length !== PAIRING_CODE_LENGTH) return false;
    for (const character of text) {
      if (!PAIRING_CODE_ALPHABET.includes(character)) return false;
    }
    return true;
  }

  function toBytes(value) {
    if (typeof value === 'string') return new TextEncoder().encode(value);
    if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    if (Object.prototype.toString.call(value) === '[object ArrayBuffer]') return new Uint8Array(value);
    if (Array.isArray(value)) return Uint8Array.from(value, (byte) => Number(byte) & 255);
    throw new TypeError('Expected bytes');
  }

  function base64url(bytes) {
    const view = toBytes(bytes);
    let out = '';
    for (let index = 0; index < view.length; index += 3) {
      const remaining = view.length - index;
      const chunk = (view[index] << 16) | ((remaining > 1 ? view[index + 1] : 0) << 8) | (remaining > 2 ? view[index + 2] : 0);
      out += BASE64URL_ALPHABET[(chunk >> 18) & 63] + BASE64URL_ALPHABET[(chunk >> 12) & 63];
      if (remaining > 1) out += BASE64URL_ALPHABET[(chunk >> 6) & 63];
      if (remaining > 2) out += BASE64URL_ALPHABET[chunk & 63];
    }
    return out;
  }

  async function sha256Hex(bytes) {
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', toBytes(bytes)));
    let hex = '';
    for (const byte of digest) hex += byte.toString(16).padStart(2, '0');
    return hex;
  }

  function sniffImageType(bytes) {
    let view;
    try {
      view = toBytes(bytes);
    } catch (_) {
      return '';
    }
    if (view.length >= 3 && view[0] === 0xff && view[1] === 0xd8 && view[2] === 0xff) return 'image/jpeg';
    const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    if (view.length >= png.length && png.every((byte, index) => view[index] === byte)) return 'image/png';
    const riff = [0x52, 0x49, 0x46, 0x46];
    const webp = [0x57, 0x45, 0x42, 0x50];
    if (view.length >= 12 && riff.every((byte, index) => view[index] === byte) && webp.every((byte, index) => view[index + 8] === byte)) return 'image/webp';
    return '';
  }

  root.GevArloRelay = Object.freeze({
    GEV_ORIGIN,
    ALLOWED_IMAGE_HOSTS,
    SELECTORS,
    FEED_STATES,
    PAIRING_CODE_ALPHABET,
    CAMERA_NAME_MAX_LENGTH,
    CLIP_MAX_LENGTH,
    THUMBNAIL_MAX_BYTES,
    isAllowedThumbnailUrl,
    normalizeCameraName,
    urlKey,
    cleanLabel,
    readFeedItems,
    pickNewestPerCamera,
    detectFeedState,
    isReportablePage,
    isPairingCode,
    base64url,
    sha256Hex,
    sniffImageType,
  });
})(globalThis);
