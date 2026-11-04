<script setup>
import { tl } from '../../../i18n/index.js';
import PanelCollapseButton from '../../rail/PanelCollapseButton.vue';
import { vPanelState } from '../../rail/panelState.js';
</script>

<template>
  <!-- God's Eye View Canada (the fork): the SOCIAL MEDIA ANALYSIS box, moved from
       src/ui/templates/layer-panels.html when upstream rendered the templates as Vue views
       (#1499). Its markup is static, so the owner modules that fill it
       (ids, classes) and the data-i18n-local markers translated at boot and on
       each language switch work as they did; the root draws its state from the
       panel chrome store (v-panel-state) and the collapse button is the kit's. -->
  <!-- Social Media Analysis: a left-stack box under CCTV. The user id and
     password stay encrypted on this computer. Analyze, Breaking News, and
     Search look up public news for the map place, then send one question. -->
<div id="social-panel" class="panel-collapsible collapsed" data-panel-id="social-panel" v-panel-state="'social-panel'">
  <div class="panel-glow"></div>
  <div class="social-panel-inner">
    <div class="panel-header">
      <span class="panel-title" data-collapsed-title="SOCIAL MEDIA ANALYSIS" data-i18n-local-collapsed-title data-i18n-local>SOCIAL MEDIA ANALYSIS</span>
      <span class="panel-divider"></span>
      <PanelCollapseButton target="social-panel" :name="tl('SOCIAL MEDIA ANALYSIS')" start-collapsed />
    </div>
    <!-- The note, the Power Up count and the heading sit flush, with no space between. -->
    <p class="social-note social-flush" data-i18n-local>Your API Keys, User Id's and Passwords stay encrypted on this computer for integrating AI Tools</p>
    <p id="social-powerup" class="social-powerup social-flush" data-i18n-local>0/0 Power Ups Attained</p>
    <div class="cctv-summary-label social-flush" data-i18n-local>Social Media/The Gig Economy/On-Demand Delivery Platforms</div>
    <div class="cctv-controls">
      <select id="social-account-platform" aria-label="Account platform" data-i18n-local-aria-label>
        <optgroup label="Social Media" data-i18n-local-label>
        <option value="facebook" data-i18n-local>Facebook</option>
        <option value="instagram" data-i18n-local>Instagram</option>
        <option value="threads" data-i18n-local>Threads</option>
        <option value="x">X</option>
        <option value="truth" data-i18n-local>Truth Social</option>
        <option value="snapchat" data-i18n-local>Snapchat</option>
        <option value="tiktok" data-i18n-local>TikTok</option>
        <option value="find-my" data-i18n-local>Apple Find My</option>
        <option value="google-maps" data-i18n-local>Google Maps</option>
        <option value="bump" data-i18n-local>Bump</option>
        <option value="blink" data-i18n-local>Blink</option>
        <option value="life360" data-i18n-local>Life360</option>
        <option value="radarly" data-i18n-local>Radarly</option>
        <option value="buzzly" data-i18n-local>Buzzly</option>
        <option value="vicinity" data-i18n-local>Vicinity</option>
        <option value="nearjoy" data-i18n-local>NearJoy</option>
        <option value="happn" data-i18n-local>Happn</option>
        <option value="pure" data-i18n-local>Pure</option>
        <option value="sniffies" data-i18n-local>Sniffies</option>
        </optgroup>
        <!-- HELP locations from these, and sending HELP through them with Find Ultra Help, are under development. -->
        <optgroup label="The Gig Economy / On-Demand Delivery" data-i18n-local-label>
        <option value="doordash" data-i18n-local>DoorDash</option>
        <option value="uber" data-i18n-local>Uber</option>
        <option value="lyft" data-i18n-local>Lyft</option>
        <option value="just-eat-takeaway" data-i18n-local>Just Eat Takeaway</option>
        <option value="delivery-hero" data-i18n-local>Delivery Hero</option>
        <option value="grubhub" data-i18n-local>Grubhub</option>
        </optgroup>
      </select>
    </div>
    <p id="social-account-note" class="social-note" hidden></p>
    <!-- HELP DELIVERY: what the gig and delivery platforms would bring. Each GEVC keeps its own default in this browser; sending it is under development. -->
    <div class="cctv-summary-label" data-i18n-local>HELP DELIVERY · On-Demand Delivery / The Gig Economy</div>
    <div class="cctv-controls">
      <select id="social-help-kind" aria-label="Help item to be delivered" data-i18n-local-aria-label>
        <option value="medicine" data-i18n-local>Medicine</option>
        <option value="transportation" data-i18n-local>Transportation</option>
        <option value="food" data-i18n-local>Food</option>
        <option value="liquid" data-i18n-local>Liquid</option>
        <option value="items" data-i18n-local>Items</option>
      </select>
      <select id="social-help-destination" aria-label="Take from current location to" hidden data-i18n-local-aria-label>
        <option value="home" data-i18n-local>From current location to Home</option>
        <option value="hospital" data-i18n-local>From current location to Hospital</option>
      </select>
    </div>
    <div class="cctv-controls" id="social-help-entries">
      <input id="social-help-item-1" class="ask-input" type="text" maxlength="80" autocomplete="off" placeholder="Medication 1" aria-label="Medication 1"  data-i18n-local-placeholder data-i18n-local-aria-label/>
      <input id="social-help-item-2" class="ask-input" type="text" maxlength="80" autocomplete="off" placeholder="Medication 2" aria-label="Medication 2"  data-i18n-local-placeholder data-i18n-local-aria-label/>
    </div>
    <div class="cctv-controls">
      <button id="social-help-save" class="scene-btn" type="button" data-i18n-local>SAVE MY DEFAULT</button>
    </div>
    <p id="social-help-default" class="social-note" data-i18n-local>No default saved yet. Sending HELP through these platforms is under development.</p>
    <div class="cctv-controls">
      <input id="social-account-handle" class="ask-input" type="text" maxlength="128" autocomplete="off" spellcheck="false" placeholder="User id" aria-label="User id"  data-i18n-local-placeholder data-i18n-local-aria-label/>
    </div>
    <div class="cctv-controls">
      <input id="social-account-password" class="ask-input" type="password" maxlength="256" autocomplete="off" spellcheck="false" placeholder="Password" aria-label="Password"  data-i18n-local-placeholder data-i18n-local-aria-label/>
      <button id="social-account-save" class="scene-btn" type="button" data-i18n-local>SAVE LOGIN</button>
    </div>
    <div class="cctv-controls">
      <input id="social-account-apikey" class="ask-input" type="password" maxlength="512" autocomplete="off" spellcheck="false" placeholder="API key" aria-label="API key"  data-i18n-local-placeholder data-i18n-local-aria-label/>
    </div>
    <div class="cctv-controls">
      <button id="social-account-open" class="scene-btn" type="button" data-i18n-local>OPEN SITE</button>
    </div>
    <div class="cctv-controls">
      <select id="social-open-kind" aria-label="Which saved sites to open" data-i18n-local-aria-label>
        <option value="login" selected data-i18n-local>ID &amp; Pass</option>
        <option value="api" data-i18n-local>API</option>
        <option value="all" data-i18n-local>All</option>
      </select>
      <button id="social-open-saved" class="scene-btn" type="button" data-i18n-local>OPEN ID &amp; PASS SITES</button>
    </div>
    <ul id="social-account-list" class="social-account-list" aria-label="Saved accounts" data-i18n-local-aria-label></ul>
    <div class="cctv-controls">
      <label class="social-show-location" for="social-show-location">
        <input id="social-show-location" type="checkbox" checked aria-label="Show live location on the map"  data-i18n-local-aria-label/>
        <span data-i18n-local>SHOW ON MAP</span>
      </label>
    </div>
    <p id="social-location-note" class="social-note" data-i18n-local>A hooked-up account that shares location displays live position on the map. If allowed by 3rd Party.</p>
    <div class="cctv-summary-label" data-i18n-local>LLM</div>
    <textarea id="social-query" class="ask-input social-query" rows="3" autocomplete="off" aria-label="Analysis, news question, or help to send" placeholder="Type the analysis, news question, or help to send" data-i18n-local-aria-label data-i18n-local-placeholder></textarea>
    <div class="cctv-controls">
      <select id="social-model" aria-label="Language model" data-i18n-local-aria-label>
        <option value="" data-i18n-local>No model key yet</option>
      </select>
    </div>
    <div class="cctv-controls">
      <button id="social-analyze" class="scene-btn" type="button" data-i18n-local>ANALYZE</button>
      <select id="social-analyze-platform" aria-label="Platform to analyze" data-i18n-local-aria-label>
        <option value="all" data-i18n-local>All platforms</option>
        <option value="facebook" data-i18n-local>Facebook</option>
        <option value="instagram" data-i18n-local>Instagram</option>
        <option value="threads" data-i18n-local>Threads</option>
        <option value="x">X</option>
        <option value="truth" data-i18n-local>Truth Social</option>
        <option value="snapchat" data-i18n-local>Snapchat</option>
        <option value="tiktok" data-i18n-local>TikTok</option>
      </select>
    </div>
    <div class="cctv-controls">
      <button id="social-news" class="scene-btn" type="button" data-i18n-local>BREAKING NEWS</button>
      <select id="social-news-platform" aria-label="Platform for breaking news" data-i18n-local-aria-label>
        <option value="all" data-i18n-local>All</option>
        <option value="facebook" data-i18n-local>Facebook</option>
        <option value="instagram" data-i18n-local>Instagram</option>
        <option value="threads" data-i18n-local>Threads</option>
        <option value="x">X</option>
        <option value="truth" data-i18n-local>Truth Social</option>
        <option value="tiktok" data-i18n-local>TikTok</option>
      </select>
    </div>
    <div class="cctv-controls">
      <button id="social-search" class="scene-btn" type="button" data-i18n-local>SEARCH</button>
    </div>
    <div class="cctv-summary-label" data-i18n-local>FIND HELP TO SEND</div>
    <div class="cctv-controls">
      <button id="social-help" class="scene-btn" type="button" data-i18n-local>FIND HELP</button>
      <select id="social-help-platform" aria-label="Location option for finding help" data-i18n-local-aria-label>
        <option value="all" data-i18n-local>All location options</option>
        <option value="find-my" data-i18n-local>Apple Find My</option>
        <option value="google-maps" data-i18n-local>Google Maps</option>
        <option value="snap-map" data-i18n-local>Snapchat Snap Map</option>
        <option value="bump" data-i18n-local>Bump</option>
        <option value="blink" data-i18n-local>Blink</option>
        <option value="life360" data-i18n-local>Life360</option>
        <option value="radarly" data-i18n-local>Radarly</option>
        <option value="buzzly" data-i18n-local>Buzzly</option>
        <option value="vicinity" data-i18n-local>Vicinity</option>
        <option value="nearjoy" data-i18n-local>NearJoy</option>
        <option value="happn" data-i18n-local>Happn</option>
        <option value="pure" data-i18n-local>Pure</option>
        <option value="sniffies" data-i18n-local>Sniffies</option>
        <option value="instagram-map" data-i18n-local>Instagram Map</option>
        <option value="facebook-checkin" data-i18n-local>Facebook check-ins</option>
        <option value="instagram-checkin" data-i18n-local>Instagram check-ins</option>
        <option value="x-checkin" data-i18n-local>X check-ins</option>
      </select>
    </div>
    <!-- Bot swarms: one bot per platform, each a single request with the provider's own search, all sent at once on the swarm's own key in POWER UP (GROK BOT, OPENAI DOTS). Answers land in this log. No login is kept here. -->
    <div class="cctv-summary-label" data-i18n-local>GROK BOT SWARM</div>
    <textarea id="social-swarm-xai-instructions" class="ask-input social-query" rows="3" maxlength="1000" autocomplete="off" aria-label="Grok bot instructions" placeholder="Grok bot instructions. Leave empty for the default: threat incidents near this map place." data-i18n-local-aria-label data-i18n-local-placeholder></textarea>
    <div class="cctv-controls">
      <button id="social-swarm-xai-run" class="scene-btn" type="button" data-i18n-local>GROK BOT SWARM</button>
      <button id="social-swarm-xai-open" class="scene-btn" type="button" data-i18n-local>OPEN GROK BOT</button>
    </div>
    <div id="social-swarm-xai-status" class="ask-status" role="status" aria-live="polite"></div>
    <div class="cctv-summary-label" data-i18n-local>OPENAI BOT SWARM</div>
    <textarea id="social-swarm-openai-instructions" class="ask-input social-query" rows="3" maxlength="1000" autocomplete="off" aria-label="OpenAI bot instructions" placeholder="OpenAI bot instructions. Leave empty for the default: threat incidents near this map place." data-i18n-local-aria-label data-i18n-local-placeholder></textarea>
    <div class="cctv-controls">
      <button id="social-swarm-openai-run" class="scene-btn" type="button" data-i18n-local>OPENAI BOT SWARM</button>
      <button id="social-swarm-openai-open" class="scene-btn" type="button" data-i18n-local>OPEN CHATGPT</button>
    </div>
    <div id="social-swarm-openai-status" class="ask-status" role="status" aria-live="polite"></div>
    <div id="social-status" class="ask-status" role="status" aria-live="polite"></div>
    <div id="social-output" class="ask-output" role="status" aria-live="polite" tabindex="0"></div>
  </div>
</div>
</template>
