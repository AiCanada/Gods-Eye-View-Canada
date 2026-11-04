<script setup>
import { tl } from '../../../i18n/index.js';
import PanelCollapseButton from '../../rail/PanelCollapseButton.vue';
import { vPanelState } from '../../rail/panelState.js';
</script>

<template>
  <!-- God's Eye View Canada (the fork): the AI RISK & TRUTH ASSESSMENT box, moved from
       src/ui/templates/layer-panels.html when upstream rendered the templates as Vue views
       (#1499). Its markup is static, so the owner modules that fill it
       (ids, classes) and the data-i18n-local markers translated at boot and on
       each language switch work as they did; the root draws its state from the
       panel chrome store (v-panel-state) and the collapse button is the kit's. -->
  <!-- AI Risk & Truth Assessment: operator-driven questions about the current view.
     A member of the left stack like the others, so it collapses to the same
     tab. Rows are built at runtime, one per model that holds a key, each with
     its own input, buttons and log, stacked top to bottom; the stack gives
     the panel its height and the rows scroll inside it, so several models
     never overlap. -->
<div id="ask-panel" class="panel-collapsible" data-panel-id="ask-panel" v-panel-state="'ask-panel'">
  <div class="panel-glow"></div>
  <div class="ask-panel-inner">
    <div class="panel-header">
      <span class="panel-title" data-collapsed-title="AI RISK &amp; TRUTH ASSESSMENT" data-i18n-local-collapsed-title data-i18n-local>AI RISK &amp; TRUTH ASSESSMENT</span>
      <span class="panel-divider"></span>
      <PanelCollapseButton target="ask-panel" :name="tl('AI RISK & TRUTH ASSESSMENT')" />
    </div>
    <div id="ask-body" class="ask-body">
      <div id="ask-empty" class="ask-status" aria-live="polite" hidden></div>
      <div id="ask-rows"></div>
    </div>
  </div>
</div>
</template>
