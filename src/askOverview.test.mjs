import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RISK_NEWS_LOOKBACK_DAYS,
  RISK_NEWS_RADIUS_KM,
  activityLevelForCount,
  buildLayerActivity,
  buildOverviewQuestion,
  buildOverviewRiskBrief,
  buildRiskAssessmentQuestion,
  classifyOverviewRegion,
  crimeSearchCityName,
  formatAskLogEntry,
  formatRiskSearchBody,
  overviewLocationName,
  overviewRiskSources,
  prependOutputLog,
  resolveOverviewCountry,
} from './askOverview.js';

test('place labels and country codes classify Canada, the US, and everywhere else', () => {
  assert.equal(classifyOverviewRegion({ countryCode: 'CA' }), 'canada');
  assert.equal(classifyOverviewRegion({ countryCode: 'US' }), 'usa');
  assert.equal(
    classifyOverviewRegion({ placeLabels: ['Toronto', 'Ontario', 'Canada'] }),
    'canada',
  );
  assert.equal(
    classifyOverviewRegion({ placeLabels: ['Austin, Texas, United States'] }),
    'usa',
  );
  assert.equal(
    classifyOverviewRegion({ placeLabels: ['Tokyo, Japan'] }),
    'international',
  );
});

test('Toronto is in Canada: the geocoder decides the country, then the Canadian gazetteer, never a latitude band', () => {
  const toronto = { latitude: 43.6532, longitude: -79.3832 };
  assert.equal(
    classifyOverviewRegion({ selectedLocation: 'Toronto', ...toronto }),
    'usa',
    'the latitude bands alone read southern Ontario as the United States',
  );

  const geocoded = resolveOverviewCountry({
    place: { countryCode: 'ca', country: 'Canada' },
    closestCity: { name: 'Toronto', source: 'preset' },
  });
  assert.deepEqual(geocoded, { countryCode: 'CA', country: 'Canada' });
  const brief = buildOverviewRiskBrief({
    ...geocoded,
    selectedLocation: 'Toronto',
    closestCity: 'Toronto',
    view: toronto,
  });
  assert.equal(brief.region, 'canada');
  assert.equal(brief.countryCode, 'CA');
  assert.ok(brief.officialSources.some((source) => /statcan/.test(source.url)));

  assert.deepEqual(
    resolveOverviewCountry({
      place: null,
      closestCity: { name: 'Hamilton', source: 'gazetteer' },
    }),
    { countryCode: 'CA', country: 'Canada' },
    'no geocoder answer: a nearest city from the Canadian gazetteer says Canada',
  );
  assert.deepEqual(
    resolveOverviewCountry({
      place: { countryCode: 'US', country: 'United States' },
      closestCity: { name: 'Windsor', source: 'gazetteer' },
    }),
    { countryCode: 'US', country: 'United States' },
    'Detroit, 3 km from Windsor: the geocoder wins over the gazetteer',
  );
  assert.deepEqual(
    resolveOverviewCountry({ place: { countryCode: 'FR', country: '' } }),
    { countryCode: 'FR', country: null },
  );
  assert.equal(
    resolveOverviewCountry({
      place: { countryCode: '' },
      closestCity: { name: 'Austin', source: 'preset' },
    }),
    null,
  );
  assert.equal(resolveOverviewCountry(), null);
});

test('coordinates fall back when labels are missing', () => {
  assert.equal(
    classifyOverviewRegion({ latitude: 45.27, longitude: -66.06 }),
    'canada',
  );
  assert.equal(
    classifyOverviewRegion({ latitude: 30.27, longitude: -97.74 }),
    'usa',
  );
  assert.equal(
    classifyOverviewRegion({ latitude: 35.68, longitude: 139.76 }),
    'international',
  );
  assert.equal(
    classifyOverviewRegion({ latitude: 21.31, longitude: -157.86 }),
    'usa',
  );
});

test('crime search uses the closest city, not a POI or Danger Zone label', () => {
  assert.equal(
    crimeSearchCityName({
      closestCity: 'Saint John',
      selectedLocation: 'Saint John City Market DZ, Saint John Danger Zone',
    }),
    'Saint John',
  );
  assert.equal(
    crimeSearchCityName({
      selectedLocation: 'Texas State Capitol, Austin',
    }),
    'Austin',
  );
  assert.equal(
    crimeSearchCityName({ selectedLocation: '📍 Saint John Danger Zone' }),
    'Saint John',
  );
});

test('the selected location name prefers the LOCATION panel over anonymous coordinates', () => {
  assert.equal(
    overviewLocationName({
      selectedLocation: '📍 Toronto',
      placeLabels: ['Ontario'],
      latitude: 43.65,
      longitude: -79.38,
    }),
    'Toronto',
  );
  assert.equal(
    overviewLocationName({
      selectedLocation: '📍 Location: --',
      placeLabels: [],
    }),
    'the current view',
  );
  assert.match(
    overviewLocationName({ latitude: 43.6532, longitude: -79.3832 }),
    /43\.6532, -79\.3832/,
  );
});

test('each region lists the official sources Overview must review', () => {
  assert.deepEqual(
    overviewRiskSources('canada').map((source) => source.url),
    [
      'https://canadacrimereport.com/crime-severity-index',
      'https://www150.statcan.gc.ca/t1/tbl1/en/tv.action?pid=3510017701',
      'https://www.aljazeera.com/',
    ],
  );
  assert.ok(
    overviewRiskSources('usa').some((source) =>
      source.url.includes('usa.gov/crime-statistics'),
    ),
  );
  assert.deepEqual(
    overviewRiskSources('international').map((source) => source.url),
    ['https://www.aljazeera.com/'],
  );
});

test('on-screen counts classify as none, low, mid, or high', () => {
  assert.equal(activityLevelForCount(0, 'traffic'), 'none');
  assert.equal(activityLevelForCount(5, 'traffic'), 'low');
  assert.equal(activityLevelForCount(20, 'traffic'), 'mid');
  assert.equal(activityLevelForCount(80, 'traffic'), 'high');
  const activity = buildLayerActivity([
    { id: 'traffic', name: 'Traffic', count: 90, enabled: true },
    { id: 'flights', name: 'Flights', count: 2, enabled: true },
    { id: 'cctv', name: 'CCTV', count: 0, enabled: false },
  ]);
  assert.equal(activity.overall, 'high');
  assert.equal(activity.layers.length, 2);
  assert.equal(activity.layers[0].level, 'high');
  assert.equal(activity.layers[1].level, 'low');
});

test('the Overview question rates activity low/mid/high and how it changes risk', () => {
  const brief = buildOverviewRiskBrief({
    selectedLocation: 'Saint John Danger Zone',
    placeLabels: ['Saint John', 'New Brunswick', 'Canada'],
    view: { latitude: 45.2733, longitude: -66.0633 },
  });
  assert.equal(brief.region, 'canada');
  const question = buildOverviewQuestion(brief);
  assert.match(question, /Saint John Danger Zone/);
  assert.match(question, /Canada/);
  assert.match(question, /displayed on screen/i);
  assert.match(question, /low, mid, or high/);
  assert.match(question, /accident risk/);
  assert.match(question, /layerActivity/);
  assert.doesNotMatch(question, /canadacrimereport/);
  assert.match(question, /Risk Assessment button/);
});

test('the Risk Assessment question ties on-screen activity to region sources when they correlate', () => {
  const brief = buildOverviewRiskBrief({
    selectedLocation: 'Saint John Danger Zone',
    placeLabels: ['Saint John', 'New Brunswick', 'Canada'],
    view: { latitude: 45.2733, longitude: -66.0633 },
  });
  assert.equal(brief.newsRadiusKm, RISK_NEWS_RADIUS_KM);
  assert.equal(brief.newsLookbackDays, RISK_NEWS_LOOKBACK_DAYS);
  assert.match(brief.newsQuery, /Saint John/);
  assert.doesNotMatch(brief.newsQuery, /Danger Zone/);
  assert.equal(brief.searchCity, 'Saint John');
  assert.match(
    brief.newsQuery,
    /danger OR crime OR violence OR protest OR unrest/,
  );

  const question = buildRiskAssessmentQuestion(brief);
  assert.match(question, /Saint John/);
  assert.match(question, /Crime-search city: Saint John/);
  assert.match(question, /35-10-0177-01/);
  assert.match(question, /Geography/);
  assert.match(question, /Violations/);
  assert.match(question, /Overview is not required first/);
  assert.match(question, /crime-stat outliers/);
  assert.match(question, /govCrimeHeadlines/);
  assert.match(question, /correlation is high/);
  assert.match(question, /canadacrimereport.com\/crime-severity-index/);
  assert.match(question, /3510017701/);
  assert.match(question, /aljazeera.com/);
  assert.match(question, /100 km/);
  assert.match(question, /30 days/);
  assert.match(question, /localHeadlines/);
  assert.match(question, /no government crime-stat outlier was supplied/);
});

test('a US risk question does not receive Canadian crime-index URLs', () => {
  const question = buildRiskAssessmentQuestion(
    buildOverviewRiskBrief({
      selectedLocation: 'Austin',
      placeLabels: ['Austin', 'Texas', 'United States'],
      view: { latitude: 30.2672, longitude: -97.7431 },
    }),
  );
  assert.match(question, /usa.gov\/crime-statistics/);
  assert.doesNotMatch(question, /canadacrimereport/);
  assert.doesNotMatch(question, /statcan/);
});

test('risk search results list government and local hits or say none were found', () => {
  const found = formatRiskSearchBody({
    govCrimeHeadlines: [
      { title: 'CSI up in Saint John', domain: 'statcan.gc.ca' },
    ],
    localHeadlines: [{ title: 'Protest downtown', domain: 'cbc.ca' }],
  });
  assert.match(found, /Government crime-stat hits \(1\)/);
  assert.match(found, /CSI up in Saint John \(statcan\.gc\.ca\)/);
  assert.match(found, /Local headlines \(1\)/);
  assert.match(found, /Protest downtown \(cbc\.ca\)/);
  const empty = formatRiskSearchBody({});
  assert.match(empty, /No government crime-stat hits/);
  assert.match(empty, /No recent local headlines/);
});

test('new output is prepended so the running log keeps earlier answers', () => {
  assert.equal(prependOutputLog('', 'newest'), 'newest');
  assert.equal(prependOutputLog('older', 'newest'), 'newest\n\nolder');
  assert.match(
    formatAskLogEntry('RISK SEARCH', 'hits', {
      locationName: 'Saint John',
      at: '2026-09-16T12:04:00Z',
    }),
    /RISK SEARCH · Saint John/,
  );
});
