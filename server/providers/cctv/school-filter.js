// School cameras are never fetched or stored: no camera on a school,
// university, college or library, whether it comes from a directory listing,
// a provincial or state feed, or a city open-data list downloaded while the
// server runs. The crawler checks a listed link before requesting anything,
// the merge and the US builder refuse any entry that slipped into a pack, and
// the server drops them from live packs before they are cached or served.
//
// A road named after a school is not a school camera: "Highway 85 at
// University Avenue", "Aut. 410 at boul. Université", "Indian School Rd" and a
// bare cross street ("SR 9 at College", "I-17 S of Indian School") are traffic
// cameras and stay. A school named as the place ("DE 24 @ Beacon Middle
// School", "Pueblo Community College", "Main St at University of Toronto",
// "Campus / Main Gate") is a school camera, and so is one named by an
// abbreviation after its own name ("Spalding Dr at Norcross HS", "E DOVER
// ELEM", "Meadowcreek High Sch", "US69/287 @ Lumberton Middle"). A 511
// traffic system camera labelled by two crossing roads with no junction word
// ("Broadway University", "University Joyce-LL" in Boise) is an intersection
// camera and stays.

/** Cameras known to sit on a school, by pack id. */
export const SCHOOL_CAMERA_IDS = new Set([
  'nb-edmundston-umce', // Université de Moncton, Edmundston campus
]);

/** Hosts that belong to a school. */
const SCHOOL_HOSTS = [/(^|\.)usask\.ca$/i, /\.edu$/i, /(^|\.)umoncton\.ca$/i];

// Unicode-aware word edges: \b treats "É" and "é" as non-letters, so it would
// miss "École" and "Université".
const SCHOOL_WORDS =
  /(?<![\p{L}\p{N}_])(schools?|universit(?:y|ies|é)|colleges?|campus|librar(?:y|ies)|biblioth[eè]que|academy|polytechnic|c[ée]gep|[ée]cole|U of \p{Lu}\p{L}*|UMC[ES]|UdeM)(?![\p{L}\p{N}_])/iu;

const EDGE = '(?![\\p{L}\\p{N}_])';
// Street types that make the words before them a road name.
const ROAD_SUFFIX =
  '(?:avenue|ave\\.?|av\\.?|street|st\\.?|road|rd\\.?|drive|dr\\.?|boulevard|blvd\\.?|way|crescent|cres\\.?|' +
  'parkway|pkwy|highway|hwy|lane|ln|place|pl|court|ct|trail|trl|pike|freeway|fwy|expressway|expy|circle|cir|' +
  'loop|terrace|ter|route|rte|exit|interchange|square|sq|bridge|br)';

/** The school word is only the name of a road ("University Avenue", "High School Rd"). */
const ROAD_AFTER = new RegExp(`^\\s*${ROAD_SUFFIX}${EDGE}`, 'iu');
/** ...with one or two more name words before the street type ("College Park Dr", "School House Ln"). */
const NAMED_ROAD_AFTER = new RegExp(
  `^(?:\\s+(?!(?:at|and|of|near|by|to|from|in|on)${EDGE})[\\p{L}\\p{N}][\\p{L}\\p{N}.'’-]*){1,2}\\s+${ROAD_SUFFIX}${EDGE}`,
  'iu',
);
const ROAD_BEFORE =
  /\b(?:boul\.?|boulevard|rue|avenue|av\.?|chemin|ch\.?|route)\s*$/i;

/** A kind of school named as the place: "Beacon Middle School", "Community College", "Public Library". */
const SCHOOL_KIND =
  /(?<![\p{L}\p{N}_])(?:high|middle|elementary|elem\.?|junior|senior|primary|secondary|intermediate|grade|community|technical|public|charter|christian|catholic|preparatory|prep|montessori|nursery|metro|metropolitan)\s*$/iu;

// A cross street named by the school word: it follows a junction or offset
// ("at", "@", "&", "/", "and", "S of", "past", "SB", "I-5 : (113) Campus",
// "Yackley-College"), with an optional compass letter ("at N University").
const CROSS_CONNECTOR =
  '(?:[@&/:_-]|(?<![\\p{L}\\p{N}])(?:at|and|of|past|near|[NSEW]B))\\s*(?:\\([A-Z]*\\d+\\)\\s*)?(?:(?:[NSEW]|north|south|east|west)\\.?\\s+)?';
const CROSS_BEFORE = new RegExp(`${CROSS_CONNECTOR}$`, 'iu');
// Only "School" takes a name word in front and stays a road ("at Stearns
// School", "S of Indian School"): a college or university with a name in
// front of it is the institution ("at Holland College").
const CROSS_BEFORE_NAMED = new RegExp(
  `${CROSS_CONNECTOR}[\\p{L}][\\p{L}.'’]*\\s+$`,
  'iu',
);
const PAREN_COMPASS_BEFORE = /\(\s*(?:[NSEW]|north|south|east|west)\.?\s+$/iu;
/** "State College" is a town (Pennsylvania) and a boulevard (Anaheim). */
const STATE_BEFORE = /(?:^|[^\p{L}\s])\s*state\s+$/iu;
/** The school word starts a junction ("University at Cameron", "(University) at Lincoln", "College @ Martin Way"). */
const CROSS_AFTER =
  /^\)?\s*(?:[@&/]|[Aa][Tt]\s|AND\s|[Aa]nd\s)\s*(?=[\p{Lu}\p{N}])/u;
const LEAD_NAME = /^\s*[\p{L}][\p{L}.'’]*\s+$/u;
/** "University of Toronto", "College of the North Atlantic": the institution, whatever comes before it. */
const INSTITUTION_TAIL = /^\s+[Oo][Ff]\s+(?:[Tt][Hh][Ee]\s+)?\p{Lu}/u;
/** "Campus / Main Gate": a junction with a spot on the grounds, not with a road. */
const GROUNDS_TAIL = new RegExp(
  `^\\)?\\s*(?:[@&/]|at\\s|and\\s)\\s*(?:(?:main|north|south|east|west|front|back|rear|side|upper|lower)\\s+)?` +
    `(?:gates?|entrances?|entry|quad|residences?|dorms?|stadium)${EDGE}(?!\\s+${ROAD_SUFFIX}${EDGE})`,
  'iu',
);

// A school named by an abbreviation right after its own name ("Norcross HS",
// "Mill Creek Hs", "E DOVER ELEM", "Meadowcreek High Sch", "Lincoln Jr High").
// Case matters: the abbreviation and the name word before it are capitalised.
const SCHOOL_ABBREVIATION =
  /(?<=(?<![\p{L}\p{N}_])\p{Lu}[\p{L}'’.-]*\s+)(?:HS|Hs|ELEM|Elem|(?:HIGH|High|MIDDLE|Middle|PRMY|Prmy)\.?\s+(?:SCH|Sch)|(?:JR|Jr)\.?\s+(?:HIGH|High))\.?(?![\p{L}\p{N}_])/gu;
/** "US69/287 @ Lumberton Middle": one name word and "Middle" end the label after a junction. */
const TRAILING_MIDDLE =
  /(?:@\s*|(?<![\p{L}\p{N}_])(?:at|At|AT)\s+)(\p{Lu}[\p{L}'’.-]*)\s+(?:Middle|MIDDLE)\s*(?:\([^()]*\)\s*)?$/u;
/** Words that make "<word> Middle" a spot on a road or crossing ("@ Bridge Middle"). */
const NOT_A_SCHOOL_NAME =
  /^(?:the|north|south|east|west|upper|lower|center|centre|bridge|ferry|span|deck|tunnel|ramps?|lanes?|exit|mile|mm|mp|tower|toll|gate)$/i;

/** A 511 traffic system camera address (IBI's /map/Cctv/ still or page). */
const TRAFFIC_SYSTEM_URL = /^https?:\/\/[^/?#]+\/map\/Cctv\//i;
/** One road name in a crossing label: "Broadway", "Capitol", "Joyce-LL". */
const CROSSING_ROAD = /^\p{Lu}[\p{L}\p{N}.'’]*(?:-\p{Lu}{1,3})?$/u;

/** "Broadway University", "University Joyce-LL": two crossing roads and nothing else. */
function isCrossingLabel(word, before, after) {
  if (!/^(?:university|college)$/i.test(word)) return false;
  const rest = [before.trim(), after.trim()].filter(Boolean);
  if (rest.length !== 1) return false;
  const [road] = rest;
  return (
    CROSSING_ROAD.test(road) &&
    !SCHOOL_KIND.test(road) &&
    !/^(?:of|state)$/i.test(road)
  );
}

function isRoadName(word, before, after) {
  if (ROAD_AFTER.test(after)) return true;
  if (SCHOOL_KIND.test(before)) return false;
  if (INSTITUTION_TAIL.test(after) || GROUNDS_TAIL.test(after)) return false;
  if (NAMED_ROAD_AFTER.test(after)) return true;
  const school = /^schools?$/i.test(word);
  if (
    ROAD_BEFORE.test(before) ||
    CROSS_BEFORE.test(before) ||
    PAREN_COMPASS_BEFORE.test(before)
  )
    return true;
  if (school && CROSS_BEFORE_NAMED.test(before)) return true;
  if (/^colleges?$/i.test(word) && STATE_BEFORE.test(before)) return true;
  if (CROSS_AFTER.test(after)) {
    if (!before.trim()) return true;
    if (school && LEAD_NAME.test(before)) return true;
    if (after.startsWith(')') && /\(\s*$/.test(before)) return true;
  }
  return false;
}

function mentionsSchool(text, { trafficSystem = false } = {}) {
  const value = String(text || '');
  for (const match of value.matchAll(new RegExp(SCHOOL_WORDS.source, 'giu'))) {
    const before = value.slice(0, match.index);
    const after = value.slice(match.index + match[0].length);
    if (isRoadName(match[0], before, after)) continue;
    if (trafficSystem && isCrossingLabel(match[0], before, after)) continue;
    return true;
  }
  for (const match of value.matchAll(SCHOOL_ABBREVIATION)) {
    const after = value.slice(match.index + match[0].length);
    if (ROAD_AFTER.test(after) || NAMED_ROAD_AFTER.test(after)) continue;
    return true;
  }
  const middle = TRAILING_MIDDLE.exec(value);
  return Boolean(middle && !NOT_A_SCHOOL_NAME.test(middle[1]));
}

/** Text that places a camera on a school, not just on a road named after one. */
export function isSchoolText(text) {
  return mentionsSchool(text);
}

/** Any school word at all, road name or not; for build reports that list what was kept. */
export function hasSchoolWord(text) {
  return new RegExp(SCHOOL_WORDS.source, 'iu').test(String(text || ''));
}

function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

/** A listed link ({ text, url }) that must not even be requested. */
export function isSchoolLink(link) {
  const host = hostOf(link?.url);
  return (
    SCHOOL_HOSTS.some((pattern) => pattern.test(host)) ||
    mentionsSchool(link?.text, {
      trafficSystem: TRAFFIC_SYSTEM_URL.test(String(link?.url || '')),
    })
  );
}

/** A pack entry that must not be stored. */
export function isSchoolCamera(cam) {
  if (!cam) return false;
  if (SCHOOL_CAMERA_IDS.has(cam.id)) return true;
  const urls = [
    cam.url,
    cam.snapshotUrl,
    cam.pageUrl,
    cam.pageUrlListed,
  ].filter(Boolean);
  if (
    urls.some((url) =>
      SCHOOL_HOSTS.some((pattern) => pattern.test(hostOf(url))),
    )
  )
    return true;
  return mentionsSchool(cam.name, {
    trafficSystem: urls.some((url) => TRAFFIC_SYSTEM_URL.test(String(url))),
  });
}

/**
 * Drop school cameras from a list before it is cached or served.
 * @param {Array<object>} sources
 * @returns {{kept: Array<object>, removed: number}}
 */
export function withoutSchoolCameras(sources) {
  const kept = [];
  let removed = 0;
  for (const source of Array.isArray(sources) ? sources : []) {
    if (isSchoolCamera(source)) removed += 1;
    else kept.push(source);
  }
  return { kept, removed };
}
