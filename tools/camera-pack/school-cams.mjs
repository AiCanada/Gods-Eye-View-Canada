// School cameras are never fetched or stored: no camera on a school,
// university, college or library, whether it comes from a directory listing
// or a provincial feed. The crawler checks a listed link before requesting
// anything, and the merge refuses any entry that slipped into a pack.
//
// A road named after a school is not a school camera: "Highway 85 at
// University Avenue" and "Aut. 410 at boul. Université" are traffic cameras
// and stay.

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

/** The school word is only the name of a road ("University Avenue"). */
const ROAD_AFTER =
  /^\s*(?:avenue|ave\.?|street|st\.?|road|rd\.?|drive|dr\.?|boulevard|blvd\.?|way|crescent|cres\.?|parkway|pkwy)\b/i;
const ROAD_BEFORE = /\b(?:boul\.?|boulevard|rue|avenue|av\.?|chemin|ch\.?|route)\s*$/i;

function mentionsSchool(text) {
  const value = String(text || '');
  for (const match of value.matchAll(new RegExp(SCHOOL_WORDS.source, 'giu'))) {
    const before = value.slice(0, match.index);
    const after = value.slice(match.index + match[0].length);
    if (ROAD_AFTER.test(after) || ROAD_BEFORE.test(before)) continue;
    return true;
  }
  return false;
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
  return SCHOOL_HOSTS.some((pattern) => pattern.test(host)) || mentionsSchool(link?.text);
}

/** A pack entry that must not be stored. */
export function isSchoolCamera(cam) {
  if (!cam) return false;
  if (SCHOOL_CAMERA_IDS.has(cam.id)) return true;
  const urls = [cam.url, cam.pageUrl, cam.pageUrlListed].filter(Boolean);
  if (urls.some((url) => SCHOOL_HOSTS.some((pattern) => pattern.test(hostOf(url))))) return true;
  return mentionsSchool(cam.name);
}
