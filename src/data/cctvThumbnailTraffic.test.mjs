import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CCTV_VIEW_MAX_TAGS,
  THUMBNAIL_ROAD_BAND_TOP,
  collectThumbnailPictures,
  paintTrafficOverThumbnails,
  vehicleTag,
} from './cctvThumbnailTraffic.js';

// Identity view-projection: clip space == world space, so a point at
// (nx, ny) lands at ((nx*0.5+0.5)*width, (0.5-ny*0.5)*height).
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const at = (sx, sy, width = 1000, height = 500) => ({ x: (sx / width) * 2 - 1, y: 1 - (sy / height) * 2, z: 0 });
const noMarkers = () => {};

function recordingContext() {
  const arcs = [];
  const texts = [];
  return {
    arcs,
    texts,
    fillStyle: '',
    beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, fillRect() {},
    measureText: (text) => ({ width: text.length * 5 }),
    arc(x, y, r) { arcs.push({ x: Math.round(x), y: Math.round(y), r, fill: null }); },
    fill() { arcs.at(-1).fill = this.fillStyle; },
    fillText(text, x, y) { texts.push({ text, x: Math.round(x), y: Math.round(y) }); },
  };
}

function card(x, y, { variant = 'thumbnail', sourceId = 'cctv', w = 104, h = 80, id = 'cam-1' } = {}) {
  return { x, y, w, h, sourceId, entry: { id, variant, thumbnailWidth: 96, thumbnailHeight: 54 } };
}

function frameWith(rects, ctx) {
  return { ctx, viewProjectionMatrix: IDENTITY, width: 1000, height: 500, paintRects: rects, paintRectCount: rects.length };
}

test('only CCTV thumbnail cards contribute pictures, inset to the image area', () => {
  const rects = [card(100, 100), card(300, 100, { variant: 'card' }), card(500, 100, { sourceId: 'flights' })];
  assert.equal(collectThumbnailPictures(frameWith(rects, recordingContext())), 1);
  const scaled = [card(100, 100, { w: 208, h: 160 })];
  assert.equal(collectThumbnailPictures(frameWith(scaled, recordingContext())), 1);
});

test('a thumbnail shows the vehicles passing behind it on the map, tagged', () => {
  const ctx = recordingContext();
  const red = { toCssColorString: () => 'rgb(255,0,0)' };
  const dots = [
    { position: at(150, 130), color: red, pixelSize: 6, show: true }, // inside the picture (104..200 x 104..158)
    { position: at(150, 170), color: red, pixelSize: 6, show: true }, // on the title strip, not the picture
    { position: at(700, 300), color: red, pixelSize: 6, show: true }, // open map
    { position: at(160, 140), color: red, pixelSize: 6, show: false }, // hidden by the traffic layer
  ];
  const drawn = paintTrafficOverThumbnails(frameWith([card(100, 100)], ctx), (visit) => dots.forEach((d, i) => visit(d, 40 + i)), noMarkers);
  assert.equal(drawn, 1);
  // Same left-right position; its height is squeezed into the picture's road
  // band (the lower 55%), so a vehicle never floats in the picture's sky.
  assert.deepEqual(ctx.arcs, [{ x: 150, y: 143, r: 3, fill: 'rgb(255,0,0)' }]);
  assert.ok(ctx.arcs[0].y >= 104 + 54 * THUMBNAIL_ROAD_BAND_TOP);
  assert.deepEqual(ctx.texts.map((t) => t.text), ['VEH-0040'], 'the ID tag rides with the vehicle');
  assert.equal(vehicleTag(7), 'VEH-0007');
});

test('every dot on a camera view carries its ID tag; a vehicle with no room for one is left off', () => {
  const ctx = recordingContext();
  // Three vehicles stacked on one spot: only the first tag fits, so only one dot.
  const stacked = [0, 1, 2].map(() => ({ position: at(200, 160), pixelSize: 6, show: true }));
  // Two more, well apart: both fit.
  const apart = [{ position: at(120, 120), pixelSize: 6, show: true }, { position: at(280, 200), pixelSize: 6, show: true }];
  const dots = [...stacked, ...apart];
  // A double-size card: picture area x 108..300, y 108..216.
  const drawn = paintTrafficOverThumbnails(frameWith([card(100, 100, { w: 208, h: 160 })], ctx), (visit) => dots.forEach((d, i) => visit(d, i)), noMarkers);
  assert.equal(drawn, 3);
  assert.equal(ctx.arcs.length, ctx.texts.length, 'never an anonymous dot');
  assert.deepEqual(ctx.texts.map((t) => t.text), ['VEH-0000', 'VEH-0003', 'VEH-0004']);
});

test('every marker on the open monitor picture is tagged, up to the shared cap', () => {
  const ctx = recordingContext();
  const many = (visit) => { for (let i = 0; i < CCTV_VIEW_MAX_TAGS + 25; i += 1) visit(at(600, 250), i); };
  paintTrafficOverThumbnails(frameWith([], ctx), () => {}, many);
  assert.equal(CCTV_VIEW_MAX_TAGS, 1000);
  assert.equal(ctx.texts.length, CCTV_VIEW_MAX_TAGS);
  assert.equal(ctx.texts[0].text, 'VEH-0000');
});

test('nothing is projected when no camera view is on screen', () => {
  const ctx = recordingContext();
  let visited = 0;
  assert.equal(paintTrafficOverThumbnails(frameWith([], ctx), (visit) => { visited += 1; visit({}, 0); }, noMarkers), 0);
  assert.equal(visited, 0, 'no cards, no per-vehicle work');
});
