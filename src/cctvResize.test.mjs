import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CCTV_CARD_SCALE_MAX,
  CCTV_CARD_SCALE_MIN,
  CCTV_CARD_SCALE_STORAGE_KEY,
  clampCardScale,
  draggedCardScale,
  isCardResizeCorner,
  loadCardScale,
  nextCardSizeStep,
  saveCardScale,
} from './data/cctvCardResize.js';
import {
  CCTV_CARD_MIN_SEP_PX,
  CCTV_CARD_THUMB_H,
  CCTV_CARD_THUMB_W,
  cctvCardSizeLabel,
  createCctvThumbnailOverlayEntry,
} from './data/cctvCards.js';
import {
  CCTV_PANEL_WIDTH_MAX,
  CCTV_PANEL_WIDTH_MIN,
  clampPanelWidth,
  draggedPanelWidth,
  nextPanelWidthStep,
} from './ui/cctvPanelResize.js';
import { locateSiteLocation, siteLocateMessage, splitSiteLocationQuery } from './privateCamerasSetup.js';

function memoryStorage() {
  const values = new Map();
  return {
    getItem: (key) => (values.has(key) ? values.get(key) : null),
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
  };
}

test('card scale is clamped, remembered and defaults to 1', () => {
  assert.equal(clampCardScale(1.5), 1.5);
  assert.equal(clampCardScale(99), CCTV_CARD_SCALE_MAX);
  assert.equal(clampCardScale(0.1), CCTV_CARD_SCALE_MIN);
  assert.equal(clampCardScale('nope'), 1);
  const storage = memoryStorage();
  assert.equal(loadCardScale(storage), 1);
  saveCardScale(2.345, storage);
  assert.equal(storage.getItem(CCTV_CARD_SCALE_STORAGE_KEY), '2.35');
  assert.equal(loadCardScale(storage), 2.35);
  assert.equal(loadCardScale({ getItem: () => { throw new Error('blocked'); } }), 1, 'blocked storage is not fatal');
});

test('one click steps the cards S → M → L → XL → S', () => {
  assert.equal(nextCardSizeStep(1), 1.5);
  assert.equal(nextCardSizeStep(1.5), 2.2);
  assert.equal(nextCardSizeStep(2.2), 0.75, 'XL wraps back to S');
  assert.equal(nextCardSizeStep(0.75), 1);
  assert.equal(nextCardSizeStep(1.2), 1.5, 'a dragged size steps to the next larger size');
  assert.deepEqual([0.75, 1, 1.5, 2.2, 1.2].map(cctvCardSizeLabel), ['S', 'M', 'L', 'XL', 'M']);
});

test('only the size badge in the bottom-right corner resizes', () => {
  const rect = { x: 100, y: 200, w: 104, h: 74 };
  assert.equal(isCardResizeCorner(rect, 200, 270), true);
  assert.equal(isCardResizeCorner(rect, 150, 230), false, 'the rest of the card still selects its camera');
  assert.equal(isCardResizeCorner(rect, 100, 270), false);
  assert.equal(isCardResizeCorner(null, 200, 270), false);
});

test('dragging the badge outward grows the cards, inward shrinks them', () => {
  const rect = { w: 100, h: 60 };
  assert.equal(draggedCardScale({ startScale: 1, rect, startX: 0, startY: 0, x: 100, y: 60 }), 2);
  assert.equal(draggedCardScale({ startScale: 2, rect, startX: 0, startY: 0, x: -50, y: -30 }), 1);
  assert.equal(draggedCardScale({ startScale: 1, rect, startX: 0, startY: 0, x: 5000, y: 5000 }), CCTV_CARD_SCALE_MAX);
});

test('a card entry scales its picture and spacing together and labels its size', () => {
  const base = createCctvThumbnailOverlayEntry({ id: 'a', title: 'A' });
  const big = createCctvThumbnailOverlayEntry({ id: 'a', title: 'A', scale: 2.2 });
  assert.deepEqual([base.thumbnailWidth, base.thumbnailHeight, base.minAnchorSeparationPx, base.resizeBadgeLabel], [CCTV_CARD_THUMB_W, CCTV_CARD_THUMB_H, CCTV_CARD_MIN_SEP_PX, 'M']);
  assert.deepEqual(
    [big.thumbnailWidth, big.thumbnailHeight, big.minAnchorSeparationPx, big.resizeBadgeLabel],
    [Math.round(CCTV_CARD_THUMB_W * 2.2), Math.round(CCTV_CARD_THUMB_H * 2.2), Math.round(CCTV_CARD_MIN_SEP_PX * 2.2), 'XL'],
  );
});

test('panel width: click steps, drag follows the anchored edge, always on screen', () => {
  assert.equal(nextPanelWidthStep(330, 1600), 380);
  assert.equal(nextPanelWidthStep(700, 1600), 300, 'the widest step wraps to the narrowest');
  assert.equal(nextPanelWidthStep(468, 500), 300, 'a narrow screen at its widest wraps instead of sticking');
  assert.equal(draggedPanelWidth({ startWidth: 330, startX: 500, x: 600, anchor: 'left', viewportWidth: 1600 }), 430);
  assert.equal(draggedPanelWidth({ startWidth: 330, startX: 500, x: 400, anchor: 'right', viewportWidth: 1600 }), 430, 'in the right rail, dragging left widens');
  assert.equal(clampPanelWidth(50, 1600), CCTV_PANEL_WIDTH_MIN);
  assert.equal(clampPanelWidth(5000, 4000), CCTV_PANEL_WIDTH_MAX);
  assert.equal(clampPanelWidth(900, 700), 668);
  assert.equal(clampPanelWidth('x'), null);
});

function jsonResponse(payload) {
  return { ok: true, json: async () => payload };
}

test('a site is located with OpenStreetMap only, from a street address or a postal code', async () => {
  assert.deepEqual(splitSiteLocationQuery('e2l4s6'), { postalCode: 'E2L 4S6', address: '' });
  assert.deepEqual(splitSiteLocationQuery('  42  Charlotte St, Saint John NB '), { postalCode: '', address: '42 Charlotte St, Saint John NB' });
  const asked = [];
  const osm =
    (results, ok = true) =>
    async (url) => {
      asked.push(new URL(url));
      return { ok, status: ok ? 200 : 503, json: async () => results };
    };

  const house = await locateSiteLocation('42 Charlotte St, Saint John NB', {
    fetchImpl: osm([{ lat: '45.2745', lon: '-66.061', display_name: '42, Charlotte Street, Saint John' }]),
  });
  assert.deepEqual(house, { lat: 45.2745, lon: -66.061, label: '42, Charlotte Street, Saint John', precision: 'exact' });
  assert.equal(asked.length, 1, 'one request, to OpenStreetMap only');
  assert.equal(asked[0].hostname, 'nominatim.openstreetmap.org');
  assert.equal(asked[0].searchParams.get('q'), '42 Charlotte St, Saint John NB');
  assert.match(siteLocateMessage(house), /^Placed at/);

  const street = await locateSiteLocation('42 Charlotte St, Saint John NB', { fetchImpl: osm([{ lat: '45.3', lon: '-66.1', display_name: 'Charlotte Street, Saint John' }]) });
  assert.equal(street.precision, 'street');
  assert.match(siteLocateMessage(street), /^Street only:/);

  const postal = await locateSiteLocation('E2L 4S6', { fetchImpl: osm([{ lat: '45.2733', lon: '-66.0633', display_name: 'Saint John, New Brunswick' }]) });
  assert.equal(postal.precision, 'approximate');
  assert.equal(asked.at(-1).searchParams.get('postalcode'), 'E2L 4S6');
  assert.equal(asked.at(-1).searchParams.get('countrycodes'), 'ca');
  assert.match(siteLocateMessage(postal), /^Approximate:/);

  assert.equal(await locateSiteLocation('Nowhere Road 99', { fetchImpl: osm([]) }), null, 'not found');
  await assert.rejects(() => locateSiteLocation('42 Charlotte St, Saint John NB', { fetchImpl: osm([], false) }), /answered 503/, 'a failed lookup is not "not found"');
  const before = asked.length;
  assert.equal(await locateSiteLocation('ab', { fetchImpl: osm([]) }), null, 'too short to look up');
  assert.equal(asked.length, before);
});
