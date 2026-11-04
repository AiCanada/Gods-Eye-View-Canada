import { locationMiniStatus } from '../locationStatus.js';
import { onLocaleChange, t } from '../i18n/index.js';
import { localizePlaceName } from './placeNames.js';

const POI_KEYS = ['Q', 'W', 'E', 'R', 'T'];

/**
 * locationStatus.js placeholder lines, built by the module itself; renderStatus
 * swaps them for translated text. Place names are shown as they are.
 */
const LOCATION_MINI_EMPTY = Object.freeze(locationMiniStatus());
const LOCATION_MINI_SEARCHED_PLACEHOLDER = Object.freeze(
  locationMiniStatus({ searchedLabel: '·' }),
);

/**
 * The location tray's presentation, keyboard handling and pending row
 * animation over supplied actions. The city pills, the landmark row, the
 * mini status, the search error and the ORBIT indicator are presented as a
 * plain view and handed to `publish`; Core's dock renders them and calls
 * `chooseCity()` and `choosePoi()`, and the scene chrome shows the indicator.
 * The globe actions and the cockpit call `reset()`. The search field's open
 * and searching state is presented too, and the dock's toggle calls
 * `toggleSearch()`; the field keeps its own key, input and blur listeners.
 */
export class LocationControls {
  constructor({
    elements,
    cities,
    getExpandedCity,
    onCity,
    onPoi,
    onSearch,
    onSearchEdit,
    onReset,
    onExtra = null,
    onShortcut = null,
    searchExpanded = false,
    publish = () => {},
    doc = document,
    requestFrame = (callback) => requestAnimationFrame(callback),
    cancelFrame = (id) => cancelAnimationFrame(id),
  }) {
    Object.assign(this, {
      elements,
      cities,
      getExpandedCity,
      onCity,
      onPoi,
      onSearch,
      onReset,
      onExtra,
      onShortcut,
      publish,
      doc,
      requestFrame,
      cancelFrame,
    });
    this.removers = [];
    this.frame = null;
    this.destroyed = false;
    // City names and the status lines are translated here; show them again
    // in a new locale.
    this.removers.push(
      onLocaleChange(() => {
        if (this._statusRecord !== undefined)
          this.renderStatus(this._statusRecord);
        else this.present();
      }),
    );
    this.rowGeneration = 0;
    this.activeCity = null;
    this.poiCity = null;
    this.activePoi = null;
    this.poisExpanded = false;
    this.status = {
      city: t('📍 Location: --'),
      poi: t('Landmark: --'),
    };
    this.searchError = null;
    // The search field: whether it is open, and whether a lookup runs.
    this.searchExpanded = Boolean(searchExpanded);
    this.searching = false;
    // The ORBIT indicator: null until the shell offers it, then whether the
    // camera orbits.
    this.orbit = null;
    // God's Eye View Canada: the saved home and business security sites
    // (ahead of the preset cities) and the shortcut pills at the very front
    // of the row: pinned landmarks, then the last and second-last places.
    this.extras = [];
    this.shortcuts = [];
    // The city row has no visible scrollbar and holds more cities than fit, so
    // a plain mouse wheel scrolls it sideways. Trackpads already scroll it.
    // The same holds for the landmark row of a city with many stops.
    for (const id of ['location-pills', 'poi-row']) {
      const row = doc?.getElementById?.(id);
      if (typeof row?.addEventListener !== 'function') continue;
      this.bind(row, 'wheel', (event) => {
        if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
        if (row.scrollWidth <= row.clientWidth) return;
        row.scrollLeft += event.deltaY;
        event.preventDefault();
      });
    }
    this.bind(doc, 'keydown', (event) => {
      const cityId = getExpandedCity();
      if (
        !cityId ||
        event.target?.matches?.('select, input, textarea') ||
        event.target === elements.search
      )
        return;
      const index = POI_KEYS.indexOf(event.key.toUpperCase());
      if (index !== -1 && index < (cities[cityId]?.pois.length || 0))
        onPoi(cityId, index);
    });
    this.bind(elements.search, 'keydown', (event) => {
      if (event.key === 'Enter') void onSearch(elements.search.value);
    });
    // Typing corrects a failed query; closing the field (which empties it) drops its error.
    this.bind(elements.search, 'input', () => onSearchEdit?.());
    this.bind(elements.search, 'blur', () => {
      if (!elements.search.value) onSearchEdit?.();
    });
    this.present();
  }
  bind(element, event, handler, removers = this.removers) {
    if (!element) return;
    const listener = (...args) => {
      if (!this.destroyed) return handler(...args);
    };
    element.addEventListener(event, listener);
    removers.push(() => element.removeEventListener(event, listener));
  }
  /** Publish the tray as it stands. */
  present() {
    if (!this.destroyed) this.publish(this.presentation());
  }
  /** The tray as it stands. */
  presentation() {
    const pois = this.cities[this.poiCity]?.pois || [];
    const pill = (entry) => ({
      id: entry.id,
      label: entry.name,
      title: entry.title || entry.name,
      active: entry.id === this.activeCity,
    });
    return {
      shortcuts: this.shortcuts.map((entry) => ({
        ...pill(entry),
        role: entry.role || null,
      })),
      extras: this.extras.map((entry) => ({
        ...pill(entry),
        kind: entry.kind || null,
      })),
      cities: Object.entries(this.cities).map(([id, city]) => ({
        id,
        label: localizePlaceName(city.name),
        active: id === this.activeCity,
      })),
      poiCity: this.poiCity,
      pois: pois.map((poi, index) => ({
        index,
        key: String(POI_KEYS[index] || index + 1),
        name: String(poi.name ?? ''),
        active: index === this.activePoi,
      })),
      poisExpanded: this.poisExpanded,
      status: { ...this.status },
      searchError: this.searchError,
      searchExpanded: this.searchExpanded,
      searching: this.searching,
      orbit: this.orbit && { ...this.orbit },
    };
  }
  /** A city pill was clicked. */
  chooseCity(id) {
    if (!this.destroyed) this.onCity(id);
  }
  /** A saved security site's pill was clicked. */
  chooseExtra(id) {
    if (!this.destroyed) this.onExtra?.(id);
  }
  /** A shortcut pill was clicked: its entry carries the target. */
  chooseShortcut(id) {
    if (this.destroyed) return;
    const entry = this.shortcuts.find((item) => item.id === id);
    if (entry) this.onShortcut?.(entry);
  }
  /**
   * Extra location pills ahead of the preset cities (saved home and business
   * security sites). Replaces any shown before; a click calls onExtra(id).
   * @param {Array<{id: string, name: string, kind?: string, title?: string}>} entries
   */
  setExtraLocations(entries = []) {
    if (this.destroyed) return;
    this.extras = Array.isArray(entries) ? [...entries] : [];
    this.present();
  }
  /**
   * Shortcut pills at the very front of the row: pinned landmarks plus the
   * last and second-last locations selected. A click calls onShortcut(entry).
   * @param {Array<{id: string, name: string, title?: string, role?: string, target: object}>} entries
   */
  setShortcutLocations(entries = []) {
    if (this.destroyed) return;
    this.shortcuts = Array.isArray(entries) ? [...entries] : [];
    this.present();
  }
  /** A reset to the full globe view was asked for. */
  reset() {
    if (!this.destroyed) return this.onReset();
  }
  /** A landmark pill of the shown city was clicked. */
  choosePoi(index) {
    if (!this.destroyed && this.poiCity !== null)
      this.onPoi(this.poiCity, index);
  }
  cancelExpansion() {
    this.rowGeneration++;
    if (this.frame !== null) this.cancelFrame(this.frame);
    this.frame = null;
  }
  showPois(cityId) {
    if (this.destroyed) return;
    const city = this.cities[cityId];
    if (!city) return;
    this.cancelExpansion();
    const generation = this.rowGeneration;
    this.poiCity = cityId;
    this.activePoi = null;
    this.present();
    // The row expands a frame after its pills render, so the transition runs.
    this.frame = this.requestFrame(() => {
      if (this.destroyed || generation !== this.rowGeneration) return;
      this.frame = null;
      this.poisExpanded = true;
      this.present();
    });
  }
  hidePois() {
    if (this.destroyed) return;
    this.cancelExpansion();
    this.poisExpanded = false;
    this.present();
  }
  highlightPoi(index) {
    if (this.destroyed) return;
    this.activePoi = index;
    this.present();
  }
  highlightCity(id) {
    if (this.destroyed) return;
    this.activeCity = id;
    this.present();
  }
  renderStatus(record) {
    if (this.destroyed) return;
    this._statusRecord = record;
    // A preset city shows its name in the UI language; the record stays English.
    const state = record?.city?.name
      ? {
          ...record,
          city: { ...record.city, name: localizePlaceName(record.city.name) },
        }
      : record;
    const lines = locationMiniStatus(state);
    this.status = {
      city:
        lines.city === LOCATION_MINI_EMPTY.city
          ? t('📍 Location: --')
          : lines.city,
      poi:
        lines.poi === LOCATION_MINI_EMPTY.poi
          ? t('Landmark: --')
          : lines.poi === LOCATION_MINI_SEARCHED_PLACEHOLDER.poi
            ? t('Searched location')
            : lines.poi,
    };
    this.present();
  }
  /** Show, or with null clear, the announced error under the search field. */
  setSearchError(message) {
    if (this.destroyed) return;
    this.searchError = message || null;
    this.present();
  }
  /** The search toggle was clicked: open the field and focus it, or close it. */
  toggleSearch() {
    if (this.destroyed) return;
    this.searchExpanded = !this.searchExpanded;
    this.present();
    if (this.searchExpanded) this.elements.search?.focus();
  }
  /** Mark the search field while a lookup runs. */
  setSearching(active) {
    if (this.destroyed) return;
    this.searching = Boolean(active);
    this.present();
  }
  /**
   * A lookup settled. One that found nothing keeps its query, the open field
   * and focus so it can be corrected; any other clears and closes the field.
   */
  settleSearch({ keepQuery = false } = {}) {
    if (this.destroyed) return;
    this.searching = false;
    if (!keepQuery) {
      this.closeSearch();
      return;
    }
    this.present();
    this.elements.search?.focus();
    this.elements.search?.select?.();
  }
  /** Close the search field and drop its query. */
  closeSearch() {
    if (this.destroyed) return;
    this.searchExpanded = false;
    this.present();
    const field = this.elements.search;
    if (field) field.value = '';
    field?.blur?.();
  }
  /** Offer the ORBIT indicator, lit while the camera orbits. */
  showOrbit(active = false) {
    if (this.destroyed) return;
    this.orbit = { active: Boolean(active) };
    this.present();
  }
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.cancelExpansion();
    for (const remove of this.removers.splice(0)) remove();
    // The ORBIT indicator leaves with its owner.
    if (this.orbit) {
      this.orbit = null;
      this.publish(this.presentation());
    }
  }
}
