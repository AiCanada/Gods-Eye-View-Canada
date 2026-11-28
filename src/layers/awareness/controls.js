import { AWARENESS_RADIUS_M } from '../../data/militaryAwarenessEngine.js';
import { toLonLatH } from '../../geo/ellipsoid.js';

const COHORT_FIELDS = Object.freeze({
  flights: 'flightsCount',
  military: 'militaryAircraftCount',
  'ais-live-vessels': 'vesselsCount',
  'military-installations': 'installationsCount',
});

export function createControls({ state: layerState, services, parts, source }) {
  const flightsLayer = services.flights;
  const militaryFlightsLayer = services.military;
  const aisLiveVesselsLayer = services.vessels;

  const methods = {
    id: 'military-awareness',

    name: 'Global Context',

    icon: '◎',

    source: 'Open-source proximity context',

    // Context is entered from its dedicated right rail, not as a raw layer.
    showInTogglePanel: false,

    updateInterval: 0,

    statsRefreshInterval: 1000,

    attachDataManager(dataManager) {
      layerState.dataManager = dataManager;
      parts.dependencies.watchAdoptions(dataManager);
    },

    setParams(params = {}) {
      if (typeof params.passive !== 'boolean') return;
      const wasPassive = layerState.passive;
      layerState.passive = params.passive;
      if (layerState.passive) services.installations?.setContextAnchor?.(null);
      if (layerState.enabled && wasPassive && !layerState.passive)
        parts.dependencies.activateOperationalContext();
    },

    /** @returns {{ passive: boolean }} Current runtime parameters. */
    getParams() {
      return { passive: layerState.passive };
    },

    getStats() {
      const subject = layerState.subject;
      return {
        recordsRevision: subject
          ? [
              subject.layerId,
              subject.id,
              subject.label,
              layerState.subjectMissing === true,
              subject.position?.x,
              subject.position?.y,
              subject.position?.z,
            ].join('|')
          : '',
        count: layerState.results ? 1 : 0,
        lastUpdate: layerState.results?.evaluatedAt || null,
        stale: false,
        error: null,
        status: layerState.enabled ? 'ready' : 'idle',
      };
    },

    /**
     * The contact Contacts is centred on, as one plain record for the analyst
     * and the Context panel, with how many items each cohort counts within
     * the awareness radius. The cohorts' own items stay with their layers
     * (flights, military, vessels, installations), so they are not repeated
     * here. Empty while off, passive or with no contact chosen.
     * @param {number} [maxCount]
     * @returns {Array<object>}
     */
    getAnalystRecords(maxCount = Infinity) {
      if (
        !layerState.enabled ||
        layerState.passive ||
        !layerState.subject ||
        !(maxCount >= 1)
      )
        return [];
      const subject = layerState.subject;
      const at = subject.position ? toLonLatH(subject.position) : null;
      if (!at || !Number.isFinite(at.lat) || !Number.isFinite(at.lon))
        return [];
      const results = layerState.results;
      const contacts = {};
      let installationsCoverage;
      for (const cohort of results?.cohorts || []) {
        if (
          !Object.hasOwn(COHORT_FIELDS, cohort?.id) ||
          !Number.isFinite(cohort.summary?.count)
        )
          continue;
        contacts[COHORT_FIELDS[cohort.id]] = cohort.summary.count;
        if (cohort.id === 'military-installations')
          installationsCoverage = cohort.coverage ?? null;
      }
      return [
        {
          id: `${subject.layerId}:${subject.id}`,
          name: subject.label || null,
          subjectLayer: subject.layerId || null,
          lat: at.lat,
          lon: at.lon,
          radiusKm: (results?.radiusM ?? AWARENESS_RADIUS_M) / 1000,
          ...contacts,
          ...(installationsCoverage !== undefined && { installationsCoverage }),
          lost: layerState.subjectMissing === true,
          evaluatedAtMs: results?.evaluatedAt ?? null,
        },
      ];
    },

    /** Return the latest read-only context result for compact HUD consumers. */
    getContextSnapshot() {
      if (!layerState.enabled || !layerState.subject) return null;
      if (!layerState.results) {
        return parts.model.buildAwarenessContextSnapshot(
          {
            subject: { ...layerState.subject },
            evaluatedAt: null,
            radiusM: AWARENESS_RADIUS_M,
            cohorts: [],
          },
          parts.model.navigationState(),
          {
            subjectPresent: !layerState.subjectMissing,
          },
        );
      }
      return parts.model.buildAwarenessContextSnapshot(
        layerState.results,
        parts.model.navigationState(),
        {
          subjectPresent: !layerState.subjectMissing,
        },
      );
    },

    /**
     * Return the exact retained aircraft cohorts behind the current Contacts
     * panel snapshot. Voice reads this immutable copy instead of re-scanning
     * live layers, so panel and spoken counts share one evaluation timestamp.
     */
    getAircraftQuerySnapshot() {
      if (!layerState.enabled || !layerState.subject || !layerState.results)
        return null;
      // Build every public count from this exact results object before
      // returning. A refresh may replace `layerState.results` as soon as the
      // caller awaits, so consumers must not make a second read later and
      // accidentally combine two evaluation timestamps.
      const panelSnapshot = parts.model.buildAwarenessContextSnapshot(
        layerState.results,
        parts.model.navigationState(),
        {
          subjectPresent: !layerState.subjectMissing,
        },
      );
      const cohorts = {};
      for (const cohort of layerState.results.cohorts || []) {
        if (!['flights', 'military'].includes(cohort?.id)) continue;
        cohorts[cohort.id] = {
          count: cohort.summary?.count ?? null,
          complete:
            Number.isFinite(cohort.summary?.count) &&
            cohort.summary?.complete !== false,
          truncated:
            !Number.isFinite(cohort.summary?.count) ||
            cohort.summary?.truncated === true,
          // These records carry structured values such as Cartesian positions.
          // A shallow spread would let a voice consumer mutate the retained
          // Contacts cohort through the advertised read-only snapshot.
          items: structuredClone(cohort.summary?.navigationNearest || []),
          source: cohort.source || null,
          provenance: cohort.provenance
            ? structuredClone(cohort.provenance)
            : null,
          reason: cohort.summary?.reason || null,
        };
      }
      return {
        subject: structuredClone(layerState.results.subject),
        evaluatedAt: layerState.results.evaluatedAt,
        radiusM: layerState.results.radiusM,
        cohorts,
        contactsWindow: parts.model.contactsWindowFromSnapshot(panelSnapshot),
      };
    },

    /**
     * Release Contact-owned camera tracking without discarding the selected
     * subject. Reset-to-globe uses this route so the normal Context FOCUS action
     * can explicitly return to the same contact, while delayed activation work
     * cannot silently reclaim the camera after the reset.
     * @returns {boolean} Whether a Contact subject remains selected.
     */
    releaseCameraOwnership({
      preserveVesselSelection = false,
      origin = 'programmatic',
    } = {}) {
      ++layerState.activationId;
      layerState.autoFocusAttempted = true;
      layerState.autoFocusRetryPending = false;

      const preservedSelectionKey =
        parts.subject.subjectKey(layerState.subject) || 'camera-release';
      layerState.pendingSelectionKey = preservedSelectionKey;
      try {
        flightsLayer.stopTracking?.({ origin });
        militaryFlightsLayer.stopTracking?.({ origin });
        if (!preserveVesselSelection) aisLiveVesselsLayer.clearSelection?.();
      } finally {
        if (layerState.pendingSelectionKey === preservedSelectionKey) {
          layerState.pendingSelectionKey = null;
        }
      }
      return Boolean(layerState.subject);
    },

    /**
     * Location switch start. Contacts fetches nothing of its own, but its cohort
     * results, cohort paging and PREVIOUS/NEXT history all describe contacts
     * around the place being left. They are released so NEXT cannot fly the
     * camera back there, and so arrival rescans instead of reusing them. The
     * selected subject survives on purpose, as on reset, so FOCUS can still
     * return to it. That holds for vessel and installation subjects alike and
     * whatever order the manager runs leave hooks in: the AIS and installations
     * leaves release their own selection with a 'location-switch' clear, which
     * both clear listeners ignore (see awarenessClearIsLocationSwitch).
     * While Contacts is on, its camera ownership is released the way explicit
     * navigation releases it (the vessel selection is left to the AIS layer's
     * own leave), and every cohort rescan is held until onLocationArrive.
     * Idempotent, no network, never throws.
     */
    onLocationLeave() {
      layerState.locationSwitching = true;
      try {
        if (layerState.enabled) {
          methods.releaseCameraOwnership({
            preserveVesselSelection: true,
            origin: 'tool',
          });
        }
      } catch (error) {
        console.warn(
          '[Data:military-awareness] location switch camera release failed:',
          error,
        );
      }
      layerState.results = null;
      layerState.lastEvaluatedPosition = null;
      layerState.navigationHistory = [];
      // The index points into the history just emptied.
      layerState.navigationIndex = -1;
      layerState.navigationVisited.clear();
      layerState.cohortPages.clear();
      if (!layerState.enabled) return;
      try {
        // With no results the panel drops to standby and the compass arrows
        // hide, instead of listing old-area contacts through the flight.
        parts.panel.renderResults();
        parts.rendering.scheduleDirectionOverlayUpdate(true);
      } catch (error) {
        console.warn(
          '[Data:military-awareness] location switch repaint failed:',
          error,
        );
      }
    },

    /**
     * Location switch end (camera arrived, Contacts on): lift the rescan hold
     * and evaluate the kept subject's cohorts now rather than on the next
     * refresh tick. An aborted arrival belongs to a superseded switch, which
     * still owns the hold.
     */
    onLocationArrive({ signal } = {}) {
      if (signal?.aborted) return;
      layerState.locationSwitching = false;
      try {
        parts.subject.refreshSelectedSubject(true);
      } catch (error) {
        console.warn(
          '[Data:military-awareness] location switch rescan failed:',
          error,
        );
      }
    },

    navigatePrevious(options = {}) {
      return parts.history.navigateHistory(-1, options);
    },

    focusCurrent(options = {}) {
      return parts.focus.focusCurrentSubject(options);
    },

    navigateNext(options = {}) {
      return parts.history.navigateHistory(1, options);
    },

    /** Select a context target through its owning layer's established tracker. */
    focusTarget(layerId, id, options = {}) {
      return parts.focus.requestFocus(layerId, id, false, options);
    },
  };

  return { methods };
}
