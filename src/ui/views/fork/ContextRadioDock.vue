<template>
  <!-- God's Eye View Canada (the fork): the Context header's radio control.
       Radio is the rail's last member, shown below the last tab when
       selected (owner ruling 2026-09-27), and this is its one button.
       ContextView renders it in the header's actions slot; the markup is
       static, so src/ui/radioBindings.js listens to it and
       src/ui/radioControls.js writes its state and words, and the
       data-i18n markers are translated at boot and on each language switch. -->
  <div id="context-radio-dock" class="context-radio-dock">
    <button id="context-radio-toggle-btn" class="context-radio-toggle" type="button" aria-expanded="false" aria-controls="radio-panel" aria-label="Expand Radio section" title="Expand Radio section" data-i18n-aria-label data-i18n-title>
      <span class="material-symbols-outlined" aria-hidden="true">radio</span>
    </button>
  </div>
</template>
