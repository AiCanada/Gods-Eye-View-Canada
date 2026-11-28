<script setup>
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { followRootClass } from '../rail/rootClass.js';
import CctvPanel from './panels/CctvPanel.vue';
import StreetLevelPanel from './panels/StreetLevelPanel.vue';
import StreetLevelPhotoViewer from './panels/StreetLevelPhotoViewer.vue';
import AskPanel from './fork/AskPanel.vue';
import UltraPanel from './fork/UltraPanel.vue';
import SocialPanel from './fork/SocialPanel.vue';
import OutbreakPanel from './fork/OutbreakPanel.vue';
import AiWorldPanel from './fork/AiWorldPanel.vue';
import DistillPanel from './fork/DistillPanel.vue';
import AbundancePanel from './fork/AbundancePanel.vue';

// The Cockpit's pitch ladder gives way while a panel in the stack is open
// (cockpit.css), through a class on the page root (src/ui/rail/rootClass.js).
// Panels move in and out of the stack at run time, so its children are
// followed as they come and go.
const stack = ref(null);
let stopOpenClass = null;
onMounted(() => {
  const el = stack.value;
  stopOpenClass = followRootClass(
    el.ownerDocument,
    'left-panel-open',
    () =>
      el.isConnected &&
      [...el.children].some((child) =>
        child.matches('.panel-collapsible:not(.collapsed)'),
      ),
    (observer) => {
      observer.observe(el, { childList: true });
      for (const child of el.children)
        observer.observe(child, { attributes: true, attributeFilter: ['class'] });
    },
  );
});
onBeforeUnmount(() => stopOpenClass?.());
</script>

<template>
  <div id="left-panel-stack" ref="stack" class="ui-scroll">
  <!-- God's Eye View Canada (the fork): the left stack holds the fork's tabs
       with CCTV and Street Level, each box its own tab (owner rulings
       2026-09-27 and 2026-10-06). Data Layers, Utilities and Authoring sit on
       the right rail (ContextView). -->
  <AskPanel />

  <!-- CCTV Coverage Panel -->
  <CctvPanel />

  <!-- Street Level Panel (moved into #right-context-rail at runtime) -->
  <StreetLevelPanel />
  <StreetLevelPhotoViewer />

  <UltraPanel />
  <SocialPanel />
  <OutbreakPanel />
  <AiWorldPanel />
  <DistillPanel />
  <AbundancePanel />
  </div>
</template>
