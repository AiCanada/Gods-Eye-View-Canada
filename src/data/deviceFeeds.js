import * as Cesium from 'cesium';
import {
  clearOverlaySource,
  hitTestWorldOverlay,
  setOverlayEntries,
  setOverlaySourceVisible,
} from '../overlays/worldOverlay.js';
import { governorRequestRender, holdContinuousRender, releaseContinuousRender } from '../renderGovernor.js';
import { DEVICE_FEEDS_CHANGED_EVENT } from '../deviceFeedsCore.mjs';
import { applyTrackedCameraFrame } from './trackedCamera.js';
import { refreshTrackedReadout } from './trackedReadout.js';
import { createDeviceRecorder } from './deviceRecorder.js';
import { bindTrackingClickGesture, isTrackingClickGesture } from './trackingClickGesture.js';

/**
 * YOUR DEVICES: the drones, robots, marine drones and GPS trackers set up under
 * POWER UP (src/deviceFeedsSetup.js), each at its latest reported position.
 *
 * The browser never talks to a device. The dev server does (device-feeds.js),
 * with the login the user saved, and this layer is told a name, a kind and a
 * position: never an address, never a login. A device's picture comes back
 * through the same server, same origin.
 *
 * FOLLOW: the device its owner marked (an Ultra Security Package does by
 * default) is handed to the same follow camera flights and satellites use. The
 * map then stays on it wherever it goes, gliding between its reports, until the
 * owner goes somewhere else (a search, a city, another tracked object, a click
 * on open map) or unticks FOLLOW. RECORD: see deviceRecorder.js.
 *
 * Geometry changes only when a poll brings a new position: nothing here is a
 * per-frame callback (see the measurements in earthquakes.js).
 */

const POSITIONS_URL = '/api/device-feeds/positions';

export const DEVICE_FEEDS_LAYER_ID = 'device-feeds';
export const DEVICE_FEEDS_OVERLAY_SOURCE_ID = 'device-feeds';
export const DEVICE_FEEDS_OVERLAY_COHORT_LIMIT = 96;
export const DEVICE_FEEDS_OVERLAY_COLLISION_CAPACITY = 48;
export const DEVICE_FEEDS_POLL_MS = 5000;
export const DEVICE_FEEDS_TRAIL_POINTS = 240;
export const DEVICE_FEEDS_TRAIL_MIN_STEP_M = 2;
export const DEVICE_FEEDS_PICTURE_REFRESH_MS = 10000;
/** Where the follow camera sits: behind and above, about 1.4 km off. */
export const DEVICE_FEEDS_FOLLOW_VIEW_FROM = Object.freeze({ x: 0, y: -1100, z: 850 });
/** A followed device glides to each new report over this long (one poll). */
export const DEVICE_FEEDS_FOLLOW_GLIDE_MS = DEVICE_FEEDS_POLL_MS;
const FOLLOW_RENDER_OWNER = 'device-feeds-follow';
/**
 * Left out of a recording: the traffic layer's dots are an animation of flow
 * along the roads, not vehicles anyone observed, and there are thousands of
 * new ones every half minute.
 */
export const DEVICE_FEEDS_RECORD_SKIP_LAYERS = Object.freeze(['traffic']);

const DEFAULT_OVERLAY_HOST = Object.freeze({
  setEntries: setOverlayEntries,
  setVisible: setOverlaySourceVisible,
  clearSource: clearOverlaySource,
});

const num = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const text = (value, limit = 80) => String(value ?? '').trim().slice(0, limit);

/**
 * The devices out of a /positions answer, or null when the answer is not one.
 * A device without a usable position is left out; a duplicate id keeps the first.
 * @param {unknown} payload
 * @returns {Array<object>|null}
 */
export function normalizeDevicePositions(payload) {
  if (!Array.isArray(payload?.devices)) return null;
  const rows = [];
  const seen = new Set();
  for (const raw of payload.devices) {
    const id = text(raw?.id, 120);
    const lat = num(raw?.lat);
    const lon = num(raw?.lon);
    if (!id || seen.has(id) || lat === null || lon === null) continue;
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;
    seen.add(id);
    const pictureUrl = text(raw.pictureUrl, 200);
    rows.push({
      id,
      kind: text(raw.kind, 20) || 'tracker',
      kindLabel: text(raw.kindLabel, 30) || 'DEVICE',
      color: /^#[0-9a-f]{6}$/i.test(String(raw.color || '')) ? raw.color : '#ffffff',
      name: text(raw.name) || 'DEVICE',
      lat,
      lon,
      altM: num(raw.altM),
      headingDeg: num(raw.headingDeg),
      speedMps: num(raw.speedMps),
      live: raw.live === true,
      at: num(raw.at),
      error: text(raw.error, 120),
      follow: raw.follow === true,
      record: raw.record === true,
      // Only the application's own picture route is ever loaded.
      pictureUrl: pictureUrl.startsWith('/api/device-feeds/frame/') ? pictureUrl : '',
    });
  }
  return rows;
}

/** The lines under a device's name: what it is, and how it is moving. */
export function deviceDetailLines(device) {
  const first = [device.kindLabel];
  if (device.record) first.push('REC');
  if (!device.live) first.push(device.error ? 'NO SIGNAL' : 'FIXED POSITION');
  const motion = [];
  if (device.speedMps !== null) motion.push(`${(device.speedMps * 3.6).toFixed(0)} KM/H`);
  if (device.headingDeg !== null) {
    motion.push(`HDG ${String(Math.round(((device.headingDeg % 360) + 360) % 360)).padStart(3, '0')}`);
  }
  if (device.altM !== null) {
    motion.push(device.altM < 0 ? `DEPTH ${Math.abs(device.altM).toFixed(0)} M` : `ALT ${device.altM.toFixed(0)} M`);
  }
  return motion.length ? [first.join(' · '), motion.join(' · ')] : [first.join(' · ')];
}

/**
 * One device's label. With a picture it is a thumbnail card, otherwise a card
 * of text.
 */
export function createDeviceOverlayEntry({ device, position, image = null, rank = 0 }) {
  return {
    id: device.id,
    position,
    variant: image ? 'thumbnail' : 'card',
    paintLane: image ? 'thumbnail' : 'ambient-card',
    title: device.name.toUpperCase(),
    details: image ? [] : deviceDetailLines(device),
    image,
    accent: device.color,
    priority: (device.live ? 200_000 : 100_000) - rank,
    collisionGroup: 'ambient-card',
    interactive: false,
    edgeFade: 'keyhole',
    horizonCull: true,
    terrainOcclusion: false,
    gapPx: 16,
    verticalOnly: true,
    placement: 'above',
  };
}

/** Metres between two lat/lon points (equirectangular: trail steps are short). */
export function deviceStepMeters(a, b) {
  const meanLat = (((a.lat + b.lat) / 2) * Math.PI) / 180;
  const dx = (b.lon - a.lon) * Math.cos(meanLat) * 111_320;
  const dy = (b.lat - a.lat) * 110_540;
  return Math.hypot(dx, dy);
}

/**
 * Add a position to a device's trail. Returns true when the trail changed.
 * @param {Array<{lat:number, lon:number}>} trail Mutated.
 */
export function extendDeviceTrail(trail, point, { minStepM = DEVICE_FEEDS_TRAIL_MIN_STEP_M, limit = DEVICE_FEEDS_TRAIL_POINTS } = {}) {
  const last = trail[trail.length - 1];
  if (last && deviceStepMeters(last, point) < minStepM) return false;
  trail.push({ lat: point.lat, lon: point.lon });
  if (trail.length > limit) trail.splice(0, trail.length - limit);
  return true;
}

export function createDeviceFeedsLayer({
  overlayHost = DEFAULT_OVERLAY_HOST,
  fetchImpl = (...args) => fetch(...args),
  windowRef = typeof window === 'undefined' ? null : window,
  createImage = () => (typeof Image === 'undefined' ? null : new Image()),
  now = () => Date.now(),
  applyFollowFrame = applyTrackedCameraFrame,
  refreshReadout = refreshTrackedReadout,
  recorder = null,
  hitTestOverlay = hitTestWorldOverlay,
} = {}) {
  const _recorder = recorder || createDeviceRecorder({ fetchImpl, now });
  let _viewer = null;
  let _dataSource = null;
  let _dataManager = null;
  let _enabled = false;
  let _count = 0;
  let _lastUpdate = null;
  let _lastError = null;
  let _onChanged = null;
  /** The follow: {id, entity, from, to, startedAt, stopFrame, removeChanged, removeClick} or null. */
  let _follow = null;
  /** A device the owner walked away from this session is not grabbed again. */
  let _followReleasedId = null;
  /** id → {entity, trailEntity, trail, picture:{image, ready, at, url}} */
  const _devices = new Map();

  const pictureFor = (record, device) => {
    if (!device.pictureUrl) {
      record.picture = null;
      return null;
    }
    let held = record.picture;
    if (!held || held.url !== device.pictureUrl) {
      held = { url: device.pictureUrl, image: null, next: null, at: 0 };
      record.picture = held;
    }
    const time = now();
    if (!held.next && time - held.at >= DEVICE_FEEDS_PICTURE_REFRESH_MS) {
      const next = createImage();
      if (next) {
        held.next = next;
        held.at = time;
        next.onload = () => {
          if (record.picture !== held || held.next !== next) return;
          held.image = next;
          held.next = null;
          if (_enabled) publish();
        };
        next.onerror = () => {
          if (held.next === next) held.next = null;
        };
        next.src = `${device.pictureUrl}?t=${Math.floor(time / DEVICE_FEEDS_PICTURE_REFRESH_MS)}`;
      }
    }
    return held.image;
  };

  let _latest = [];
  function publish() {
    if (!_enabled) return;
    const entries = _latest.filter((device) => device.id !== _follow?.id).map((device, rank) => {
      const record = _devices.get(device.id);
      return createDeviceOverlayEntry({
        device,
        position: record?.position,
        image: record?.picture?.image || null,
        rank,
      });
    }).filter((entry) => entry.position);
    overlayHost.setEntries(DEVICE_FEEDS_OVERLAY_SOURCE_ID, entries.slice(0, DEVICE_FEEDS_OVERLAY_COHORT_LIMIT), {
      cohortLimit: DEVICE_FEEDS_OVERLAY_COHORT_LIMIT,
      collisionCapacity: DEVICE_FEEDS_OVERLAY_COLLISION_CAPACITY,
      moving: true,
    });
    governorRequestRender('device-feeds');
  }

  // ---- follow -------------------------------------------------------------
  const groundedPosition = (device) => {
    let ground = 0;
    try {
      const height = _viewer?.scene?.globe?.getHeight?.(Cesium.Cartographic.fromDegrees(device.lon, device.lat));
      if (Number.isFinite(height)) ground = height;
    } catch {
      ground = 0;
    }
    const above = device.altM !== null && device.altM > 0 ? device.altM : 0;
    return Cesium.Cartesian3.fromDegrees(device.lon, device.lat, ground + above);
  };

  const followLabel = (device) => ({
    title: device.name.toUpperCase(),
    details: deviceDetailLines(device),
    accent: device.color,
  });

  /**
   * Let go of the follow. When ANOTHER layer has just taken the follow camera,
   * viewer.trackedEntity is theirs now and is left alone (mirror of flights).
   */
  const stopFollow = ({ skipViewerUntrack = false, released = false } = {}) => {
    if (!_follow) return false;
    const follow = _follow;
    _follow = null;
    if (released) _followReleasedId = follow.id;
    follow.removeChanged?.();
    follow.removeClick?.();
    follow.stopFrame?.();
    releaseContinuousRender(FOLLOW_RENDER_OWNER);
    if (_viewer && !skipViewerUntrack && _viewer.trackedEntity === follow.entity) _viewer.trackedEntity = undefined;
    try {
      _viewer?.entities?.remove(follow.entity);
    } catch {
      /* viewer already gone */
    }
    governorRequestRender('device-feeds-follow-end');
    return true;
  };

  const glidePosition = (follow, result) => {
    const t = Math.min(1, Math.max(0, (now() - follow.startedAt) / DEVICE_FEEDS_FOLLOW_GLIDE_MS));
    return Cesium.Cartesian3.lerp(follow.from, follow.to, t, result || new Cesium.Cartesian3());
  };

  const startFollow = (device) => {
    if (!_viewer?.entities || !_enabled) return false;
    stopFollow();
    const at = groundedPosition(device);
    const follow = { id: device.id, from: at, to: at, startedAt: now(), entity: null, stopFrame: null, removeChanged: null, removeClick: null };
    const scratch = new Cesium.Cartesian3();
    follow.entity = _viewer.entities.add({
      position: new Cesium.CallbackProperty(() => glidePosition(follow, scratch), false),
      viewFrom: new Cesium.Cartesian3(DEVICE_FEEDS_FOLLOW_VIEW_FROM.x, DEVICE_FEEDS_FOLLOW_VIEW_FROM.y, DEVICE_FEEDS_FOLLOW_VIEW_FROM.z),
      point: { pixelSize: 1, color: Cesium.Color.TRANSPARENT },
    });
    follow.entity.gevSelectionOrigin = 'programmatic';
    follow.entity.gevTrackedId = `${DEVICE_FEEDS_LAYER_ID}:${device.id}`;
    follow.entity.gevLabelModel = followLabel(device);
    follow.entity.gevDisplayPosition = () => glidePosition(follow);
    _follow = follow;
    holdContinuousRender(FOLLOW_RENDER_OWNER);
    _viewer.trackedEntity = follow.entity;
    follow.stopFrame = applyFollowFrame(_viewer, follow.entity, follow.entity.viewFrom?.getValue?.() ?? follow.entity.viewFrom) || null;
    // Someone else taking the follow camera (a flight, a satellite, a search)
    // ends this follow without touching what they just set.
    const changed = _viewer.trackedEntityChanged;
    if (changed?.addEventListener) {
      const onChanged = (next) => {
        if (_follow === follow && next !== follow.entity) stopFollow({ skipViewerUntrack: true, released: true });
      };
      changed.addEventListener(onChanged);
      follow.removeChanged = () => changed.removeEventListener(onChanged);
    }
    // A clean click on open map (nothing picked, no card under it) lets go.
    if (_viewer.scene?.canvas) {
      const handler = new Cesium.ScreenSpaceEventHandler(_viewer.scene.canvas);
      bindTrackingClickGesture(handler, (click, gesture) => {
        if (_follow !== follow || !isTrackingClickGesture(gesture)) return;
        if (hitTestOverlay(click?.position?.x, click?.position?.y) || _viewer.scene.pick(click.position)) return;
        stopFollow({ released: true });
      });
      follow.removeClick = () => handler.destroy();
    }
    return true;
  };

  const syncFollow = (rows) => {
    const wanted = rows.find((row) => row.follow && row.live) || null;
    if (!wanted) {
      // Its owner unticked FOLLOW, or removed it. A device that merely stops
      // answering keeps the camera where it last was.
      if (_follow && !rows.some((row) => row.id === _follow.id && row.follow)) stopFollow();
      if (!rows.some((row) => row.follow)) _followReleasedId = null;
      return;
    }
    if (_follow?.id === wanted.id) {
      _follow.from = glidePosition(_follow);
      _follow.to = groundedPosition(wanted);
      _follow.startedAt = now();
      _follow.entity.gevLabelModel = followLabel(wanted);
      refreshReadout(_follow.entity);
      return;
    }
    if (_followReleasedId === wanted.id) return;
    startFollow(wanted);
  };

  const toLatLon = (position) => {
    if (!position) return null;
    try {
      const carto = Cesium.Cartographic.fromCartesian(position);
      if (!carto) return null;
      return { lat: Cesium.Math.toDegrees(carto.latitude), lon: Cesium.Math.toDegrees(carto.longitude), altM: Math.round(carto.height) };
    } catch {
      return null;
    }
  };

  const removeDevice = (id) => {
    const record = _devices.get(id);
    if (!record) return;
    if (record.entity) _dataSource?.entities.remove(record.entity);
    if (record.trailEntity) _dataSource?.entities.remove(record.trailEntity);
    _devices.delete(id);
  };

  const applyDevice = (device) => {
    let record = _devices.get(device.id);
    if (!record) {
      record = { entity: null, trailEntity: null, trail: [], picture: null, position: null };
      _devices.set(device.id, record);
    }
    const height = device.altM !== null && device.altM > 0 ? device.altM : 0;
    const color = Cesium.Color.fromCssColorString(device.color);
    record.position = Cesium.Cartesian3.fromDegrees(device.lon, device.lat, height);
    const heightReference = height > 0 ? Cesium.HeightReference.RELATIVE_TO_GROUND : Cesium.HeightReference.CLAMP_TO_GROUND;
    if (!record.entity) {
      record.entity = _dataSource.entities.add({
        id: `device-feed:${device.id}`,
        position: record.position,
        point: {
          pixelSize: 11,
          color: color.withAlpha(device.live ? 0.95 : 0.45),
          outlineColor: Cesium.Color.BLACK.withAlpha(0.85),
          outlineWidth: 2,
          heightReference,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
        properties: { deviceId: device.id, kind: device.kind, name: device.name },
      });
    } else {
      record.entity.position = record.position;
      record.entity.point.color = color.withAlpha(device.live ? 0.95 : 0.45);
      record.entity.point.heightReference = heightReference;
    }
    // A trail is drawn only from positions the device itself reported.
    if (device.live && extendDeviceTrail(record.trail, device) && record.trail.length > 1) {
      const positions = record.trail.map((point) => Cesium.Cartesian3.fromDegrees(point.lon, point.lat));
      if (!record.trailEntity) {
        record.trailEntity = _dataSource.entities.add({
          id: `device-feed-trail:${device.id}`,
          polyline: {
            positions,
            width: 2,
            material: color.withAlpha(0.7),
            clampToGround: true,
          },
        });
      } else {
        record.trailEntity.polyline.positions = positions;
      }
    }
    pictureFor(record, device);
  };

  const layer = {
    id: DEVICE_FEEDS_LAYER_ID,
    name: 'Your Devices',
    icon: '🛰️',
    source: 'POWER UP',
    updateInterval: DEVICE_FEEDS_POLL_MS,

    /**
     * Saving a device under POWER UP shows it at once: the layer comes on if it
     * was off, and asks again if it was on. Listened for from here, not from
     * init: the manager initialises a layer only when it is first enabled.
     */
    attachDataManager(dataManager) {
      _dataManager = dataManager;
      if (!windowRef?.addEventListener || _onChanged) return;
      _onChanged = (event) => {
        const count = Number(event?.detail?.count) || 0;
        // Saving a card is the owner speaking: FOLLOW is honoured afresh.
        _followReleasedId = null;
        if (!_enabled) {
          if (count > 0) Promise.resolve(_dataManager?.setEnabled?.(DEVICE_FEEDS_LAYER_ID, true)).catch(() => {});
          return;
        }
        const refreshed = _dataManager?.refreshLayer?.(DEVICE_FEEDS_LAYER_ID);
        if (refreshed) Promise.resolve(refreshed).catch(() => {});
        else layer.update(_viewer).catch(() => {});
      };
      windowRef.addEventListener(DEVICE_FEEDS_CHANGED_EVENT, _onChanged);
    },

    init(viewer) {
      _viewer = viewer;
      _dataSource = new Cesium.CustomDataSource('device-feeds');
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
      _count = 0;
      _lastUpdate = null;
      _lastError = null;
      _enabled = false;
      overlayHost.setVisible(DEVICE_FEEDS_OVERLAY_SOURCE_ID, false);
    },

    enable() {
      _enabled = true;
      if (_dataSource) _dataSource.show = true;
      overlayHost.setVisible(DEVICE_FEEDS_OVERLAY_SOURCE_ID, true);
      publish();
    },

    disable() {
      stopFollow();
      _enabled = false;
      if (_dataSource) _dataSource.show = false;
      overlayHost.clearSource(DEVICE_FEEDS_OVERLAY_SOURCE_ID);
      overlayHost.setVisible(DEVICE_FEEDS_OVERLAY_SOURCE_ID, false);
    },

    async update() {
      try {
        const response = await fetchImpl(POSITIONS_URL, { cache: 'no-store', credentials: 'same-origin' });
        if (!response.ok) {
          _lastError = response.status === 404 ? 'Device feeds need the local server' : `Device feeds HTTP ${response.status}`;
          return false;
        }
        const rows = normalizeDevicePositions(await response.json());
        if (!rows) {
          _lastError = 'Malformed device feed response';
          return false;
        }
        if (!_dataSource) return false;
        const keep = new Set(rows.map((row) => row.id));
        for (const id of [..._devices.keys()]) if (!keep.has(id)) removeDevice(id);
        for (const device of rows) applyDevice(device);
        _latest = rows;
        _count = rows.length;
        _lastUpdate = now();
        const silent = rows.filter((row) => !row.live && row.error).length;
        _lastError = silent ? `${silent} of ${rows.length} not answering` : null;
        if (_enabled) {
          syncFollow(rows);
          // Not awaited: a slow save never holds up the next position.
          _recorder.tick(rows, _dataManager, { toLatLon, skip: DEVICE_FEEDS_RECORD_SKIP_LAYERS }).then((results) => {
            if (results.some((result) => result.error)) _lastError = _lastError || 'Recording could not be saved';
          }).catch(() => {});
        }
        publish();
        return true;
      } catch {
        _lastError = 'Device feeds unreachable';
        return false;
      }
    },

    destroy(viewer) {
      stopFollow();
      _followReleasedId = null;
      _recorder.forget();
      _enabled = false;
      if (_onChanged && windowRef?.removeEventListener) {
        windowRef.removeEventListener(DEVICE_FEEDS_CHANGED_EVENT, _onChanged);
      }
      _onChanged = null;
      overlayHost.clearSource(DEVICE_FEEDS_OVERLAY_SOURCE_ID);
      overlayHost.setVisible(DEVICE_FEEDS_OVERLAY_SOURCE_ID, false);
      _devices.clear();
      _latest = [];
      if (_dataSource) {
        viewer.dataSources.remove(_dataSource, true);
        _dataSource = null;
      }
      _viewer = null;
      _count = 0;
      _lastUpdate = null;
      _lastError = null;
    },

    /** The follow contract the other tracked layers keep (flights, satellites). */
    trackById(id) {
      const device = _latest.find((row) => row.id === id);
      if (!device) return false;
      _followReleasedId = null;
      return startFollow(device);
    },

    stopTracking() {
      stopFollow({ released: true });
      return true;
    },

    getTrackedInfo() {
      const device = _follow ? _latest.find((row) => row.id === _follow.id) : null;
      return device ? { id: device.id, name: device.name, kind: device.kind, lat: device.lat, lon: device.lon } : null;
    },

    /** Plain records for the analyst query engine. Never an address or a login. */
    getAnalystRecords(maxCount = 2000) {
      if (!_enabled) return [];
      const limit = Number.isFinite(maxCount) ? Math.max(1, Math.floor(maxCount)) : 2000;
      return _latest.slice(0, limit).map((device) => ({
        id: device.id,
        kind: device.kind,
        name: device.name,
        lat: device.lat,
        lon: device.lon,
        altM: device.altM,
        headingDeg: device.headingDeg,
        speedMps: device.speedMps,
        live: device.live,
        timeMs: device.at,
      }));
    },

    getStats() {
      return { count: _count, lastUpdate: _lastUpdate, error: _lastError, following: _follow?.id || null, ..._recorder.stats() };
    },
  };
  return layer;
}

const deviceFeedsLayer = createDeviceFeedsLayer();

export default deviceFeedsLayer;
