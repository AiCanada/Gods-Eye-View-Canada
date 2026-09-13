// Curation for webcams scraped from directory pages (build-transcanada-links.mjs).
//
// A scraper that looks for "an image on the page" also finds share images,
// video posters, banners and article photos, and a directory often points
// several different cameras at the same page, so one picture ends up claimed
// by cameras hundreds of kilometres apart. This step keeps only entries that
// look like one live still at one place.

/** Address patterns of images that are not live camera stills. */
const NOT_A_LIVE_STILL = [
  [/\/_next\/image/i, 'website image resizer, not the camera'],
  [/og_image/i, 'page share image'],
  [/poster\.jpg/i, 'video poster frame'],
  [/wp-content\/uploads/i, 'article upload'],
  [/header|banner|live_webcams_\d{4}/i, 'site banner'],
  [/\/styles\/\d+\/public\//i, 'CMS image style'],
  [/CityPage\/images\//i, 'CMS page photo'],
  [/\bthumb_/i, 'thumbnail of another camera'],
];

/** Known stills whose name-based geocode lands in the wrong place. */
const PLACE_OVERRIDES = [
  [/ccimg\.bcferries\.com\/.*cam1_DUK\.jpg/i, { name: 'BC Ferries Duke Point Terminal', lat: 49.1627, lon: -123.8913 }],
];

/** Claimants of one image within this distance count as the same camera. */
const SAME_PLACE_KM = 2;

const km = (a, b) => {
  const r = Math.PI / 180;
  const dLat = (b.lat - a.lat) * r;
  const dLon = (b.lon - a.lon) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLon / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(h));
};

/** Drop cache-busting query parameters so one camera has one stable address. */
export function stableStillUrl(url) {
  try {
    const parsed = new URL(url);
    // A bare number or date after "?" (now.jpg?20260913) is a cache-buster.
    if (/^\?\d+$/.test(parsed.search)) parsed.search = '';
    for (const key of [...parsed.searchParams.keys()]) {
      if (/^(t|ts|time|timestamp|_|cb|rand)$/i.test(key)) parsed.searchParams.delete(key);
    }
    return parsed.toString().replace(/\?$/, '');
  } catch {
    return url;
  }
}

/**
 * @param {Array<object>} entries Scraped source-pack entries.
 * @returns {{kept: Array<object>, dropped: Array<{name: string, url: string, reason: string}>}}
 */
export function curateLinkCameras(entries) {
  const groups = new Map();
  for (const entry of entries) {
    const url = stableStillUrl(entry.url);
    if (!groups.has(url)) groups.set(url, []);
    groups.get(url).push({ ...entry, url });
  }

  const kept = [];
  const dropped = [];
  for (const [url, group] of groups) {
    const junk = NOT_A_LIVE_STILL.find(([pattern]) => pattern.test(url));
    if (junk) {
      for (const entry of group) dropped.push({ name: entry.name, url, reason: junk[1] });
      continue;
    }
    const first = group[0];
    const spread = Math.max(...group.map((entry) => km(first, entry)));
    if (spread > SAME_PLACE_KM) {
      for (const entry of group) dropped.push({ name: entry.name, url, reason: `one image claimed by cameras ${Math.round(spread)} km apart` });
      continue;
    }
    const override = PLACE_OVERRIDES.find(([pattern]) => pattern.test(url))?.[1];
    kept.push(override ? { ...first, ...override, coordConfidence: 'curated' } : first);
    for (const entry of group.slice(1)) dropped.push({ name: entry.name, url, reason: `same camera as "${first.name}"` });
  }
  return { kept, dropped };
}
