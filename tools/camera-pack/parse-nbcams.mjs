// Parse the nbcams.ca directory page into God's Eye View CCTV source-pack entries.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isSchoolCamera } from './school-cams.mjs';

const SOURCES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'sources');
const src = (name) => path.join(SOURCES, name);

const html = fs.readFileSync(process.argv[2] || src('nbcams.html'), 'utf8');

// Each camera lives in its own <table class="nothing"> ... </table> block.
const blocks = html.split(/<table class="nothing"/i).slice(1);

const decode = (s) =>
  String(s || '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&copy;/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();

const slug = (s) =>
  decode(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);

const cams = [];
const seen = new Set();

for (const block of blocks) {
  // Feed image: the first absolute-URL <img> that is not a site chrome icon.
  const imgs = [...block.matchAll(/<img[^>]+src="([^"]+)"[^>]*>/gi)].map((m) => m[1]);
  const feed = imgs.find((u) => /^https?:\/\//i.test(u) && !/nbcams\.ca\/(images|icons)\//i.test(u));
  if (!feed) continue;

  // Name: prefer the visible caption, fall back to the image alt text.
  const nameMatch = block.match(/class="cameraLocation"[^>]*>([^<]+)</i);
  const altMatch = block.match(/alt="Web Cam image of ([^"]+)"/i);
  const name = decode(nameMatch?.[1] || altMatch?.[1] || '');
  if (!name) continue;

  // Exact camera position from the "Google Maps" pin link.
  const posMatch = block.match(/maps\?q=(-?\d+\.\d+),(-?\d+\.\d+)/i);
  // Street View link additionally encodes field of view, heading and tilt:
  //   @lat,lon,3a,<fov>y,<heading>h,<tilt>t
  const svMatch = block.match(
    /maps\/@(-?\d+\.\d+),(-?\d+\.\d+),3a,([\d.]+)y,([\d.]+)h,([\d.]+)t/i
  );

  const lat = Number(posMatch?.[1] ?? svMatch?.[1]);
  const lon = Number(posMatch?.[2] ?? svMatch?.[2]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;

  const fovDeg = svMatch ? Number(svMatch[3]) : 70;
  const headingDeg = svMatch ? Number(svMatch[4]) : 0;
  // Street View tilt: 90 = horizon, >90 looks down. The pack wants negative = down.
  // These tilts are hand-set approximations on the directory site and a fair
  // number point above the horizon, which would aim the projected frustum at
  // the sky. Keep only the downward ones; otherwise use a gentle default.
  const rawPitch = svMatch ? 90 - Number(svMatch[5]) : NaN;
  const pitchDeg = Number.isFinite(rawPitch) && rawPitch < 0
    ? Number(Math.max(rawPitch, -25).toFixed(2))
    : -5;

  const creditMatch = block.match(/class="copyCamera"[^>]*>(.*?)<\/span>/is);
  const credit = decode(creditMatch?.[1]?.replace(/<[^>]+>/g, ' ') || '');

  let id = `nb-${slug(name)}`;
  let n = 2;
  while (seen.has(id)) id = `nb-${slug(name)}-${n++}`;
  seen.add(id);

  // Drop the cache-busting TIME parameter; the proxy refreshes on its own cadence.
  const url = feed.replace(/[?&]TIME=\d+/i, '');

  const isTraffic = /511\.gnb\.ca/i.test(url);

  // School cameras are never stored (school-cams.mjs).
  if (isSchoolCamera({ id, name, url })) continue;

  cams.push({
    id,
    name,
    city: 'New Brunswick',
    cityId: 'nb',
    provider: isTraffic ? 'NB 511 (GNB)' : 'nbcams.ca directory',
    sourceKind: 'configured',
    poseSource: svMatch ? 'curated' : undefined,
    feedType: 'image',
    url,
    lat,
    lon,
    headingDeg,
    headingConfidence: svMatch ? 'curated' : 'unknown',
    pitchDeg,
    fovDeg,
    rangeM: 450,
    mountHeightM: 9,
    groundElevationM: 10,
    license: credit || 'Public web camera listed on nbcams.ca',
  });
}

const withPose = cams.filter((c) => c.headingConfidence === 'curated').length;
process.stderr.write(
  `parsed ${cams.length} cameras (${withPose} with Street View heading)\n`
);
fs.writeFileSync(process.argv[3] || src('nbcams.json'), JSON.stringify(cams, null, 2));
