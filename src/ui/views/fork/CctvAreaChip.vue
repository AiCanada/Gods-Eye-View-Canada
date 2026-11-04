<template>
  <!-- God's Eye View Canada (the fork): the CCTV area chip, the cameras loaded
       for the selected place (at most 1,000 within 50 km, a hard cap). CctvPanel
       renders it under the coverage row; the markup is static, so the fork's
       CCTV code writes its words, title and state, in English for now
       (data-i18n-skip). -->
  <div class="cctv-controls">
    <span id="cctv-region-cap-chip" class="gev-status-badge gev-status-badge--box" tabindex="0" role="note" title="No camera area loaded yet. Cameras load for the selected place: at most 1,000 within 50 km." aria-label="No camera area loaded yet. Cameras load for the selected place: at most 1,000 within 50 km." data-i18n-skip>AREA --</span>
  </div>
</template>
