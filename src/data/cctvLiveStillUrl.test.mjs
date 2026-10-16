import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  decodeNumericEntities,
  liveStillUrl,
  normalizeSourceItem,
} from '../../server/providers/cctv/normalize.js';
import { staticFrameRefreshMs } from './cctvLod.js';

const TORONTO =
  'https://opendata.toronto.ca/transportation/tmc/rescucameraimages';
const PACKS = [
  'config/cctv_sources.canada.json',
  'config/cctv_sources.intl.json',
  'config/cctv_sources.inventory.json',
];

function packCameras(file) {
  const data = JSON.parse(
    fs.readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8'),
  );
  return Array.isArray(data) ? data : data.cameras;
}

test('numeric character references decode; invalid ones stay as written', () => {
  assert.equal(decodeNumericEntities('Vall&#232;s &#xE0;'), 'Vallès à');
  assert.equal(decodeNumericEntities('a&#0;b&#xD800;'), 'a&#0;b&#xD800;');
  assert.equal(decodeNumericEntities(null), '');
});

test('Catalonia SCT RenderService links become the direct TransitCamera frame', () => {
  const direct =
    'http://mct.gencat.cat/mct2bo/TransitCamera?nom=c0746.gif&visualitzacio=imatge';
  for (const scheme of ['https', 'http'])
    assert.equal(
      liveStillUrl(
        `${scheme}://mct.gencat.cat/mct2bo/RenderService?sctidcam=c0746.gif`,
      ),
      direct,
    );
  // Only a bare image filename is accepted as the camera id.
  const odd = 'https://mct.gencat.cat/mct2bo/RenderService?sctidcam=../x&y=1';
  assert.equal(liveStillUrl(odd), odd);
});

test('a Toronto 2016 comparison still becomes the camera’s live view', () => {
  for (const view of ['n', 's', 'e', 'w', ''])
    assert.equal(
      liveStillUrl(`${TORONTO}/ComparisonImages/loc8071${view}.jpg`),
      `${TORONTO}/CameraImages/loc8071.jpg`,
    );
  assert.equal(
    liveStillUrl(`${TORONTO}/CameraImages/loc8238.jpg`),
    `${TORONTO}/CameraImages/loc8238.jpg`,
  );
});

test('entity junk, control characters and trailing escaped spaces leave a link', () => {
  assert.equal(
    liveStillUrl(
      'https://emap.terrassa.cat/it_terrassa/cam01.jpeg?a=1%20&#13;',
    ),
    'https://emap.terrassa.cat/it_terrassa/cam01.jpeg?a=1',
  );
  assert.equal(
    liveStillUrl('  https://x.example/a.jpg\r\n'),
    'https://x.example/a.jpg',
  );
  assert.equal(liveStillUrl(undefined), '');
});

test('the catalogue normalises every source’s url and snapshotUrl', () => {
  const source = normalizeSourceItem({
    id: 'a',
    url: `${TORONTO}/ComparisonImages/loc8071e.jpg`,
    snapshotUrl: 'https://mct.gencat.cat/mct2bo/RenderService?sctidcam=c1.gif',
  });
  assert.equal(source.url, `${TORONTO}/CameraImages/loc8071.jpg`);
  assert.equal(
    source.snapshotUrl,
    'http://mct.gencat.cat/mct2bo/TransitCamera?nom=c1.gif&visualitzacio=imatge',
  );
});

test('no pack lists a dead Toronto still, a RenderService link or entity junk', () => {
  for (const file of PACKS)
    for (const camera of packCameras(file)) {
      const url = String(camera.url || '');
      assert.doesNotMatch(
        url,
        /ComparisonImages|RenderService|&#/,
        `${file} ${camera.id}`,
      );
      assert.equal(liveStillUrl(url), url.trim(), `${file} ${camera.id}`);
    }
});

test('each Toronto camera is one live entry per pack, with no direction rows', () => {
  for (const file of PACKS) {
    const ids = new Set();
    const views = new Map();
    for (const camera of packCameras(file)) {
      assert.ok(!ids.has(camera.id), `${file}: duplicate id ${camera.id}`);
      ids.add(camera.id);
      const loc = /rescucameraimages\/CameraImages\/loc(\d+)\.jpg$/.exec(
        camera.url || '',
      )?.[1];
      if (!loc) continue;
      assert.ok(!views.has(loc), `${file}: loc${loc} listed twice`);
      views.set(loc, camera.id);
      assert.doesNotMatch(camera.name, /\((North|South|East|West)( view)?\)$/);
    }
  }
});

test('Catalonia SCT frames refresh every 3 minutes', () => {
  for (const provider of [
    'Catalonia SCT cameres.kml',
    'Catalonia SCT cameres.xml',
  ])
    assert.equal(staticFrameRefreshMs({ provider }), 180_000);
});
