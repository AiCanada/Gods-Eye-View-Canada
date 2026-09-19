import { createStandalonePlaceSearch } from './standalone/placeSearch.js';
// Camera-framing mode contract for fly_to_location (field test 8 + rootcause doc §3):
// parks/lakes/campuses and streets are NOT precise POIs — flying to "Zilker Park" at
// building range (250 m) lands on a random rooftop. Pure mapping tests, no network.
//
// Run with: npm test   (node --test)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as Cesium from 'cesium';
import {
  CANCELLED_SEARCH,
  placeFramingViewport,
  PLACE_VIEWPORT_MAX_SPAN_KM,
  PLACE_ANCHOR_OFFSET_RATIO,
  flyToGlobeView,
  flyToPresetLocation,
  geocodeNavigationMode,
  regionFramingPlan,
  REGION_SWATH_SPAN_KM,
  GLOBE_VIEW,
  searchAndFlyTo,
  findCanadianCity,
  presetCityIdForQuery,
  CANADIAN_CITIES,
  CITY_POIS,
  CITY_OVERVIEW_RANGE_M,
  closestCityForSearch,
  presetCitySearchName,
} from './locations.js';

function stubViewer() {
  const flights = [];
  return {
    flights,
    scene: { globe: null, canvas: { clientWidth: 0, clientHeight: 0 } },
    camera: {
      positionCartographic: {
        longitude: Cesium.Math.toRadians(-97.7431),
        latitude: Cesium.Math.toRadians(30.2672),
        height: 1200,
      },
      cancelFlight() {},
      flyTo(options) { flights.push(options); },
      flyToBoundingSphere(sphere, options) { flights.push({ sphere, ...options }); },
      lookAt() {},
      lookAtTransform() {},
    },
  };
}

const AUSTIN_RESULT = {
  formatted_address: 'Austin, TX, USA',
  types: ['locality', 'political'],
  geometry: {
    location: { lat: 30.2672, lng: -97.7431 },
    viewport: {
      southwest: { lat: 30.1, lng: -97.95 },
      northeast: { lat: 30.5, lng: -97.55 },
    },
  },
};

async function runSearch(viewer, options, { result = AUSTIN_RESULT, query = 'austin' } = {}) {
  const hadWindow = Object.hasOwn(globalThis, 'window');
  const priorWindow = globalThis.window;
  const priorFetch = globalThis.fetch;
  globalThis.window = { __GOOGLE_MAPS_API_KEY__: 'test-key' };
  globalThis.fetch = async () => ({
    json: async () => ({ status: 'OK', results: [result] }),
  });
  try {
    return await searchAndFlyTo(viewer, query, { placeSearch: createStandalonePlaceSearch({ resolveApiKey: () => globalThis.window?.__GOOGLE_MAPS_API_KEY__ }), ...options });
  } finally {
    globalThis.fetch = priorFetch;
    if (hadWindow) globalThis.window = priorWindow;
    else delete globalThis.window;
  }
}

/** Read a recorded viewport flight back as a degrees rectangle. */
function flownRectangleDegrees(viewer, index = 0) {
  const rectangle = viewer.flights[index]?.destination;
  assert.ok(rectangle instanceof Cesium.Rectangle, 'expected a rectangle (viewport) flight');
  return {
    south: Cesium.Math.toDegrees(rectangle.south),
    north: Cesium.Math.toDegrees(rectangle.north),
    west: Cesium.Math.toDegrees(rectangle.west),
    east: Cesium.Math.toDegrees(rectangle.east),
    // Cesium's own width, which adds a full turn when the box crosses the
    // antimeridian — the number the camera actually frames.
    widthDeg: Cesium.Math.toDegrees(rectangle.width),
    crossesAntimeridian: rectangle.east < rectangle.west,
  };
}

test('parks / lakes / campuses frame as area-overview, not precise-place', () => {
  // Zilker Park — the field-test rooftop bug.
  assert.equal(geocodeNavigationMode(['park', 'tourist_attraction', 'point_of_interest', 'establishment']), 'area-overview');
  // Lady Bird Lake.
  assert.equal(geocodeNavigationMode(['natural_feature', 'establishment']), 'area-overview');
  assert.equal(geocodeNavigationMode(['university', 'point_of_interest']), 'area-overview');
  assert.equal(geocodeNavigationMode(['airport']), 'area-overview');
});

test('streets frame as street-corridor (rootcause doc §3 — Sixth Street)', () => {
  assert.equal(geocodeNavigationMode(['route']), 'street-corridor');
  assert.equal(geocodeNavigationMode(['intersection']), 'street-corridor');
});

test('existing modes unchanged: admin, city, neighborhood, precise POI', () => {
  assert.equal(geocodeNavigationMode(['country', 'political']), 'region-overview');
  assert.equal(geocodeNavigationMode(['administrative_area_level_1', 'political']), 'region-overview');
  assert.equal(geocodeNavigationMode(['locality', 'political']), 'city-overview');
  assert.equal(geocodeNavigationMode(['neighborhood', 'political']), 'neighborhood-close');
  // A statue / small POI stays precise (tourist_attraction alone must NOT widen it).
  assert.equal(geocodeNavigationMode(['tourist_attraction', 'point_of_interest', 'establishment']), 'precise-place');
  assert.equal(geocodeNavigationMode(['premise']), 'precise-place');
  assert.equal(geocodeNavigationMode([]), 'precise-place');
});

test('admin types win over area types when both present', () => {
  // A locality that is also tagged park-ish should still frame as the locality.
  assert.equal(geocodeNavigationMode(['locality', 'park', 'political']), 'city-overview');
});

// Natural-region framing heuristic (owner field test 2026-07-23): "take me to the
// Rocky Mountains" geocodes as natural_feature with a ~2,700 km viewport — framing
// the whole box flies the camera to space. Region-scale viewports get a capped
// oblique swath instead; ordinary parks/lakes keep full-viewport framing.

test('regionFramingPlan: Rocky-Mountains-scale viewport gets a capped oblique swath', () => {
  // Real-shape geocode bounds for the Rockies: ~25° of latitude, N-S elongated.
  const plan = regionFramingPlan({
    southwest: { lat: 35.0, lng: -119.0 },
    northeast: { lat: 60.0, lng: -105.0 },
  });
  assert.equal(plan.mode, 'swath');
  assert.ok(plan.spanKm > 2000, `span should be huge, got ${plan.spanKm}`);
  // Camera range is CAPPED at regional scale — never the multi-thousand-km bbox fit.
  assert.ok(plan.rangeM <= 400000, `rangeM must stay regional, got ${plan.rangeM}`);
  assert.ok(plan.rangeM >= 150000, `rangeM must still read as a region, got ${plan.rangeM}`);
  // Oblique cinematic angle, not straight down.
  assert.ok(plan.pitchDeg > -60 && plan.pitchDeg <= -20, `pitch should be oblique, got ${plan.pitchDeg}`);
  // N-S elongated range → camera looks along the long axis (north).
  assert.equal(plan.headingDeg, 0);
  // Swath is centered on the feature.
  assert.ok(Math.abs(plan.centerLat - 47.5) < 0.01);
  assert.ok(Math.abs(plan.centerLng - (-112)) < 0.01);
});

test('regionFramingPlan: E-W elongated region looks along the east axis', () => {
  // Alps-shaped box: ~2.3° lat, ~11° lon.
  const plan = regionFramingPlan({
    southwest: { lat: 45.5, lng: 5.0 },
    northeast: { lat: 47.8, lng: 16.0 },
  });
  assert.equal(plan.mode, 'swath');
  assert.equal(plan.headingDeg, 90);
});

test('regionFramingPlan: park- and lake-scale viewports keep full framing', () => {
  // Zilker Park (~3 km).
  assert.equal(regionFramingPlan({
    southwest: { lat: 30.26, lng: -97.78 },
    northeast: { lat: 30.28, lng: -97.75 },
  }).mode, 'full');
  // Lake Tahoe (~50 km).
  assert.equal(regionFramingPlan({
    southwest: { lat: 38.90, lng: -120.20 },
    northeast: { lat: 39.25, lng: -119.90 },
  }).mode, 'full');
});

test('regionFramingPlan: threshold splits full vs swath', () => {
  // ~330 km tall box (3° latitude, negligible width) → still full framing.
  const under = regionFramingPlan({
    southwest: { lat: 40.0, lng: -100.0 },
    northeast: { lat: 43.0, lng: -99.9 },
  });
  assert.equal(under.mode, 'full');
  assert.ok(under.spanKm < REGION_SWATH_SPAN_KM);
  // ~560 km tall box (5° latitude) → swath.
  const over = regionFramingPlan({
    southwest: { lat: 40.0, lng: -100.0 },
    northeast: { lat: 45.0, lng: -99.9 },
  });
  assert.equal(over.mode, 'swath');
  assert.ok(over.spanKm > REGION_SWATH_SPAN_KM);
});

test('regionFramingPlan: antimeridian-crossing viewport measured the short way round', () => {
  // 20° of longitude across the date line at the equator (~2,200 km), NOT ~340°.
  const plan = regionFramingPlan({
    southwest: { lat: -5.0, lng: 170.0 },
    northeast: { lat: 5.0, lng: -170.0 },
  });
  assert.equal(plan.mode, 'swath');
  assert.ok(plan.spanKm < 3000, `span must use the short arc, got ${plan.spanKm}`);
  // Center sits on the antimeridian, normalized into [-180, 180].
  assert.ok(Math.abs(Math.abs(plan.centerLng) - 180) < 0.01);
});

// ── Off-centre viewport sanity gate (2026-08-20 QA hunt) ────────────────────
// Free-text "Tokyo" flew the camera ~977 km out over the open Pacific. Tokyo
// geocodes as the PREFECTURE (administrative_area_level_1), and Tokyo Metropolis
// owns the Izu/Ogasawara chains ~1,000 km out to sea — so its bounding box is
// mostly ocean and its centroid is nowhere near the city. "Hawaii" behaves the
// same way via the Northwestern Hawaiian Islands.
//
// EVERY fixture below is SYNTHETIC geometry, constructed here. Google Maps
// content — geocodes included — may not be cached, stored, rehosted, or
// committed (DATA_SOURCES.md), so no captured API response appears in this repo.
// The fixtures reproduce the SHAPES that matter instead: an oversized box whose
// place sits in one corner, an oversized box centred on its place, the same
// crossing the antimeridian, and city-sized boxes.

/** Synthetic geocode bounds from explicit south/west/north/east degrees. */
function boxOf(southLat, westLng, northLat, eastLng) {
  return { southwest: { lat: southLat, lng: westLng }, northeast: { lat: northLat, lng: eastLng } };
}

/** Synthetic geocode bounds from a centre and its degree spans. */
function boxAround(centerLat, centerLng, latSpanDeg, lonSpanDeg) {
  return boxOf(
    centerLat - latSpanDeg / 2,
    centerLng - lonSpanDeg / 2,
    centerLat + latSpanDeg / 2,
    centerLng + lonSpanDeg / 2,
  );
}

/** Build a synthetic geocode result around one of the boxes above. */
function resultOf(types, bounds, lat, lng, label = 'Synthetic Place') {
  return { formatted_address: label, types, geometry: { location: { lat, lng }, bounds } };
}

// ~3,055 km box whose place sits near the NW corner, ~1,352 km off the centroid
// → ratio ~0.44. Mirrors the Tokyo (0.397) and Hawaii (0.456) failures.
const OFF_CENTRE_ADMIN_BOX = boxOf(10, 100, 30, 120);
const OFF_CENTRE_ADMIN_ANCHOR = { lat: 29, lng: 101 };
const OFF_CENTRE_ADMIN_RESULT = resultOf(
  ['administrative_area_level_1', 'political'],
  OFF_CENTRE_ADMIN_BOX,
  OFF_CENTRE_ADMIN_ANCHOR.lat,
  OFF_CENTRE_ADMIN_ANCHOR.lng,
  'Off-Centre Prefecture',
);

// ~1,439 km box centred on its place (~62 km off → ratio ~0.043). Mirrors a
// state or province: big, but the box IS the place.
const CENTRED_REGION_BOX = boxAround(35, -5, 10, 10);
const CENTRED_REGION_RESULT = resultOf(
  ['administrative_area_level_1', 'political'],
  CENTRED_REGION_BOX,
  35.5,
  -5.3,
  'Centred Province',
);

// Well-centred region crossing the antimeridian: 20 deg tall, 60 deg wide the
// SHORT way round (sw 170E, ne -130). Mirrors Alaska.
const ANTIMERIDIAN_REGION_BOX = boxOf(50, 170, 70, -130);
const ANTIMERIDIAN_REGION_RESULT = resultOf(
  ['administrative_area_level_1', 'political'],
  ANTIMERIDIAN_REGION_BOX,
  62.5,
  -163,
  'Antimeridian Territory',
);

test('placeFramingViewport: an off-centre admin box collapses to a metro box on the RESULT location', () => {
  const framed = placeFramingViewport(
    OFF_CENTRE_ADMIN_BOX,
    OFF_CENTRE_ADMIN_ANCHOR.lat,
    OFF_CENTRE_ADMIN_ANCHOR.lng,
    OFF_CENTRE_ADMIN_RESULT.types,
  );
  const centerLat = (framed.southwest.lat + framed.northeast.lat) / 2;
  const centerLng = (framed.southwest.lng + framed.northeast.lng) / 2;
  // Centred on the place — NOT the box centroid, which is ~1,350 km away.
  assert.ok(Math.abs(centerLat - OFF_CENTRE_ADMIN_ANCHOR.lat) < 1e-6, `centred on the place, got ${centerLat}`);
  assert.ok(Math.abs(centerLng - OFF_CENTRE_ADMIN_ANCHOR.lng) < 1e-6, `centred on the place, got ${centerLng}`);
  // And it is metro-sized: ~40 km on a side, well inside the gate.
  const plan = regionFramingPlan(framed);
  assert.ok(plan.spanKm < 60, `metro box must stay city-scale, got ${plan.spanKm} km`);
});

test('placeFramingViewport: genuinely large, well-centred regions keep whole-place framing', () => {
  // Each is far over the span gate, but its place sits near the box centre, so
  // the box IS the place. The last one also exercises the antimeridian path.
  const regions = [
    ['centred province', CENTRED_REGION_BOX, 35.5, -5.3],
    ['tall province', boxAround(-20, 140, 12, 9), -20.4, 140.3],
    ['broad territory', boxAround(60, -95, 24, 40), 61.2, -93.5],
    ['antimeridian territory', ANTIMERIDIAN_REGION_BOX, 62.5, -163],
  ];
  for (const [name, box, lat, lng] of regions) {
    assert.ok(
      regionFramingPlan(box).spanKm > PLACE_VIEWPORT_MAX_SPAN_KM,
      `${name} is over the span gate by construction`,
    );
    assert.equal(
      placeFramingViewport(box, lat, lng, ['administrative_area_level_1', 'political']),
      box,
      `${name} must still frame its own bounds`,
    );
  }
});

test('placeFramingViewport: ordinary city viewports never reach the gate', () => {
  // City-scale boxes across the latitude range, including a municipality as wide
  // as the widest real one measured (~140 km corner to corner).
  const cityBoxes = [
    ['equatorial city', boxAround(0, 100, 0.5, 0.5)],
    ['mid-latitude metro', boxAround(35, 20, 0.4, 0.5)],
    ['southern coastal city', boxAround(-23, -43, 0.65, 0.5)],
    ['high-latitude capital', boxAround(51.5, -0.1, 0.42, 0.84)],
    ['wide municipality', boxAround(61, -150, 0.87, 1.93)],
  ];
  for (const [name, box] of cityBoxes) {
    assert.ok(
      regionFramingPlan(box).spanKm < PLACE_VIEWPORT_MAX_SPAN_KM,
      `${name} must sit under the gate, got ${regionFramingPlan(box).spanKm} km`,
    );
    assert.equal(placeFramingViewport(box, 0, 0, ['locality']), box, `${name} must be framed as geocoded`);
  }
});

test('placeFramingViewport: the gate needs BOTH an oversized box and an off-centre anchor', () => {
  // A 3-degree box near the equator: ~470 km diagonal, over the span gate.
  const over = boxOf(8, 18, 11, 21);
  const spanKm = regionFramingPlan(over).spanKm;
  assert.ok(spanKm > PLACE_VIEWPORT_MAX_SPAN_KM);

  // Anchor at the centre → the box is the place, keep it.
  assert.equal(placeFramingViewport(over, 9.5, 19.5, ['administrative_area_level_1']), over);
  // Anchor pushed past the ratio → collapse to a metro box.
  const offCentreLat = 9.5 + (spanKm * PLACE_ANCHOR_OFFSET_RATIO * 1.5) / 111.32;
  assert.notEqual(placeFramingViewport(over, offCentreLat, 19.5, ['administrative_area_level_1']), over);

  // Under the span gate, even a wildly off-centre anchor is left alone.
  const under = boxOf(9, 19, 10.9, 20.9);
  assert.ok(regionFramingPlan(under).spanKm < PLACE_VIEWPORT_MAX_SPAN_KM);
  assert.equal(placeFramingViewport(under, 9.05, 19.05, ['locality']), under);
});

test('placeFramingViewport: countries are exempt, deliberately and on the record', () => {
  // Several countries have the identical pathology from overseas territories and
  // today fly to a mid-ocean centroid. Reframing a country is a bigger call than
  // fixing a prefecture, so it is left for the owner rather than changed silently.
  // Same shape as the gated fixture, differing ONLY in the `country` type.
  assert.notEqual(
    placeFramingViewport(OFF_CENTRE_ADMIN_BOX, 29, 101, ['administrative_area_level_1', 'political']),
    OFF_CENTRE_ADMIN_BOX,
    'the shape itself is gated when it is an administrative area',
  );
  assert.equal(
    placeFramingViewport(OFF_CENTRE_ADMIN_BOX, 29, 101, ['country', 'political']),
    OFF_CENTRE_ADMIN_BOX,
    'country framing must stay exactly as shipped until the owner rules on it',
  );
});

test('placeFramingViewport: no usable viewport or anchor leaves framing alone', () => {
  assert.equal(placeFramingViewport(null, 29, 101, ['locality']), null);
  assert.equal(placeFramingViewport(undefined, 29, 101, ['locality']), undefined);
  // Without a finite anchor there is nothing better to fly to than the box.
  assert.equal(placeFramingViewport(OFF_CENTRE_ADMIN_BOX, NaN, 101, ['administrative_area_level_1']), OFF_CENTRE_ADMIN_BOX);
  assert.equal(placeFramingViewport(OFF_CENTRE_ADMIN_BOX, 29, undefined, ['administrative_area_level_1']), OFF_CENTRE_ADMIN_BOX);
});

test('an off-centre admin search lands over the place, not the box centroid', async () => {
  const viewer = stubViewer();
  const result = await runSearch(viewer, {}, { result: OFF_CENTRE_ADMIN_RESULT, query: 'Off-Centre Prefecture' });
  assert.equal(result.navigationMode, 'region-overview', 'the fixture is a prefecture, not a locality');
  const flown = flownRectangleDegrees(viewer);
  const centerLat = (flown.south + flown.north) / 2;
  const centerLng = (flown.west + flown.east) / 2;
  assert.ok(Math.abs(centerLat - 29) < 0.01, `expected the place latitude, got ${centerLat}`);
  assert.ok(Math.abs(centerLng - 101) < 0.01, `expected the place longitude, got ${centerLng}`);
  // The regression: the old framing centred on the box centroid, ~9 degrees away.
  assert.ok(centerLng < 105, 'must not drift toward the far side of the box');
  // Metro framing, not an ocean-wide box.
  assert.ok(flown.widthDeg < 1, `expected a metro-scale box, got ${flown.widthDeg}°`);
});

test('a well-centred region search still frames its whole bounds', async () => {
  const viewer = stubViewer();
  const result = await runSearch(viewer, {}, { result: CENTRED_REGION_RESULT, query: 'Centred Province' });
  assert.equal(result.navigationMode, 'region-overview');
  const flown = flownRectangleDegrees(viewer);
  // The region's own bounds, plus flyToViewportBounds' 12% padding — never a metro box.
  assert.ok(flown.south <= 30 && flown.north >= 40, `must span the region N-S, got ${flown.south}..${flown.north}`);
  assert.ok(flown.west <= -10 && flown.east >= 0, `must span the region E-W, got ${flown.west}..${flown.east}`);
});

// ── Explicit overview intent outranks the sanity gate ───────────────────────
// The gate exists to guess what an ambiguous place name meant. "Show me an
// overview of Hawaii" (voice `viewMode: 'overview'`) leaves nothing to guess, so
// the whole administrative area must be framed even though the gate would fire.
test('an explicit overview ask frames the whole administrative area', async () => {
  const gated = stubViewer();
  await runSearch(gated, {}, { result: OFF_CENTRE_ADMIN_RESULT, query: 'Off-Centre Prefecture' });
  const gatedFlight = flownRectangleDegrees(gated);
  assert.ok(gatedFlight.widthDeg < 1, 'without the ask, the gate collapses it to a metro box');

  const overview = stubViewer();
  await runSearch(
    overview,
    { viewMode: 'overview' },
    { result: OFF_CENTRE_ADMIN_RESULT, query: 'Off-Centre Prefecture' },
  );
  const flown = flownRectangleDegrees(overview);
  // The full 20x20 degree box plus 12% padding, not a 0.4 degree metro box.
  assert.ok(flown.widthDeg > 20, `overview must frame the whole area, got ${flown.widthDeg}°`);
  assert.ok(flown.south <= 10 && flown.north >= 30, `must span the area N-S, got ${flown.south}..${flown.north}`);
});

test('an explicit overview ask still reaches a well-centred region unchanged', async () => {
  const viewer = stubViewer();
  await runSearch(
    viewer,
    { viewMode: 'overview' },
    { result: CENTRED_REGION_RESULT, query: 'Centred Province' },
  );
  const flown = flownRectangleDegrees(viewer);
  assert.ok(flown.south <= 30 && flown.north >= 40);
  assert.ok(flown.west <= -10 && flown.east >= 0);
});

// ── Antimeridian framing in the ACTUAL flight ───────────────────────────────
// flyToViewportBounds padded from a raw longitude subtraction, so any box
// crossing the antimeridian inflated catastrophically: a 0.41 degree metro box
// straddling the dateline subtracts to -359.6, whose 12% padding alone is 43
// degrees, and the camera framed ~86.7 degrees of ocean.
test('a metro fallback straddling the antimeridian frames a metro box, not a hemisphere', async () => {
  // Oversized box crossing the dateline whose place sits at 179.9 — the gate
  // fires and produces a metro box that straddles +/-180.
  const bounds = boxOf(10, 161, 30, -159);
  const result = resultOf(['administrative_area_level_1', 'political'], bounds, 29, 179.9, 'Dateline Prefecture');
  const viewer = stubViewer();
  await runSearch(viewer, {}, { result, query: 'Dateline Prefecture' });

  const flown = flownRectangleDegrees(viewer);
  assert.ok(flown.crossesAntimeridian, 'the framed box must be a real east<west crossing rectangle');
  assert.ok(
    flown.widthDeg > 0.3 && flown.widthDeg < 1,
    `expected a metro-scale width across the dateline, got ${flown.widthDeg}°`,
  );
  assert.ok(flown.west >= -180 && flown.west <= 180, `west must be normalized, got ${flown.west}`);
  assert.ok(flown.east >= -180 && flown.east <= 180, `east must be normalized, got ${flown.east}`);
});

test('an antimeridian REGION frames its own span, not four times it', async () => {
  const viewer = stubViewer();
  await runSearch(viewer, {}, { result: ANTIMERIDIAN_REGION_RESULT, query: 'Antimeridian Territory' });

  const flown = flownRectangleDegrees(viewer);
  // 60 deg short-way span + 12% padding on each side = 74.4 deg. Raw subtraction
  // produced ~132 deg instead.
  assert.ok(flown.crossesAntimeridian, 'the territory box crosses the antimeridian');
  assert.ok(
    Math.abs(flown.widthDeg - 74.4) < 0.5,
    `expected the padded 60° span (74.4°), got ${flown.widthDeg}°`,
  );
  assert.ok(flown.west >= -180 && flown.west <= 180, `west must be normalized, got ${flown.west}`);
  assert.ok(flown.east >= -180 && flown.east <= 180, `east must be normalized, got ${flown.east}`);
});

test('ordinary boxes are framed exactly as before the antimeridian fix', async () => {
  const viewer = stubViewer();
  await runSearch(viewer, {}, { result: CENTRED_REGION_RESULT, query: 'Centred Province' });
  const flown = flownRectangleDegrees(viewer);
  // 10 deg span + 12% padding each side = 12.4 deg, and no crossing.
  assert.equal(flown.crossesAntimeridian, false);
  assert.ok(Math.abs(flown.widthDeg - 12.4) < 0.01, `expected 12.4°, got ${flown.widthDeg}°`);
});
test('regionFramingPlan: invalid viewports return null', () => {
  assert.equal(regionFramingPlan(null), null);
  assert.equal(regionFramingPlan({}), null);
  assert.equal(regionFramingPlan({ southwest: { lat: NaN, lng: 0 }, northeast: { lat: 1, lng: 1 } }), null);
});

// Globe-view preset (owner field test 2026-07-23): "zoom out to a globe view" needs an
// ABSOLUTE full-earth framing — the relative zoom tool can never reach it. The preset
// must sit inside the app's own 'global' view-scale band (>12,000 km camera height,
// classifyViewScale in gevActions.js) and under the fly_to rangeM ceiling (20,000 km).
test('GLOBE_VIEW preset height sits in the global view band', () => {
  assert.ok(GLOBE_VIEW.heightM > 12000000, `must classify as global band, got ${GLOBE_VIEW.heightM}`);
  assert.ok(GLOBE_VIEW.heightM <= 20000000, `must stay under the 20,000 km ceiling, got ${GLOBE_VIEW.heightM}`);
  // Straight-down framing so the planet reads as a globe, not a horizon shot.
  assert.equal(GLOBE_VIEW.pitchDeg, -90);
});

// The globe flight's callbacks are what resolves Reset Globe / zoom_to_globe.
// They were published under this module's OWN option names (`onComplete` /
// `onCancel`), which Cesium's Camera.flyTo ignores — so neither ever fired and
// every caller resolved off its ~4.2 s watchdog timeout instead of the flight.
test('the globe flight publishes its callbacks under Cesium\'s own option names', () => {
  const viewer = stubViewer();
  const fired = [];
  flyToGlobeView(viewer, {
    onComplete: () => fired.push('complete'),
    onCancel: () => fired.push('cancel'),
  });

  const flight = viewer.flights[0];
  assert.equal(typeof flight.complete, 'function', 'Cesium resolves arrival through `complete`');
  assert.equal(typeof flight.cancel, 'function', 'Cesium reports supersession through `cancel`');
  // Not merely present under both spellings: the ignored names must be gone,
  // or a later reader can "fix" the wrong one back.
  assert.equal('onComplete' in flight, false, 'Cesium ignores onComplete — do not publish it');
  assert.equal('onCancel' in flight, false, 'Cesium ignores onCancel — do not publish it');

  flight.complete();
  flight.cancel();
  assert.deepEqual(fired, ['complete', 'cancel'], 'each hook reaches the caller it belongs to');
});

test('a globe flight without callbacks still flies (both hooks are optional)', () => {
  const viewer = stubViewer();
  const target = flyToGlobeView(viewer);
  assert.equal(viewer.flights.length, 1);
  assert.equal(target.heightM, GLOBE_VIEW.heightM);
  assert.equal(viewer.flights[0].complete, undefined);
  assert.equal(viewer.flights[0].cancel, undefined);
});

test('geocoded Location branches forward the resolved-navigation ownership hook', () => {
  const source = fs.readFileSync(new URL('./locations.js', import.meta.url), 'utf8');
  const searchStart = source.indexOf('export async function searchAndFlyTo');
  const searchEnd = source.indexOf('function placesViewportToBounds', searchStart);
  const search = source.slice(searchStart, searchEnd);
  assert.equal(
    (search.match(/onStart: options\.onStart/g) || []).length,
    5,
    'preset, gazetteer, swath, viewport, and landmark flights must each forward onStart',
  );
  assert.equal(
    (search.match(/onCancel: options\.onCancel/g) || []).length,
    5,
    'preset, gazetteer, swath, viewport, and landmark flights must each forward onCancel',
  );
  // The ordering rule belongs to the geocoding half of the function: a geocode
  // that resolves nothing must bail before any flight is started. The gazetteer
  // branch runs ahead of all of that and flies on its own hit, so the slice
  // starts where geocoding does.
  const geocoded = search.slice(search.indexOf('placeSearch.geocode('));
  assert.ok(geocoded.indexOf('return null;') < geocoded.indexOf('onStart: options.onStart'));
});

test('globe and city-overview flights name the world frame explicitly', () => {
  const globeViewer = stubViewer();
  flyToGlobeView(globeViewer);
  assert.equal(globeViewer.flights[0].endTransform, Cesium.Matrix4.IDENTITY);

  const cityViewer = stubViewer();
  flyToPresetLocation(cityViewer, 'austin', { viewMode: 'overview' });
  assert.equal(cityViewer.flights[0].endTransform, Cesium.Matrix4.IDENTITY);
});

test('city and landmark flights expose completion and cancellation hooks', () => {
  const overviewViewer = stubViewer();
  const overviewEvents = [];
  flyToPresetLocation(overviewViewer, 'austin', {
    viewMode: 'overview',
    onComplete: () => overviewEvents.push('complete'),
    onCancel: () => overviewEvents.push('cancel'),
  });
  overviewViewer.flights[0].complete();
  overviewViewer.flights[0].cancel();
  assert.deepEqual(overviewEvents, ['complete', 'cancel']);

  const landmarkViewer = stubViewer();
  const landmarkEvents = [];
  flyToPresetLocation(landmarkViewer, 'austin', {
    onComplete: () => landmarkEvents.push('complete'),
    onCancel: () => landmarkEvents.push('cancel'),
  });
  landmarkViewer.flights[0].complete();
  landmarkViewer.flights[0].cancel();
  assert.deepEqual(landmarkEvents, ['complete', 'cancel']);
});

test('beforeFly runs once after resolution and immediately before the flight', async () => {
  const viewer = stubViewer();
  const order = [];
  const result = await runSearch(viewer, {
    beforeFly: () => {
      order.push(`before:${viewer.flights.length}`);
      return true;
    },
  });
  assert.equal(result.navigationMode, 'city-overview');
  assert.deepEqual(order, ['before:0']);
  assert.equal(viewer.flights.length, 1);
});

test('a final authority veto returns cancellation without issuing a flight', async () => {
  const viewer = stubViewer();
  const result = await runSearch(viewer, { beforeFly: () => false });
  assert.equal(result, CANCELLED_SEARCH);
  assert.equal(viewer.flights.length, 0);
});

test('search without an authority hook preserves the existing caller contract', async () => {
  const viewer = stubViewer();
  const result = await runSearch(viewer, {});
  assert.equal(result.navigationMode, 'city-overview');
  assert.equal(viewer.flights.length, 1);
});


// ---------------------------------------------------------------------------
// Built-in Canadian gazetteer
//
// Geocoding needs a Google key, so on a keyless build the search box could not
// answer anything at all. These entries resolve locally instead. The tests that
// matter are the disambiguation rules: a bare name must not quietly send the
// camera to the wrong continent.
// ---------------------------------------------------------------------------

test('gazetteer resolves a city named with its province', () => {
  const hit = findCanadianCity('Saint John, NB');
  assert.ok(hit, 'expected Saint John to resolve');
  assert.equal(hit.province, 'New Brunswick');
  assert.ok(Math.abs(hit.lat - 45.2733) < 0.01);
  assert.ok(Math.abs(hit.lon - -66.0633) < 0.01);
  assert.equal(hit.label, 'Saint John, New Brunswick');
});

test('gazetteer accepts the spelled-out province and a missing comma', () => {
  const a = findCanadianCity('saint john new brunswick');
  const b = findCanadianCity('Saint John, New Brunswick');
  assert.ok(a && b);
  assert.equal(a.name, b.name);
});

test('gazetteer expands the Saint abbreviation', () => {
  assert.equal(findCanadianCity('st john nb').name, 'Saint John');
  assert.equal(findCanadianCity('Sault Ste. Marie').name, 'Sault Ste. Marie');
  assert.equal(findCanadianCity('sault ste marie on').name, 'Sault Ste. Marie');
});

test('gazetteer folds accents and punctuation', () => {
  assert.equal(findCanadianCity('L\u00e9vis').name, 'Levis');
  assert.equal(findCanadianCity('St. Catharines').name, 'St. Catharines');
  assert.equal(findCanadianCity('st catharines ontario').name, 'St. Catharines');
});

test('a bare name that collides with a curated city stays with the curated one', () => {
  // London is London, England in this app. Only naming the province moves it.
  assert.equal(findCanadianCity('London'), null);
  const ontario = findCanadianCity('London Ontario');
  assert.ok(ontario);
  assert.ok(ontario.lon < -80, 'expected London, Ontario rather than London, England');
});

test('an unambiguous bare name resolves on its own', () => {
  assert.equal(findCanadianCity('Saskatoon').name, 'Saskatoon');
  assert.equal(findCanadianCity('moncton').name, 'Moncton');
});

test('a name that is in neither list does not resolve', () => {
  assert.equal(findCanadianCity('Nowhere Junction'), null);
  assert.equal(findCanadianCity(''), null);
  assert.equal(findCanadianCity(null), null);
});

test('every gazetteer entry has a plausible Canadian coordinate', () => {
  assert.ok(CANADIAN_CITIES.length >= 50);
  for (const city of CANADIAN_CITIES) {
    assert.ok(city.name && city.province && city.abbr, `${city.name} is missing a field`);
    assert.ok(city.lat > 41.5 && city.lat < 83.5, `${city.name} latitude out of range`);
    assert.ok(city.lon > -141.5 && city.lon < -52, `${city.name} longitude out of range`);
  }
  const ids = new Set(CANADIAN_CITIES.map((c) => `${c.name}|${c.province}`));
  assert.equal(ids.size, CANADIAN_CITIES.length, 'duplicate gazetteer entry');
});

test('search flies to a gazetteer city with no API key present', async () => {
  const viewer = stubViewer();
  const hadWindow = Object.hasOwn(globalThis, 'window');
  const priorWindow = globalThis.window;
  const priorFetch = globalThis.fetch;
  // No key, and any network call is a failure: the gazetteer must answer alone.
  globalThis.window = {};
  globalThis.fetch = async () => {
    throw new Error('search must not reach the network for a gazetteer city');
  };
  try {
    const result = await searchAndFlyTo(viewer, 'Halifax, Nova Scotia');
    assert.equal(result.label, 'Halifax, Nova Scotia');
    assert.equal(result.navigationMode, 'city-overview');
    assert.equal(result.rangeM, CITY_OVERVIEW_RANGE_M);
    assert.equal(viewer.flights.length, 1, 'expected exactly one flight');
  } finally {
    globalThis.fetch = priorFetch;
    if (hadWindow) globalThis.window = priorWindow;
    else delete globalThis.window;
  }
});

test('Saint John is a preset city whose first stop is the Danger Zone', () => {
  const city = CITY_POIS.saintjohn;
  assert.ok(city, 'expected a Saint John preset city');
  assert.equal(city.name, 'Saint John Danger Zone');
  // The first POI is the default fly-to for the city.
  assert.equal(city.pois[0].name, 'Saint John Danger Zone');
  assert.ok(Math.abs(city.pois[0].lat - 45.2733) < 0.02);
  assert.ok(Math.abs(city.pois[0].lon - -66.0633) < 0.02);
  for (const poi of city.pois) {
    assert.ok(poi.lat > 45.2 && poi.lat < 45.36, `${poi.name} is outside Saint John`);
    assert.ok(poi.lon > -66.15 && poi.lon < -65.95, `${poi.name} is outside Saint John`);
  }
});

// Search-box resolution order: preset city, then gazetteer, then geocoder.

async function withKeylessWindow(run) {
  const hadWindow = Object.hasOwn(globalThis, 'window');
  const priorWindow = globalThis.window;
  const priorFetch = globalThis.fetch;
  globalThis.window = {};
  globalThis.fetch = async () => {
    throw new Error('search must not reach the network for a local answer');
  };
  try {
    return await run();
  } finally {
    globalThis.fetch = priorFetch;
    if (hadWindow) globalThis.window = priorWindow;
    else delete globalThis.window;
  }
}

test('typing a preset city name flies its curated first stop with no key present', async () => {
  await withKeylessWindow(async () => {
    const viewer = stubViewer();
    assert.equal(presetCityIdForQuery('saint john'), 'saintjohn');
    assert.equal(presetCityIdForQuery('Saint John Danger Zone'), 'saintjohn');
    const result = await searchAndFlyTo(viewer, 'Saint John');
    assert.equal(result.label, 'Saint John Danger Zone');
    assert.equal(viewer.flights.length, 1, 'the preset flies without a geocoder');
    assert.equal(result.navigationMode, 'precise-place');
  });
});

test('a province-qualified gazetteer hit resolves locally even when a key is present', async () => {
  const viewer = stubViewer();
  const hadWindow = Object.hasOwn(globalThis, 'window');
  const priorWindow = globalThis.window;
  const priorFetch = globalThis.fetch;
  globalThis.window = { __GOOGLE_MAPS_API_KEY__: 'AIza-test' };
  let geocoded = 0;
  const placeSearch = { async geocode() { geocoded += 1; throw new Error('geocoder reached'); } };
  try {
    const result = await searchAndFlyTo(viewer, 'Windsor, ON', { placeSearch });
    assert.equal(result.label, 'Windsor, Ontario');
    assert.equal(geocoded, 0, 'a qualified name never needs the geocoder');
    // A bare, globally ambiguous name defers to the viewport-biased geocoder.
    await assert.rejects(() => searchAndFlyTo(viewer, 'Windsor', { placeSearch }), /geocoder reached/);
    assert.equal(geocoded, 1);
  } finally {
    globalThis.fetch = priorFetch;
    if (hadWindow) globalThis.window = priorWindow;
    else delete globalThis.window;
  }
});

test('a keyless search with no local answer falls through to the place search', async () => {
  await withKeylessWindow(async () => {
    const queries = [];
    const placeSearch = {
      async geocode(query) {
        queries.push(query);
        return { place: null, answered: true };
      },
    };
    // Bare "Windsor" resolves locally only without a key; an unknown name must
    // reach the composed service (keyless Photon) instead of throwing.
    const result = await searchAndFlyTo(stubViewer(), 'Nowhere Junction', { placeSearch });
    assert.deepEqual(queries, ['Nowhere Junction']);
    assert.equal(result, null);
  });
});

test('gazetteer flights honour the authority veto, explicit range, and close view', async () => {
  await withKeylessWindow(async () => {
    const vetoed = stubViewer();
    const veto = await searchAndFlyTo(vetoed, 'Halifax, NS', { beforeFly: () => false });
    assert.equal(veto, CANCELLED_SEARCH);
    assert.equal(vetoed.flights.length, 0, 'a vetoed gazetteer search starts no flight');

    const ranged = stubViewer();
    const explicit = await searchAndFlyTo(ranged, 'Halifax, NS', { range: 3000 });
    assert.equal(explicit.navigationMode, 'explicit-range');
    assert.equal(explicit.rangeM, 3000);

    const close = await searchAndFlyTo(stubViewer(), 'Halifax, NS', { forceClose: true });
    assert.equal(close.navigationMode, 'precise-place');
    assert.ok(close.rangeM < CITY_OVERVIEW_RANGE_M);
  });
});

test("St. John's resolves separately from Saint John", () => {
  assert.equal(findCanadianCity("St. John's").province, 'Newfoundland and Labrador');
  assert.equal(findCanadianCity('st johns nl').province, 'Newfoundland and Labrador');
  assert.equal(findCanadianCity('saint john nb').name, 'Saint John');
  assert.equal(findCanadianCity('toronto on canada').qualified, true);
  assert.equal(findCanadianCity('saskatoon').qualified, false);
});

// ---------------------------------------------------------------------------
// Ten largest Canadian metropolitan areas (2021 Census) in the location bar
// ---------------------------------------------------------------------------

const CANADA_TOP_TEN = [
  'toronto', 'montreal', 'vancouver', 'ottawa', 'calgary',
  'edmonton', 'quebec', 'winnipeg', 'hamilton', 'kitchener',
];

test('the location bar lists Saint John Danger Zone, the ten largest Canadian metros, Fort McMurray and Halifax, then the world', () => {
  const ids = Object.keys(CITY_POIS);
  assert.deepEqual(ids.slice(0, 13), ['saintjohn', ...CANADA_TOP_TEN, 'fortmcmurray', 'halifax']);
  for (const id of ['austin', 'sf', 'nyc', 'tokyo', 'london', 'paris', 'dubai', 'dc']) {
    assert.ok(ids.includes(id), `${id} is still listed`);
  }
});

test('every Canadian metro preset has five stops inside its bounds and near its city centre', () => {
  const centreName = {
    toronto: 'Toronto', montreal: 'Montreal', vancouver: 'Vancouver', ottawa: 'Ottawa', calgary: 'Calgary',
    edmonton: 'Edmonton', quebec: 'Quebec City', winnipeg: 'Winnipeg', hamilton: 'Hamilton', kitchener: 'Kitchener',
    fortmcmurray: 'Fort McMurray', halifax: 'Halifax',
  };
  for (const id of [...CANADA_TOP_TEN, 'fortmcmurray', 'halifax']) {
    const city = CITY_POIS[id];
    assert.equal(city.pois.length, 5, `${id} has five stops`);
    const { southwest: sw, northeast: ne } = city.viewBounds;
    const centre = CANADIAN_CITIES.find((entry) => entry.name === centreName[id]);
    for (const poi of city.pois) {
      assert.ok(
        poi.lat > sw.lat && poi.lat < ne.lat && poi.lon > sw.lng && poi.lon < ne.lng,
        `${poi.name} is inside ${city.name}`,
      );
      const km = Math.hypot(
        (poi.lat - centre.lat) * 111,
        (poi.lon - centre.lon) * 111 * Math.cos((centre.lat * Math.PI) / 180),
      );
      assert.ok(km < 25, `${poi.name} is ${km.toFixed(1)} km from ${centre.name}`);
    }
  }
});

test('closest city for crime search uses Saint John, not the Danger Zone label', () => {
  assert.equal(presetCitySearchName(CITY_POIS.saintjohn), 'Saint John');
  const saintJohn = closestCityForSearch(45.2733, -66.0633);
  assert.equal(saintJohn?.name, 'Saint John');
  assert.ok(saintJohn.distKm < 5);
  const austin = closestCityForSearch(30.2672, -97.7431);
  assert.equal(austin?.name, 'Austin');
  assert.equal(closestCityForSearch(0, 0), null);
});

test('Canadian metro names match camera spellings and search wording', () => {
  assert.equal(CITY_POIS.montreal.name, 'Montréal');
  assert.equal(CITY_POIS.quebec.name, 'Québec City');
  assert.equal(presetCityIdForQuery('Toronto'), 'toronto');
  assert.equal(presetCityIdForQuery('Montreal'), 'montreal');
  assert.equal(presetCityIdForQuery('Montréal'), 'montreal');
  assert.equal(presetCityIdForQuery('Quebec City'), 'quebec');
  assert.equal(presetCityIdForQuery('Ottawa'), 'ottawa');
  assert.equal(presetCityIdForQuery('Gatineau'), 'ottawa');
  assert.equal(presetCityIdForQuery('Waterloo'), 'kitchener');
  assert.equal(presetCityIdForQuery('Kitchener-Waterloo'), 'kitchener');
  assert.equal(presetCityIdForQuery('Vancouver BC'), 'vancouver');
  assert.equal(presetCityIdForQuery('Ft McMurray'), 'fortmcmurray');
  assert.equal(presetCityIdForQuery('Fort McMurray, AB'), 'fortmcmurray');
  assert.equal(presetCityIdForQuery('Halifax, NS'), 'halifax');
  // A bare metro name now names the preset; naming the province still reaches the gazetteer.
  assert.equal(findCanadianCity('Toronto'), null);
  assert.equal(findCanadianCity('Toronto, ON').name, 'Toronto');
});
