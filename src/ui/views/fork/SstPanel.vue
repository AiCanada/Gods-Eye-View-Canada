<script setup>
import PanelCollapseButton from '../../rail/PanelCollapseButton.vue';
import { vPanelState } from '../../rail/panelState.js';
</script>

<template>
  <!-- God's Eye View Canada (the fork): the SEA SURFACE TEMPERATURE (SST) box, moved from
       src/ui/templates/context.html when upstream rendered the templates as Vue views
       (#1499). Its markup is static, so the owner module that fills it (ids,
       classes) works as it did, and it stays English (data-i18n-skip); the
       root draws its state from the panel chrome store (v-panel-state) and
       the collapse button is the kit's. -->
  <!-- Sea Surface Temperature Panel -->
<div id="sst-panel" class="panel-collapsible collapsed" data-panel-id="sst-panel" data-i18n-skip v-panel-state="'sst-panel'">
  <div class="panel-glow"></div>
  <div class="sst-panel-inner">
    <div class="panel-header">
      <span class="panel-title" data-collapsed-title="SEA TEMP (SST)">SEA SURFACE TEMPERATURE (SST)</span>
      <span class="panel-divider"></span>
      <PanelCollapseButton target="sst-panel" name="SEA SURFACE TEMPERATURE (SST)" start-collapsed />
    </div>
    <div class="sst-subtitle">For temperature-sensitive fish that follow moving thermal fronts</div>
    <div class="cctv-controls">
      <button id="sst-enable-btn" class="scene-btn" type="button" aria-pressed="false">SST OFF</button>
      <button id="sst-fronts-btn" class="scene-btn" type="button" aria-pressed="true" title="Detect thermal fronts in Level-3 data">FRONTS ON</button>
      <select id="sst-fronts-sensitivity" aria-label="Thermal front sensitivity" title="How strong a temperature change must be to count as a front"></select>
    </div>
    <div class="cctv-controls">
      <select id="sst-product-select" aria-label="Sea surface temperature product"></select>
    </div>
    <label class="sst-opacity">
      <span class="cctv-summary-label">OPACITY</span>
      <input id="sst-opacity" type="range" min="10" max="100" step="5" value="75" aria-label="Sea surface temperature opacity" />
    </label>
    <div class="sst-legend" aria-hidden="true">
      <span id="sst-legend-min">COLD</span><span class="sst-legend-bar"></span><span id="sst-legend-max">WARM</span>
    </div>
    <div id="sst-date" class="sst-readout">DATA DATE · --</div>
    <div id="sst-fronts" class="sst-readout">FRONTS · --</div>
    <div id="sst-earthdata" class="sst-readout" role="status" aria-live="polite">EARTHDATA · --</div>
    <div id="sst-note" class="sst-note">Off. Turn on to drape NASA sea surface temperature over the oceans.</div>
  </div>
</div>
</template>
