<script setup>
import { tl } from '../../../i18n/index.js';
import PanelCollapseButton from '../../rail/PanelCollapseButton.vue';
import { vPanelState } from '../../rail/panelState.js';
</script>

<template>
  <!-- God's Eye View Canada (the fork): the ARTIFICIAL INTELLIGENCE WORLD TRAINING SIM box, moved from
       src/ui/templates/layer-panels.html when upstream rendered the templates as Vue views
       (#1499). Its markup is static, so the owner modules that fill it
       (ids, classes) and the data-i18n-local markers translated at boot and on
       each language switch work as they did; the root draws its state from the
       panel chrome store (v-panel-state) and the collapse button is the kit's. -->
  <!-- Artificial Intelligence World Training Sim: a left-stack box under
     Outbreak. TRAIN ON is one tick box per data layer, then news events,
     population demographics, outbreak sim episodes and the owner's
     devices, with ALL first. INITIALIZE shows an estimate before it
     starts anything; DELETE lists exactly what it would remove, and a
     second press inside the box removes it. STATUS follows each stage;
     PREDICTIONS picks what the globe draws. The rows, the status and the
     lists are filled by src/aiWorldPanel.js from /api/ai-world
     (docs/AI-WORLD-TAB.md). -->
<div id="ai-world-panel" class="panel-collapsible collapsed" data-panel-id="ai-world-panel" v-panel-state="'ai-world-panel'">
  <div class="panel-glow"></div>
  <div class="ai-world-panel-inner">
    <div class="panel-header">
      <span class="panel-title" data-collapsed-title="ARTIFICIAL INTELLIGENCE WORLD TRAINING SIM" data-i18n-local-collapsed-title data-i18n-local>ARTIFICIAL INTELLIGENCE WORLD TRAINING SIM</span>
      <span class="panel-divider"></span>
      <PanelCollapseButton target="ai-world-panel" :name="tl('ARTIFICIAL INTELLIGENCE WORLD TRAINING SIM')" start-collapsed />
    </div>
    <div id="ai-world-status" class="ask-status" role="status" aria-live="polite"></div>
    <details id="ai-world-howto" class="ai-world-howto">
      <summary data-i18n-local>INSTRUCTIONS</summary>
      <ol class="ai-world-list">
        <li data-i18n-local>TRAIN ON: tick the data layers, FINANCIAL ASSETS, NEWS EVENTS and DEMOGRAPHICS (or ALL). Military is never used.</li>
        <li data-i18n-local>AREAS: move the map and ADD VIEW AS AREA where cameras, traffic, news and imagery should record.</li>
        <li data-i18n-local>INITIALIZE: check the estimate and the storage cap, then CONFIRM INITIALIZE. Recording starts.</li>
        <li data-i18n-local>Each finished day is binned, then the world model trains or post-trains by itself; STATUS shows it.</li>
        <li data-i18n-local>PREDICTIONS: tick a domain once it is trained (PRICE MOVES draws each asset's predicted move where it trades) and set the HORIZON.</li>
        <li data-i18n-local>POST-TRAIN: keep another world model up to date with an adapter and its checkpoint.</li>
        <li data-i18n-local>Your own model: export the data, or use the reinforcement-learning environment. A custom LLM trains in CUSTOM LLM TRAINING, at the bottom of this tab.</li>
        <li data-i18n-local>TENSORFLOW: open a section to train a Keras world model, see every training curve in TensorBoard, export TFRecords, a SavedModel and TFLite, or post-train a Keras model. The GPU needs npm run tensorflow:wsl-setup once.</li>
        <li data-i18n-local>MLFLOW: every training run is tracked in MLflow on this PC; open MLFLOW UI to compare runs, register a model as a CHAMPION or CHALLENGER version, serve it, evaluate the registered world models against persistence, or ask a custom LLM with a trace.</li>
      </ol>
      <p class="social-note" data-i18n-local>Full instructions: docs/TRAINING-GUIDE.md</p>
    </details>
    <div class="cctv-summary-label" data-i18n-local>TRAIN ON</div>
    <p id="ai-world-military-note" class="social-note" data-i18n-local>Military layers and military flights are not used for training.</p>
    <label class="outbreak-mode ai-world-all" data-class="all"><input id="ai-world-all" type="checkbox" /><span class="outbreak-swatch"></span><span data-i18n-local>ALL</span></label>
    <ul id="ai-world-sources" class="ai-world-list ai-world-sources" aria-label="Data the AI trains on" data-i18n-local-aria-label></ul>
    <!-- AREAS: cameras, traffic, news, recent imagery, street level and
         the mapped static layers record around these places only. ADD
         VIEW AS AREA adds the place in the middle of the map; REMOVE
         stops recording there and keeps what was recorded (refused on the
         owner's phone, as every removal is). -->
    <div class="cctv-summary-label" data-i18n-local>AREAS</div>
    <ul id="ai-world-areas" class="ai-world-list ai-world-areas" aria-label="Areas recorded around" data-i18n-local-aria-label></ul>
    <div class="cctv-controls ai-world-actions">
      <button id="ai-world-area-add" class="scene-btn" type="button" title="Adds the place in the middle of the map: cameras, traffic, news, imagery and street level record around each area" data-i18n-local-title data-i18n-local>ADD VIEW AS AREA</button>
    </div>
    <div class="cctv-summary-label" data-i18n-local>NEWS EVENTS</div>
    <p id="ai-world-news-count" class="social-note">0 / 100</p>
    <ul id="ai-world-news-urls" class="ai-world-list" aria-label="News URLs" data-i18n-local-aria-label></ul>
    <div class="cctv-controls ai-world-actions">
      <input id="ai-world-news-url" type="url" maxlength="2000" placeholder="https://…" aria-label="News URL"  data-i18n-local-placeholder data-i18n-local-aria-label/>
      <button id="ai-world-news-add" class="scene-btn" type="button" data-i18n-local>ADD</button>
    </div>
    <div class="cctv-summary-label" data-i18n-local>FINANCIAL ASSETS</div>
    <p class="social-note" data-i18n-local>Live quotes: currencies, yields, commodities, stock indexes, volatility and crypto. Once trained, each shows its predicted move, and PRICE MOVES draws them where each benchmark is set. Not a recommendation. The same hour is kept beside news, ships, traffic, weather, and flights. That is not a claim one moved the other.</p>
    <ul id="ai-world-markets" class="ai-world-list" aria-label="Live financial asset quotes" data-i18n-local-aria-label></ul>
    <div class="cctv-summary-label" data-i18n-local>CONTROLS</div>
    <div class="cctv-controls ai-world-actions">
      <button id="ai-world-init" class="scene-btn" type="button" title="Shows the storage and compute estimate first, then starts on CONFIRM INITIALIZE" data-i18n-local-title data-i18n-local>INITIALIZE</button>
      <button id="ai-world-pause" class="scene-btn" type="button" title="PAUSE holds the work where it is; CONTINUE resumes it" disabled data-i18n-local-title data-i18n-local>PAUSE</button>
      <button id="ai-world-stop" class="scene-btn" type="button" title="Stops recording, sim episodes and training; the data stays" disabled data-i18n-local-title data-i18n-local>STOP</button>
      <button id="ai-world-delete" class="scene-btn" type="button" title="Lists the files first; a second press in the box deletes them" data-i18n-local-title data-i18n-local>DELETE</button>
    </div>
    <div id="ai-world-estimate" class="ai-world-block" hidden>
      <div class="cctv-summary-label" data-i18n-local>ESTIMATE</div>
      <ul id="ai-world-estimate-lines" class="ai-world-list" aria-label="What INITIALIZE will use" data-i18n-local-aria-label></ul>
      <div class="ai-world-fields">
        <label for="ai-world-cap" data-i18n-local>STORAGE CAP (GB)</label>
        <input id="ai-world-cap" type="number" min="1" max="100000" step="1" value="600" />
        <label id="ai-world-scenarios-label" for="ai-world-scenarios" hidden data-i18n-local>SIM SCENARIOS</label>
        <input id="ai-world-scenarios" type="number" min="1" max="1000000" step="1" value="2000" hidden />
      </div>
      <div class="cctv-controls">
        <button id="ai-world-init-confirm" class="scene-btn" type="button" disabled data-i18n-local>CONFIRM INITIALIZE</button>
        <button id="ai-world-init-cancel" class="scene-btn" type="button" aria-label="Cancel initialize" data-i18n-local-aria-label data-i18n-local>CANCEL</button>
      </div>
    </div>
    <div id="ai-world-delete-panel" class="ai-world-block ai-world-block-danger" hidden>
      <div class="cctv-summary-label" data-i18n-local>WHAT DELETE WILL REMOVE</div>
      <div class="cctv-controls">
        <select id="ai-world-delete-scope" aria-label="What to delete" data-i18n-local-aria-label>
          <option value="all" selected data-i18n-local>ALL DATA</option>
          <option value="tape" data-i18n-local>TAPE</option>
          <option value="bins" data-i18n-local>BINS</option>
          <option value="datasets" data-i18n-local>SIM DATASETS</option>
          <option value="worlds" data-i18n-local>WORLDS</option>
          <option value="models" data-i18n-local>MODELS</option>
          <option value="predictions" data-i18n-local>PREDICTIONS</option>
          <option value="demographics" data-i18n-local>DEMOGRAPHICS</option>
        </select>
      </div>
      <ul id="ai-world-delete-groups" class="ai-world-list" aria-label="Files that will be deleted" data-i18n-local-aria-label></ul>
      <p id="ai-world-delete-total" class="social-note"></p>
      <div class="cctv-controls">
        <button id="ai-world-delete-confirm" class="scene-btn ultra-danger" type="button" disabled data-i18n-local>DELETE LISTED FILES</button>
        <button id="ai-world-delete-cancel" class="scene-btn" type="button" aria-label="Cancel delete" data-i18n-local-aria-label data-i18n-local>CANCEL</button>
      </div>
    </div>
    <div class="cctv-summary-label" data-i18n-local>STATUS</div>
    <ul id="ai-world-stages" class="ai-world-list" aria-label="Status of each stage" data-i18n-local-aria-label>
      <li id="ai-world-stage-state" data-i18n-local>STATE · WAITING FOR THE SERVER</li>
      <li id="ai-world-stage-recorder" data-i18n-local>RECORDING · OFF</li>
      <li id="ai-world-stage-generator" data-i18n-local>SIM EPISODES · OFF</li>
      <li id="ai-world-stage-trainer" data-i18n-local>TRAINING · OFF</li>
      <li id="ai-world-stage-predictor" data-i18n-local>PREDICTING · OFF</li>
      <li id="ai-world-stage-storage" data-i18n-local>STORAGE · NOTHING RECORDED</li>
      <li id="ai-world-stage-gaps" data-i18n-local>GAPS · NONE</li>
      <li id="ai-world-stage-compute" data-i18n-local>COMPUTE · WAITING FOR THE SERVER</li>
      <li id="ai-world-stage-links" class="ai-world-measured" hidden></li>
    </ul>
    <!-- POST-TRAIN: keep an existing world model up to date on the newest
         recordings (ml.gevtape.posttrain). The kit's own world model does
         this by itself every day. The adapter must be a file in
         ml/adapters/ or .gev-data/ai-world/adapters/, the checkpoint a path
         inside .gev-data/. -->
    <div class="cctv-summary-label" data-i18n-local>POST-TRAIN</div>
    <p id="ai-world-posttrain-note" class="social-note" data-i18n-local>The kit's own world model post-trains itself every day on all recorded days, and grows when a new layer or asset arrives.</p>
    <div class="ai-world-fields">
      <label for="ai-world-posttrain-adapter" data-i18n-local>ADAPTER</label>
      <input id="ai-world-posttrain-adapter" type="text" maxlength="130" placeholder="kit_world:KitWorldAdapter" autocomplete="off" spellcheck="false"  data-i18n-local-placeholder/>
      <label for="ai-world-posttrain-checkpoint" data-i18n-local>CHECKPOINT</label>
      <input id="ai-world-posttrain-checkpoint" type="text" maxlength="400" placeholder="path inside .gev-data/" autocomplete="off" spellcheck="false"  data-i18n-local-placeholder/>
    </div>
    <label class="outbreak-mode ai-world-all" data-class="all"><input id="ai-world-posttrain-daily" type="checkbox" /><span class="outbreak-swatch"></span><span data-i18n-local>POST-TRAIN DAILY ON NEW DATA</span></label>
    <div class="cctv-controls ai-world-actions">
      <button id="ai-world-posttrain-save" class="scene-btn" type="button" data-i18n-local>SAVE</button>
      <button id="ai-world-posttrain-run" class="scene-btn" type="button" title="Post-trains the model now on every recorded day; the last days are held out to score it before and after" data-i18n-local-title data-i18n-local>POST-TRAIN NOW</button>
    </div>
    <!-- PREDICTIONS: a domain is a live tick once the predictor draws it,
         LEARNING until then. The choice and the horizon stay in this
         browser and go to the globe overlay. -->
    <div class="cctv-summary-label" data-i18n-local>PREDICTIONS</div>
    <label class="outbreak-mode ai-world-all" data-class="all"><input id="ai-world-predict-all" type="checkbox" /><span class="outbreak-swatch"></span><span data-i18n-local>ALL PREDICTIONS</span></label>
    <div id="ai-world-domains" class="ai-world-domains" role="group" aria-label="Predictions drawn on the globe" data-i18n-local-aria-label>
      <div class="ai-world-row"><label class="outbreak-mode" data-domain="outbreak"><input id="ai-world-domain-outbreak" type="checkbox" aria-label="Predict outbreak" aria-describedby="ai-world-domain-outbreak-note" disabled  data-i18n-local-aria-label/><span class="outbreak-swatch"></span><span data-i18n-local>OUTBREAK</span></label><span id="ai-world-domain-outbreak-note" class="ai-world-note" data-i18n-local>LEARNING</span></div>
      <div class="ai-world-row"><label class="outbreak-mode" data-domain="mobility"><input id="ai-world-domain-mobility" type="checkbox" aria-label="Predict mobility" aria-describedby="ai-world-domain-mobility-note" disabled  data-i18n-local-aria-label/><span class="outbreak-swatch"></span><span data-i18n-local>MOBILITY</span></label><span id="ai-world-domain-mobility-note" class="ai-world-note" data-i18n-local>LEARNING</span></div>
      <div class="ai-world-row"><label class="outbreak-mode" data-domain="weather"><input id="ai-world-domain-weather" type="checkbox" aria-label="Predict weather" aria-describedby="ai-world-domain-weather-note" disabled  data-i18n-local-aria-label/><span class="outbreak-swatch"></span><span data-i18n-local>WEATHER</span></label><span id="ai-world-domain-weather-note" class="ai-world-note" data-i18n-local>LEARNING</span></div>
      <div class="ai-world-row"><label class="outbreak-mode" data-domain="hazards"><input id="ai-world-domain-hazards" type="checkbox" aria-label="Predict hazards" aria-describedby="ai-world-domain-hazards-note" disabled  data-i18n-local-aria-label/><span class="outbreak-swatch"></span><span data-i18n-local>HAZARDS</span></label><span id="ai-world-domain-hazards-note" class="ai-world-note" data-i18n-local>LEARNING</span></div>
      <div class="ai-world-row"><label class="outbreak-mode" data-domain="news"><input id="ai-world-domain-news" type="checkbox" aria-label="Predict news" aria-describedby="ai-world-domain-news-note" disabled  data-i18n-local-aria-label/><span class="outbreak-swatch"></span><span data-i18n-local>NEWS</span></label><span id="ai-world-domain-news-note" class="ai-world-note" data-i18n-local>LEARNING</span></div>
      <div class="ai-world-row"><label class="outbreak-mode" data-domain="tracks"><input id="ai-world-domain-tracks" type="checkbox" aria-label="Predict tracks" aria-describedby="ai-world-domain-tracks-note" disabled  data-i18n-local-aria-label/><span class="outbreak-swatch"></span><span data-i18n-local>TRACKS</span></label><span id="ai-world-domain-tracks-note" class="ai-world-note" data-i18n-local>LEARNING</span></div>
    </div>
    <div class="cctv-summary-label" data-i18n-local>INFER</div>
    <div class="cctv-controls ai-world-actions">
      <select id="ai-world-infer-kind" aria-label="What to infer" data-i18n-local-aria-label>
        <option value="location" selected data-i18n-local>LOCATION</option>
        <option value="item" data-i18n-local>ITEM</option>
        <option value="topic" data-i18n-local>TOPIC</option>
        <option value="event" data-i18n-local>EVENT</option>
      </select>
      <input id="ai-world-infer-query" type="text" maxlength="200" placeholder="Place, id, topic, or event" aria-label="Infer query"  data-i18n-local-placeholder data-i18n-local-aria-label/>
      <button id="ai-world-infer" class="scene-btn" type="button" title="Predict from the trained model for this place, item, topic, or event. An empty location uses the middle of the map." data-i18n-local-title data-i18n-local>ASK</button>
    </div>
    <p id="ai-world-infer-note" class="social-note"></p>
    <div class="ai-world-horizon">
      <label for="ai-world-horizon" data-i18n-local>HORIZON</label>
      <input id="ai-world-horizon" type="range" min="1" max="168" step="1" value="24" aria-valuetext="24 HOURS" />
      <output id="ai-world-horizon-value" class="ai-world-horizon-value" for="ai-world-horizon">24 H</output>
    </div>
    <div id="ai-world-output" class="ask-output" role="status" aria-live="polite" tabindex="0"></div>
    <!-- TENSORFLOW (owner request 2026-10-17): four expandable sections,
         TENSORFLOW TRAINING, TENSORBOARD, EXPORT FOR TENSORFLOW and
         POST-TRAIN A TENSORFLOW MODEL (src/tensorflowSetup.js,
         /api/tensorflow), on the GPU through WSL2 when it is set up.
         Hidden until the server answers. -->
    <div id="tensorflow-tools" class="ai-world-tf-tools" hidden></div>
    <!-- MLFLOW (owner request 2026-10-17): six expandable sections,
         MLFLOW TRACKING, MLFLOW UI, MODEL REGISTRY, MODEL SERVING,
         EVALUATION and LLM TRACING (src/mlflowSetup.js, /api/mlflow),
         all on this PC in .gev-data/mlflow/. Hidden until the server
         answers. -->
    <div id="mlflow-tools" class="ai-world-tf-tools ai-world-mlflow-tools" hidden></div>
    <!-- CUSTOM LLM TRAINING (owner request 2026-10-17: moved here from
         POWER UP, at the bottom of the tab): a language model trained on
         what the app records and on the owner's URLs and files
         (src/llmTrainingSetup.js, /api/llm-training). Hidden until the
         server answers. -->
    <div id="llm-training" class="ai-world-llm" hidden></div>
  </div>
</div>
</template>
