import * as Cesium from 'cesium';

export function createController({
  flightState,
  services,
  parts,
  layer,
  resolveAsset,
}) {
  function _abortActiveUpdates() {
    for (const controller of flightState.feed._activeUpdateControllers)
      controller.abort();
    flightState.feed._activeUpdateControllers.clear();
  }

  /** Abort in-flight updates on behalf of a location switch (see update()'s catch). */
  function _abortActiveUpdatesForLocationSwitch() {
    for (const controller of flightState.feed._activeUpdateControllers)
      flightState.feed._locationSwitchAbortedUpdates.add(controller);
    _abortActiveUpdates();
  }

  function _flightQuery(viewer) {
    const cartographic = viewer?.camera?.positionCartographic;
    return cartographic
      ? {
          latitude: Cesium.Math.toDegrees(cartographic.latitude),
          longitude: Cesium.Math.toDegrees(cartographic.longitude),
        }
      : {};
  }
  return {
    _abortActiveUpdates,
    _abortActiveUpdatesForLocationSwitch,
    _flightQuery,
  };
}
