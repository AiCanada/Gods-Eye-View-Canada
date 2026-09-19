/**
 * Shortcut pills at the front of the LOCATION row: one fixed landmark the
 * operator asked to keep one click away, plus the last and second-last
 * locations selected, so hopping between two places never needs a scroll.
 */

const STORAGE_KEY = 'gev.locations.recent';
/** Current selection plus the two before it. */
const HISTORY_MAX = 3;
/** Landmarks that always get their own pill: matched against POI names. */
const PINNED_LANDMARKS = Object.freeze([/^rapid falls\b/i]);

/** Stable identity of one selection. */
export function selectionKey(selection) {
  if (!selection) return '';
  return selection.type === 'site'
    ? `site:${selection.siteId}`
    : `poi:${selection.cityId}:${selection.poiIndex}`;
}

/**
 * Put a selection at the head of the history, without duplicates.
 * @param {Array<object>} history Most recent first.
 * @param {{type: 'poi', cityId: string, poiIndex: number, name: string}|{type: 'site', siteId: string, name: string}} selection
 * @returns {Array<object>} New history.
 */
export function recordLocationSelection(history, selection) {
  const key = selectionKey(selection);
  if (!key) return Array.isArray(history) ? history : [];
  const rest = (Array.isArray(history) ? history : []).filter(
    (entry) => selectionKey(entry) !== key,
  );
  return [selection, ...rest].slice(0, HISTORY_MAX);
}

/** A stored selection is only usable while the place it names still exists. */
function selectionResolves(selection, cities, siteIds) {
  if (selection?.type === 'site') return siteIds.has(selection.siteId);
  return Boolean(cities?.[selection?.cityId]?.pois?.[selection?.poiIndex]);
}

/**
 * The shortcut pills to show, in order: pinned landmarks, LAST, 2ND LAST.
 * History entry 0 is where the operator already is, so LAST is entry 1.
 * @param {{cities: object, history: Array<object>, siteIds?: Set<string>}} input
 * @returns {Array<{id: string, name: string, title: string, role: string, target: object}>}
 */
export function buildLocationShortcuts({
  cities,
  history,
  siteIds = new Set(),
}) {
  const shortcuts = [];
  for (const [cityId, city] of Object.entries(cities || {})) {
    (city.pois || []).forEach((poi, poiIndex) => {
      if (!PINNED_LANDMARKS.some((pattern) => pattern.test(poi.name))) return;
      shortcuts.push({
        id: `shortcut:poi:${cityId}:${poiIndex}`,
        name: poi.name,
        title: `${poi.name} · ${city.name}`,
        role: 'pinned',
        target: { type: 'poi', cityId, poiIndex, name: poi.name },
      });
    });
  }
  const pinnedKeys = new Set(
    shortcuts.map((entry) => selectionKey(entry.target)),
  );
  const previous = (Array.isArray(history) ? history : [])
    .slice(1)
    .filter((entry) => selectionResolves(entry, cities, siteIds));
  const roles = [
    ['last', 'LAST'],
    ['second-last', '2ND LAST'],
  ];
  previous.slice(0, roles.length).forEach((entry, index) => {
    // A pinned landmark already has its pill; do not show it twice.
    if (pinnedKeys.has(selectionKey(entry))) return;
    const [role, label] = roles[index];
    shortcuts.push({
      id: `shortcut:${role}`,
      name: `${label} · ${entry.name}`,
      title: `${label === 'LAST' ? 'Last' : 'Second-last'} location selected: ${entry.name}`,
      role,
      target: entry,
    });
  });
  return shortcuts;
}

/** Read the stored history; any storage problem just means no history. */
export function loadLocationHistory(storage = globalThis.localStorage) {
  try {
    const parsed = JSON.parse(storage?.getItem(STORAGE_KEY) || '[]');
    return Array.isArray(parsed)
      ? parsed.filter((entry) => selectionKey(entry)).slice(0, HISTORY_MAX)
      : [];
  } catch {
    return [];
  }
}

export function saveLocationHistory(
  history,
  storage = globalThis.localStorage,
) {
  try {
    storage?.setItem(
      STORAGE_KEY,
      JSON.stringify((history || []).slice(0, HISTORY_MAX)),
    );
  } catch {
    // Private mode or a full store: the pills still work for this session.
  }
}
