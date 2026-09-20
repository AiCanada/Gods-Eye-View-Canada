import { readResponseJsonCapped } from '../common/http.js';

const STATCAN_PRODUCT_ID = 35100177;
const STATCAN_TABLE_URL =
  'https://www150.statcan.gc.ca/t1/tbl1/en/tv.action?pid=3510017701';
const STATCAN_TABLE_LABEL = 'Statistics Canada table 35-10-0177-01';
const WDS_BASE = 'https://www150.statcan.gc.ca/t1/wds/rest';
const METADATA_TTL_MS = 24 * 60 * 60 * 1000;
const METADATA_MAX_BYTES = 2 * 1024 * 1024;
const RATE_HIGH_VS_CANADA = 1.5;
const RATE_LOW_VS_CANADA = 1 / 1.5;
const PCT_CHANGE_OUTLIER = 15;

const FOCUS_VIOLATIONS = Object.freeze([
  'Total, all violations',
  'Total, all Criminal Code violations (excluding traffic)',
  'Total violent Criminal Code violations',
  'Homicide',
  'Total property crime violations',
  'Total theft of motor vehicle',
  'Total robbery',
  'Total impaired driving',
  'Total drug violations',
  // Wider scan so a city with several unusual rates can surface up to
  // STATCAN_MAX_OUTLIERS of them; names the table does not carry are skipped.
  'Attempted murder',
  'Total sexual violations against children',
  'Sexual assault, level 1',
  'Total assaults (levels 1 to 3)',
  'Total firearms, use of, discharge, pointing',
  'Total breaking and entering',
  'Total theft under $5,000 (non-motor vehicle)',
  'Total fraud',
  'Total mischief',
  'Total weapons violations',
  'Total Criminal Code traffic violations',
  'Uttering threats',
  'Criminal harassment',
]);

/** Most outliers one risk assessment is given; fewer is fine. */
const STATCAN_MAX_OUTLIERS = 10;

let metadataCache = { at: 0, value: null };

function normalizeGeoName(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/\bst\.?\s+/g, 'saint ')
    .replace(/['’]/g, '')
    .replace(/[–—]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

function startsWithCity(memberNorm, cityNorm) {
  if (!cityNorm || !memberNorm) return false;
  if (memberNorm === cityNorm) return true;
  if (!memberNorm.startsWith(cityNorm)) return false;
  const next = memberNorm.charAt(cityNorm.length);
  return (
    next === '' ||
    next === ',' ||
    next === ' ' ||
    next === '[' ||
    next === '(' ||
    next === '-'
  );
}

/**
 * Pick the Geography member for a city on table 35-10-0177-01.
 * Prefers a CMA match; does not treat St. John's as Saint John.
 * @param {Array<{memberId: number, memberNameEn: string, geoLevel?: number}>} members
 * @param {string} city
 */
function matchStatCanGeography(members, city) {
  const needle = normalizeGeoName(city).replace(/\s*danger zone$/, '');
  if (!needle || !Array.isArray(members)) return null;
  const hits = members.filter((member) =>
    startsWithCity(normalizeGeoName(member?.memberNameEn), needle),
  );
  if (!hits.length) return null;
  hits.sort((a, b) => {
    const level = (member) => Number(member.geoLevel);
    const aCma = level(a) === 35 ? 0 : 1;
    const bCma = level(b) === 35 ? 0 : 1;
    if (aCma !== bCma) return aCma - bCma;
    return String(a.memberNameEn).length - String(b.memberNameEn).length;
  });
  return hits[0];
}

function cubeCoordinate(geoId, violationId, statisticId) {
  return [geoId, violationId, statisticId, 0, 0, 0, 0, 0, 0, 0].join('.');
}

function latestPoint(points) {
  if (!Array.isArray(points) || !points.length) return null;
  return points[points.length - 1];
}

function yearOf(point) {
  const raw = String(point?.refPer || '').slice(0, 4);
  return /^\d{4}$/.test(raw) ? raw : null;
}

function formatRate(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return n >= 100 ? n.toFixed(0) : n.toFixed(1);
}

function findMemberByName(members, name) {
  const needle = String(name || '').toLowerCase();
  return (members || []).find(
    (member) => String(member?.memberNameEn || '').toLowerCase() === needle,
  );
}

function slimDimension(dimension) {
  return {
    id: dimension.dimensionPositionId,
    name: dimension.dimensionNameEn,
    members: (dimension.member || []).map((member) => ({
      memberId: member.memberId,
      memberNameEn: member.memberNameEn,
      parentMemberId: member.parentMemberId ?? null,
      geoLevel: member.geoLevel ?? null,
    })),
  };
}

/**
 * The table's own notes, English only: what each total includes and leaves
 * out, which series cannot be compared across years, which numbers were
 * corrected after publication. The ground-truth checks read these; a note is
 * linked to one member of one dimension (or to the whole table).
 */
function slimFootnotes(cube) {
  return (Array.isArray(cube?.footnote) ? cube.footnote : [])
    .map((note) => ({
      id: note?.footnoteId ?? null,
      text: String(note?.footnotesEn || '').trim(),
      dimension: note?.link?.dimensionPositionId ?? null,
      memberId: note?.link?.memberId ?? null,
    }))
    .filter((note) => note.text);
}

function slimCorrections(cube) {
  return (Array.isArray(cube?.correction) ? cube.correction : [])
    .map((entry) => ({
      date: String(entry?.correctionDate || '').slice(0, 10) || null,
      note: String(entry?.correctionNoteEn || '')
        .replace(/<[^>]*>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/\s+/g, ' ')
        .trim(),
    }))
    .filter((entry) => entry.note);
}

async function postWds(path, body, timeoutMs = 15000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${WDS_BASE}/${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'User-Agent': 'GodsEyeView/0.1',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok)
      throw new Error(`StatCan WDS returned ${response.status}`);
    return await readResponseJsonCapped(response, METADATA_MAX_BYTES);
  } finally {
    clearTimeout(timeout);
  }
}

async function loadTableMetadata() {
  const now = Date.now();
  if (metadataCache.value && now - metadataCache.at < METADATA_TTL_MS) {
    return metadataCache.value;
  }
  const payload = await postWds(
    'getCubeMetadata',
    [{ productId: STATCAN_PRODUCT_ID }],
    20000,
  );
  const cube = Array.isArray(payload) ? payload[0]?.object : payload?.object;
  const dimensions = Array.isArray(cube?.dimension) ? cube.dimension : [];
  const geography = slimDimension(
    dimensions.find((dimension) =>
      /^geography$/i.test(dimension.dimensionNameEn),
    ) || { member: [] },
  );
  const violations = slimDimension(
    dimensions.find((dimension) =>
      /^violations$/i.test(dimension.dimensionNameEn),
    ) || { member: [] },
  );
  const statistics = slimDimension(
    dimensions.find((dimension) =>
      /^statistics$/i.test(dimension.dimensionNameEn),
    ) || { member: [] },
  );
  const value = {
    geography,
    violations,
    statistics,
    footnotes: slimFootnotes(cube),
    corrections: slimCorrections(cube),
    startYear: String(cube?.cubeStartDate || '').slice(0, 4) || null,
    endYear: String(cube?.cubeEndDate || '').slice(0, 4) || null,
  };
  metadataCache = { at: now, value };
  return value;
}

/**
 * Turn WDS rows into outlier headlines for the selected city versus Canada.
 * @param {object[]} rows
 * @param {{
 *   cityMember: {memberId: number, memberNameEn: string},
 *   canadaMember: {memberId: number, memberNameEn: string},
 *   violationById: Map<number, string>,
 *   rateStatId: number,
 *   pctStatId: number,
 * }} options
 */
function classifyStatCanOutliers(rows, options) {
  const { cityMember, canadaMember, violationById, rateStatId, pctStatId } =
    options;
  const latest = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (row?.status && row.status !== 'SUCCESS') continue;
    const object = row?.object || row;
    const coordinate = String(object?.coordinate || '');
    const [geo, violation, statistic] = coordinate.split('.').map(Number);
    const point = latestPoint(object?.vectorDataPoint);
    if (!Number.isFinite(geo) || !point) continue;
    latest.set(`${geo}.${violation}.${statistic}`, point);
  }

  const outliers = [];
  const seen = new Set();
  for (const [key, point] of latest) {
    const [geo, violation, statistic] = key.split('.').map(Number);
    if (geo !== cityMember.memberId || statistic !== pctStatId) continue;
    const name = violationById.get(violation);
    if (!name || seen.has(violation)) continue;
    const cityRate = latest.get(
      `${cityMember.memberId}.${violation}.${rateStatId}`,
    );
    const canadaRate = latest.get(
      `${canadaMember.memberId}.${violation}.${rateStatId}`,
    );
    const pct = Number(point.value);
    const cityValue = Number(cityRate?.value);
    const canadaValue = Number(canadaRate?.value);
    const flags = [];
    // How far past its threshold the strongest signal is; ranks the list.
    let score = 0;
    if (Number.isFinite(pct) && Math.abs(pct) >= PCT_CHANGE_OUTLIER) {
      score = Math.max(score, Math.abs(pct) / PCT_CHANGE_OUTLIER);
      flags.push(
        `${pct > 0 ? 'up' : 'down'} ${Math.abs(pct).toFixed(1)}% year over year`,
      );
    }
    if (
      Number.isFinite(cityValue) &&
      Number.isFinite(canadaValue) &&
      canadaValue > 0
    ) {
      const ratio = cityValue / canadaValue;
      if (ratio >= RATE_HIGH_VS_CANADA)
        score = Math.max(score, ratio / RATE_HIGH_VS_CANADA);
      else if (ratio > 0 && ratio <= RATE_LOW_VS_CANADA)
        score = Math.max(score, RATE_LOW_VS_CANADA / ratio);
      if (ratio >= RATE_HIGH_VS_CANADA) {
        flags.push(`${ratio.toFixed(1)} times the Canada rate`);
      } else if (ratio <= RATE_LOW_VS_CANADA) {
        flags.push(`${ratio.toFixed(1)} times the Canada rate (below it)`);
      }
    }
    if (!flags.length) continue;
    seen.add(violation);
    const year = yearOf(cityRate || point);
    const cityRateText = formatRate(cityValue);
    const canadaRateText = formatRate(canadaValue);
    const bits = [
      `${name}: ${cityRateText ?? 'n/a'} per 100,000${year ? ` in ${year}` : ''}`,
    ];
    if (canadaRateText) bits.push(`Canada ${canadaRateText}`);
    bits.push(flags.join('; '));
    outliers.push({
      title: `${cityMember.memberNameEn} · ${bits.join(' · ')}`,
      url: STATCAN_TABLE_URL,
      domain: 'statcan.gc.ca',
      publishedAt: cityRate?.refPer
        ? `${String(cityRate.refPer).slice(0, 10)}T00:00:00.000Z`
        : null,
      sourceCountry: 'Canada',
      score,
    });
  }
  return outliers;
}

function emptyResult(query, status = 'empty') {
  return {
    status,
    query: query || null,
    articles: [],
    source: STATCAN_TABLE_LABEL,
  };
}

async function fetchStatCanCrimeOutliers(city) {
  const place = String(city || '').trim();
  if (!place) return emptyResult(null);
  let metadata;
  try {
    metadata = await loadTableMetadata();
  } catch {
    return emptyResult(place, 'unavailable');
  }
  const cityMember = matchStatCanGeography(metadata.geography.members, place);
  const canadaMember = findMemberByName(metadata.geography.members, 'Canada');
  const rateStat = findMemberByName(
    metadata.statistics.members,
    'Rate per 100,000 population',
  );
  const pctStat = findMemberByName(
    metadata.statistics.members,
    'Percentage change in rate',
  );
  if (!cityMember || !canadaMember || !rateStat || !pctStat) {
    return emptyResult(place);
  }

  const focus = FOCUS_VIOLATIONS.map((name) =>
    findMemberByName(metadata.violations.members, name),
  ).filter(Boolean);
  if (!focus.length) return emptyResult(place);

  const body = [];
  for (const geo of [cityMember, canadaMember]) {
    for (const violation of focus) {
      for (const statistic of [rateStat, pctStat]) {
        body.push({
          productId: STATCAN_PRODUCT_ID,
          coordinate: cubeCoordinate(
            geo.memberId,
            violation.memberId,
            statistic.memberId,
          ),
          latestN: 2,
        });
      }
    }
  }

  let rows;
  try {
    rows = await postWds(
      'getDataFromCubePidCoordAndLatestNPeriods',
      body,
      20000,
    );
  } catch {
    return emptyResult(place, 'unavailable');
  }

  const violationById = new Map(
    focus.map((member) => [member.memberId, member.memberNameEn]),
  );
  const outliers = classifyStatCanOutliers(rows, {
    cityMember,
    canadaMember,
    violationById,
    rateStatId: rateStat.memberId,
    pctStatId: pctStat.memberId,
  });
  if (outliers.length) {
    return {
      status: 'ready',
      query: `${place} Geography + Violations on ${STATCAN_TABLE_LABEL}`,
      // Strongest first, at most ten; a city with fewer simply returns fewer.
      articles: [...outliers]
        .sort((a, b) => b.score - a.score)
        .slice(0, STATCAN_MAX_OUTLIERS)
        .map(({ score: _score, ...article }) => article),
      source: STATCAN_TABLE_LABEL,
    };
  }
  return {
    status: 'empty',
    query: `${place} Geography + Violations on ${STATCAN_TABLE_LABEL}`,
    articles: [
      {
        title: `${cityMember.memberNameEn} is in ${STATCAN_TABLE_LABEL}; no rate outlier versus Canada on the scanned violations.`,
        url: STATCAN_TABLE_URL,
        domain: 'statcan.gc.ca',
        publishedAt: null,
        sourceCountry: 'Canada',
      },
    ],
    source: STATCAN_TABLE_LABEL,
  };
}

export {
  STATCAN_PRODUCT_ID,
  STATCAN_TABLE_LABEL,
  STATCAN_TABLE_URL,
  cubeCoordinate,
  findMemberByName,
  loadTableMetadata,
  postWds,
  slimCorrections,
  slimFootnotes,
  classifyStatCanOutliers,
  STATCAN_MAX_OUTLIERS,
  fetchStatCanCrimeOutliers,
  matchStatCanGeography,
  normalizeGeoName,
};
