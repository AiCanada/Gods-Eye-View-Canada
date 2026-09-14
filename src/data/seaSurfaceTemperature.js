import * as Cesium from 'cesium';
import {
  DEFAULT_SST_FRONT_SENSITIVITY,
  DEFAULT_SST_PRODUCT_ID,
  SST_FRONT_SENSITIVITIES,
  SST_PRODUCTS,
  sstProductById,
} from './sstProducts.js';

/** NASA GIBS Web Mercator tile root (keyless). */
export const GIBS_WEB_MERCATOR_ROOT = 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best';

/** Status older than this is refreshed the next time the layer turns on. */
const STATUS_MAX_AGE_MS = 30 * 60 * 1000;
/** Wait for the camera to settle before drawing Level-3 data for a new view. */
const LEVEL3_REFRESH_DELAY_MS = 700;

const OFF_NOTE = 'Off. Turn on to drape sea surface temperature over the oceans.';
const PHOTOREAL_NOTE = 'Hidden on the photorealistic 3D map. Switch MAP to an imagery stack to see SST.';
const LOADING_NOTE = 'Loading OceanColor Level-3 data and detecting fronts for this view…';
const NO_LAND_MASK_NOTE = 'Land mask unavailable right now: lakes and coasts may show false fronts.';

/**
 * Tile URL template for a GIBS product on a date. An unknown date asks GIBS
 * for its newest one ("default").
 */
export function sstTileUrlTemplate(product, date) {
  const time = /^\d{4}-\d{2}-\d{2}$/.test(String(date || '')) ? date : 'default';
  return `${GIBS_WEB_MERCATOR_ROOT}/${product.gibsLayer}/default/${time}/${product.matrixSet}/{z}/{y}/{x}.png`;
}

/**
 * The view box to request, in degrees: padded 10%, snapped outward to whole
 * degrees so small camera nudges reuse the server's cached images. A view
 * across the antimeridian asks for every longitude.
 *
 * @param {{west:number, south:number, east:number, north:number}|null} view Degrees.
 * @returns {string} "west,south,east,north"
 */
export function sstViewBbox(view) {
  if (!view) return '-180,-90,180,90';
  let { west, east } = view;
  if (east < west) {
    west = -180;
    east = 180;
  }
  const padX = (east - west) * 0.1;
  const padY = (view.north - view.south) * 0.1;
  return [
    Math.max(-180, Math.floor(west - padX)),
    Math.max(-90, Math.floor(view.south - padY)),
    Math.min(180, Math.ceil(east + padX)),
    Math.min(90, Math.ceil(view.north + padY)),
  ].join(',');
}

/** One-line Earthdata readout for the box. */
export function sstEarthdataLabel(earthdata, oceanColor) {
  if (!earthdata) return 'EARTHDATA · --';
  if (!earthdata.configured) return 'EARTHDATA · NO TOKEN · ADD EARTHDATA_TOKEN IN POWER UP';
  if (earthdata.expired) return 'EARTHDATA · TOKEN EXPIRED';
  if (!earthdata.authenticated) {
    return `EARTHDATA · SIGN-IN FAILED${earthdata.httpStatus ? ` · HTTP ${earthdata.httpStatus}` : ''}`;
  }
  const newest = oceanColor?.latestModisAquaL3Date
    ? ` · MODIS AQUA L3 FILES TO ${oceanColor.latestModisAquaL3Date}`
    : '';
  return `EARTHDATA · SIGNED IN${newest}`;
}

/** Fronts readout for a Level-3 view summary. */
export function sstFrontsLabel(meta, frontsEnabled) {
  if (!frontsEnabled) return 'FRONTS · OFF';
  if (!meta) return 'FRONTS · --';
  const { cells, maxGradientCPerKm, sensitivity } = meta.fronts || {};
  const level = sensitivity ? ` · ${String(sensitivity).toUpperCase()}` : '';
  if (!cells) return `FRONTS${level} · NONE IN THIS VIEW`;
  return `FRONTS${level} · ${cells.toLocaleString('en-US')} CELLS · STRONGEST ${maxGradientCPerKm.toFixed(2)} °C/KM`;
}

/**
 * Wire the Sea Surface Temperature box. The layer is always off at launch and
 * its on/off state is never saved. Nothing is requested until the box is
 * opened or the layer is turned on.
 *
 * @returns {Function} Removes the layers and every listener.
 */
export function initSeaSurfaceTemperaturePanel({
  viewer,
  documentRef = globalThis.document,
  windowRef = globalThis.window,
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = Date.now,
  apiBase = '',
} = {}) {
  const byId = (id) => documentRef?.getElementById?.(id) || null;
  const panel = byId('sst-panel');
  const button = byId('sst-enable-btn');
  const frontsButton = byId('sst-fronts-btn');
  const sensitivitySelect = byId('sst-fronts-sensitivity');
  const select = byId('sst-product-select');
  const opacity = byId('sst-opacity');
  const dateReadout = byId('sst-date');
  const frontsReadout = byId('sst-fronts');
  const earthdataReadout = byId('sst-earthdata');
  const legendMin = byId('sst-legend-min');
  const legendMax = byId('sst-legend-max');
  const note = byId('sst-note');
  if (!viewer || !button || !select) return () => {};

  let enabled = false;
  let frontsEnabled = true;
  let destroyed = false;
  let layers = [];
  let status = null;
  let statusAt = 0;
  let statusPromise = null;
  let level3Key = null;
  let level3Meta = null;
  let level3Loading = false;
  let level3Error = null;
  let level3Controller = null;
  /** Key of the Level-3 request in flight, so the same view is not asked twice. */
  let level3PendingKey = null;
  /** Set from a location switch's leave until arrival: camera refreshes wait. */
  let locationSwitching = false;
  let refreshTimer = null;
  let globeShown = viewer.scene?.globe?.show !== false;
  const lifetime = new AbortController();
  const credit = new Cesium.Credit('Sea surface temperature: NASA OceanColor / GIBS / Earthdata');

  for (const product of SST_PRODUCTS) {
    const option = documentRef.createElement('option');
    option.value = product.id;
    option.textContent = product.label;
    select.append(option);
  }
  select.value = DEFAULT_SST_PRODUCT_ID;
  if (sensitivitySelect) {
    for (const level of SST_FRONT_SENSITIVITIES) {
      const option = documentRef.createElement('option');
      option.value = level.id;
      option.textContent = level.label;
      sensitivitySelect.append(option);
    }
    sensitivitySelect.value = DEFAULT_SST_FRONT_SENSITIVITY;
  }

  const product = () => sstProductById(select.value);
  const isLevel3 = () => product().source === 'oceancolor';
  const sensitivity = () => sensitivitySelect?.value || DEFAULT_SST_FRONT_SENSITIVITY;
  const gibsLatestDate = () =>
    status?.products?.find((entry) => entry.id === product().id)?.latestDate || null;
  const alpha = () => Math.max(0.1, Math.min(1, Number(opacity?.value || 75) / 100));

  const render = () => {
    if (destroyed) return;
    button.textContent = enabled ? 'SST ON' : 'SST OFF';
    button.classList.toggle('active', enabled);
    button.setAttribute('aria-pressed', String(enabled));
    const level3 = isLevel3();
    if (frontsButton) {
      frontsButton.textContent = frontsEnabled ? 'FRONTS ON' : 'FRONTS OFF';
      frontsButton.classList.toggle('active', frontsEnabled && level3);
      frontsButton.setAttribute('aria-pressed', String(frontsEnabled));
      frontsButton.disabled = !level3;
    }
    if (sensitivitySelect) sensitivitySelect.disabled = !level3 || !frontsEnabled;
    const meta = level3 ? level3Meta : null;
    if (dateReadout) {
      if (level3) {
        dateReadout.textContent = meta
          ? `DATA DATE · ${meta.startDate}${meta.endDate && meta.endDate !== meta.startDate ? ` TO ${meta.endDate}` : ''} · ${meta.cellKm} KM`
          : 'DATA DATE · --';
      } else {
        const date = gibsLatestDate();
        dateReadout.textContent = `DATA DATE · ${date || (status ? 'NEWEST AVAILABLE' : '--')}`;
      }
    }
    if (frontsReadout) {
      frontsReadout.textContent = level3
        ? sstFrontsLabel(meta, frontsEnabled)
        : 'FRONTS · LEVEL-3 PRODUCTS ONLY';
    }
    if (legendMin && legendMax) {
      const range = meta?.sstRange;
      legendMin.textContent = range ? `${range.min.toFixed(1)} °C` : 'COLD';
      legendMax.textContent = range ? `${range.max.toFixed(1)} °C` : 'WARM';
    }
    if (earthdataReadout) {
      earthdataReadout.textContent = sstEarthdataLabel(status?.earthdata, status?.oceanColor);
    }
    if (note) {
      if (!enabled) note.textContent = OFF_NOTE;
      else if (!globeShown) note.textContent = PHOTOREAL_NOTE;
      else if (level3 && level3Error) note.textContent = level3Error;
      else if (level3 && level3Loading) note.textContent = LOADING_NOTE;
      else if (level3 && meta?.landMask === 'unavailable') note.textContent = NO_LAND_MASK_NOTE;
      else note.textContent = product().note;
    }
  };

  const loadStatus = () => {
    if (statusPromise && now() - statusAt <= STATUS_MAX_AGE_MS) return statusPromise;
    statusAt = now();
    statusPromise = Promise.resolve()
      .then(() => fetchImpl(`${apiBase}/api/sst/status`, { cache: 'no-store', signal: lifetime.signal }))
      .then((response) => (response?.ok ? response.json() : null))
      .catch(() => null)
      .then((payload) => {
        if (payload) status = payload;
        render();
        return status;
      });
    return statusPromise;
  };

  const removeLayers = (list = layers) => {
    if (!viewer.isDestroyed()) {
      for (const layer of list) viewer.imageryLayers.remove(layer, true);
    }
    if (list === layers) layers = [];
  };

  const showGibs = () => {
    const selected = product();
    const provider = new Cesium.UrlTemplateImageryProvider({
      url: sstTileUrlTemplate(selected, gibsLatestDate()),
      tilingScheme: new Cesium.WebMercatorTilingScheme(),
      tileWidth: 256,
      tileHeight: 256,
      maximumLevel: selected.maximumLevel,
      credit,
    });
    const layer = new Cesium.ImageryLayer(provider, { alpha: alpha() });
    viewer.imageryLayers.add(layer);
    removeLayers();
    layers = [layer];
  };

  const currentViewDegrees = () => {
    const rectangle = viewer.camera?.computeViewRectangle?.();
    if (!rectangle) return null;
    return {
      west: Cesium.Math.toDegrees(rectangle.west),
      south: Cesium.Math.toDegrees(rectangle.south),
      east: Cesium.Math.toDegrees(rectangle.east),
      north: Cesium.Math.toDegrees(rectangle.north),
    };
  };

  const showLevel3 = async ({ force = false } = {}) => {
    if (destroyed || !enabled || !isLevel3()) return;
    const selected = product();
    const query = [
      `period=${encodeURIComponent(selected.period)}`,
      `bbox=${encodeURIComponent(sstViewBbox(currentViewDegrees()))}`,
      `fronts=${encodeURIComponent(sensitivity())}`,
    ].join('&');
    const key = `${query}&overlay=${frontsEnabled}`;
    if (!force && key === level3Key) return;
    // The same view is already on its way (the camera settled just after an
    // arrival forced it): restarting would abort and repeat that request.
    if (!force && level3Loading && key === level3PendingKey) return;
    level3Controller?.abort();
    const controller = new AbortController();
    level3Controller = controller;
    level3PendingKey = key;
    level3Loading = true;
    level3Error = null;
    render();

    let meta = null;
    let errorText = null;
    try {
      const response = await fetchImpl(`${apiBase}/api/sst/l3/meta?${query}`, {
        cache: 'no-store',
        signal: AbortSignal.any([lifetime.signal, controller.signal]),
      });
      const payload = await response.json().catch(() => null);
      if (response.ok) meta = payload;
      else errorText = payload?.error || `Level-3 data unavailable (HTTP ${response.status})`;
    } catch {
      if (controller.signal.aborted) return;
      errorText = 'Level-3 data unavailable: the server did not answer';
    }
    // An aborted request is stale even when its answer already arrived: the
    // view it describes was left.
    if (destroyed || controller !== level3Controller || controller.signal.aborted || !enabled || !isLevel3()) return;
    level3Loading = false;
    if (!meta) {
      level3Error = errorText;
      level3Meta = null;
      render();
      return;
    }

    const { west, south, east, north } = meta.rectangle;
    const rectangle = Cesium.Rectangle.fromDegrees(west, south, east, north);
    const imageLayer = (kind, layerAlpha) =>
      new Cesium.ImageryLayer(
        new Cesium.SingleTileImageryProvider({
          url: `${apiBase}/api/sst/l3/${kind}.png?${query}`,
          rectangle,
          tileWidth: meta.width,
          tileHeight: meta.height,
          credit,
        }),
        { alpha: layerAlpha },
      );
    const next = [imageLayer('sst', alpha())];
    if (frontsEnabled) next.push(imageLayer('fronts', 1));
    // Add the new view before removing the old one so the ocean never blinks.
    for (const layer of next) viewer.imageryLayers.add(layer);
    removeLayers();
    layers = next;
    level3Key = key;
    level3Meta = meta;
    render();
  };

  const show = () => {
    if (isLevel3()) void showLevel3({ force: true });
    else showGibs();
  };

  const setEnabled = async (next) => {
    enabled = next;
    if (!enabled) {
      level3Controller?.abort();
      level3Loading = false;
      level3Key = null;
      removeLayers();
      render();
      return;
    }
    render();
    if (isLevel3()) {
      void loadStatus();
      await showLevel3({ force: true });
    } else {
      await loadStatus();
      if (destroyed || !enabled) return;
      showGibs();
    }
    render();
  };

  const onToggle = () => {
    void setEnabled(!enabled);
  };
  const onFronts = () => {
    frontsEnabled = !frontsEnabled;
    render();
    if (enabled && isLevel3()) void showLevel3({ force: true });
  };
  const onSensitivity = () => {
    render();
    if (enabled && isLevel3() && frontsEnabled) void showLevel3({ force: true });
  };
  const onProduct = () => {
    level3Controller?.abort();
    level3Loading = false;
    level3Error = null;
    level3Key = null;
    level3Meta = null;
    if (enabled) {
      removeLayers();
      show();
    }
    render();
  };
  const onOpacity = () => {
    if (layers[0]) layers[0].alpha = alpha();
  };
  const onCameraSettled = () => {
    if (!enabled || !isLevel3() || locationSwitching) return;
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => void showLevel3(), LEVEL3_REFRESH_DELAY_MS);
  };
  // The panel is not a manager layer, so it hears location switches on window.
  // Leave drops the Level-3 work and images for the view being left while the
  // layer stays on; GIBS tiles are global and stay. Arrival draws the new view.
  const onLocationSwitch = (event) => {
    if (destroyed) return;
    const phase = event?.detail?.phase;
    if (phase === 'leave') {
      locationSwitching = true;
      clearTimeout(refreshTimer);
      refreshTimer = null;
      level3Controller?.abort();
      level3Loading = false;
      level3Error = null;
      level3Key = null;
      if (isLevel3()) removeLayers();
      render();
    } else if (phase === 'arrive') {
      locationSwitching = false;
      clearTimeout(refreshTimer);
      refreshTimer = null;
      void showLevel3({ force: true });
    }
  };
  button.addEventListener('click', onToggle);
  frontsButton?.addEventListener('click', onFronts);
  sensitivitySelect?.addEventListener('change', onSensitivity);
  select.addEventListener('change', onProduct);
  opacity?.addEventListener('input', onOpacity);
  const removeMoveEnd = viewer.camera?.moveEnd?.addEventListener?.(onCameraSettled);
  windowRef?.addEventListener?.('gev:location-switch', onLocationSwitch);

  // The photorealistic stack hides the globe the images drape on; say so.
  const removePostRender = viewer.scene?.postRender?.addEventListener?.(() => {
    const shown = viewer.scene.globe?.show !== false;
    if (shown === globeShown) return;
    globeShown = shown;
    render();
  });

  // Opening the box is the moment to check the Earthdata sign-in.
  let observer = null;
  if (panel && typeof globalThis.MutationObserver === 'function') {
    observer = new globalThis.MutationObserver(() => {
      if (!panel.classList.contains('collapsed')) void loadStatus();
    });
    observer.observe(panel, { attributes: true, attributeFilter: ['class'] });
  }

  render();

  return () => {
    destroyed = true;
    clearTimeout(refreshTimer);
    lifetime.abort();
    level3Controller?.abort();
    removeLayers();
    button.removeEventListener('click', onToggle);
    frontsButton?.removeEventListener('click', onFronts);
    sensitivitySelect?.removeEventListener('change', onSensitivity);
    select.removeEventListener('change', onProduct);
    opacity?.removeEventListener('input', onOpacity);
    if (typeof removeMoveEnd === 'function') removeMoveEnd();
    windowRef?.removeEventListener?.('gev:location-switch', onLocationSwitch);
    if (typeof removePostRender === 'function') removePostRender();
    observer?.disconnect();
  };
}
