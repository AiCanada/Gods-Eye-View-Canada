#!/usr/bin/env node
/** Camera-panel browser acceptance with controlled sources, images and terrain. */
import fs from 'node:fs';
import puppeteer from 'puppeteer';
const origin = process.env.QA_BASE_URL || 'http://localhost:4173';
const selectAllModifier = process.platform === 'darwin' ? 'Meta' : 'Control';
const sources = [
  {
    id: 'qa-camera-a',
    name: 'QA Camera A',
    lat: 30.2747,
    lon: -97.7403,
    headingDeg: 30,
  },
  {
    id: 'qa-camera-b',
    name: 'QA Camera B',
    lat: 30.2672,
    lon: -97.7431,
    headingDeg: 200,
  },
].map((camera) => ({
  ...camera,
  city: 'Austin',
  cityId: 'austin',
  provider: 'QA camera fixture',
  feedType: 'snapshot',
  feedConfigured: true,
  pitchDeg: -18,
  fovDeg: 60,
  rangeM: 300,
  mountHeightM: 8,
}));
// Near both fixture cameras; the layer loads an area only below 400 km or for
// a selected place, so the script views and selects this point before waiting.
const fixturePlace = { lat: 30.271, lon: -97.7417 };
const areaRadiusKm = 50;
const distanceKm = (lat1, lon1, lat2, lon2) => {
  const rad = Math.PI / 180;
  const a =
    Math.sin(((lat2 - lat1) * rad) / 2) ** 2 +
    Math.cos(lat1 * rad) *
      Math.cos(lat2 * rad) *
      Math.sin(((lon2 - lon1) * rad) / 2) ** 2;
  return 12742 * Math.asin(Math.min(1, Math.sqrt(a)));
};
/** The camera-area contract: fixture cameras within 50 km, nearest first. */
const areaResponse = (params) => {
  const lat = Number(params.get('lat'));
  const lon = Number(params.get('lon'));
  const inArea =
    Number.isFinite(lat) && Number.isFinite(lon)
      ? sources
          .map((camera) => ({
            camera,
            km: distanceKm(lat, lon, camera.lat, camera.lon),
          }))
          .filter(({ km }) => km <= areaRadiusKm)
          .sort((a, b) => a.km - b.km)
          .map(({ camera }) => camera)
      : [];
  return {
    area: {
      lat,
      lon,
      radiusKm: areaRadiusKm,
      limit: 1000,
      inArea: inArea.length,
      loaded: inArea.length,
      dropped: 0,
      reachKm: areaRadiusKm,
      capped: false,
      total: sources.length,
      generation: 1,
      pending: [],
    },
    sources: inArea,
  };
};
const browser = await puppeteer.launch({
  headless: true,
  args: [
    '--no-sandbox',
    ...(process.platform === 'darwin'
      ? ['--use-angle=metal', '--enable-gpu']
      : ['--use-gl=angle', '--use-angle=swiftshader']),
  ],
});
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
let failures = 0;
const check = (name, ok, detail) => {
  console.log(
    `[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${JSON.stringify(detail)}` : ''}`,
  );
  if (!ok) failures++;
};
let delayCameraA = false;
const delayedFrames = new Set();
try {
  await page.setViewport({ width: 1440, height: 900 });
  await page.setRequestInterception(true);
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.origin !== new URL(origin).origin) return void request.continue();
    const json = (body) =>
      request.respond({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(body),
      });
    if (url.pathname === '/api/cctv/sources')
      return void json(areaResponse(url.searchParams));
    // The layer keeps this machine's private cameras; none here keeps the
    // catalog to exactly the two fixture cameras.
    if (url.pathname === '/api/private-cams/sources')
      return void json({ sources: [] });
    if (url.pathname === '/api/cctv/health')
      return void json({
        cameras: sources.map((camera) => ({
          id: camera.id,
          status: 'ok',
          sourceKind: 'snapshot',
          label: 'QA camera fixture',
        })),
      });
    if (url.pathname.startsWith('/api/cctv/frame/')) {
      const cameraA = url.pathname.endsWith('qa-camera-a');
      const respond = () =>
        request
          .respond({
            status: 200,
            contentType: 'image/svg+xml',
            headers: { 'Cache-Control': 'no-store' },
            body: `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><rect width="640" height="360" fill="${cameraA ? '#16364d' : '#254b32'}"/><path d="M0 260L640 130M240 0L420 360" stroke="#97acb7" stroke-width="26"/><text x="30" y="55" fill="white" font-size="30">QA CAMERA ${cameraA ? 'A' : 'B'}</text></svg>`,
          })
          .catch(() => {});
      if (cameraA && delayCameraA) delayedFrames.add(respond);
      else void respond();
      return;
    }
    if (url.pathname === '/api/terrain/heights') {
      const points = (url.searchParams.get('points') || '')
        .split(';')
        .filter(Boolean);
      return void json({
        results: points.map((point) => {
          const [lon, lat] = point.split(',').map(Number);
          return { lon, lat, elevation: 0, geoid: 0, ellipsoid: 0 };
        }),
      });
    }
    if (url.pathname === '/api/openai/hud-summary')
      return void json({ summary: 'QA camera controls' });
    void request.continue();
  });
  await page.goto(`${origin}/?welcome=0`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () =>
      window.__godsEyeView?.styleManager?._cctvControls &&
      window.__godsEyeView?.dataManager?.layers?.has('cctv') &&
      document.getElementById('loading-screen')?.classList.contains('hidden'),
    { timeout: 60000 },
  );
  await page.evaluate(({ lat, lon }) => {
    const { viewer } = window.__godsEyeView;
    const Cartesian3 = viewer.camera.position.constructor;
    viewer.camera.setView({
      destination: Cartesian3.fromDegrees(lon, lat, 6000),
      orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
    });
  }, fixturePlace);
  await page.$eval('[data-collapse-target="cctv-panel"]', (button) =>
    button.click(),
  );
  await page.click('#cctv-enable-btn');
  // Select the place too, so the area loads even if a boot flight moves the view.
  await page.evaluate(
    (point) => window.__godsEyeView.dataManager.selectLocationArea({ point }),
    fixturePlace,
  );
  await page.waitForFunction(
    () =>
      window.__godsEyeView.dataManager.layers.get('cctv').module.getUIState()
        .cameras.length === 2 &&
      !document.getElementById('cctv-camera-select').disabled,
    { timeout: 30000 },
  );
  check(
    'CCTV enable uses the supplied two-camera catalog',
    await page.$eval(
      '#cctv-camera-select',
      (select) => select.options.length === 2 && !select.disabled,
    ),
  );
  await page.select('#cctv-camera-select', 'qa-camera-a');
  await page.waitForFunction(
    () =>
      document.getElementById('cctv-frame').dataset.cameraId ===
        'qa-camera-a' &&
      document
        .getElementById('cctv-frame-wrap')
        .classList.contains('has-frame'),
  );
  const state = () =>
    page.evaluate(() =>
      window.__godsEyeView.dataManager.layers.get('cctv').module.getUIState(),
    );
  check(
    'selected camera, decoded preview and source label agree',
    await page.evaluate(() => {
      const camera = window.__godsEyeView.dataManager.layers
        .get('cctv')
        .module.getUIState().activeCamera;
      return (
        camera.id === 'qa-camera-a' &&
        document.getElementById('cctv-frame').src.includes('qa-camera-a') &&
        document
          .getElementById('cctv-meta')
          .textContent.includes('QA camera fixture')
      );
    }),
  );
  const coverage = (await state()).coverageMode;
  const modes = [];
  for (let i = 0; i < 3; i++) {
    await page.click('#cctv-coverage-btn');
    modes.push((await state()).coverageMode);
  }
  check(
    'coverage cycles through all three modes and returns to its starting state',
    new Set(modes).size === 3 && modes.at(-1) === coverage,
    modes,
  );
  const projection = (await state()).showProjection;
  await page.click('#cctv-projection-btn');
  check(
    'projection control updates the layer state',
    (await state()).showProjection === !projection,
  );
  await page.click('#cctv-projection-btn');
  await page.click('#cctv-next-btn');
  await page.waitForFunction(
    () =>
      window.__godsEyeView.dataManager.layers.get('cctv').module.getUIState()
        .activeCameraId === 'qa-camera-b',
  );
  await page.click('#cctv-prev-btn');
  await page.waitForFunction(
    () =>
      window.__godsEyeView.dataManager.layers.get('cctv').module.getUIState()
        .activeCameraId === 'qa-camera-a',
  );
  check(
    'native Next and Previous return to the original camera',
    (await state()).activeCameraId === 'qa-camera-a',
  );
  for (const [selector, key] of [
    ['#cctv-auto-hop-btn', 'autoHop'],
    ['#cctv-adjust-btn', 'calibrationMode'],
  ]) {
    const before = (await state())[key];
    await page.click(selector);
    const changed = (await state())[key] === !before;
    await page.click(selector);
    check(
      `${key} control changes and restores the layer setting`,
      changed && (await state())[key] === before,
    );
  }
  // Auto Hop can legitimately advance immediately; restore the calibration target.
  await page.select('#cctv-camera-select', 'qa-camera-a');
  await page.waitForFunction(
    () =>
      window.__godsEyeView.dataManager.layers.get('cctv').module.getUIState()
        .activeCameraId === 'qa-camera-a',
  );
  const heading = (await state()).activeCamera.headingDeg;
  const chip = '.cctv-cal-value[data-cal-field="heading"]';
  await page.click(chip);
  await page.focus(`${chip} input`);
  await page.keyboard.down(selectAllModifier);
  await page.keyboard.press('a');
  await page.keyboard.up(selectAllModifier);
  await page.keyboard.type(String(heading + 10));
  await page.keyboard.press('Enter');
  check(
    'native calibration editing commits an offset for the selected camera',
    Math.abs((await state()).activeCamera.headingDeg - (heading + 10)) < 0.01,
  );
  await page.click('#cctv-calib-save-btn');
  check(
    'Save persists the selected camera calibration',
    await page.evaluate(() =>
      Boolean(
        JSON.parse(
          localStorage.getItem('godsEyeView.cctv.calibration.v2') || '{}',
        )['qa-camera-a'],
      ),
    ),
  );
  await page.click('#cctv-calib-reset-btn');
  check(
    'Reset restores the original pose',
    Math.abs((await state()).activeCamera.headingDeg - heading) < 0.01,
  );
  await page.click(chip);
  await page.focus(`${chip} input`);
  await page.keyboard.down(selectAllModifier);
  await page.keyboard.press('a');
  await page.keyboard.up(selectAllModifier);
  await page.keyboard.type('110');
  await page.keyboard.press('Escape');
  check(
    'Escape cancels editing without collapsing CCTV',
    (await page.evaluate(
      () =>
        !document.querySelector('.cctv-cal-input') &&
        !document.getElementById('cctv-panel').classList.contains('collapsed'),
    )) && Math.abs((await state()).activeCamera.headingDeg - heading) < 0.01,
  );
  await page.click(chip);
  await page.evaluate(() => {
    const input = document.querySelector('.cctv-cal-input');
    input.value = '110';
    window.__godsEyeView.dataManager.layers
      .get('cctv')
      .module.selectCamera('qa-camera-b');
    input.dispatchEvent(new Event('blur'));
  });
  check(
    'an external camera selection cancels the prior calibration editor',
    (await state()).activeCamera.id === 'qa-camera-b' &&
      Math.abs((await state()).activeCamera.headingDeg - 200) < 0.01 &&
      (await page.$('.cctv-cal-input')) === null,
  );
  await page.waitForFunction(
    () =>
      document.getElementById('cctv-frame').dataset.cameraId ===
        'qa-camera-b' &&
      document
        .getElementById('cctv-frame-wrap')
        .classList.contains('has-frame'),
  );
  await page.setCacheEnabled(false);
  delayCameraA = true;
  await page.select('#cctv-camera-select', 'qa-camera-a');
  await page.waitForFunction(
    () =>
      document.getElementById('cctv-frame').dataset.cameraId ===
        'qa-camera-a' &&
      document.getElementById('cctv-frame').dataset.loading === 'true',
  );
  await page.evaluate(() => {
    const image =
      window.__godsEyeView.styleManager._cctvControls._cctvFramePreloader;
    window.__qaLateCctvImage = image;
    window.__qaLateCctvImageLoaded = false;
    image.addEventListener(
      'load',
      () => {
        window.__qaLateCctvImageLoaded = true;
      },
      { once: true },
    );
  });
  check(
    'a newly selected camera clears old pixels while its frame loads',
    await page.$eval(
      '#cctv-frame-wrap',
      (element) => !element.classList.contains('has-frame'),
    ),
  );
  await page.select('#cctv-camera-select', 'qa-camera-b');
  await page.waitForFunction(
    () =>
      document.getElementById('cctv-frame').dataset.cameraId ===
        'qa-camera-b' &&
      document
        .getElementById('cctv-frame-wrap')
        .classList.contains('has-frame'),
  );
  delayCameraA = false;
  await Promise.all([...delayedFrames].map((respond) => respond()));
  delayedFrames.clear();
  await page.waitForFunction(() => window.__qaLateCctvImageLoaded);
  check(
    'late frames cannot overwrite the latest camera selection',
    await page.$eval(
      '#cctv-frame',
      (image) =>
        image.dataset.cameraId === 'qa-camera-b' &&
        image.src.includes('qa-camera-b'),
    ),
  );
  delayCameraA = false;
  await page.click('#cctv-enable-btn');
  await page.waitForFunction(
    () => !window.__godsEyeView.dataManager.isEnabled('cctv'),
  );
  const disabledCleanly = await page.$eval(
    '#cctv-frame',
    (image) => !image.getAttribute('src') && image.dataset.cameraId === '',
  );
  await page.click('#cctv-enable-btn');
  await page.waitForFunction(
    () =>
      window.__godsEyeView.dataManager.isEnabled('cctv') &&
      document
        .getElementById('cctv-frame-wrap')
        .classList.contains('has-frame'),
  );
  check(
    'disable clears the preview and re-enable reacquires the camera frame',
    disabledCleanly,
  );
  await page.$eval('#cctv-frame', (image) =>
    image.scrollIntoView({ block: 'nearest' }),
  );
  fs.mkdirSync('qa-shots/camera-controls', { recursive: true });
  await page.screenshot({ path: 'qa-shots/camera-controls/desktop.png' });
  await page.evaluate(() => {
    const camera = window.__godsEyeView.viewer.camera;
    camera.setView({
      orientation: {
        heading: camera.heading + Math.PI / 3,
        pitch: -0.6,
        roll: 0,
      },
    });
  });
  await new Promise((resolve) => setTimeout(resolve, 700));
  await page.screenshot({ path: 'qa-shots/camera-controls/angle.png' });
  await page.setViewport({ width: 390, height: 844 });
  await new Promise((resolve) => setTimeout(resolve, 700));
  await page.screenshot({ path: 'qa-shots/camera-controls/narrow.png' });
  check(
    'narrow camera panel remains within the viewport',
    await page.$eval('#cctv-panel', (panel) => {
      const rect = panel.getBoundingClientRect();
      return rect.width > 0 && rect.left >= 0 && rect.right <= innerWidth + 1;
    }),
  );
  check(
    'rebuilding Radio preserves the active camera controller and subscription',
    await page.evaluate(() => {
      const ui = window.__godsEyeView.styleManager;
      const camera = ui._cctvControls;
      const cameraId = camera.getState()?.activeCameraId;
      ui._initRadioPanel();
      ui._radioControls.connect();
      return (
        ui._cctvControls === camera &&
        !camera.destroyed &&
        Boolean(camera._cctvUnsubscribe) &&
        camera.getState()?.activeCameraId === cameraId
      );
    }),
  );
  await page.evaluate(() => window.__godsEyeView.styleManager.dispose());
  check(
    'CCTV controller is destroyed with the real UI',
    await page.evaluate(
      () => window.__godsEyeView.styleManager._cctvControls.destroyed,
    ),
  );
  check(
    'camera controls produce no uncaught browser errors',
    errors.length === 0,
    errors,
  );
} finally {
  await Promise.all([...delayedFrames].map((respond) => respond()));
  await browser.close();
}
if (failures) process.exitCode = 1;
