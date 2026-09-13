// Turn the individual webcams linked from transcanadahighway.com into
// source-pack entries.
//
// Page: https://transcanadahighway.com/traveltips/trans-canada-webcams-and-photos/
// saved as sources/transcanada-webcams.html (raw download, not committed).
//
// The provincial 511 systems that page links to are already in
// cams-transcanada.json. What remains are ~140 hand-picked city, tourism and
// news webcams, listed by name under regional headings with no coordinates and
// mostly as web pages rather than images. For each link this script:
//   1. fetches the page (politely: one request at a time, an honest identity);
//   2. looks for a live still: the link itself if it is an image, else the
//      page's og:image, else an <img> whose address looks like a webcam frame;
//   3. keeps it only if it really is a recent JPEG/PNG of reasonable size, at a
//      stable address (no capture timestamp baked into the path);
//   4. places it by geocoding "<link text>, <region>" with Photon.
// Anything that fails a step is reported with the reason and left out.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { curateLinkCameras } from './curate-link-cameras.mjs';
import { isSchoolCamera, isSchoolLink } from './school-cams.mjs';

const SOURCES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'sources');
const src = (name) => path.join(SOURCES, name);

const USER_AGENT = 'gods-eye-view-camera-pack/1.0 (one-off webcam directory build)';
const PAGE_TIMEOUT_MS = 20000;
const PAUSE_MS = 700;
const MAX_PAGE_BYTES = 3 * 1024 * 1024;
const MIN_IMAGE_BYTES = 8000;
/** A newly found still older than this is not proof of a live camera: static
 * banners, share images and article photos look exactly like frozen webcams.
 * A camera must show a fresh frame once to get in; after that it is carried
 * over build to build and never removed for being offline (see below). */
const MAX_IMAGE_AGE_DAYS = 14;

// Region headings on the page -> a geocoding hint and the pack's cityId.
const REGIONS = [
  [/victoria|vancouver|whistler|fraser|okanagan|british columbia/i, 'British Columbia', 'bc'],
  [/banff|rockies|calgary|edmonton|alberta/i, 'Alberta', 'ab'],
  [/saskatoon|regina|saskatchewan/i, 'Saskatchewan', 'sk'],
  [/manitoba|winnipeg/i, 'Manitoba', 'mb'],
  [/ontario|toronto|ottawa/i, 'Ontario', 'on'],
  [/quebec|montreal/i, 'Quebec', 'qc'],
  [/new brunswick/i, 'New Brunswick', 'nb'],
  [/nova scotia|cape breton|halifax/i, 'Nova Scotia', 'ns'],
  [/prince edward/i, 'Prince Edward Island', 'pe'],
  [/newfoundland|labrador/i, 'Newfoundland and Labrador', 'nl'],
  [/yukon/i, 'Yukon', 'yt'],
  [/northwest territories|nunavut/i, 'Northwest Territories', 'nt'],
];

// Links that are directories, ski-resort portals or other systems handled
// elsewhere (the provincial 511 feeds are in cams-transcanada.json).
const SKIP_HOSTS = [
  'drivebc.ca', 'images.drivebc.ca', 'th.gov.bc.ca', '511.alberta.ca', 'hotline.gov.sk.ca',
  'manitoba511.ca', 'quebec511.info', 'roads.gov.nl.ca', '511nl.ca', '511yukon.ca',
  'webcam.erdc.dren.mil', 'mackinacbridge.org', 'explore.org', 'onthesnow.ca',
];

const decode = (s) =>
  String(s || '')
    .replace(/<[^>]+>/g, '')
    .replace(/&#8211;|&ndash;/g, '-')
    .replace(/&#8217;|&rsquo;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const slug = (s) =>
  String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Every external link on the page, with the regional heading above it. */
function linksFromPage(html) {
  const tokens = [
    ...html.matchAll(
      /<(h[1-6]|strong)\b[^>]*>([\s\S]*?)<\/\1>|<a\b[^>]*href=["'](https?:\/\/[^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi,
    ),
  ];
  const links = [];
  const seen = new Set();
  let section = '';
  for (const token of tokens) {
    if (token[1]) {
      const heading = decode(token[2]);
      if (heading && heading.length < 70) section = heading;
      continue;
    }
    const url = token[3];
    const text = decode(token[4]);
    if (!text || seen.has(url)) continue;
    if (/transcanadahighway\.com|facebook|twitter|instagram|pinterest|youtube|linkedin|foundlocally|movingincanada|wordpress|google|wp\.me/i.test(url)) continue;
    seen.add(url);
    links.push({ section, text, url });
  }
  return links;
}

async function fetchWithTimeout(url, options = {}) {
  return fetch(url, {
    redirect: 'follow',
    ...options,
    headers: { 'User-Agent': USER_AGENT, ...(options.headers || {}) },
    signal: AbortSignal.timeout(PAGE_TIMEOUT_MS),
  });
}

/** Is this address a recent, real still image? Returns { ok, reason, lastModified }. */
async function checkImage(url) {
  if (/\/\d{4}\/\d{2}\/\d{2}\/.*\/\d{2}-\d{2}\.(jpg|jpeg|png)$/i.test(url)) {
    return { ok: false, reason: 'address embeds a capture timestamp' };
  }
  let response;
  try {
    response = await fetchWithTimeout(url);
  } catch (error) {
    return { ok: false, reason: `image unreachable (${error.name})` };
  }
  const type = response.headers.get('content-type') || '';
  if (!response.ok) return { ok: false, reason: `image HTTP ${response.status}` };
  if (!/^image\/(jpeg|jpg|png)/i.test(type)) return { ok: false, reason: `not a still image (${type || 'no type'})` };
  const bytes = (await response.arrayBuffer()).byteLength;
  if (bytes < MIN_IMAGE_BYTES) return { ok: false, reason: `image too small (${bytes} B)` };
  const modified = Date.parse(response.headers.get('last-modified') || '');
  if (Number.isFinite(modified) && Date.now() - modified > MAX_IMAGE_AGE_DAYS * 86400000) {
    return { ok: false, reason: `still not updated since ${new Date(modified).toISOString().slice(0, 10)}` };
  }
  return { ok: true, lastModified: Number.isFinite(modified) ? new Date(modified).toISOString() : null };
}

/** Candidate still addresses on a page, best first. */
function stillCandidates(html, pageUrl) {
  const absolute = (value) => {
    try {
      return new URL(value.replace(/&amp;/g, '&'), pageUrl).toString();
    } catch {
      return '';
    }
  };
  const found = [];
  const og =
    html.match(/<meta[^>]+property=["']og:image["'][^>]*content=["']([^"']+)["']/i) ||
    html.match(/<meta[^>]+content=["']([^"']+)["'][^>]*property=["']og:image["']/i);
  if (og) found.push(absolute(og[1]));
  for (const match of html.matchAll(/<img\b[^>]*src=["']([^"']+)["']/gi)) {
    if (/webcam|cam\d|camera|snapshot|current|live|latest|image\.jpg|\.jpg\?/i.test(match[1])) found.push(absolute(match[1]));
  }
  return [...new Set(found.filter((u) => /^https?:\/\//.test(u) && !/logo|icon|sprite|banner|avatar|placeholder/i.test(u)))].slice(0, 4);
}

async function geocode(query) {
  const url = `https://photon.komoot.io/api/?limit=1&q=${encodeURIComponent(query)}`;
  try {
    const response = await fetchWithTimeout(url);
    const feature = (await response.json()).features?.[0];
    if (!feature) return null;
    const [lon, lat] = feature.geometry.coordinates;
    return { lat, lon, label: feature.properties?.name || '' };
  } catch {
    return null;
  }
}

const html = fs.readFileSync(src('transcanada-webcams.html'), 'utf8');
const links = linksFromPage(html);
const out = [];
const report = [];
const reasons = {};
const note = (link, reason) => {
  reasons[reason.replace(/\(.*\)/, '').trim()] = (reasons[reason.replace(/\(.*\)/, '').trim()] || 0) + 1;
  report.push(`skip  ${link.section.slice(0, 22).padEnd(22)} ${link.text.slice(0, 40).padEnd(40)} ${reason}`);
};

for (const link of links) {
  // School cameras are never requested, stored or named in the report.
  if (isSchoolLink(link)) { reasons['school camera, not requested'] = (reasons['school camera, not requested'] || 0) + 1; continue; }
  const host = new URL(link.url).hostname.replace(/^www\./, '');
  if (SKIP_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))) { note(link, 'provincial system or portal handled elsewhere'); continue; }
  const region = REGIONS.find(([pattern]) => pattern.test(link.section));
  if (!region) { note(link, `no region for heading "${link.section}"`); continue; }

  let still = null;
  let lastReason = 'no still image found on the page';
  if (/\.(jpe?g|png)(\?|$)/i.test(link.url)) {
    const check = await checkImage(link.url);
    if (check.ok) still = { url: link.url, ...check };
    else lastReason = check.reason;
  } else {
    let page;
    try {
      page = await fetchWithTimeout(link.url);
    } catch (error) {
      note(link, `page unreachable (${error.name})`);
      await sleep(PAUSE_MS);
      continue;
    }
    const type = page.headers.get('content-type') || '';
    if (!page.ok) { note(link, `page HTTP ${page.status}`); await sleep(PAUSE_MS); continue; }
    if (/^image\//i.test(type)) {
      const check = await checkImage(page.url);
      if (check.ok) still = { url: page.url, ...check };
      else lastReason = check.reason;
    } else {
      const text = (await page.text()).slice(0, MAX_PAGE_BYTES);
      for (const candidate of stillCandidates(text, page.url)) {
        await sleep(PAUSE_MS);
        const check = await checkImage(candidate);
        if (check.ok) { still = { url: candidate, ...check }; break; }
        lastReason = check.reason;
      }
    }
  }
  if (!still) { note(link, lastReason); await sleep(PAUSE_MS); continue; }

  await sleep(PAUSE_MS);
  const place = await geocode(`${link.text}, ${region[1]}, Canada`) || await geocode(`${link.section.replace(/webcams?/i, '')}, ${region[1]}, Canada`);
  if (!place) { note(link, 'could not be placed on the map'); continue; }

  out.push({
    id: `tch-link-${slug(host)}-${slug(link.text)}`,
    name: link.text,
    city: link.section.replace(/\s*webcams?\s*$/i, '').trim() || region[1],
    cityId: region[2],
    provider: host,
    sourceKind: 'configured',
    feedType: 'image',
    url: still.url,
    pageUrlListed: link.url,
    lat: place.lat,
    lon: place.lon,
    headingDeg: null,
    headingConfidence: 'unknown',
    pitchDeg: -8,
    fovDeg: 70,
    rangeM: 600,
    mountHeightM: 10,
    groundElevationM: 10,
    license: `Camera operated by ${host}; listed by transcanadahighway.com`,
    coordConfidence: 'estimated',
    country: 'CA',
  });
  report.push(`keep  ${link.section.slice(0, 22).padEnd(22)} ${link.text.slice(0, 40).padEnd(40)} ${still.url.slice(0, 70)} (${place.lat.toFixed(3)},${place.lon.toFixed(3)} ~ ${place.label})`);
  await sleep(PAUSE_MS);
}

// Share images, banners and one picture claimed by several cameras are not
// live stills; curation drops them before anything reaches the pack.
// A camera an earlier build kept is never removed for being offline: if this
// run could not reach it, or its frame has gone stale, it is carried over, as
// it is most likely back within the minute or the day. The proxy backs off
// from a failing still and shows the placeholder card meanwhile.
const previous = fs.existsSync(src('cams-transcanada-links.json'))
  ? JSON.parse(fs.readFileSync(src('cams-transcanada-links.json'), 'utf8'))
  : [];
const produced = new Set(out.map((cam) => cam.id));
const carried = previous.filter((cam) => !produced.has(cam.id) && !isSchoolCamera(cam));
for (const cam of carried) report.push(`carry ${cam.name.slice(0, 40).padEnd(40)} kept from the previous build; not reached this run`);

const { kept, dropped } = curateLinkCameras([...out, ...carried]);
for (const item of dropped) report.push(`curate ${item.name.slice(0, 40).padEnd(40)} ${item.reason}`);

fs.writeFileSync(src('cams-transcanada-links.json'), JSON.stringify(kept, null, 2));
fs.writeFileSync(src('cams-transcanada-links.report.txt'), report.join('\n') + '\n');
process.stderr.write(`trans-canada links: ${links.length} listed, ${out.length} with a still, ${carried.length} carried over, ${kept.length} kept after curation\n`);
process.stderr.write(`skip reasons: ${JSON.stringify(reasons)}\n`);
