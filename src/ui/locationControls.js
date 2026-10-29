import { locationMiniStatus } from '../locationStatus.js';
import { t } from '../i18n/index.js';
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

/** Location DOM, keyboard handling and pending row animation over supplied actions. */
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
      doc,
      requestFrame,
      cancelFrame,
    });
    this.removers = [];
    this.poiRemovers = [];
    this.extraRemovers = [];
    this.extraPills = [];
    this.shortcutRemovers = [];
    this.shortcutPills = [];
    this.firstCityPill = null;
    this.frame = null;
    this.destroyed = false;
    this.rowGeneration = 0;
    elements.pills.replaceChildren();
    for (const [id, city] of Object.entries(cities)) {
      const pill = doc.createElement('button');
      pill.type = 'button';
      pill.className = 'location-pill';
      pill.dataset.locationId = id;
      pill.textContent = localizePlaceName(city.name);
      this.bind(pill, 'click', () => onCity(id));
      elements.pills.appendChild(pill);
      this.firstCityPill ??= pill;
    }
    // The city row has no visible scrollbar and holds more cities than fit, so
    // a plain mouse wheel scrolls it sideways. Trackpads already scroll it.
    // The same holds for the landmark row of a city with many stops.
    for (const row of [elements.pills, elements.poiRow]) {
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
    this.bind(elements.searchToggle, 'click', () => {
      elements.search.classList.toggle('expanded');
      if (elements.search.classList.contains('expanded'))
        elements.search.focus();
    });
    this.bind(elements.search, 'keydown', (event) => {
      if (event.key === 'Enter') void onSearch(elements.search.value);
    });
    // Typing corrects a failed query; closing the field (which empties it) drops its error.
    this.bind(elements.search, 'input', () => onSearchEdit?.());
    this.bind(elements.search, 'blur', () => {
      if (!elements.search.value) onSearchEdit?.();
    });
    for (const button of elements.resetButtons)
      this.bind(button, 'click', onReset);
  }
  bind(element, event, handler, removers = this.removers) {
    if (!element) return;
    const listener = (...args) => {
      if (!this.destroyed) return handler(...args);
    };
    element.addEventListener(event, listener);
    removers.push(() => element.removeEventListener(event, listener));
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
    for (const remove of this.poiRemovers.splice(0)) remove();
    this.elements.poiRow.replaceChildren();
    city.pois.forEach((poi, index) => {
      const pill = this.doc.createElement('button');
      pill.type = 'button';
      pill.className = 'poi-pill';
      pill.dataset.poiIndex = index;
      const key = this.doc.createElement('span');
      key.className = 'poi-pill-key';
      key.textContent = POI_KEYS[index] || index + 1;
      const label = this.doc.createElement('span');
      label.className = 'poi-pill-name';
      label.textContent = poi.name;
      pill.append(key, label);
      this.bind(
        pill,
        'click',
        () => this.onPoi(cityId, index),
        this.poiRemovers,
      );
      this.elements.poiRow.appendChild(pill);
    });
    this.frame = this.requestFrame(() => {
      if (this.destroyed || generation !== this.rowGeneration) return;
      this.frame = null;
      this.elements.poiRow.classList.add('expanded');
      this.elements.divider.classList.add('visible');
    });
  }
  hidePois() {
    if (this.destroyed) return;
    this.cancelExpansion();
    this.elements.poiRow.classList.remove('expanded');
    this.elements.divider.classList.remove('visible');
  }
  /**
   * Extra location pills ahead of the preset cities (saved home and business
   * security sites). Replaces any shown before; a click calls onExtra(id).
   * @param {Array<{id: string, name: string, kind?: string, title?: string}>} entries
   */
  setExtraLocations(entries = []) {
    if (this.destroyed) return;
    for (const remove of this.extraRemovers.splice(0)) remove();
    for (const pill of this.extraPills.splice(0)) pill.remove();
    for (const entry of entries) {
      const pill = this.doc.createElement('button');
      pill.type = 'button';
      pill.className = 'location-pill location-pill-private';
      pill.dataset.locationId = entry.id;
      if (entry.kind) pill.dataset.siteKind = entry.kind;
      pill.textContent = entry.name;
      pill.title = entry.title || entry.name;
      this.bind(
        pill,
        'click',
        () => this.onExtra?.(entry.id),
        this.extraRemovers,
      );
      if (this.firstCityPill)
        this.elements.pills.insertBefore(pill, this.firstCityPill);
      else this.elements.pills.appendChild(pill);
      this.extraPills.push(pill);
    }
  }
  /**
   * Shortcut pills at the very front of the row: pinned landmarks plus the
   * last and second-last locations selected. A click calls onShortcut(entry).
   * @param {Array<{id: string, name: string, title?: string, role?: string, target: object}>} entries
   */
  setShortcutLocations(entries = []) {
    if (this.destroyed) return;
    for (const remove of this.shortcutRemovers.splice(0)) remove();
    for (const pill of this.shortcutPills.splice(0)) pill.remove();
    const before = this.elements.pills.firstChild || null;
    for (const entry of entries) {
      const pill = this.doc.createElement('button');
      pill.type = 'button';
      pill.className = 'location-pill location-pill-shortcut';
      pill.dataset.locationId = entry.id;
      if (entry.role) pill.dataset.shortcutRole = entry.role;
      pill.textContent = entry.name;
      pill.title = entry.title || entry.name;
      this.bind(
        pill,
        'click',
        () => this.onShortcut?.(entry),
        this.shortcutRemovers,
      );
      if (before) this.elements.pills.insertBefore(pill, before);
      else this.elements.pills.appendChild(pill);
      this.shortcutPills.push(pill);
    }
  }
  highlightPoi(index) {
    if (this.destroyed) return;
    for (const pill of this.elements.poiRow.querySelectorAll('.poi-pill'))
      pill.classList.toggle('active', Number(pill.dataset.poiIndex) === index);
  }
  highlightCity(id) {
    if (this.destroyed) return;
    for (const pill of this.elements.pills.querySelectorAll('.location-pill'))
      pill.classList.toggle('active', pill.dataset.locationId === id);
  }
  renderStatus(record) {
    if (this.destroyed || !this.elements.statusCity || !this.elements.statusPoi)
      return;
    // A preset city shows its name in the UI language; the record stays English.
    const state = record?.city?.name
      ? {
          ...record,
          city: { ...record.city, name: localizePlaceName(record.city.name) },
        }
      : record;
    const lines = locationMiniStatus(state);
    this.elements.statusCity.textContent =
      lines.city === LOCATION_MINI_EMPTY.city
        ? t('📍 Location: --')
        : lines.city;
    if (lines.poi === LOCATION_MINI_EMPTY.poi) {
      this.elements.statusPoi.textContent = t('Landmark: --');
    } else if (lines.poi === LOCATION_MINI_SEARCHED_PLACEHOLDER.poi) {
      this.elements.statusPoi.textContent = t('Searched location');
    } else {
      this.elements.statusPoi.textContent = lines.poi;
    }
  }
  createOrbitIndicator() {
    if (this.destroyed) return null;
    if (!this.orbitIndicator) {
      this.orbitIndicator = this.doc.createElement('div');
      this.orbitIndicator.id = 'orbit-indicator';
      const icon = this.doc.createElement('span');
      icon.className = 'orbit-icon';
      icon.textContent = '↻';
      this.orbitIndicator.append(icon, ` ${t('ORBIT')}`);
      this.doc.body.appendChild(this.orbitIndicator);
    }
    return this.orbitIndicator;
  }
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.cancelExpansion();
    for (const remove of [
      ...this.poiRemovers.splice(0),
      ...this.extraRemovers.splice(0),
      ...this.removers.splice(0),
    ])
      remove();
    this.orbitIndicator?.remove();
  }
}
