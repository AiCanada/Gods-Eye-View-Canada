<script setup>
import { tl } from '../../../i18n/index.js';
import PanelCollapseButton from '../../rail/PanelCollapseButton.vue';
import { vPanelState } from '../../rail/panelState.js';
</script>

<template>
  <!-- God's Eye View Canada (the fork): the ULTRA SECURITY PACKAGE box, moved from
       src/ui/templates/layer-panels.html when upstream rendered the templates as Vue views
       (#1499). Its markup is static, so the owner modules that fill it
       (ids, classes) and the data-i18n-local markers translated at boot and on
       each language switch work as they did; the root draws its state from the
       panel chrome store (v-panel-state) and the collapse button is the kit's. -->
  <!-- Ultra Security Package: the owner's paired phone, not the CCTV catalogues. -->
<div id="ultra-panel" class="panel-collapsible collapsed" data-panel-id="ultra-panel" v-panel-state="'ultra-panel'">
  <div class="panel-glow"></div>
  <div class="ultra-panel-inner">
    <div class="panel-header">
      <span class="panel-title" data-collapsed-title="ULTRA" data-i18n-local-collapsed-title data-i18n-local>ULTRA SECURITY PACKAGE</span>
      <span class="panel-divider"></span>
      <PanelCollapseButton target="ultra-panel" :name="tl('ULTRA SECURITY PACKAGE')" start-collapsed />
    </div>
    <div id="ultra-status" class="sst-readout" role="status" aria-live="polite" data-i18n-local>PHONE · WAITING</div>
    <div id="ultra-cam-link" class="sst-readout"></div>
    <!-- Send help: one press releases this phone's position to every token marked NETWORK for four hours (STAND DOWN any time) and hands the phone the plea for the saved helpers. The incident comes from the FIND HELP select. -->
    <div class="cctv-summary-label"><span data-i18n-local>SEND HELP</span> <span id="ultra-release-state"></span></div>
    <div id="ultra-release" class="cctv-controls ultra-release">
      <!-- Shown only with more than one package saved: each has its own call, and these buttons act on the one chosen here. -->
      <select id="ultra-release-package" aria-label="Which package is asking for help" hidden data-i18n-local-aria-label></select>
      <button id="ultra-release-send" class="scene-btn ultra-danger" type="button" data-i18n-local>SEND HELP</button>
      <!-- Always beside SEND HELP: with no call on, a press ends nothing and says so. -->
      <button id="ultra-release-stand-down" class="scene-btn" type="button" data-i18n-local>STAND DOWN</button>
    </div>
    <p id="ultra-release-note" class="ultra-note"></p>
    <div id="ultra-release-plea" class="sst-readout" hidden></div>
    <!-- Help messages from token holders sit first under the status line: an incoming plea outranks the camera controls. -->
    <div id="ultra-inbox" class="ultra-inbox"></div>
    <div class="cctv-controls ultra-read-row">
      <label class="ultra-match"><input id="ultra-read-aloud" type="checkbox" checked> <span data-i18n-local>Read new help messages aloud</span></label>
      <label class="ultra-match"><input id="ultra-private-cams" type="checkbox"> <span data-i18n-local>Private CCTV on map</span></label>
    </div>
    <div class="cctv-controls ultra-map-controls">
      <label class="ultra-match"><input id="ultra-map-show" type="checkbox"> <span data-i18n-local>Display Ultra history on map</span></label>
      <select id="ultra-map-period" aria-label="How much of the Ultra holders' path the map shows" title="How much of each Ultra holder's path over time the map shows" data-i18n-local-aria-label data-i18n-local-title>
        <option value="live" data-i18n-local>Live only</option>
        <option value="1h" data-i18n-local>Last hour</option>
        <option value="6h" data-i18n-local>Last 6 hours</option>
        <option value="24h" data-i18n-local>Last 24 hours</option>
        <option value="7d" data-i18n-local>Last 7 days</option>
        <option value="30d" selected data-i18n-local>Last 30 days</option>
        <option value="365d" data-i18n-local>Last year</option>
      </select>
    </div>
    <div class="cctv-summary-label"><span data-i18n-local>ULTRA CELLS</span> <span id="ultra-cells-count"></span></div>
    <div id="ultra-cells" class="ultra-cells"></div>
    <div class="cctv-controls">
      <button id="ultra-cells-all" class="scene-btn" type="button" title="Every Ultra cell and every path on the map at the same time" data-i18n-local-title data-i18n-local>SHOW ALL ON MAP</button>
    </div>
    <form id="ultra-cell-add" class="cctv-controls ultra-contact">
      <input id="ultra-cell-name" type="text" maxlength="60" placeholder="Name of another Ultra cell" aria-label="Name of another Ultra cell" autocomplete="off" data-i18n-local-placeholder data-i18n-local-aria-label>
      <button id="ultra-cell-add-btn" class="scene-btn" type="submit" data-i18n-local>+ ADD ULTRA CELL</button>
    </form>
    <p id="ultra-cell-note" class="ultra-note" hidden></p>
    <div class="cctv-controls">
      <select id="ultra-model" aria-label="Ultra phone model" data-i18n-local-aria-label>
        <option value="generic-cell" data-i18n-local>Generic cell</option>
        <option value="google-pixel" data-i18n-local>Google Pixel</option>
        <option value="motorola" data-i18n-local>Motorola</option>
        <option value="oppo" data-i18n-local>Oppo</option>
        <option value="vivo" data-i18n-local>Vivo</option>
        <option value="xiaomi" data-i18n-local>Xiaomi</option>
        <option value="samsung-s26" data-i18n-local>Galaxy S26</option>
        <option value="samsung-s22-ultra" selected data-i18n-local>Galaxy S22 Ultra</option>
        <option value="samsung-z8" data-i18n-local>Galaxy Z8</option>
        <option value="samsung-z3" data-i18n-local>Galaxy Z3</option>
        <option value="samsung-z-fold" data-i18n-local>Galaxy Z Fold</option>
      </select>
    </div>
    <!-- CELL: which saved phone TAKE PHOTO and TAKE VIDEO go to (owner
         request 2026-10-16). AUTO is the phone whose camera page is open,
         else the one that reported last; the rest name a saved Ultra cell.
         The entries are filled from the status (src/ultraHelpPanel.js). -->
    <div class="cctv-controls">
      <select id="ultra-camera-cell" aria-label="Which Ultra cell takes the photo or video" data-i18n-local-aria-label>
        <option value="" data-i18n-local>AUTO · THE PHONE WHOSE PAGE IS OPEN, ELSE THE LAST TO REPORT</option>
      </select>
    </div>
    <!-- CELL CAMERAS: PHOTO (one still) and VIDEO (live) for each camera
         this phone model has. Every press also records a clip, kept on
         this computer (owner ruling, 2026-10-08). -->
    <div class="cctv-summary-label" data-i18n-local>CELL CAMERAS</div>
    <div class="cctv-controls ultra-cam-row" data-ultra-camera-row="front">
      <span class="ultra-cam-name" data-i18n-local>Front Cell Cam</span>
      <button class="scene-btn" type="button" data-ultra-camera="front" data-ultra-mode="photo" title="One still from the Front Cell Cam" data-i18n-local-title data-i18n-local>TAKE PHOTO</button><button class="scene-btn ultra-step" type="button" data-ultra-media-step="photos" data-ultra-media-dir="-1" title="The photos before, on the map" data-i18n-local-title>◀</button><button class="scene-btn ultra-step" type="button" data-ultra-media-step="photos" data-ultra-media-dir="1" title="The next photos, on the map" data-i18n-local-title>▶</button>
      <button class="scene-btn" type="button" data-ultra-camera="front" data-ultra-mode="video" title="Live video from the Front Cell Cam" data-i18n-local-title data-i18n-local>TAKE VIDEO</button><button class="scene-btn ultra-step" type="button" data-ultra-media-step="videos" data-ultra-media-dir="-1" title="The videos before, on the map" data-i18n-local-title>◀</button><button class="scene-btn ultra-step" type="button" data-ultra-media-step="videos" data-ultra-media-dir="1" title="The next videos, on the map" data-i18n-local-title>▶</button>
    </div>
    <div class="cctv-controls ultra-cam-row" data-ultra-camera-row="rear">
      <span class="ultra-cam-name" data-i18n-local>Rear Cell Cam</span>
      <button class="scene-btn" type="button" data-ultra-camera="rear" data-ultra-mode="photo" title="One still from the Rear Cell Cam" data-i18n-local-title data-i18n-local>TAKE PHOTO</button><button class="scene-btn ultra-step" type="button" data-ultra-media-step="photos" data-ultra-media-dir="-1" title="The photos before, on the map" data-i18n-local-title>◀</button><button class="scene-btn ultra-step" type="button" data-ultra-media-step="photos" data-ultra-media-dir="1" title="The next photos, on the map" data-i18n-local-title>▶</button>
      <button class="scene-btn" type="button" data-ultra-camera="rear" data-ultra-mode="video" title="Live video from the Rear Cell Cam" data-i18n-local-title data-i18n-local>TAKE VIDEO</button><button class="scene-btn ultra-step" type="button" data-ultra-media-step="videos" data-ultra-media-dir="-1" title="The videos before, on the map" data-i18n-local-title>◀</button><button class="scene-btn ultra-step" type="button" data-ultra-media-step="videos" data-ultra-media-dir="1" title="The next videos, on the map" data-i18n-local-title>▶</button>
    </div>
    <div class="cctv-controls ultra-cam-row" data-ultra-camera-row="inner">
      <span class="ultra-cam-name" data-i18n-local>Inside Fold Cell Cam</span>
      <button class="scene-btn" type="button" data-ultra-camera="inner" data-ultra-mode="photo" title="One still from the Inside Fold Cell Cam" data-i18n-local-title data-i18n-local>TAKE PHOTO</button><button class="scene-btn ultra-step" type="button" data-ultra-media-step="photos" data-ultra-media-dir="-1" title="The photos before, on the map" data-i18n-local-title>◀</button><button class="scene-btn ultra-step" type="button" data-ultra-media-step="photos" data-ultra-media-dir="1" title="The next photos, on the map" data-i18n-local-title>▶</button>
      <button class="scene-btn" type="button" data-ultra-camera="inner" data-ultra-mode="video" title="Live video from the Inside Fold Cell Cam" data-i18n-local-title data-i18n-local>TAKE VIDEO</button><button class="scene-btn ultra-step" type="button" data-ultra-media-step="videos" data-ultra-media-dir="-1" title="The videos before, on the map" data-i18n-local-title>◀</button><button class="scene-btn ultra-step" type="button" data-ultra-media-step="videos" data-ultra-media-dir="1" title="The next videos, on the map" data-i18n-local-title>▶</button>
    </div>
    <div id="ultra-extra-cameras">
    <div class="cctv-controls ultra-cam-row" data-ultra-camera-row="rear-ultrawide" hidden>
      <span class="ultra-cam-name" data-i18n-local>Rear Ultrawide Cam</span>
      <button class="scene-btn" type="button" data-ultra-camera="rear-ultrawide" data-ultra-mode="photo" title="One still from the Rear Ultrawide Cam" data-i18n-local-title data-i18n-local>TAKE PHOTO</button><button class="scene-btn ultra-step" type="button" data-ultra-media-step="photos" data-ultra-media-dir="-1" title="The photos before, on the map" data-i18n-local-title>◀</button><button class="scene-btn ultra-step" type="button" data-ultra-media-step="photos" data-ultra-media-dir="1" title="The next photos, on the map" data-i18n-local-title>▶</button>
      <button class="scene-btn" type="button" data-ultra-camera="rear-ultrawide" data-ultra-mode="video" title="Live video from the Rear Ultrawide Cam" data-i18n-local-title data-i18n-local>TAKE VIDEO</button><button class="scene-btn ultra-step" type="button" data-ultra-media-step="videos" data-ultra-media-dir="-1" title="The videos before, on the map" data-i18n-local-title>◀</button><button class="scene-btn ultra-step" type="button" data-ultra-media-step="videos" data-ultra-media-dir="1" title="The next videos, on the map" data-i18n-local-title>▶</button>
    </div>
    <div class="cctv-controls ultra-cam-row" data-ultra-camera-row="rear-tele" hidden>
      <span class="ultra-cam-name" data-i18n-local>Rear Telephoto Cam</span>
      <button class="scene-btn" type="button" data-ultra-camera="rear-tele" data-ultra-mode="photo" title="One still from the Rear Telephoto Cam" data-i18n-local-title data-i18n-local>TAKE PHOTO</button><button class="scene-btn ultra-step" type="button" data-ultra-media-step="photos" data-ultra-media-dir="-1" title="The photos before, on the map" data-i18n-local-title>◀</button><button class="scene-btn ultra-step" type="button" data-ultra-media-step="photos" data-ultra-media-dir="1" title="The next photos, on the map" data-i18n-local-title>▶</button>
      <button class="scene-btn" type="button" data-ultra-camera="rear-tele" data-ultra-mode="video" title="Live video from the Rear Telephoto Cam" data-i18n-local-title data-i18n-local>TAKE VIDEO</button><button class="scene-btn ultra-step" type="button" data-ultra-media-step="videos" data-ultra-media-dir="-1" title="The videos before, on the map" data-i18n-local-title>◀</button><button class="scene-btn ultra-step" type="button" data-ultra-media-step="videos" data-ultra-media-dir="1" title="The next videos, on the map" data-i18n-local-title>▶</button>
    </div>
    </div>
    <!-- Photos and videos show on the map only, beside the Ultra cell: a
         photo card and a separate video card, the size of its live card.
         Three of each at most. Tick the ones for the map; the ◀ ▶ beside
         TAKE PHOTO and TAKE VIDEO step through them. Untick PHOTOS ON MAP or
         VIDEOS ON MAP to take that kind off the map; CCTV in the list still
         plays them. DELETE takes the ticked
         ones off this computer, or every one with All ticked; it asks once
         more first. -->
    <div class="cctv-controls ultra-media-controls">
      <label class="ultra-match"><input id="ultra-photos-on-map" type="checkbox" checked> <span data-i18n-local>PHOTOS ON MAP</span> <span id="ultra-photo-pos"></span></label>
      <label class="ultra-match"><input id="ultra-videos-on-map" type="checkbox" checked> <span data-i18n-local>VIDEOS ON MAP</span> <span id="ultra-video-pos"></span></label>
    </div>
    <div class="cctv-controls ultra-media-controls">
      <label class="ultra-match"><input id="ultra-media-delete-all" type="checkbox"> <span data-i18n-local>All</span></label>
      <button id="ultra-media-delete" class="scene-btn" type="button" title="Delete the ticked photos and videos, or all of them with All ticked" disabled data-i18n-local-title data-i18n-local>DELETE TICKED</button>
    </div>
    <ul id="ultra-media" class="ultra-media" aria-label="Photos and videos from the Ultra cell" data-i18n-local-aria-label></ul>
    <div class="cctv-summary-label" data-i18n-local>FIND HELP</div>
    <!-- The incident select names the incident SEND HELP sends. Find Ultra Help is under development: its button does nothing yet. -->
    <div class="cctv-controls">
      <select id="ultra-incident" aria-label="Classified incident type" data-i18n-local-aria-label>
        <option value="threat" data-i18n-local>THREAT</option>
        <option value="fire" data-i18n-local>FIRE</option>
        <option value="medical" data-i18n-local>MEDICAL</option>
        <option value="other" data-i18n-local>OTHER</option>
      </select>
      <button id="ultra-find" class="scene-btn" type="button" disabled title="Under development" data-i18n-local-title data-i18n-local>Find Ultra Help (under development)</button>
    </div>
    <!-- GROK BOT SWARM: seven bots on GROK_BOT_API_KEY for the phone's last
         fix. Answers land in this log. Without the key, the Grok Bot
         computer (POWER UP), else the copied task and Grok Bot opened. -->
    <div class="cctv-summary-label" data-i18n-local>GROK BOT SWARM</div>
    <textarea id="ultra-swarm-instructions" class="ask-input social-query" rows="3" maxlength="1000" autocomplete="off" aria-label="Grok bot instructions" placeholder="Grok bot instructions. Leave empty for the default: threat incidents near the phone's last fix." data-i18n-local-aria-label data-i18n-local-placeholder></textarea>
    <div class="cctv-controls">
      <button id="ultra-swarm-run" class="scene-btn" type="button" data-i18n-local>GROK BOT SWARM</button>
    </div>
    <div id="ultra-swarm-status" class="ask-status" role="status" aria-live="polite"></div>
    <div id="ultra-swarm-output" class="ask-output" role="status" aria-live="polite" tabindex="0"></div>
    <div class="cctv-summary-label" data-i18n-local>PREDEFINED HELP #</div>
    <form id="ultra-contact" class="cctv-controls ultra-contact">
      <input id="ultra-contact-label" type="text" placeholder="Helper name" aria-label="Helper name" autocomplete="off"  data-i18n-local-placeholder data-i18n-local-aria-label/>
      <input id="ultra-contact-number" type="tel" placeholder="+15065550100" aria-label="Helper phone number" autocomplete="off"  data-i18n-local-aria-label/>
      <select id="ultra-contact-kind" aria-label="Helper kind" data-i18n-local-aria-label>
        <option value="police" data-i18n-local>POLICE</option>
        <option value="fire" data-i18n-local>FIRE</option>
        <option value="other" data-i18n-local>OTHER</option>
      </select>
      <button class="scene-btn" type="submit" data-i18n-local>SAVE #</button>
    </form>
    <p id="ultra-help-store-note" class="ultra-note" hidden data-i18n-local>The helpers file was changed and is not being used. The next save replaces it.</p>
    <p id="ultra-outbound-note" class="ultra-note" hidden></p>
    <div id="ultra-contacts"></div>
    <!-- Share help tokens: one token per person, handed over beside the tailnet address; the plaintext only ever lands in the reveal box, which the status poll cannot repaint. -->
    <div class="cctv-summary-label" data-i18n-local>SHARE ENCRYPTED ULTRA TOKENS</div>
    <p id="ultra-token-note" class="ultra-note"></p>
    <form id="ultra-number" class="cctv-controls ultra-contact">
      <input id="ultra-number-input" type="tel" placeholder="+15065550100 your cell: calls for help you receive are texted here" aria-label="Your number for SMS help" autocomplete="off" data-i18n-local-placeholder data-i18n-local-aria-label>
      <button class="scene-btn" type="submit" data-i18n-local>SAVE MY #</button>
      <button id="ultra-number-clear" class="scene-btn" type="button" hidden data-i18n-local>CLEAR MY #</button>
    </form>
    <form id="ultra-token" class="cctv-controls ultra-contact">
      <input id="ultra-token-label" type="text" placeholder="Name of Ultra Token Holder" aria-label="Name of Ultra Token Holder" autocomplete="off" data-i18n-local-placeholder data-i18n-local-aria-label>
      <!-- A token carries the location poll alone: Network is its only switch. -->
      <label class="ultra-match"><input id="ultra-token-network" type="checkbox" checked> <span data-i18n-local>Network</span></label>
      <!-- Skill codes are written into the token string. Encrypt seals that list inside the string; leaving every box off mints the short token. -->
      <div id="ultra-token-skills" class="ultra-skills">
        <span class="cctv-summary-label" data-i18n-local>Your Gifts or Skills Encrypted into Token String</span>
        <label class="ultra-match"><input id="ultra-skill-dr" type="checkbox" data-ultra-skill="dr"> <span data-i18n-local>Doctor</span></label>
        <label class="ultra-match"><input id="ultra-skill-pm" type="checkbox" data-ultra-skill="pm"> <span data-i18n-local>Paramedic</span></label>
        <label class="ultra-match"><input id="ultra-skill-fr" type="checkbox" data-ultra-skill="fr"> <span data-i18n-local>First Responder</span></label>
        <label class="ultra-match"><input id="ultra-skill-lg" type="checkbox" data-ultra-skill="lg"> <span data-i18n-local>Lifeguard</span></label>
        <label class="ultra-match"><input id="ultra-skill-ff" type="checkbox" data-ultra-skill="ff"> <span data-i18n-local>Firefighter</span></label>
        <label class="ultra-match ultra-skill-wide"><input id="ultra-skill-sr" type="checkbox" data-ultra-skill="sr"> <span data-i18n-local>Search and Rescue (SAR) Specialist</span></label>
        <label class="ultra-match"><input id="ultra-skill-br" type="checkbox" data-ultra-skill="br"> <span data-i18n-local>Brave</span></label>
        <label class="ultra-match"><input id="ultra-skill-st" type="checkbox" data-ultra-skill="st"> <span data-i18n-local>Strong</span></label>
        <label class="ultra-match"><input id="ultra-skill-cc" type="checkbox" data-ultra-skill="cc"> <span data-i18n-local>Crisis Counselor</span></label>
        <label class="ultra-match"><input id="ultra-skill-en" type="checkbox" data-ultra-skill="en"> <span data-i18n-local>Enforcer</span></label>
        <label class="ultra-match"><input id="ultra-skill-ac" type="checkbox" data-ultra-skill="ac"> <span data-i18n-local>Animal Control</span></label>
        <label class="ultra-match ultra-skill-wide"><input id="ultra-skill-hz" type="checkbox" data-ultra-skill="hz"> <span data-i18n-local>Hazardous Materials (HAZMAT)</span></label>
        <label class="ultra-match"><input id="ultra-skill-rg" type="checkbox" data-ultra-skill="rg"> <span data-i18n-local>Ranger</span></label>
        <label class="ultra-match"><input id="ultra-skill-tr" type="checkbox" data-ultra-skill="tr"> <span data-i18n-local>Transportation</span></label>
        <label class="ultra-match"><input id="ultra-skill-ng" type="checkbox" data-ultra-skill="ng"> <span data-i18n-local>Mr./Mrs. Nice Guy</span></label>
        <span class="cctv-summary-label" data-i18n-local>Your Custom Gifts or Skills Encrypted into Token String</span>
        <input id="ultra-skill-custom-1" class="ultra-skill-custom" type="text" maxlength="40" placeholder="Custom skill" aria-label="Custom skill 1" autocomplete="off" title="A long name is shortened to the words the token can carry." data-i18n-local-placeholder data-i18n-local-aria-label data-i18n-local-title>
        <input id="ultra-skill-custom-2" class="ultra-skill-custom" type="text" maxlength="40" placeholder="Custom skill" aria-label="Custom skill 2" autocomplete="off" title="A long name is shortened to the words the token can carry." data-i18n-local-placeholder data-i18n-local-aria-label data-i18n-local-title>
        <input id="ultra-skill-custom-3" class="ultra-skill-custom" type="text" maxlength="40" placeholder="Custom skill" aria-label="Custom skill 3" autocomplete="off" title="A long name is shortened to the words the token can carry." data-i18n-local-placeholder data-i18n-local-aria-label data-i18n-local-title>
        <input id="ultra-skill-custom-4" class="ultra-skill-custom" type="text" maxlength="40" placeholder="Custom skill" aria-label="Custom skill 4" autocomplete="off" title="A long name is shortened to the words the token can carry." data-i18n-local-placeholder data-i18n-local-aria-label data-i18n-local-title>
        <input id="ultra-skill-custom-5" class="ultra-skill-custom" type="text" maxlength="40" placeholder="Custom skill" aria-label="Custom skill 5" autocomplete="off" title="A long name is shortened to the words the token can carry." data-i18n-local-placeholder data-i18n-local-aria-label data-i18n-local-title>
        <p id="ultra-skill-custom-preview" class="ultra-note" hidden></p>
        <label class="ultra-match ultra-skill-wide" title="On: the skill list is sealed inside the token string. Off: the skill codes are written in the token string in the clear. Either way the token still works. No skills and Encrypt off keeps the short token." data-i18n-local-title><input id="ultra-token-encrypt" type="checkbox"> <span data-i18n-local>Encrypt</span></label>
      </div>
      <select id="ultra-token-package" aria-label="Which package" hidden data-i18n-local-aria-label></select>
      <button id="ultra-token-submit" class="scene-btn" type="submit" data-i18n-local>GENERATE NEW TOKEN</button>
    </form>
    <div id="ultra-token-reveal" class="ultra-reveal" hidden>
      <pre id="ultra-token-link"></pre>
      <div class="cctv-controls">
        <button id="ultra-token-copy-address" class="scene-btn" type="button" data-i18n-local>COPY ADDRESS</button>
        <button id="ultra-token-copy" class="scene-btn" type="button" data-i18n-local>COPY TOKEN</button>
        <button id="ultra-token-hide" class="scene-btn" type="button" data-i18n-local>HIDE</button>
      </div>
    </div>
    <div id="ultra-tokens"></div>
    <!-- CONFIRM ULTRA TOKEN SKILLS: below the token REMOVE rows, above
         HELP NETWORK. Paste an Ultra Token to decrypt its skills. -->
    <div class="cctv-controls">
      <button id="ultra-skill-check-open" class="scene-btn" type="button" data-i18n-local>CONFIRM ULTRA TOKEN SKILLS</button>
    </div>
    <form id="ultra-skill-check" class="ultra-reveal" hidden>
      <p id="ultra-skill-check-for" class="ultra-note"></p>
      <p class="ultra-note" data-i18n-local>CONFIRMED, NO CONFIRMATION or REJECTED CLAIM, each with its link. Every detail is optional except the skills and a name or link; they help the bots or LLM find the right person.</p>
      <div class="cctv-controls ultra-contact">
        <input id="ultra-skill-check-skills" type="text" maxlength="500" placeholder="Paste Ultra Token and decrypt skills from Ultra token to confirm" aria-label="Paste Ultra Token and decrypt skills from Ultra token to confirm" autocomplete="off" spellcheck="false" data-i18n-local-placeholder data-i18n-local-aria-label>
        <input id="ultra-skill-check-name" type="text" maxlength="80" placeholder="Name of token holder" aria-label="Name of token holder" autocomplete="off" data-i18n-local-placeholder data-i18n-local-aria-label>
        <input id="ultra-skill-check-alias" type="text" maxlength="80" placeholder="Alias/AKA" aria-label="Alias or AKA of token holder" autocomplete="off" data-i18n-local-placeholder data-i18n-local-aria-label>
        <input id="ultra-skill-check-location" type="text" maxlength="120" placeholder="Location of token holder" aria-label="Location of token holder" autocomplete="off" data-i18n-local-placeholder data-i18n-local-aria-label>
        <input id="ultra-skill-check-age" type="number" min="13" max="120" step="1" placeholder="Age" aria-label="Age of token holder" autocomplete="off" data-i18n-local-placeholder data-i18n-local-aria-label>
        <select id="ultra-skill-check-sex" aria-label="Male, female or other" data-i18n-local-aria-label>
          <option value="" data-i18n-local>Male / Female / Other</option>
          <option value="male" data-i18n-local>Male</option>
          <option value="female" data-i18n-local>Female</option>
          <option value="other" data-i18n-local>Other</option>
        </select>
        <input id="ultra-skill-check-profession" type="text" maxlength="80" placeholder="Profession" aria-label="Profession of token holder" autocomplete="off" data-i18n-local-placeholder data-i18n-local-aria-label>
      </div>
      <textarea id="ultra-skill-check-urls" class="ask-input social-query" rows="2" maxlength="1600" autocomplete="off" spellcheck="false" aria-label="URLs of token holder" placeholder="URLs of token holder, one per line (profile, website, licence page)" data-i18n-local-aria-label data-i18n-local-placeholder></textarea>
      <div id="ultra-skill-check-apps" class="ultra-skills" role="group" aria-label="Apps to search for token holder skills" data-i18n-local-aria-label></div>
      <div class="cctv-controls">
        <select id="ultra-skill-check-swarm" aria-label="Which swarm checks the skills" data-i18n-local-aria-label>
          <option value="xai" data-i18n-local>GROK BOT SWARM</option>
          <option value="openai" data-i18n-local>OPENAI DOT SWARM</option>
          <option value="llm" data-i18n-local>LLM</option>
        </select>
        <button id="ultra-skill-check-run" class="scene-btn" type="submit" data-i18n-local>CHECK SKILLS</button>
        <button id="ultra-skill-check-close" class="scene-btn" type="button" data-i18n-local>CLOSE</button>
      </div>
      <p id="ultra-skill-check-status" class="ultra-note" aria-live="polite"></p>
      <div id="ultra-skill-check-paste" hidden>
        <textarea id="ultra-skill-check-report" class="ask-input social-query" rows="4" maxlength="8000" autocomplete="off" aria-label="Chief of Staff report" placeholder="Paste the Chief of Staff's report here, then READ REPORT" data-i18n-local-aria-label data-i18n-local-placeholder></textarea>
        <div class="cctv-controls">
          <button id="ultra-skill-check-read" class="scene-btn" type="button" data-i18n-local>READ REPORT</button>
        </div>
      </div>
      <ul id="ultra-skill-check-results" class="ultra-skill-check-results"></ul>
    </form>
    <!-- Help network: the handouts (tailnet address + Ultra Token) this machine's server polls, the directory the group shares, my published token and the SMS relay. Other people's tokens are never shown here; only hosts are. -->
    <div class="cctv-summary-label"><span data-i18n-local>HELP NETWORK</span> <span id="ultra-network-count"></span></div>
    <p id="ultra-network-note" class="ultra-note"></p>
    <form id="ultra-network-me" class="cctv-controls ultra-contact">
      <input id="ultra-network-me-name" type="text" maxlength="60" placeholder="Your name, as your holders see it" aria-label="Your network name" autocomplete="off" data-i18n-local-placeholder data-i18n-local-aria-label>
      <button class="scene-btn" type="submit" data-i18n-local>SAVE MY NAME</button>
    </form>
    <form id="ultra-directory" class="cctv-controls ultra-contact">
      <input id="ultra-directory-url" type="url" placeholder="https://raw.githubusercontent.com/<group>/<repo>/main/ultra-directory.json" aria-label="Directory address" autocomplete="off" spellcheck="false" data-i18n-local-placeholder data-i18n-local-aria-label>
      <input id="ultra-directory-token" type="password" placeholder="GitHub write token (optional, never shown)" aria-label="Directory write token" autocomplete="off" data-i18n-local-placeholder data-i18n-local-aria-label>
      <button class="scene-btn" type="submit" data-i18n-local>SAVE DIRECTORY</button>
    </form>
    <div class="cctv-controls">
      <select id="ultra-publish-token" aria-label="Which token to publish" hidden data-i18n-local-aria-label></select>
      <!-- Shown only with more than one package saved and DIRECTORY TOKEN chosen: which package's position the new directory token follows. -->
      <select id="ultra-publish-package" aria-label="Which package to publish" hidden data-i18n-local-aria-label></select>
      <button id="ultra-network-publish" class="scene-btn" type="button" data-i18n-local>PUBLISH MY TOKEN</button>
      <button id="ultra-network-update" class="scene-btn" type="button" data-i18n-local>UPDATE HOME LIST</button>
      <button id="ultra-network-poll" class="scene-btn" type="button" data-i18n-local>CHECK NOW</button>
    </div>
    <div id="ultra-network-entry" class="ultra-reveal" hidden>
      <pre id="ultra-network-entry-text"></pre>
      <p id="ultra-network-entry-note" class="ultra-note"></p>
      <div class="cctv-controls">
        <button id="ultra-network-entry-copy" class="scene-btn" type="button" data-i18n-local>COPY ENTRY</button>
        <a id="ultra-network-entry-mail" class="scene-btn" rel="noopener" hidden data-i18n-local>EMAIL ENTRY</a>
        <button id="ultra-network-entry-hide" class="scene-btn" type="button" data-i18n-local>HIDE</button>
      </div>
    </div>
    <!-- A handout is two boxes: the tailnet address and the Ultra Token. The token is never part of a URL; a legacy whole link pasted into the address box is split before posting. -->
    <form id="ultra-network-add" class="cctv-controls ultra-contact">
      <input id="ultra-network-address" type="text" placeholder="Their tailnet address (https://<machine>.<tailnet>.ts.net)" aria-label="Their tailnet address" autocomplete="off" spellcheck="false" data-i18n-local-placeholder data-i18n-local-aria-label>
      <input id="ultra-network-token" type="text" placeholder="Their Ultra Token (uht1.…)" aria-label="Their Ultra Token" autocomplete="off" spellcheck="false" data-i18n-local-placeholder data-i18n-local-aria-label>
      <input id="ultra-network-link-name" type="text" maxlength="60" placeholder="Their name" aria-label="Their name" autocomplete="off" data-i18n-local-placeholder data-i18n-local-aria-label>
      <button class="scene-btn" type="submit" data-i18n-local>ADD TO HOME LIST</button>
    </form>
    <div id="ultra-network-list"></div>
    <div class="cctv-controls">
      <span id="ultra-sms-relay" class="sst-readout"></span>
      <button id="ultra-sms-test" class="scene-btn" type="button" data-i18n-local>TEST SMS</button>
    </div>
    <!-- ULTRA SECURITY PACKAGE: the package cards (how each phone or tracker connects, its address, login and report-in key), last in the tab. Moved from POWER UP on 2026-10-17 (owner request). src/deviceFeedsSetup.js draws them in this tab's look and src/ultraHelpPanel.js mounts them; hidden until /api/device-feeds answers. -->
    <div id="ultra-package-setup" class="ultra-package-setup" hidden></div>
  </div>
</div>
</template>
