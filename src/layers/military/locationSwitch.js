import { greatCircleKm } from '../../data/routePlausible.js';

// ---------------------------------------------------------------------------
// Location switch (mirror of src/layers/flights/locationSwitch.js, see the
// rationale there). The adsb.lol /v2/mil feed is worldwide and identical at any
// location, so the contact maps, polling and any in-flight fetch stay. A switch
// hides the fleet models built for the view being left and frees them in
// bounded fleet-tick slices, admits no new models while the camera flies, and
// pauses the per-poll floor warm and mesh sampling until arrival. The hooks are
// layer.onLocationLeave and onLocationArrive.
// ---------------------------------------------------------------------------
/** Fleet models freed per fleet tick while a location switch drains. */
export const LOCATION_MODEL_RELEASE_BATCH = 24;
/** Longest a leave pauses camera-driven work without its arrival (cancelled
 *  flight, disabled mid-flight): resume rather than stay paused forever. */
export const LOCATION_SWITCH_MAX_HOLD_MS = 15_000;

/** Own the military-flight location-switch state machine. */
export function createLocationSwitch({ flightState, parts }) {
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
    const hasPoint = Number.isFinite(to?.lat) && Number.isFinite(to?.lon);
    const keepKm = parts.rendering._modelKeepDistM() / 1000;
    const queue = flightState._locationReleaseQueue || new Set();
    for (const [icao24, model] of flightState._models) {
      const info = hasPoint ? flightState.records.data.get(icao24) : null;
      if (
        info &&
        Number.isFinite(info.rawLat) &&
        Number.isFinite(info.rawLon) &&
        greatCircleKm(to.lat, to.lon, info.rawLat, info.rawLon) <= keepKm
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
      if (!flightState._models.has(icao24)) continue; // already gone (aged out, regime exit)
      parts.rendering._releaseModel(icao24);
      released += 1;
    }
    if (queue.size === 0) flightState._locationReleaseQueue = null;
  }

  /** Run one location-switch step; a failure is logged and never skips the steps after it. */
  function _locationSwitchStep(label, step) {
    try {
      step();
    } catch (error) {
      console.warn(`[Data:Military] location switch: ${label} failed`, error);
    }
  }

  const methods = {
    /**
     * Location switch started (DataLayerManager hook; see the location-switch
     * section). The worldwide feed, contact maps, polling and any in-flight fetch
     * stay. The layer is never toggled for this: disable() hands known-military
     * duplicates back to the flights layer (setMilitaryLayerActive) and forces an
     * extra OpenSky poll. Hides the fleet models built for the view being left
     * (freed in slices by the fleet tick), destroys the trail primitive, forgets
     * the Cockpit near band, and pauses model admission, floor warming and mesh
     * sampling until onLocationArrive. Tracking is left to the navigation, which
     * already releases it. Idempotent, no network, never throws.
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
      _locationSwitchStep('model release', () =>
        _queueLocationModelRelease(to),
      );
      _locationSwitchStep('trail', parts.tracking._destroyTrail);
      _locationSwitchStep('cockpit near band', _resetCockpitNearContacts);
    },

    /**
     * Camera arrived (DataLayerManager hook, enabled layers only). Resumes model
     * admission and floor work, and resets the fleet tick throttle and pose
     * signature so models are admitted and noses re-projected at the destination
     * on the next frame. No arrival refetch: the next 15 s poll is a worldwide
     * snapshot that already holds the destination. Never throws.
     * @param {object} [change] Location switch detail.
     * @param {AbortSignal|null} [change.signal] Aborted when a newer switch superseded this one.
     */
    onLocationArrive({ signal = null } = {}) {
      if (signal?.aborted) return; // a newer leave owns the pause now
      flightState._locationSwitchStartedMs = 0;
      flightState._lastCamPoseSig = '';
      flightState._lastFleetTickMs = 0;
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

  return {
    methods,
    _locationSwitchActive,
    _resetLocationSwitch,
    _resetCockpitNearContacts,
    _queueLocationModelRelease,
    _drainLocationReleaseQueue,
  };
}
