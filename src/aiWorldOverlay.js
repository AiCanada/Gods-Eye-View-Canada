/**
 * The Artificial Intelligence World Training Sim's predictions on the globe
 * (owner requests 2026-10-13 and 2026-10-15: "Predict all actions and price
 * movements on globe"). The tab says which domains to draw and the horizon
 * (the `ai-world:predictions` event); this asks /api/ai-world/predict for
 * each and draws predicted places as heat (size and strength by value),
 * predicted tracks as ghost lines, and predicted price moves as a dot and a
 * card where each asset's benchmark is set (green up, red down; the card
 * lists every asset priced there, biggest move first). A domain still
 * learning draws nothing: never invented output. It draws through its own
 * primitives on the viewer, not a map layer, and its cards through the
 * shared world-overlay host (never Cesium labels), and removes both when the
 * tab goes.
 */
import * as Cesium from 'cesium';
import {
  clearOverlaySource,
  setOverlayEntries,
  setOverlaySourceVisible,
} from './overlays/worldOverlay.js';

/** The world-overlay source the price cards are published under. */
export const AI_WORLD_MARKETS_SOURCE_ID = 'ai-world-markets';
const MARKETS_COHORT_LIMIT = 64;
const MARKET_DOT_PX = 10;

const OVERLAY_HOST = Object.freeze({
  setEntries: setOverlayEntries,
  setVisible: setOverlaySourceVisible,
  clearSource: clearOverlaySource,
});

export const PREDICTION_COLORS = Object.freeze({
  outbreak: '#ff5a4f',
  mobility: '#4fc3ff',
  trains: '#7eb6ff',
  traffic: '#ffd56a',
  weather: '#9ad85f',
  hazards: '#ffb347',
  news: '#d68cff',
  tracks: '#ffffff',
  flights: '#d7f3ff',
  vessels: '#6ec8c8',
  transit: '#f0a36b',
  infer: '#e7c2ff',
});

/** Price moves: rise, fall, no change. */
export const MARKET_MOVE_COLORS = Object.freeze({
  up: '#3ddc84',
  down: '#ff5a5f',
  flat: '#c8c8c8',
});

/** The label a predicted price move carries: asset, arrow, percent. */
export function marketLabel(point) {
  const pct = Number(point?.value);
  if (point?.value === null || point?.value === '' || !Number.isFinite(pct))
    return '';
  const arrow = pct > 0 ? '▲' : pct < 0 ? '▼' : '■';
  return `${point.label || point.series || ''} ${arrow} ${Math.abs(pct).toFixed(2)}%`.trim();
}

const EXTRA_COLORS = Object.freeze([
  '#7fd1ff',
  '#f2c14e',
  '#8d6bff',
  '#5ad1a4',
  '#ff8f6b',
]);

/** The colour of a move: up, down or flat. */
export function moveColor(value) {
  const pct = Number(value);
  return pct > 0
    ? MARKET_MOVE_COLORS.up
    : pct < 0
      ? MARKET_MOVE_COLORS.down
      : MARKET_MOVE_COLORS.flat;
}

/**
 * One card per hub from a markets prediction: the hub's name, then each
 * asset priced there with its move, biggest first. The card takes the colour
 * of its biggest move and outranks a hub with smaller moves.
 * @param {Array<object>} points Prediction points (lat, lon, value, label, hub).
 * @param {(lon: number, lat: number) => object} toPosition
 */
export function marketCards(points, toPosition) {
  const hubs = new Map();
  for (const p of Array.isArray(points) ? points : []) {
    if (!Number.isFinite(p?.lat) || !Number.isFinite(p?.lon)) continue;
    const text = marketLabel(p);
    if (!text) continue;
    const key = `${p.lat.toFixed(2)},${p.lon.toFixed(2)}`;
    const hub = hubs.get(key) || {
      key,
      lat: p.lat,
      lon: p.lon,
      name: '',
      rows: [],
    };
    hub.name ||= p.hub || '';
    hub.rows.push({ text, value: Number(p.value) });
    hubs.set(key, hub);
  }
  return [...hubs.values()].map((hub) => {
    hub.rows.sort((a, b) => Math.abs(b.value) - Math.abs(a.value));
    const top = hub.rows[0];
    return {
      id: `hub:${hub.key}`,
      position: toPosition(hub.lon, hub.lat),
      variant: 'card',
      cardStyle: 'tactical',
      collisionGroup: 'ambient-card',
      edgeFade: 'keyhole',
      horizonCull: true,
      terrainOcclusion: false,
      interactive: false,
      gapPx: MARKET_DOT_PX + 8,
      leaderOffsetPx: MARKET_DOT_PX + 2,
      verticalOnly: true,
      viewportMargin: 4,
      title: hub.name || hub.rows[0].text,
      details: hub.rows.map((row) => row.text),
      accent: moveColor(top.value),
      priority: Math.round(Math.abs(top.value) * 1000),
      maxDistance: Number.POSITIVE_INFINITY,
      dot: { lat: hub.lat, lon: hub.lon, value: top.value },
    };
  });
}

/** A domain the overlay may draw. Military ids are refused. */
export function isDrawDomain(id) {
  return (
    typeof id === 'string' &&
    /^[a-z][a-z0-9-]{0,40}$/.test(id) &&
    id !== 'military' &&
    !id.startsWith('military-')
  );
}

export function predictionColor(domain) {
  if (PREDICTION_COLORS[domain]) return PREDICTION_COLORS[domain];
  let n = 0;
  for (const ch of String(domain))
    n = (n + ch.charCodeAt(0)) % EXTRA_COLORS.length;
  return EXTRA_COLORS[n];
}
const REFRESH_MS = 5 * 60_000;

/** The event's choice, cleaned: known domains, horizon 1–168 hours. */
export function cleanChoice(detail) {
  const domains = Array.isArray(detail?.domains)
    ? detail.domains.filter((d) => isDrawDomain(d))
    : [];
  const horizon = Number(detail?.horizonHours);
  return {
    domains: [...new Set(domains)],
    horizonHours: Number.isFinite(horizon)
      ? Math.min(168, Math.max(1, Math.round(horizon)))
      : 24,
  };
}

/** Size and strength of a predicted place, from its magnitude among the rest. */
export function pointStyle(value, maxAbs) {
  const mag = Math.abs(Number(value));
  const scale = Number(maxAbs);
  const share =
    Number.isFinite(mag) && scale > 0 ? Math.min(1, mag / scale) : 0;
  return {
    pixelSize: 4 + 10 * Math.sqrt(share),
    alpha: 0.3 + 0.55 * share,
    negative: Number(value) < 0,
  };
}

/**
 * @param {object} options
 * @param {{viewer: object}} options.dataManager
 * @param {AbortSignal} [options.signal]
 */
export function initAiWorldOverlay({
  dataManager,
  signal,
  fetchImpl = (...args) => globalThis.fetch(...args),
  documentRef = globalThis.document,
  cesium = Cesium,
  // Wrapped: a browser's timer functions throw "Illegal invocation" when
  // called as methods of another object.
  timers = {
    setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
    clearTimeout: (id) => globalThis.clearTimeout(id),
    setInterval: (fn, ms) => globalThis.setInterval(fn, ms),
    clearInterval: (id) => globalThis.clearInterval(id),
  },
  debounceMs = 300,
  overlayHost = OVERLAY_HOST,
} = {}) {
  const viewer = dataManager?.viewer;
  if (!viewer?.scene?.primitives || !documentRef) return null;
  const points = viewer.scene.primitives.add(
    new cesium.PointPrimitiveCollection(),
  );
  const lines = viewer.scene.primitives.add(new cesium.PolylineCollection());
  let cards = [];
  let published = false;
  let choice = { domains: [], horizonHours: 24 };
  let infer = null;
  let debounce = null;
  let generation = 0;
  let disposed = false;

  const fetchPrediction = async (domain) => {
    try {
      const response = await fetchImpl(
        `/api/ai-world/predict?domain=${encodeURIComponent(domain)}&horizon=${choice.horizonHours}`,
        { credentials: 'same-origin', cache: 'no-store' },
      );
      return response.ok ? await response.json() : null;
    } catch {
      return null;
    }
  };

  // Price moves at their hubs: a dot coloured by the biggest move there, and
  // a card on the overlay host naming every asset priced at that hub.
  const drawMarkets = (prediction) => {
    const hubCards = marketCards(prediction.points, (lon, lat) =>
      cesium.Cartesian3.fromDegrees(lon, lat, 0),
    );
    for (const card of hubCards)
      points.add({
        position: card.position,
        pixelSize: MARKET_DOT_PX,
        color: cesium.Color.fromCssColorString(card.accent).withAlpha(0.85),
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      });
    cards.push(...hubCards.map(({ dot, ...card }) => card));
  };

  const publishCards = () => {
    if (cards.length) {
      overlayHost.setVisible(AI_WORLD_MARKETS_SOURCE_ID, true);
      overlayHost.setEntries(AI_WORLD_MARKETS_SOURCE_ID, cards, {
        cohortLimit: MARKETS_COHORT_LIMIT,
        collisionCapacity: Math.min(MARKETS_COHORT_LIMIT, cards.length),
        moving: false,
      });
      published = true;
    } else if (published) {
      overlayHost.clearSource(AI_WORLD_MARKETS_SOURCE_ID);
      overlayHost.setVisible(AI_WORLD_MARKETS_SOURCE_ID, false);
      published = false;
    }
  };

  const draw = (prediction, domain) => {
    if (!prediction || prediction.learning) return;
    if (domain === 'markets') {
      drawMarkets(prediction);
      return;
    }
    const color = cesium.Color.fromCssColorString(predictionColor(domain));
    const list = Array.isArray(prediction.points) ? prediction.points : [];
    // A blank value (null, '') is no prediction: Number(null) would draw 0.
    const finite = list.filter(
      (p) =>
        Number.isFinite(p?.lat) &&
        Number.isFinite(p?.lon) &&
        p.value !== null &&
        p.value !== '' &&
        Number.isFinite(Number(p.value)),
    );
    const max = finite.reduce(
      (m, p) => Math.max(m, Math.abs(Number(p.value))),
      0,
    );
    for (const p of finite) {
      const value = Number(p.value);
      const style = pointStyle(value, max);
      points.add({
        position: cesium.Cartesian3.fromDegrees(p.lon, p.lat, 0),
        pixelSize: style.pixelSize,
        color: color.withAlpha(
          style.negative ? style.alpha * 0.55 : style.alpha,
        ),
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      });
    }
    for (const track of Array.isArray(prediction.tracks)
      ? prediction.tracks
      : []) {
      const path = (track?.path || []).filter(
        ([lat, lon]) => Number.isFinite(lat) && Number.isFinite(lon),
      );
      if (path.length < 2) continue;
      lines.add({
        positions: cesium.Cartesian3.fromDegreesArray(
          path.flatMap(([lat, lon]) => [lon, lat]),
        ),
        width: 2,
        material: cesium.Material.fromType('Color', {
          color: color.withAlpha(0.65),
        }),
      });
    }
  };

  const refresh = async () => {
    const mine = (generation += 1);
    const domains = choice.domains;
    const results = await Promise.all(domains.map(fetchPrediction));
    if (disposed || mine !== generation) return;
    points.removeAll();
    lines.removeAll();
    cards = [];
    results.forEach((prediction, k) => draw(prediction, domains[k]));
    if (infer) draw(infer, 'infer');
    publishCards();
    viewer.scene.requestRender?.();
  };

  const onChoice = (event) => {
    choice = cleanChoice(event?.detail);
    infer =
      event?.detail?.infer && !event.detail.infer.learning
        ? event.detail.infer
        : null;
    timers.clearTimeout(debounce);
    debounce = timers.setTimeout(refresh, debounceMs);
  };
  documentRef.addEventListener('ai-world:predictions', onChoice);
  const poll = timers.setInterval(() => {
    if (choice.domains.length || infer) refresh();
  }, REFRESH_MS);
  poll?.unref?.();

  const destroy = () => {
    if (disposed) return;
    disposed = true;
    documentRef.removeEventListener('ai-world:predictions', onChoice);
    timers.clearTimeout(debounce);
    timers.clearInterval(poll);
    viewer.scene.primitives.remove?.(points);
    viewer.scene.primitives.remove?.(lines);
    cards = [];
    publishCards();
    viewer.scene.requestRender?.();
  };
  signal?.addEventListener?.('abort', destroy, { once: true });
  return {
    destroy,
    refresh,
    get choice() {
      return choice;
    },
  };
}
