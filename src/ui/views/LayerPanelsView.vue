<script setup>
import CctvPanel from './panels/CctvPanel.vue';
import StreetLevelPanel from './panels/StreetLevelPanel.vue';
import AskPanel from './fork/AskPanel.vue';
import UltraPanel from './fork/UltraPanel.vue';
import SocialPanel from './fork/SocialPanel.vue';
import OutbreakPanel from './fork/OutbreakPanel.vue';
import AiWorldPanel from './fork/AiWorldPanel.vue';
import DistillPanel from './fork/DistillPanel.vue';
import AbundancePanel from './fork/AbundancePanel.vue';
</script>

<template>
  <div id="left-panel-stack" class="ui-scroll">
  <!-- God's Eye View Canada (the fork): the left stack holds the fork's tabs
       with CCTV and Street Level, each box its own tab (owner rulings
       2026-09-27 and 2026-10-06). Data Layers, Utilities and Authoring sit on
       the right rail (ContextView). -->
  <AskPanel />

  <!-- CCTV Coverage Panel -->
  <CctvPanel />

  <!-- Street Level Panel (moved into #right-context-rail at runtime) -->
  <StreetLevelPanel />

  <UltraPanel />
  <SocialPanel />
  <OutbreakPanel />
  <AiWorldPanel />
  <DistillPanel />
  <AbundancePanel />
  </div>
</template>
