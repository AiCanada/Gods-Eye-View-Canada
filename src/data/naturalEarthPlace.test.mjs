import assert from 'node:assert/strict';
import test from 'node:test';
import {
  NEAREST_CITY_MAX_KM,
  REGION_GROUP_COUNTRIES,
  TERRITORIAL_SEA_KM,
  createNaturalEarthIndexLoader,
  createNaturalEarthPlaces,
} from './naturalEarthPlace.js';
import { CLOSEST_CITY_MAX_KM } from '../locations.js';

const loadIndex = createNaturalEarthIndexLoader();
const places = createNaturalEarthPlaces({ loadIndex });
const naturalEarthRegionAt = (latitude, longitude) =>
  places.regionAt(latitude, longitude);
const naturalEarthCityAt = (latitude, longitude) =>
  places.cityAt(latitude, longitude);
const keyAt = async (latitude, longitude) =>
  (await naturalEarthRegionAt(latitude, longitude))?.key ?? null;

// First, so the packs load under it: nothing is fetched, ever.
test('lookups never fetch, and a point off the globe has no answer', async (t) => {
  t.mock.method(globalThis, 'fetch', () => {
    throw new Error('an offline lookup must not fetch');
  });
  assert.equal(await keyAt(43.6511, -79.3832), 'CA-ON');
  assert.equal(
    (await naturalEarthCityAt(43.6511, -79.3832))?.locality,
    'Toronto',
  );
  for (const [latitude, longitude] of [
    [Number.NaN, 0],
    [91, 0],
    [0, 181],
    [Infinity, 0],
  ]) {
    assert.equal(await naturalEarthRegionAt(latitude, longitude), null);
    assert.equal(await naturalEarthCityAt(latitude, longitude), null);
  }
});

test('lookups over one index loader share one load of the packs', async () => {
  const index = await loadIndex();
  assert.equal(await loadIndex(), index, 'the loaded index is kept');
  assert.ok(index.admin1.length > 4587, 'every polygon of every unit');
  assert.equal(index.places.length, 7342);
  const other = createNaturalEarthPlaces({ loadIndex });
  assert.deepEqual(
    await other.regionAt(45.5017, -73.5673),
    await places.regionAt(45.5017, -73.5673),
  );
  assert.equal(await loadIndex(), index);
});

test('a point names its province or state and its country, with their ISO codes', async () => {
  assert.deepEqual(await naturalEarthRegionAt(43.6511, -79.3832), {
    key: 'CA-ON',
    region: 'Ontario',
    regionCode: 'CA-ON',
    country: 'Canada',
    countryCode: 'CA',
  });
  assert.deepEqual(await naturalEarthRegionAt(30.2672, -97.7431), {
    key: 'US-TX',
    region: 'Texas',
    regionCode: 'US-TX',
    country: 'United States of America',
    countryCode: 'US',
  });
  for (const [latitude, longitude, key] of [
    [45.5017, -73.5673, 'CA-QC'], // Montréal
    [44.6488, -63.5752, 'CA-NS'], // Halifax
    [63.7467, -68.517, 'CA-NU'], // Iqaluit
    [21.3, -157.87, 'US-HI'], // Honolulu
    [30.0444, 31.2357, 'EG-C'], // Cairo
  ])
    assert.equal(
      await keyAt(latitude, longitude),
      key,
      `${latitude},${longitude}`,
    );
});

test('a river border splits the cities on its banks', async () => {
  assert.equal(await keyAt(42.3149, -83.0364), 'CA-ON'); // Windsor
  assert.equal(await keyAt(42.3314, -83.0458), 'US-MI'); // Detroit
  assert.equal(await keyAt(45.4215, -75.6972), 'CA-ON'); // Ottawa
  assert.equal(await keyAt(45.4765, -75.7013), 'CA-QC'); // Gatineau
});

test('a harbour, a bay or a lake belongs to its shore; past 12 nautical miles at sea, nowhere', async () => {
  assert.equal(TERRITORIAL_SEA_KM, 22.224);
  assert.equal(await keyAt(49.285, -123.165), 'CA-BC'); // English Bay, Vancouver
  assert.equal(await keyAt(44.63, -63.55), 'CA-NS'); // Halifax Harbour
  assert.equal(await keyAt(43.45, -77.9), 'US-NY'); // Lake Ontario, either side
  assert.equal(await keyAt(43.8, -77.9), 'CA-ON'); // of the border line
  for (const [latitude, longitude] of [
    [44.3, -63.2], // 40 km off Nova Scotia
    [40.1, -50.2],
    [-60.1234, -30.5678],
    [0, 0],
  ])
    assert.equal(
      await naturalEarthRegionAt(latitude, longitude),
      null,
      `${latitude},${longitude}`,
    );
});

test('across the antimeridian: Chukotka east of 180° and Fiji', async () => {
  assert.equal(await keyAt(66.16, -169.81), 'RU-CHU'); // Uelen
  assert.equal(await keyAt(-16.85, -179.95), 'FJ-N'); // Taveuni
});

test('where the units are boroughs, counties or departments, a region is the group above them', async () => {
  // Three of London's 33 boroughs: one region, so moving around London never switches.
  for (const [latitude, longitude] of [
    [51.5007, -0.1246], // Westminster
    [51.5055, -0.0754], // Tower Bridge
    [51.539, -0.1426], // Camden
  ])
    assert.equal(await keyAt(latitude, longitude), 'GB:London');
  assert.equal(await keyAt(55.9533, -3.1883), 'GB:Scotland'); // Edinburgh
  assert.equal(await keyAt(48.8566, 2.3522), 'FR:Île-de-France'); // Paris
  assert.equal(await keyAt(48.8918, 2.2361), 'FR:Île-de-France'); // La Défense
  assert.equal(await keyAt(41.9028, 12.4964), 'IT:Lazio'); // Rome
  assert.equal(await keyAt(53.3498, -6.2603), 'IE:Dublin');
  assert.equal(await keyAt(53.2944, -6.1339), 'IE:Dublin'); // Dún Laoghaire
  const paris = await naturalEarthRegionAt(48.8566, 2.3522);
  assert.deepEqual(
    [paris.region, paris.regionCode, paris.country, paris.countryCode],
    ['Île-de-France', null, 'France', 'FR'],
  );
  // Canada's and the United States' units are already provinces and states.
  assert.equal(REGION_GROUP_COUNTRIES.has('CA'), false);
  assert.equal(REGION_GROUP_COUNTRIES.has('US'), false);
});

test('nearest city: the nearest populated place in reach of the page gazetteer, with its own region', async () => {
  assert.equal(NEAREST_CITY_MAX_KM, CLOSEST_CITY_MAX_KM);
  const toronto = await naturalEarthCityAt(43.6511, -79.3832);
  assert.deepEqual(
    [toronto.locality, toronto.region, toronto.country, toronto.countryCode],
    ['Toronto', 'Ontario', 'Canada', 'CA'],
  );
  assert.ok(toronto.distanceKm < 10);
  const saintJohn = await naturalEarthCityAt(45.2733, -66.0633);
  assert.deepEqual(
    [saintJohn.locality, saintJohn.region],
    ['Saint John', 'New Brunswick'],
  );
  // The city's own region, not the point's: Gatineau's nearest is Ottawa, Ontario.
  const gatineau = await naturalEarthCityAt(45.4765, -75.7013);
  assert.deepEqual([gatineau.locality, gatineau.region], ['Ottawa', 'Ontario']);
  // The nearest city, across a border too: Fort Erie's is Buffalo, 8 km away.
  const fortErie = await naturalEarthCityAt(42.9017, -78.9722);
  assert.deepEqual(
    [fortErie.locality, fortErie.region],
    ['Buffalo', 'New York'],
  );
  const london = await naturalEarthCityAt(51.5007, -0.1246);
  assert.deepEqual([london.locality, london.region], ['London', 'London']);
  // At sea in reach of a city, that city; 150 km from every city, none.
  assert.equal((await naturalEarthCityAt(44.3, -63.2))?.locality, 'Halifax');
  assert.equal(await naturalEarthCityAt(53.5, -73.0), null); // inland Québec
  assert.equal(await naturalEarthCityAt(40.1, -50.2), null); // mid-Atlantic
});
