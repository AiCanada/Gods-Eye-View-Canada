export function _calBadgeLabel(badge) {
  switch (badge) {
    case 'calibrated':
      return 'CALIBRATED';
    case 'curated':
      return 'CURATED';
    case 'raw-prior':
      return 'RAW PRIOR';
    default:
      return '--';
  }
}

/**
 * Chip text for the loaded camera area: at most 1,000 cameras within 50 km
 * of the selected place, the server's hard cap with no off switch.
 * @param {?object} area - `state.area` from the CCTV layer.
 * @returns {{text: string, description: string, capped: boolean}}
 */
export function cctvAreaChip(area) {
  const count = (value) =>
    Math.max(0, Math.round(Number(value) || 0)).toLocaleString('en-US');
  const radius = Number(area?.radiusKm) > 0 ? Math.round(area.radiusKm) : 50;
  const limit = count(Number(area?.limit) > 0 ? area.limit : 1000);
  if (area?.loading) {
    return {
      text: 'AREA LOADING',
      description: `Loading the cameras nearest this place: at most ${limit} within ${radius} km.`,
      capped: false,
    };
  }
  if (!area?.ready) {
    return {
      text: 'AREA --',
      description: `No camera area loaded yet. Cameras load for the selected place: at most ${limit} within ${radius} km.`,
      capped: false,
    };
  }
  if (area.capped) {
    return {
      text: `AREA ${radius} KM · ${limit} CAP · ${count(area.dropped)} MORE NEARBY`,
      description: `The ${limit} cameras nearest this place are loaded; ${count(area.dropped)} more within ${radius} km are not.`,
      capped: true,
    };
  }
  return {
    text: `AREA ${radius} KM · ${count(area.loaded)} CAMERAS`,
    description: `${count(area.loaded)} cameras within ${radius} km of the selected place are loaded (at most ${limit}).`,
    capped: false,
  };
}

export function _renderCctvState(state) {
  if (this.destroyed) return;
  if (
    !state?.enabled ||
    !this.actions.isEnabled() ||
    state?.activeCameraId !== this._cctvState?.activeCameraId
  ) {
    this._calibrationEdit?.(false);
  }
  this._cctvState = state || null;
  const cameras = state?.cameras || [];
  const enabled = !!state?.enabled && !!this.actions.isEnabled();
  const activeId = state?.activeCameraId || '';
  const activeCamera = state?.activeCamera || null;

  // Auto-expand the panel when the active camera CHANGES to a new non-null
  // id while the layer is enabled. Covers click-on-globe, panel controls,
  // and voice (selectCamera/cycleCamera/focusNearest all notify through
  // this subscription). The last-seen guard keeps routine notifications
  // from re-expanding a panel the user deliberately collapsed, and timed
  // auto-hop transitions only expand on the first activation so the panel
  // does not pop open on every hop.
  const effectiveActiveId = enabled ? activeId || null : null;
  const isFirstActivation = this._lastSeenCctvActiveId === null;
  if (
    effectiveActiveId &&
    effectiveActiveId !== this._lastSeenCctvActiveId &&
    (!state?.autoHop || isFirstActivation)
  ) {
    this.actions.setPanelCollapsed('cctv-panel', false, {
      explicit: Boolean(state?.explicitSelection),
    });
  }
  this._lastSeenCctvActiveId = effectiveActiveId;

  this._updateCctvSyncChip(state?.loading, enabled);

  if (this._cctvEnableBtn) {
    this._cctvEnableBtn.classList.toggle('active', enabled);
    this._cctvEnableBtn.textContent = enabled ? 'CCTV ON' : 'CCTV OFF';
  }

  if (this._cctvSelect) {
    const shouldRebuild =
      this._cctvSelect.options.length !== cameras.length ||
      cameras.some(
        (cam, idx) => this._cctvSelect.options[idx]?.value !== cam.id,
      );
    if (shouldRebuild) {
      this._cctvSelect.innerHTML = '';
      for (const camera of cameras) {
        const option = document.createElement('option');
        option.value = camera.id;
        option.textContent = `${camera.city} · ${camera.name}`;
        this._cctvSelect.appendChild(option);
      }
    }
    this._cctvSelect.disabled = !enabled || cameras.length === 0;
    if (
      activeId &&
      Array.from(this._cctvSelect.options).some((opt) => opt.value === activeId)
    ) {
      this._cctvSelect.value = activeId;
    } else if (!activeId) {
      this._cctvSelect.selectedIndex = -1;
    }
  }

  // NEAREST re-centres an empty area on the view, so it needs only the layer
  // on; PREV and NEXT step through cameras that are loaded.
  if (this._cctvNearestBtn) this._cctvNearestBtn.disabled = !enabled;
  for (const btn of [this._cctvPrevBtn, this._cctvNextBtn]) {
    if (!btn) continue;
    btn.disabled = !enabled || cameras.length === 0;
  }
  if (this._cctvFocusBtn) {
    this._cctvFocusBtn.disabled = !enabled || cameras.length === 0 || !activeId;
  }

  if (this._cctvCoverageBtn) {
    // Tri-state (viewshed design §3b): off → on (wireframes) → viewshed
    // (color-coded volumes). The click handler cycles; this renders.
    const mode = state?.coverageMode || (state?.showCoverage ? 'on' : 'off');
    this._cctvCoverageBtn.classList.toggle('active', mode !== 'off');
    this._cctvCoverageBtn.textContent =
      mode === 'viewshed'
        ? 'VIEWSHED ON'
        : mode === 'on'
          ? 'COVERAGE ON'
          : 'COVERAGE OFF';
    this._cctvCoverageBtn.disabled = !enabled;
  }

  if (this._cctvAutoHopBtn) {
    const autoHop = !!state?.autoHop;
    this._cctvAutoHopBtn.classList.toggle('active', autoHop);
    this._cctvAutoHopBtn.textContent = autoHop ? 'AUTO HOP ON' : 'AUTO HOP OFF';
    this._cctvAutoHopBtn.disabled = !enabled;
  }

  if (this._cctvRegionCapChip) {
    // The camera area: a hard server cap with no off switch, shown so the
    // viewer knows why a dense city stops at 1,000 cameras.
    const chip = cctvAreaChip(state?.area);
    this._cctvRegionCapChip.textContent = chip.text;
    this._cctvRegionCapChip.dataset.over = chip.capped ? 'true' : 'false';
    this._cctvRegionCapChip.title = chip.description;
    this._cctvRegionCapChip.setAttribute('aria-label', chip.description);
  }

  if (this._cctvProjectionBtn) {
    const showProjection = state?.showProjection !== false;
    this._cctvProjectionBtn.classList.toggle('active', showProjection);
    this._cctvProjectionBtn.textContent = showProjection
      ? 'PROJECTION ON'
      : 'PROJECTION OFF';
    this._cctvProjectionBtn.disabled = !enabled;
  }

  if (this._cctvQualityChip) {
    // CAL badge (cctv-v2 design §3b, amended by LOCKED §9.2 — panel-only,
    // no in-world tint): three states driven by cctv.js's deriveCalBadge,
    // no client-side scoring math. Casing is unified via _calBadgeLabel so
    // the chip and the meta line never drift onto different conventions.
    // Save-gated persistence (viewshed design §3e): unsaved live edits show
    // EDITED on top of whatever the persisted badge state is — SAVE CAL
    // promotes to CALIBRATED, RESET CAL clears.
    const badge = activeCamera?.calBadge || null;
    const dirty = !!activeCamera?.calDirty;
    this._cctvQualityChip.textContent = dirty
      ? 'CAL · EDITED (UNSAVED)'
      : `CAL · ${this._calBadgeLabel(badge)}`;
    this._cctvQualityChip.dataset.calBadge = dirty ? 'edited' : badge || '';
  }

  this._syncCctvCalReadout(enabled, activeCamera);

  if (this._cctvMeta) {
    if (activeCamera) {
      const provider =
        activeCamera.sourceLabel ||
        activeCamera.provider ||
        'Configured Source';
      // A camera with no public still says why (Road511 lookup state).
      const statusText = activeCamera.lookupNote || activeCamera.sourceMessage;
      const statusMsg = statusText ? ` · ${statusText}` : '';
      const calBadge = activeCamera.calBadge
        ? this._calBadgeLabel(activeCamera.calBadge)
        : '';
      const projLabel = state?.showProjection !== false ? 'MONITOR' : 'OFF';
      this._cctvMeta.textContent = `${activeCamera.city} · HDG ${Math.round(activeCamera.headingDeg)}° · FOV ${Math.round(activeCamera.fovDeg)}° · RANGE ${Math.round(activeCamera.rangeM)}m · ${projLabel}${calBadge ? ` · ${calBadge}` : ''} · ${provider}${statusMsg}`;
    } else if (cameras.length > 0) {
      this._cctvMeta.textContent = enabled
        ? `${cameras.length} cameras loaded · click a camera to activate`
        : `${cameras.length} cameras loaded · enable CCTV to activate`;
    } else {
      this._cctvMeta.textContent = 'Enable CCTV to load camera intersections';
    }
  }

  if (this._cctvFrame) {
    const nextSrc = enabled ? activeCamera?.frameUrl : null;
    const nextCameraId = enabled ? activeCamera?.id || '' : '';
    const cameraChanged = this._cctvFrame.dataset.cameraId !== nextCameraId;
    const frameLoading = this._cctvFrame.dataset.loading === 'true';
    // A same-camera refresh waits for the current image to settle. Replacing
    // src every 10 seconds can cancel a slow but healthy decode forever and
    // leave SNAPSHOT · OK beside a blank/loading preview. Camera changes are
    // immediate so navigation never waits on the prior camera's request.
    if (
      nextSrc &&
      (cameraChanged ||
        (!frameLoading && this._cctvFrame.dataset.currentSrc !== nextSrc))
    ) {
      this._queueCctvFrame(nextSrc, nextCameraId, cameraChanged);
    }
    if (!nextSrc) {
      this._clearCctvFrame();
    }
  }

  this._syncCctvSourceBadge(activeCamera, enabled);
  this._typeCctvSummary(
    state?.summary ||
      'Enable CCTV to start camera-linked intelligence summaries.',
  );
}

export function _typeCctvSummary(text) {
  if (this.destroyed || !this._cctvSummary) return;
  const nextText = String(text || '').trim() || 'No summary available.';
  if (nextText === this._lastCctvSummaryText) return;
  this._lastCctvSummaryText = nextText;

  clearInterval(this._cctvSummaryTypingTimer);
  this._cctvSummary.textContent = '';
  let idx = 0;
  this._cctvSummaryTypingTimer = setInterval(() => {
    if (this.destroyed) return;
    idx += 3;
    if (idx >= nextText.length) {
      this._cctvSummary.textContent = nextText;
      clearInterval(this._cctvSummaryTypingTimer);
      this._cctvSummaryTypingTimer = null;
      return;
    }
    this._cctvSummary.textContent = nextText.slice(0, idx);
  }, 20);
}

export function _updateCctvSyncChip(loading, enabled) {
  if (this.destroyed) return;
  if (!this._cctvSyncChip || !this._cctvSyncLabel || !this._cctvSyncProgress)
    return;
  const total = Number(loading?.total) || 0;
  const loaded = Math.max(0, Math.min(Number(loading?.loaded) || 0, total));
  const busy = !!enabled && !!loading?.active && total > 0;

  if (busy) {
    clearTimeout(this._cctvChipHideTimer);
    this._cctvChipHideTimer = null;
    this._cctvChipWasBusy = true;
    this.actions.setSplitFlapText(this._cctvSyncLabel, 'loading frames');
    // The counter is left plain on purpose: it ticks every few frames
    // during a grid load, and flapping it would read as a slot machine.
    this._cctvSyncProgress.textContent = `${loaded}/${total}`;
    this._cctvSyncChip.classList.add('visible');
    return;
  }

  if (this._cctvChipWasBusy && enabled && total > 0) {
    // Load just completed — flash the final count, then auto-hide.
    this._cctvChipWasBusy = false;
    this.actions.setSplitFlapText(this._cctvSyncLabel, 'camera grid ready');
    this._cctvSyncProgress.textContent = `${total}/${total}`;
    this._cctvSyncChip.classList.add('visible');
    clearTimeout(this._cctvChipHideTimer);
    this._cctvChipHideTimer = window.setTimeout(() => {
      if (this.destroyed) return;
      this._cctvChipHideTimer = null;
      this._cctvSyncChip.classList.remove('visible');
    }, 1500);
    return;
  }

  if (!this._cctvChipHideTimer) {
    this._cctvChipWasBusy = false;
    this._cctvSyncChip.classList.remove('visible');
  }
}
