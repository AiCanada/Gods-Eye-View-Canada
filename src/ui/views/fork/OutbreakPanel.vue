<script setup>
import { tl } from '../../../i18n/index.js';
import PanelCollapseButton from '../../rail/PanelCollapseButton.vue';
import { vPanelState } from '../../rail/panelState.js';
</script>

<template>
  <!-- God's Eye View Canada (the fork): the OUTBREAK LOCATIONS & PREDICTED SPREAD box, moved from
       src/ui/templates/layer-panels.html when upstream rendered the templates as Vue views
       (#1499). Its markup is static, so the owner modules that fill it
       (ids, classes) and the data-i18n-local markers translated at boot and on
       each language switch work as they did; the root draws its state from the
       panel chrome store (v-panel-state) and the collapse button is the kit's. -->
  <!-- Outbreak Locations & Predicted Spread: a left-stack box under Social
     Media Analysis. Outbreak locations (Irkutsk and Shelekhov to start,
     any can be added or removed), the travel out of them since the scan
     began, and how far each way of travel could have carried it, drawn
     on the map by the Outbreak layer for the hour picked. -->
<div id="outbreak-panel" class="panel-collapsible collapsed" data-panel-id="outbreak-panel" v-panel-state="'outbreak-panel'">
  <div class="panel-glow"></div>
  <div class="outbreak-panel-inner">
    <div class="panel-header">
      <span class="panel-title" data-collapsed-title="OUTBREAK LOCATIONS &amp; PREDICTED SPREAD" data-i18n-local-collapsed-title data-i18n-local>OUTBREAK LOCATIONS &amp; PREDICTED SPREAD</span>
      <span class="panel-divider"></span>
      <PanelCollapseButton target="outbreak-panel" :name="tl('OUTBREAK LOCATIONS & PREDICTED SPREAD')" start-collapsed />
    </div>
    <div class="cctv-controls">
      <label class="social-show-location" for="outbreak-show">
        <input id="outbreak-show" type="checkbox" aria-label="Display the outbreak and its predicted spread on the map"  data-i18n-local-aria-label/>
        <span data-i18n-local>Display spread on map</span>
      </label>
      <!-- CLEAR MAP: the spread leaves the map; every result is kept.
           CLEAR DATA: the last run's results go (scan, flights, future
           spread, found places, the log) and the map with them; the
           locations and settings stay. -->
      <button id="outbreak-clear-map" class="scene-btn" type="button" title="Take the spread off the map; the results are kept" data-i18n-local-title data-i18n-local>CLEAR MAP</button>
      <button id="outbreak-clear" class="scene-btn" type="button" title="Clear the last run's results for a new run from scratch" data-i18n-local-title data-i18n-local>CLEAR DATA</button>
    </div>
    <div class="cctv-summary-label" data-i18n-local>CURRENT OUTBREAK LOCATIONS</div>
    <ul id="outbreak-locations" class="outbreak-list" aria-label="Outbreak locations" data-i18n-local-aria-label></ul>
    <form id="outbreak-add" class="cctv-controls" autocomplete="off">
      <input id="outbreak-add-name" class="ask-input" type="text" maxlength="80" placeholder="New outbreak location (city, town)" aria-label="New outbreak location"  data-i18n-local-placeholder data-i18n-local-aria-label/>
      <button id="outbreak-add-btn" class="scene-btn" type="submit" data-i18n-local>+ ADD</button>
    </form>
    <div class="cctv-controls">
      <input id="outbreak-keywords" class="ask-input" type="text" maxlength="80" placeholder="Disease or outbreak name (optional)" aria-label="Disease or outbreak name"  data-i18n-local-placeholder data-i18n-local-aria-label/>
    </div>
    <!-- PATHOGEN CHARACTERISTICS (optional): any field left at "Not set" is
         ignored. Set ones suggest a HOW CONTAGIOUS level (USE SUGGESTED
         applies it) and go with every language-model and bot request. -->
    <div class="cctv-summary-label" data-i18n-local>PATHOGEN CHARACTERISTICS (OPTIONAL)</div>
    <!-- A preset fills every field below with typical published values
         (illustrative, not definitive); each field stays editable. -->
    <div class="outbreak-profile">
      <label for="outbreak-preset" data-i18n-local>Pathogen preset</label>
      <select id="outbreak-preset" aria-label="Pathogen preset" data-i18n-local-aria-label>
        <option value="" data-i18n-local>Not set</option>
      </select>
      <label for="outbreak-transmission" data-i18n-local>Transmission mode</label>
      <select id="outbreak-transmission" aria-label="Transmission mode" data-i18n-local-aria-label>
        <option value="" data-i18n-local>Not set</option>
        <option value="airborne" data-i18n-local>Airborne (lingers in the air)</option>
        <option value="droplets" data-i18n-local>Respiratory droplets (coughing, sneezing)</option>
        <option value="contact" data-i18n-local>Direct physical contact</option>
        <option value="fomites" data-i18n-local>Fomites (contaminated surfaces)</option>
        <option value="vector" data-i18n-local>Vector-borne (e.g. mosquitoes)</option>
      </select>
      <label for="outbreak-r0" data-i18n-local>Reproduction number R₀</label>
      <input id="outbreak-r0" type="number" min="0.1" max="20" step="0.1" placeholder="Not set" aria-label="Basic reproduction number R0"  data-i18n-local-placeholder data-i18n-local-aria-label/>
      <label for="outbreak-asymptomatic" data-i18n-local>Asymptomatic transmission</label>
      <select id="outbreak-asymptomatic" aria-label="Asymptomatic transmission" data-i18n-local-aria-label>
        <option value="" data-i18n-local>Not set</option>
        <option value="yes" data-i18n-local>Yes, spreads without symptoms</option>
        <option value="no" data-i18n-local>No, only with symptoms</option>
      </select>
      <label for="outbreak-incubation" data-i18n-local>Incubation period (days)</label>
      <input id="outbreak-incubation" type="number" min="0.5" max="60" step="0.5" placeholder="Not set" aria-label="Incubation period in days"  data-i18n-local-placeholder data-i18n-local-aria-label/>
      <label for="outbreak-mutation" data-i18n-local>Mutation rate</label>
      <select id="outbreak-mutation" aria-label="Mutation rate" data-i18n-local-aria-label>
        <option value="" data-i18n-local>Not set</option>
        <option value="low" data-i18n-local>Low</option>
        <option value="medium" data-i18n-local>Medium</option>
        <option value="high" data-i18n-local>High</option>
      </select>
      <label for="outbreak-latent" data-i18n-local>Latent period (days, infected → infectious)</label>
      <input id="outbreak-latent" type="number" min="0.1" max="60" step="0.1" placeholder="Not set" aria-label="Latent period (days, infected → infectious)"  data-i18n-local-placeholder data-i18n-local-aria-label/>
      <label for="outbreak-infectious" data-i18n-local>Infectious period (days)</label>
      <input id="outbreak-infectious" type="number" min="0.5" max="60" step="0.5" placeholder="Not set" aria-label="Infectious period (days)"  data-i18n-local-placeholder data-i18n-local-aria-label/>
      <label for="outbreak-asym-pct" data-i18n-local>Asymptomatic share (%)</label>
      <input id="outbreak-asym-pct" type="number" min="0" max="95" step="1" placeholder="Not set" aria-label="Asymptomatic share (%)"  data-i18n-local-placeholder data-i18n-local-aria-label/>
      <label for="outbreak-asym-relative" data-i18n-local>Asymptomatic infectiousness (× symptomatic)</label>
      <input id="outbreak-asym-relative" type="number" min="0" max="1.5" step="0.05" placeholder="Not set" aria-label="Asymptomatic infectiousness (× symptomatic)"  data-i18n-local-placeholder data-i18n-local-aria-label/>
      <label for="outbreak-superspreading" data-i18n-local>Superspreading</label>
      <select id="outbreak-superspreading" aria-label="Superspreading" data-i18n-local-aria-label>
        <option value="" data-i18n-local>Not set</option>
      </select>
      <label for="outbreak-hospital" data-i18n-local>Hospitalised (% of symptomatic)</label>
      <input id="outbreak-hospital" type="number" min="0" max="100" step="0.5" placeholder="Not set" aria-label="Hospitalised (% of symptomatic)"  data-i18n-local-placeholder data-i18n-local-aria-label/>
      <label for="outbreak-fatality" data-i18n-local>Fatality (% of symptomatic)</label>
      <input id="outbreak-fatality" type="number" min="0" max="100" step="0.05" placeholder="Not set" aria-label="Fatality (% of symptomatic)"  data-i18n-local-placeholder data-i18n-local-aria-label/>
      <label for="outbreak-hospital-days" data-i18n-local>Hospital stay (days)</label>
      <input id="outbreak-hospital-days" type="number" min="1" max="60" step="1" placeholder="Not set" aria-label="Hospital stay (days)"  data-i18n-local-placeholder data-i18n-local-aria-label/>
      <label for="outbreak-icu" data-i18n-local>Intensive care (% of hospitalised)</label>
      <input id="outbreak-icu" type="number" min="0" max="100" step="5" placeholder="Not set" aria-label="Intensive care (% of hospitalised)"  data-i18n-local-placeholder data-i18n-local-aria-label/>
      <label for="outbreak-admit-delay" data-i18n-local>Admission delay (days)</label>
      <input id="outbreak-admit-delay" type="number" min="0" max="14" step="0.5" placeholder="Not set" aria-label="Admission delay (days)"  data-i18n-local-placeholder data-i18n-local-aria-label/>
      <label for="outbreak-waning" data-i18n-local>Immunity wanes after (days)</label>
      <input id="outbreak-waning" type="number" min="0" max="3650" step="30" placeholder="Not set" aria-label="Immunity wanes after (days)" title="Days until a recovered person can catch it again (0: never)"  data-i18n-local-placeholder data-i18n-local-aria-label data-i18n-local-title/>
      <label for="outbreak-variants" data-i18n-local>Variant emergence</label>
      <select id="outbreak-variants" aria-label="Variant emergence" data-i18n-local-aria-label>
        <option value="" data-i18n-local>Not set</option>
      </select>
      <label for="outbreak-strain2-day" data-i18n-local>Second strain starts (day)</label>
      <input id="outbreak-strain2-day" type="number" min="0" max="40" step="1" placeholder="Not set" aria-label="Second strain starts (day)"  data-i18n-local-placeholder data-i18n-local-aria-label/>
      <label for="outbreak-strain2-cases" data-i18n-local>Second strain seed cases</label>
      <input id="outbreak-strain2-cases" type="number" min="1" max="100000" step="1" placeholder="Not set" aria-label="Second strain seed cases"  data-i18n-local-placeholder data-i18n-local-aria-label/>
      <label for="outbreak-strain2-place" data-i18n-local>Second strain airport code</label>
      <input id="outbreak-strain2-place" type="text" maxlength="4" placeholder="Not set" aria-label="Second strain airport code"  data-i18n-local-placeholder data-i18n-local-aria-label/>
      <label for="outbreak-strain2-spread" data-i18n-local>Second strain transmissibility (% of first)</label>
      <input id="outbreak-strain2-spread" type="number" min="10" max="300" step="5" placeholder="Not set" aria-label="Second strain transmissibility (% of first)"  data-i18n-local-placeholder data-i18n-local-aria-label/>
      <label for="outbreak-strain2-severity" data-i18n-local>Second strain severity (% of first)</label>
      <input id="outbreak-strain2-severity" type="number" min="10" max="500" step="5" placeholder="Not set" aria-label="Second strain severity (% of first)"  data-i18n-local-placeholder data-i18n-local-aria-label/>
      <label for="outbreak-cross-immunity" data-i18n-local>Cross-immunity (% of first-strain immunity kept)</label>
      <input id="outbreak-cross-immunity" type="number" min="0" max="100" step="5" placeholder="Not set" aria-label="Cross-immunity (% of first-strain immunity kept)"  data-i18n-local-placeholder data-i18n-local-aria-label/>
    </div>
    <!-- HUMAN BEHAVIOR & DEMOGRAPHICS (optional): how quickly the people
         at the outbreak let it spread. Like the pathogen, they suggest a
         HOW CONTAGIOUS level and go with every model and bot request. -->
    <div class="cctv-summary-label" data-i18n-local>HUMAN BEHAVIOR &amp; DEMOGRAPHICS (OPTIONAL)</div>
    <div class="outbreak-profile">
      <label for="outbreak-density" data-i18n-local>Population Density Near Patient Zero</label>
      <select id="outbreak-density" aria-label="Population Density Near Patient Zero" data-i18n-local-aria-label>
        <option value="" data-i18n-local>Not set</option>
      </select>
      <label for="outbreak-density-new" data-i18n-local>Population Density of New Infected Locations</label>
      <select id="outbreak-density-new" aria-label="Population Density of New Infected Locations" data-i18n-local-aria-label>
        <option value="" data-i18n-local>Not set</option>
      </select>
      <label for="outbreak-travel" data-i18n-local>Global travel &amp; mobility</label>
      <select id="outbreak-travel" aria-label="Global travel &amp; mobility" data-i18n-local-aria-label>
        <option value="" data-i18n-local>Not set</option>
        <option value="low" data-i18n-local>Low</option>
        <option value="medium" data-i18n-local>Medium</option>
        <option value="high" data-i18n-local>High (major flight and transit hub)</option>
      </select>
      <label for="outbreak-compliance" data-i18n-local>Public compliance &amp; trust</label>
      <select id="outbreak-compliance" aria-label="Public compliance &amp; trust" data-i18n-local-aria-label>
        <option value="" data-i18n-local>Not set</option>
        <option value="high" data-i18n-local>High</option>
        <option value="medium" data-i18n-local>Medium</option>
        <option value="low" data-i18n-local>Low</option>
      </select>
      <label for="outbreak-vulnerability" data-i18n-local>Socioeconomic vulnerability</label>
      <select id="outbreak-vulnerability" aria-label="Socioeconomic vulnerability" data-i18n-local-aria-label>
        <option value="" data-i18n-local>Not set</option>
        <option value="low" data-i18n-local>Low</option>
        <option value="medium" data-i18n-local>Medium</option>
        <option value="high" data-i18n-local>High (no remote work, clean water, sick leave)</option>
      </select>
      <label for="outbreak-season" data-i18n-local>Seasonality &amp; weather</label>
      <select id="outbreak-season" aria-label="Seasonality &amp; weather" data-i18n-local-aria-label>
        <option value="" data-i18n-local>Not set</option>
        <option value="warm" data-i18n-local>Warm and humid</option>
        <option value="mild" data-i18n-local>Mild</option>
        <option value="winter" data-i18n-local>Cold, dry winter</option>
        <option value="rain" data-i18n-local>Heavy rain (people indoors)</option>
      </select>
      <label for="outbreak-immunity" data-i18n-local>Immunity landscape</label>
      <select id="outbreak-immunity" aria-label="Immunity landscape" data-i18n-local-aria-label>
        <option value="" data-i18n-local>Not set</option>
        <option value="novel" data-i18n-local>Novel (no immunity)</option>
        <option value="partial" data-i18n-local>Partial</option>
        <option value="strong" data-i18n-local>Strong (past strains, vaccination)</option>
      </select>
      <label for="outbreak-age" data-i18n-local>Age structure</label>
      <select id="outbreak-age" aria-label="Age structure" data-i18n-local-aria-label>
        <option value="" data-i18n-local>Not set</option>
      </select>
      <label for="outbreak-household" data-i18n-local>Household size</label>
      <select id="outbreak-household" aria-label="Household size" data-i18n-local-aria-label>
        <option value="" data-i18n-local>Not set</option>
      </select>
      <label for="outbreak-healthcare" data-i18n-local>Healthcare &amp; surveillance</label>
      <select id="outbreak-healthcare" aria-label="Healthcare &amp; surveillance" data-i18n-local-aria-label>
        <option value="" data-i18n-local>Not set</option>
      </select>
      <label for="outbreak-response" data-i18n-local>Public response to reported cases</label>
      <select id="outbreak-response" aria-label="Public response to reported cases" data-i18n-local-aria-label>
        <option value="" data-i18n-local>Not set</option>
      </select>
      <label for="outbreak-gathering" data-i18n-local>Mass gathering</label>
      <select id="outbreak-gathering" aria-label="Mass gathering" data-i18n-local-aria-label>
        <option value="" data-i18n-local>Not set</option>
      </select>
      <label for="outbreak-holiday" data-i18n-local>Holiday travel</label>
      <select id="outbreak-holiday" aria-label="Holiday travel" data-i18n-local-aria-label>
        <option value="" data-i18n-local>Not set</option>
      </select>
      <label for="outbreak-transit" data-i18n-local>Public transit crowding</label>
      <select id="outbreak-transit" aria-label="Public transit crowding" data-i18n-local-aria-label>
        <option value="" data-i18n-local>Not set</option>
      </select>
      <label for="outbreak-reservoir" data-i18n-local>Animal reservoir</label>
      <select id="outbreak-reservoir" aria-label="Animal reservoir" data-i18n-local-aria-label>
        <option value="" data-i18n-local>Not set</option>
      </select>
      <label for="outbreak-heterogeneity" data-i18n-local>Susceptibility variation</label>
      <select id="outbreak-heterogeneity" aria-label="Susceptibility variation" data-i18n-local-aria-label>
        <option value="" data-i18n-local>Not set</option>
      </select>
      <label for="outbreak-mixing" data-i18n-local>Commuting mixing</label>
      <select id="outbreak-mixing" aria-label="Commuting mixing" data-i18n-local-aria-label>
        <option value="" data-i18n-local>Not set</option>
      </select>
      <label for="outbreak-commute-day" data-i18n-local>Commuting concentrated in daytime</label>
      <input id="outbreak-commute-day" type="number" min="0.5" max="1" step="0.05" placeholder="Not set" aria-label="Commuting concentrated in daytime" title="0.5: flat all day; 1: all commuting between 7 and 19 local"  data-i18n-local-placeholder data-i18n-local-aria-label data-i18n-local-title/>
      <label for="outbreak-clock" data-i18n-local>Departure clock</label>
      <select id="outbreak-clock" aria-label="Departure clock" data-i18n-local-aria-label>
        <option value="" data-i18n-local>Not set</option>
      </select>
      <label for="outbreak-transfers" data-i18n-local>Airport transfers</label>
      <select id="outbreak-transfers" aria-label="Airport transfers" data-i18n-local-aria-label>
        <option value="" data-i18n-local>Not set</option>
      </select>
      <label for="outbreak-response-signal" data-i18n-local>Response signal</label>
      <select id="outbreak-response-signal" aria-label="Response signal" data-i18n-local-aria-label>
        <option value="" data-i18n-local>Not set</option>
      </select>
      <label for="outbreak-response-reach" data-i18n-local>Response reach</label>
      <select id="outbreak-response-reach" aria-label="Response reach" data-i18n-local-aria-label>
        <option value="" data-i18n-local>Not set</option>
      </select>
      <label for="outbreak-response-fatigue" data-i18n-local>Awareness fatigue (days to halve)</label>
      <input id="outbreak-response-fatigue" type="number" min="0" max="180" step="5" placeholder="Not set" aria-label="Awareness fatigue (days to halve)"  data-i18n-local-placeholder data-i18n-local-aria-label/>
      <label for="outbreak-vaccinated" data-i18n-local>Vaccinated at the start (%)</label>
      <input id="outbreak-vaccinated" type="number" min="0" max="100" step="5" placeholder="Not set" aria-label="Vaccinated at the start (%)"  data-i18n-local-placeholder data-i18n-local-aria-label/>
      <label for="outbreak-vaccine-efficacy" data-i18n-local>Vaccine protection (%)</label>
      <input id="outbreak-vaccine-efficacy" type="number" min="0" max="100" step="5" placeholder="Not set" aria-label="Vaccine protection (%)" title="All-or-nothing protection against infection"  data-i18n-local-placeholder data-i18n-local-aria-label data-i18n-local-title/>
      <label for="outbreak-travel-domestic" data-i18n-local>Domestic flights (% of normal)</label>
      <input id="outbreak-travel-domestic" type="number" min="0" max="300" step="5" placeholder="Not set" aria-label="Domestic flights (% of normal)"  data-i18n-local-placeholder data-i18n-local-aria-label/>
      <label for="outbreak-travel-intl" data-i18n-local>International flights (% of normal)</label>
      <input id="outbreak-travel-intl" type="number" min="0" max="300" step="5" placeholder="Not set" aria-label="International flights (% of normal)"  data-i18n-local-placeholder data-i18n-local-aria-label/>
    </div>
    <div class="cctv-controls">
      <p id="outbreak-suggest" class="social-note outbreak-suggest" data-i18n-local>Set any of these for a suggested HOW CONTAGIOUS level.</p>
      <button id="outbreak-use-suggested" class="scene-btn" type="button" disabled data-i18n-local>USE SUGGESTED</button>
    </div>
    <div class="cctv-summary-label" data-i18n-local>TRAVEL HISTORY</div>
    <div class="cctv-controls">
      <select id="outbreak-days" aria-label="Scan travel history from" data-i18n-local-aria-label>
        <option value="1" data-i18n-local>From 1 day ago</option>
        <option value="2" selected data-i18n-local>From 2 days ago</option>
        <option value="3" data-i18n-local>From 3 days ago</option>
        <option value="5" data-i18n-local>From 5 days ago</option>
        <option value="7" data-i18n-local>From 7 days ago</option>
      </select>
      <button id="outbreak-scan" class="scene-btn" type="button" data-i18n-local>SCAN TRAVEL</button>
    </div>
    <p id="outbreak-scan-note" class="social-note" data-i18n-local>Plane: flight history (POWER UP → OPENSKY), else the chosen language model's airline schedules. Train and boat: OpenStreetMap near each location. Road and train follow the main roads and rail lines from OpenStreetMap: a road lights up dark red and a rail line orange once the spread reaches it; where one seems to end, it carries on along the closest one at the same speed. Roads load farther in steps (500, 2,500 and 8,000 km) so the spread keeps going to the end of the forecast. A circle where they could not be fetched. Red is air, and the road after landing.</p>
    <div class="cctv-summary-label" data-i18n-local>SPREAD BY TRANSPORT</div>
    <div id="outbreak-modes" class="outbreak-modes">
      <label class="outbreak-mode" data-mode="plane"><input id="outbreak-mode-plane" type="checkbox" checked aria-label="Show spread by plane"  data-i18n-local-aria-label/><span class="outbreak-swatch"></span><span data-i18n-local>Plane · Red · flights, then the roads out of each landing airport light up green: 100 km at road speed, onward at ¼</span></label>
      <label class="outbreak-mode" data-mode="train"><input id="outbreak-mode-train" type="checkbox" checked aria-label="Show spread by train"  data-i18n-local-aria-label/><span class="outbreak-swatch"></span><span data-i18n-local>Train · Orange · rail lines light up orange once reached</span> <input id="outbreak-speed-train" class="outbreak-speed" type="number" min="1" max="1000" step="1" value="60" aria-label="Train speed in km/h"  data-i18n-local-aria-label/> <span data-i18n-local>KM/H</span></label>
      <label class="outbreak-mode" data-mode="boat"><input id="outbreak-mode-boat" type="checkbox" checked aria-label="Show spread by boat or vehicle"  data-i18n-local-aria-label/><span class="outbreak-swatch"></span><span data-i18n-local>Boat or vehicle · Yellow · within 100 km</span> <input id="outbreak-speed-boat" class="outbreak-speed" type="number" min="1" max="1000" step="1" value="38" aria-label="Boat or vehicle speed in km/h"  data-i18n-local-aria-label/> <span data-i18n-local>KM/H</span></label>
      <label class="outbreak-mode" data-mode="road"><input id="outbreak-mode-road" type="checkbox" checked aria-label="Show spread by road"  data-i18n-local-aria-label/><span class="outbreak-swatch"></span><span data-i18n-local>Road vehicle · Dark red · main roads light up dark red once reached</span> <input id="outbreak-speed-road" class="outbreak-speed" type="number" min="1" max="1000" step="1" value="100" aria-label="Road speed in km/h"  data-i18n-local-aria-label/> <span data-i18n-local>KM/H</span></label>
    </div>
    <!-- HOW CONTAGIOUS: how the spread is drawn in PLAY and MAP FUTURE
         SPREAD, thicker and darker when high, thinner and lighter when
         low. It does not change how far the spread reaches. -->
    <div class="outbreak-contagion">
      <label for="outbreak-contagion" data-i18n-local>HOW CONTAGIOUS</label>
      <span class="outbreak-contagion-end" data-i18n-local>LOW</span>
      <input id="outbreak-contagion" type="range" min="0" max="110" step="5" value="50" aria-label="How contagious the outbreak is, low to high, then zero hour"  data-i18n-local-aria-label/>
      <span class="outbreak-contagion-end" data-i18n-local>ZERO HOUR</span>
      <span id="outbreak-contagion-value" class="outbreak-contagion-value" data-i18n-local>MEDIUM</span>
    </div>
    <p id="outbreak-contagion-note" class="outbreak-contagion-note" data-i18n-local>Entire airport considered infected after 5.5 h, not just connected flights on infected planes</p>
    <div class="cctv-controls">
      <select id="outbreak-hour" aria-label="Spread shown at hour" data-i18n-local-aria-label></select>
      <button id="outbreak-play" class="scene-btn" type="button" data-i18n-local>PLAY</button>
    </div>
    <!-- FIND FUTURE SPREAD LOCATIONS (left): a new global news search,
         then one request to the chosen model per window up to the reach
         chosen in the menu above it (filled by outbreakPanel.js: 24 h to
         30 days, 30 days by default; within 24 h, then 24 to 48 h, then to
         3, 7, 14 and 30 days) from the scan and the news. Pink: 24 h.
         Violet: later. MAP FUTURE SPREAD (right): plays the present to
         +30 days, hourly to +48 h, then every 6 hours. -->
    <div class="cctv-controls">
      <select id="outbreak-future-days" aria-label="Future spread window" data-i18n-local-aria-label></select>
    </div>
    <div class="cctv-controls outbreak-future-row">
      <button id="outbreak-future" class="scene-btn" type="button" data-i18n-local>FIND FUTURE SPREAD LOCATIONS</button>
      <button id="outbreak-play-future" class="scene-btn" type="button" data-i18n-local>MAP FUTURE SPREAD</button>
    </div>
    <ul id="outbreak-forecast" class="outbreak-list" aria-label="Future spread locations" data-i18n-local-aria-label></ul>
    <!-- INTERVENTIONS (optional): each starts at the hour given, counted
         from the scan's start. They change the EPIDEMIC MODEL only. -->
    <div class="cctv-summary-label" data-i18n-local>INTERVENTIONS (OPTIONAL)</div>
    <div class="outbreak-profile">
      <label for="outbreak-intervention-hour" data-i18n-local>Interventions start (hours after the scan start)</label>
      <input id="outbreak-intervention-hour" type="number" min="0" max="720" step="1" placeholder="Not set" aria-label="Interventions start (hours after the scan start)"  data-i18n-local-placeholder data-i18n-local-aria-label/>
      <label for="outbreak-travel-ban" data-i18n-local>Travel restriction (% fewer passengers)</label>
      <input id="outbreak-travel-ban" type="number" min="0" max="100" step="5" placeholder="Not set" aria-label="Travel restriction (% fewer passengers)"  data-i18n-local-placeholder data-i18n-local-aria-label/>
      <label for="outbreak-exit-screening" data-i18n-local>Exit screening</label>
      <select id="outbreak-exit-screening" aria-label="Exit screening" data-i18n-local-aria-label>
        <option value="" data-i18n-local>Not set</option>
      </select>
      <label for="outbreak-entry-screening" data-i18n-local>Entry screening</label>
      <select id="outbreak-entry-screening" aria-label="Entry screening" data-i18n-local-aria-label>
        <option value="" data-i18n-local>Not set</option>
      </select>
      <label for="outbreak-quarantine" data-i18n-local>Quarantine on arrival (days)</label>
      <input id="outbreak-quarantine" type="number" min="0" max="21" step="1" placeholder="Not set" aria-label="Quarantine on arrival (days)"  data-i18n-local-placeholder data-i18n-local-aria-label/>
      <label for="outbreak-lockdown" data-i18n-local>Lockdown / distancing (% fewer contacts)</label>
      <input id="outbreak-lockdown" type="number" min="0" max="90" step="5" placeholder="Not set" aria-label="Lockdown / distancing (% fewer contacts)" title="Fewer contacts; with Lockdown reach set to outside the home, households keep mixing"  data-i18n-local-placeholder data-i18n-local-aria-label data-i18n-local-title/>
      <label for="outbreak-tracing" data-i18n-local>Contact tracing</label>
      <select id="outbreak-tracing" aria-label="Contact tracing" data-i18n-local-aria-label>
        <option value="" data-i18n-local>Not set</option>
      </select>
      <label for="outbreak-intervention-days" data-i18n-local>Interventions end after (days)</label>
      <input id="outbreak-intervention-days" type="number" min="0" max="40" step="1" placeholder="Not set" aria-label="Interventions end after (days)" title="0: never"  data-i18n-local-placeholder data-i18n-local-aria-label data-i18n-local-title/>
      <label for="outbreak-trigger-mode" data-i18n-local>Local trigger</label>
      <select id="outbreak-trigger-mode" aria-label="Local trigger" data-i18n-local-aria-label>
        <option value="" data-i18n-local>Not set</option>
      </select>
      <label for="outbreak-trigger-level" data-i18n-local>Case trigger (reported per 100,000 in 7 days)</label>
      <input id="outbreak-trigger-level" type="number" min="0" max="500" step="0.5" placeholder="Not set" aria-label="Case trigger (reported per 100,000 in 7 days)"  data-i18n-local-placeholder data-i18n-local-aria-label/>
      <label for="outbreak-trigger-beds" data-i18n-local>Bed trigger (% of beds full)</label>
      <input id="outbreak-trigger-beds" type="number" min="0" max="100" step="5" placeholder="Not set" aria-label="Bed trigger (% of beds full)"  data-i18n-local-placeholder data-i18n-local-aria-label/>
      <label for="outbreak-min-lock-days" data-i18n-local>Minimum restriction (days)</label>
      <input id="outbreak-min-lock-days" type="number" min="1" max="28" step="1" placeholder="Not set" aria-label="Minimum restriction (days)"  data-i18n-local-placeholder data-i18n-local-aria-label/>
      <label for="outbreak-restriction-fatigue" data-i18n-local>Restriction fatigue (days to halve compliance)</label>
      <input id="outbreak-restriction-fatigue" type="number" min="0" max="180" step="5" placeholder="Not set" aria-label="Restriction fatigue (days to halve compliance)"  data-i18n-local-placeholder data-i18n-local-aria-label/>
      <label for="outbreak-lockdown-scope" data-i18n-local>Lockdown reach</label>
      <select id="outbreak-lockdown-scope" aria-label="Lockdown reach" data-i18n-local-aria-label>
        <option value="" data-i18n-local>Not set</option>
      </select>
      <label for="outbreak-border-policy" data-i18n-local>Border policy</label>
      <select id="outbreak-border-policy" aria-label="Border policy" data-i18n-local-aria-label>
        <option value="" data-i18n-local>Not set</option>
      </select>
      <label for="outbreak-border-trigger" data-i18n-local>Border trigger (reported cases in the country)</label>
      <input id="outbreak-border-trigger" type="number" min="1" max="100000" step="1" placeholder="Not set" aria-label="Border trigger (reported cases in the country)"  data-i18n-local-placeholder data-i18n-local-aria-label/>
      <label for="outbreak-import-detection" data-i18n-local>Detection of arriving cases</label>
      <select id="outbreak-import-detection" aria-label="Detection of arriving cases" data-i18n-local-aria-label>
        <option value="" data-i18n-local>Not set</option>
      </select>
      <label for="outbreak-test-capacity" data-i18n-local>Testing capacity (tests per 1,000 people a day)</label>
      <input id="outbreak-test-capacity" type="number" min="0" max="50" step="0.1" placeholder="Not set" aria-label="Testing capacity (tests per 1,000 people a day)"  data-i18n-local-placeholder data-i18n-local-aria-label/>
      <label for="outbreak-vaccine-start" data-i18n-local>Vaccination starts (day)</label>
      <input id="outbreak-vaccine-start" type="number" min="0" max="40" step="1" placeholder="Not set" aria-label="Vaccination starts (day)"  data-i18n-local-placeholder data-i18n-local-aria-label/>
      <label for="outbreak-vaccine-pace" data-i18n-local>Vaccination pace (doses per 1,000 people a day)</label>
      <input id="outbreak-vaccine-pace" type="number" min="0" max="50" step="0.5" placeholder="Not set" aria-label="Vaccination pace (doses per 1,000 people a day)"  data-i18n-local-placeholder data-i18n-local-aria-label/>
      <label for="outbreak-vaccine-cap" data-i18n-local>Vaccination cap (% of people)</label>
      <input id="outbreak-vaccine-cap" type="number" min="0" max="95" step="5" placeholder="Not set" aria-label="Vaccination cap (% of people)"  data-i18n-local-placeholder data-i18n-local-aria-label/>
      <label for="outbreak-vaccine-priority" data-i18n-local>Vaccination priority</label>
      <select id="outbreak-vaccine-priority" aria-label="Vaccination priority" data-i18n-local-aria-label>
        <option value="" data-i18n-local>Not set</option>
      </select>
      <label for="outbreak-compare" data-i18n-local>Compare against</label>
      <select id="outbreak-compare" aria-label="Compare against" data-i18n-local-aria-label>
        <option value="" data-i18n-local>Not set</option>
      </select>
    </div>
    <!-- EPIDEMIC MODEL: a stochastic simulation (src/outbreakEpi.mjs) over
         the scan's flights and normal air traffic, commuting between
         nearby cities, and every field above. Each place gets a chance
         of arrival and an arrival window; the map shades it by that
         chance at the hour shown, so PLAY and MAP FUTURE SPREAD play it.
         The hospital, restriction and border options above add bed
         shortages, per-place triggers and country border closures. A
         second strain and a comparison run against fewer measures are
         optional. -->
    <div class="cctv-summary-label" data-i18n-local>EPIDEMIC MODEL</div>
    <div class="cctv-controls outbreak-epi-row">
      <!-- Each label sits small above its box. -->
      <div class="outbreak-epi-field">
        <label for="outbreak-initial-cases" class="outbreak-epi-label" data-i18n-local>Starting cases</label>
        <input id="outbreak-initial-cases" class="outbreak-speed" type="number" min="1" max="100000" step="1" placeholder="50" aria-label="Starting cases" title="Infected people at the start"  data-i18n-local-aria-label data-i18n-local-title/>
      </div>
      <div class="outbreak-epi-field">
        <label for="outbreak-epi-runs" class="outbreak-epi-label" data-i18n-local>Number of runs</label>
        <select id="outbreak-epi-runs" aria-label="Number of runs" data-i18n-local-aria-label>
          <option value="50" data-i18n-local>50 runs</option>
          <option value="200" selected data-i18n-local>200 runs</option>
          <option value="500" data-i18n-local>500 runs</option>
        </select>
      </div>
      <div class="outbreak-epi-field">
        <label for="outbreak-epi-days" class="outbreak-epi-label" data-i18n-local>Forecast</label>
        <select id="outbreak-epi-days" aria-label="Forecast" data-i18n-local-aria-label>
          <option value="2" selected data-i18n-local>2 days</option>
          <option value="7" data-i18n-local>7 days</option>
          <option value="14" data-i18n-local>14 days</option>
          <option value="30" data-i18n-local>30 days</option>
        </select>
      </div>
      <div class="outbreak-epi-field">
        <label for="outbreak-epi-seed" class="outbreak-epi-label" data-i18n-local>Random seed</label>
        <input id="outbreak-epi-seed" class="outbreak-speed" type="number" min="0" max="4294967295" step="1" placeholder="auto" aria-label="Random seed" title="Same seed, same result; blank picks one from the inputs"  data-i18n-local-placeholder data-i18n-local-aria-label data-i18n-local-title/>
      </div>
    </div>
    <!-- RUN EPIDEMIC MODEL, DOWNLOAD RESULTS and DOWNLOAD CSV: their own
         row under the boxes, same buttons and sizes as before. -->
    <div class="cctv-controls outbreak-epi-actions">
      <button id="outbreak-epi-run" class="scene-btn" type="button" data-i18n-local>RUN EPIDEMIC MODEL</button>
      <button id="outbreak-epi-download" class="scene-btn" type="button" disabled data-i18n-local>DOWNLOAD RESULTS</button>
      <button id="outbreak-epi-csv" class="scene-btn" type="button" disabled data-i18n-local>DOWNLOAD CSV</button>
    </div>
    <label class="outbreak-mode" data-mode="epidemic"><input id="outbreak-mode-epidemic" type="checkbox" checked aria-label="Show the epidemic model on the map"  data-i18n-local-aria-label/><span class="outbreak-swatch"></span><span data-i18n-local>Epidemic model · chance of arrival · commuting</span></label>
    <!-- The epidemic curve: infected (teal, with its 5–95 % band),
         reported (orange) and deaths (red), day by day. -->
    <div id="outbreak-epi-curve" class="outbreak-epi-curve" hidden></div>
    <ul id="outbreak-epidemic" class="outbreak-list" aria-label="Epidemic model results" data-i18n-local-aria-label></ul>
    <ul id="outbreak-summary" class="outbreak-list" aria-label="How far each way of travel has reached" data-i18n-local-aria-label></ul>
    <ul id="outbreak-destinations" class="outbreak-list" aria-label="Places reached by plane" data-i18n-local-aria-label></ul>
    <div class="cctv-summary-label" data-i18n-local>GLOBAL MEDIA SEARCH · LLM</div>
    <div class="cctv-controls">
      <select id="outbreak-model" aria-label="Language model" data-i18n-local-aria-label>
        <option value="" data-i18n-local>No model key yet</option>
      </select>
      <button id="outbreak-media" class="scene-btn" type="button" data-i18n-local>MEDIA SEARCH</button>
    </div>
    <div class="cctv-summary-label" data-i18n-local>GLOBAL SOCIAL MEDIA SEARCH</div>
    <div class="cctv-controls">
      <select id="outbreak-swarm" aria-label="Social media search bot" data-i18n-local-aria-label>
        <option value="xai" data-i18n-local>Grok Bot</option>
        <option value="openai" data-i18n-local>OpenAI DOTS</option>
      </select>
      <button id="outbreak-social" class="scene-btn" type="button" data-i18n-local>SOCIAL SEARCH</button>
    </div>
    <div class="cctv-summary-label" data-i18n-local>NEW LOCATIONS FOUND</div>
    <ul id="outbreak-found" class="outbreak-list" aria-label="New outbreak locations found" data-i18n-local-aria-label></ul>
    <div id="outbreak-status" class="ask-status" role="status" aria-live="polite"></div>
    <div id="outbreak-output" class="ask-output" role="status" aria-live="polite" tabindex="0"></div>
  </div>
</div>
</template>
