<script setup>
import { tl } from '../../../i18n/index.js';
import PanelCollapseButton from '../../rail/PanelCollapseButton.vue';
import { vPanelState } from '../../rail/panelState.js';
</script>

<template>
  <!-- God's Eye View Canada (the fork): the GLOBAL ABUNDANCE MAP box, moved from
       src/ui/templates/layer-panels.html when upstream rendered the templates as Vue views
       (#1499). Its markup is static, so the owner modules that fill it
       (ids, classes) and the data-i18n-local markers translated at boot and on
       each language switch work as they did; the root draws its state from the
       panel chrome store (v-panel-state) and the collapse button is the kit's. -->
  <!-- Global Abundance Map (owner request 2026-10-22): a left-stack box
     under AI Distillation. Countries, states and provinces or cities
     coloured from scarce to abundant by the ticked indicators (GDP per
     person, life span, health, income, inflation, cost of living,
     education, infrastructure, share in prison, utilities, water,
     happiness, safety, work), with the abundance grid that links each
     scarce place to its nearest abundant one. Filled by
     src/abundancePanel.js from /api/abundance; drawn by
     src/abundanceOverlay.js (docs/GLOBAL-ABUNDANCE-MAP.md). -->
<div id="abundance-panel" class="panel-collapsible collapsed" data-panel-id="abundance-panel" v-panel-state="'abundance-panel'">
  <div class="panel-glow"></div>
  <div class="abundance-panel-inner">
    <div class="panel-header">
      <span class="panel-title" data-collapsed-title="GLOBAL ABUNDANCE MAP" data-i18n-local-collapsed-title data-i18n-local>GLOBAL ABUNDANCE MAP</span>
      <span class="panel-divider"></span>
      <PanelCollapseButton target="abundance-panel" :name="tl('GLOBAL ABUNDANCE MAP')" start-collapsed />
    </div>
    <div id="abundance-status" class="ask-status abundance-run" role="status" aria-live="polite"></div>
    <details class="abundance-howto">
      <summary data-i18n-local>INSTRUCTIONS</summary>
      <ol class="abundance-list">
        <li data-i18n-local>Pick the LEVEL: countries, states and provinces, or cities. SHOW ON MAP colours the globe from scarce (red) to abundant (green).</li>
        <li data-i18n-local>Tick the INDICATORS that make the score (ALL, or just some). Each row says what it measures at this level and how many places have a figure of their own; a state takes its country's figure where it has none, a city its state's or country's.</li>
        <li data-i18n-local>Slide a weight to make an indicator count more in the score. With one indicator ticked the legend shows its real values. The arrows give the change of each figure over five years.</li>
        <li data-i18n-local>Rest the pointer on a place to read its figures under SELECTED; click it to keep it there and on the map. RANKING lists the most and least abundant.</li>
        <li data-i18n-local>ABUNDANCE GRID draws the first orchestration model: every scarce place linked to its nearest abundant one.</li>
        <li data-i18n-local>DATA: the World Bank, Our World in Data and the OECD regional database, fetched by REFRESH DATA and kept thirty days. LOAD CSV puts your own figures on top; CLEAR CSV takes them off.</li>
      </ol>
      <p class="abundance-note" translate="no">World Bank WDI (CC BY 4.0) · Our World in Data (CC BY 4.0) · OECD (OECD terms) · Natural Earth (public domain)</p>
      <p class="abundance-note" data-i18n-local>Full instructions: docs/GLOBAL-ABUNDANCE-MAP.md</p>
    </details>
    <div id="abundance-body" class="abundance-body" hidden></div>
  </div>
</div>
</template>
