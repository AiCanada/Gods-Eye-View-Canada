import { greatCircleKm } from '../../data/routePlausible.js';

// ---------------------------------------------------------------------------
// Location switch (the user picked a place in a different first-level region).
// The feed is worldwide, so the contact maps and polling stay: clearing them
// would blank the destination's sky for a poll plus RENDER_DELAY_SEC. What goes
// is what was built for the view being left. Fleet models are hidden at once
// and freed through the fleet tick in bounded slices (a synchronous sweep of
// 350 GPU-backed models stalls the render thread, see the IR reload queue).
// While the camera flies, the tick admits no new models and update() skips its
// view-anchored work (ambient enrichment, floor warm, mesh sampling, and the
// fetch itself on the camera-anchored fallback). Arrival resumes all of it at
// the destination. The hooks are layer.onLocationLeave/onLocationArrive.
// ---------------------------------------------------------------------------
/** Fleet models freed per fleet tick while a location switch drains. */
export const LOCATION_MODEL_RELEASE_BATCH = 24;
/** Longest a leave pauses camera-driven work without its arrival (cancelled
 *  flight, disabled mid-flight): resume rather than stay paused forever. */
export const LOCATION_SWITCH_MAX_HOLD_MS = 15_000;
/** adsb.lol regional fallback radius (nm): ADSBLOL_POINT_RADIUS_NM in server/providers/aircraft/opensky.js. */
const REGIONAL_FALLBACK_RADIUS_NM = 250;
/** Keep margin (km) for the server rounding its fallback anchor to 0.25 deg (at most ~20 km). */
const REGIONAL_FALLBACK_ANCHOR_SLACK_KM = 20;

/**
 * Finite `{lat, lon}` of a location-switch endpoint, or null.
 * @param {{lat?: number, lon?: number}|null|undefined} place
 * @returns {{lat: number, lon: number}|null}
 */
function _locationPoint(place) {
  return Number.isFinite(place?.lat) && Number.isFinite(place?.lon)
    ? { lat: place.lat, lon: place.lon }
    : null;
}

/** Own the civil-flight location-switch state machine. */
export function createLocationSwitch({ flightState, parts }) {
  /**
   * True when the latest snapshot came from the server's camera-anchored adsb.lol
   * fallback (X-Flight-Source / X-Flight-Coverage, server/providers/aircraft/opensky.js)
   * instead of the worldwide OpenSky snapshot. Only that feed is scoped to a place.
   * @returns {boolean}
   */
  function _onRegionalFallback() {
    return (
      flightState.feed._lastSource === 'adsb.lol' ||
      /regional fallback/i.test(flightState.feed._lastCoverage || '')
    );
  }

  /** True while a location switch is between leave and arrival (bounded by LOCATION_SWITCH_MAX_HOLD_MS). */
  function _locationSwitchActive() {
    if (!flightState._locationSwitchStartedMs) return false;
    if (
      Date.now() - flightState._locationSwitchStartedMs <=
      LOCATION_SWITCH_MAX_HOLD_MS
    )
      return true;
    flightState._locationSwitchStartedMs = 0;
    return false;
  }

  /** Forget any switch in progress (init / disable / destroy). */
  function _resetLocationSwitch() {
    flightState._locationSwitchStartedMs = 0;
    flightState._locationReleaseQueue = null;
  }

  /**
   * Forget the Cockpit near band on a location switch: it was measured around
   * the view being left. Contacts that were near get their far presentation back
   * now; while cockpit stays active the next fleet tick re-measures the band at
   * the new camera.
   */
  function _resetCockpitNearContacts() {
    if (!flightState._cockpitNearContacts.size) return;
    const previous = flightState._cockpitNearContacts;
    flightState._cockpitNearContacts = new Set();
    for (const icao24 of previous) {
      const bb = flightState._billboards.get(icao24);
      if (bb) parts.rendering._applyFleetBillboardPresentation(icao24, bb);
    }
    flightState._lastCamPoseSig = '';
  }

  /**
   * Hide every fleet model built for the view being left and queue it for the
   * batched release. Models whose contact already sits within the keep radius of
   * the destination stay; the tick keeps or drops them on arrival as usual.
   * In-flight loads are invalidated now (cheap generation bumps).
   * @param {{lat?: number, lon?: number}|null} to - Destination of the switch.
   */
  function _queueLocationModelRelease(to) {
    const point = _locationPoint(to);
    const keepKm = parts.rendering._modelKeepDistM() / 1000;
    const queue = flightState._locationReleaseQueue || new Set();
    for (const [icao24, model] of flightState._models) {
      const info = point ? flightState.records.data.get(icao24) : null;
      if (
        info &&
        Number.isFinite(info.rawLat) &&
        Number.isFinite(info.rawLon) &&
        greatCircleKm(point.lat, point.lon, info.rawLat, info.rawLon) <= keepKm
      )
        continue;
      queue.add(icao24);
      if (model) model.show = false;
      const bb = flightState._billboards.get(icao24);
      if (bb && icao24 !== flightState._trackedIcao) bb.show = true; // gap-proof: the icon is back before the model goes
    }
    for (const icao24 of flightState._modelPending) {
      if (!flightState._models.has(icao24))
        flightState._modelGen.set(
          icao24,
          (flightState._modelGen.get(icao24) || 0) + 1,
        );
    }
    flightState._locationReleaseQueue = queue.size ? queue : null;
  }

  /** Free one bounded slice of the location-switch model queue (called from the fleet tick). */
  function _drainLocationReleaseQueue() {
    const queue = flightState._locationReleaseQueue;
    if (!queue) return;
    let released = 0;
    for (const icao24 of queue) {
      if (released >= LOCATION_MODEL_RELEASE_BATCH) break;
      queue.delete(icao24);
      if (!flightState._models.has(icao24)) continue; // already gone (aged out, suppressed, regime exit)
      parts.rendering._releaseModel(icao24);
      released += 1;
    }
    if (queue.size === 0) flightState._locationReleaseQueue = null;
  }

  /**
   * Remove one contact and everything this layer holds for it (billboard, model,
   * metadata, history, display caches). Mirrors the snapshot renderer's aged-out
   * removal. Callers clear tracking first when the contact is the tracked one.
   * @param {string} icao24 - ICAO 24-bit transponder address.
   * @param {object} bb - The contact's fleet billboard.
   */
  function _forgetContact(icao24, bb) {
    flightState._billboardCollection?.remove(bb);
    flightState._billboards.delete(icao24);
    parts.rendering._releaseModel(icao24); // no orphaned model, no cap leak
    flightState.records.forget(icao24);
    flightState._cullPositions.delete(icao24);
    flightState._positionHistory.delete(icao24);
    flightState._displayCourse.delete(icao24);
    flightState._groundSnap.forget(icao24);
    flightState._displayFloorState.delete(icao24);
  }

  /**
   * Evict untracked contacts outside the destination's adsb.lol fallback
   * coverage. That feed only returns aircraft within 250 nm of the camera anchor,
   * so old-region contacts would otherwise linger as stale icons for
   * MISSING_POLL_LIMIT polls (~90 s).
   * @param {{lat?: number, lon?: number}|null} to - Destination of the switch.
   * @returns {number} Number of evicted contacts.
   */
  function _evictOutsideRegionalFallback(to) {
    const point = _locationPoint(to);
    if (!point) return 0;
    const radiusKm =
      REGIONAL_FALLBACK_RADIUS_NM * 1.852 + REGIONAL_FALLBACK_ANCHOR_SLACK_KM;
    const evict = [];
    for (const [icao24, bb] of flightState._billboards) {
      if (icao24 === flightState._trackedIcao) continue; // a follow that survived navigation is not ours to drop
      const info = flightState.records.data.get(icao24);
      if (!Number.isFinite(info?.rawLat) || !Number.isFinite(info?.rawLon))
        continue;
      if (
        greatCircleKm(point.lat, point.lon, info.rawLat, info.rawLon) > radiusKm
      )
        evict.push([icao24, bb]);
    }
    for (const [icao24, bb] of evict) _forgetContact(icao24, bb);
    flightState.feed._count = flightState._billboards.size;
    return evict.length;
  }

  /** Run one location-switch step; a failure is logged and never skips the steps after it. */
  function _locationSwitchStep(label, step) {
    try {
      step();
    } catch (error) {
      console.warn(`[Data:Flights] location switch: ${label} failed`, error);
    }
  }

  const methods = {
    /**
     * Location switch started (DataLayerManager hook; see the location-switch
     * section). The worldwide contact maps and polling stay. Releases what was
     * built for the view being left: fleet models (hidden now, freed in slices by
     * the fleet tick), the trail primitive, the Cockpit near band and queued
     * ambient enrichment. On the camera-anchored adsb.lol fallback it also aborts
     * the in-flight fetch for the old anchor. Camera-driven work pauses until
     * onLocationArrive. Tracking is left to the navigation, which already
     * releases it. Idempotent, no network, never throws.
     * @param {object} [change] Location switch detail.
     * @param {{key: string, region: string, country: string, lat: number, lon: number}|null} [change.from]
     * @param {{key: string, region: string, country: string, lat: number, lon: number}} [change.to]
     * @param {AbortSignal} [change.signal]
     * @param {boolean} [change.enabled=true] Whether the layer is on.
     */
    onLocationLeave({ to = null, enabled = true } = {}) {
      // Only an enabled layer polls and ticks, so only it pauses: a disabled
      // layer would never receive the arrival that resumes it.
      if (enabled) flightState._locationSwitchStartedMs = Date.now();
      _locationSwitchStep('fallback fetch', () => {
        if (_onRegionalFallback())
          parts.controller._abortActiveUpdatesForLocationSwitch();
      });
      _locationSwitchStep('model release', () =>
        _queueLocationModelRelease(to),
      );
      _locationSwitchStep('trail', parts.tracking._destroyTrail);
      _locationSwitchStep('cockpit near band', _resetCockpitNearContacts);
      _locationSwitchStep(
        'ambient enrichment',
        parts.enrichment._dropAmbientEnrichQueue,
      );
    },

    /**
     * Camera arrived (DataLayerManager hook, enabled layers only). Resumes
     * camera-driven work and resets the fleet tick throttle and pose signature so
     * models are admitted and noses re-projected at the destination on the next
     * frame. On the adsb.lol fallback it evicts untracked contacts outside the
     * destination's 250 nm coverage now instead of after MISSING_POLL_LIMIT
     * polls, and the manager then refetches the new anchor (see
     * refreshOnLocationArrive). Never throws.
     * @param {object} [change] Location switch detail.
     * @param {{lat: number, lon: number}} [change.to]
     * @param {AbortSignal|null} [change.signal] Aborted when a newer switch superseded this one.
     */
    onLocationArrive({ to = null, signal = null } = {}) {
      if (signal?.aborted) return; // a newer leave owns the pause now
      flightState._locationSwitchStartedMs = 0;
      flightState._lastCamPoseSig = '';
      flightState._lastFleetTickMs = 0;
      _locationSwitchStep('fallback eviction', () => {
        if (_onRegionalFallback()) _evictOutsideRegionalFallback(to);
      });
      _locationSwitchStep('trail', () => {
        // Tracking normally ends with the navigation; a follow that survived gets its trail back.
        const tracked = flightState._trackedIcao;
        if (
          tracked &&
          !flightState._trail &&
          flightState.records.data.has(tracked)
        )
          parts.tracking._startTrail(tracked);
      });
    },
  };

  /**
   * Whether the manager should run one update() after onLocationArrive. Only
   * the adsb.lol fallback is anchored to the camera. The worldwide OpenSky
   * snapshot already holds the destination's aircraft, and an extra refresh
   * there would only spend OpenSky credits. Installed as a getter on the layer.
   */
  const accessors = {
    get refreshOnLocationArrive() {
      return _onRegionalFallback();
    },
  };

  return {
    methods,
    accessors,
    _onRegionalFallback,
    _locationSwitchActive,
    _resetLocationSwitch,
    _resetCockpitNearContacts,
    _queueLocationModelRelease,
    _drainLocationReleaseQueue,
    _forgetContact,
    _evictOutsideRegionalFallback,
  };
}
