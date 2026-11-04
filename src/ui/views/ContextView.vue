<script setup>
import { computed } from 'vue';
import { storeToRefs } from 'pinia';
import { t } from '../../i18n/index.js';
import RailPanel from '../rail/RailPanel.vue';
import { vClassToggle } from '../rail/classToggle.js';
import { useCockpitStore } from '../stores/cockpit.js';
import { useBhoteKoshiPanelStore } from '../stores/bhoteKoshiPanel.js';
import { useContextStore } from '../stores/context.js';
import { useSceneSharingStore } from '../stores/sceneSharing.js';
import { useSceneStore } from '../stores/scenes.js';
import AwarenessPanel from './panels/AwarenessPanel.vue';
import BhoteKoshiPanel from './panels/BhoteKoshiPanel.vue';
import MissionDetail from './panels/MissionDetail.vue';
import MissionRoster from './panels/MissionRoster.vue';
import RadioPanel from './panels/RadioPanel.vue';
import SceneDialog from './panels/SceneDialog.vue';
import SceneOptions from './SceneOptions.vue';
import SceneShotList from './SceneShotList.vue';
import DrawControls from './panels/DrawControls.vue';
import GeoImport from './panels/GeoImport.vue';
import UiButton from '../kit/UiButton.vue';
import UiSelect from '../kit/UiSelect.js';
import ContextRadioDock from './fork/ContextRadioDock.vue';
import SstPanel from './fork/SstPanel.vue';

// ContextControls presents the mode switch and the nearby sites search and
// publishes them; until it does, the panel shows its initial markup.
const { view: ctx } = storeToRefs(useContextStore());
const { presence: cockpit } = storeToRefs(useCockpitStore());
// While the Bhote Koshi event is on, its panel is the rail's only content.
const { panel: bhotePanel } = storeToRefs(useBhoteKoshiPanelStore());
// Scene sharing (src/scenes/sharing.js) offers its authoring bar and presents
// its dialog through this store; without this view, neither is drawn. (The
// fork keeps Authoring on the right rail, so this view draws them.)
const { toolbar, dialog } = storeToRefs(useSceneSharingStore());
// SceneControls presents the Scene panel's buttons, status, progress and
// runtime chip and answers the buttons through the store.
const scenes = useSceneStore();
const { panel: scene } = storeToRefs(scenes);
const off = (name) => scene.value?.disabled[name] ?? false;
// The Scene runtime chip SceneControls presents while a scene plays.
const sceneRuntime = computed(() => scene.value?.runtime ?? '');
// The hidden file input is the IMPORT button's chooser, open only while an
// owner presents the panel. It is cleared once the import settles, so the same
// file can be chosen again, unless the owner went away meanwhile.
function chooseImport(input) {
  if (scenes.attached) input.click();
}
async function importChosen(event) {
  const input = event.currentTarget;
  const file = input.files?.[0];
  if (!file || !scenes.attached) return;
  await scenes.act('importFile', file);
  if (scenes.attached) input.value = '';
}
</script>

<template>
  <!-- Global Context is deliberately independent from the left layer accordion. -->
  <aside id="right-context-rail" class="ui-scroll" v-class-toggle="{ 'bhote-event-active': !!bhotePanel }">
    <!-- God's Eye View Canada (the fork): the right rail holds Data Layers
         with Utilities beside it, Weather, Recent Imagery, Context, Sea Surface
         Temperature, Authoring and, last, Radio; the left stack holds the
         fork's tabs with CCTV and Street Level (LayerPanelsView). -->
    <!-- Data Layer Toggle Panel -->
    <RailPanel id="data-panel" start-collapsed class="active" :title="t('DATA LAYERS')">
      <div id="data-toggles" class="data-toggle-list ui-scroll"></div>
    </RailPanel>

    <!-- Utilities: Directions (LayerPanel renders its row here), Draw, Import -->
    <RailPanel id="utilities-panel" start-collapsed :title="t('UTILITIES')" :hint="t('Directions, drawing and your own files')" scroll>
      <div id="utilities-toggles" class="data-toggle-list utilities-list"></div>
      <div class="utilities-tools"><DrawControls /><GeoImport /></div>
    </RailPanel>

    <RailPanel id="weather-panel" hidden :title="t('WEATHER')" sideways rail-scroller>
      <template #badge><span id="weather-panel-count" :aria-label="t('Active weather products')">0</span></template>
      <div id="weather-panel-body" class="ui-scroll" data-rail-scroller></div>
    </RailPanel>
    <RailPanel id="recent-imagery-panel" hidden :title="t('RECENT IMAGERY')" sideways rail-scroller>
      <template #badge><span id="recent-imagery-panel-count" :aria-label="t('Imagery days in the box')"></span></template>
      <div id="recent-imagery-panel-body" class="ui-scroll" data-rail-scroller></div>
    </RailPanel>
    <RailPanel id="global-context-panel" start-collapsed v-class-toggle="{ ...(ctx && { 'context-enabled': ctx.enabled }) }" :data-context-mode="ctx?.mode" :title="t('CONTEXT')" sideways scroll rail-scroller>
        <!-- The radio control: Radio itself is the rail's last member. -->
        <template #actions><ContextRadioDock /></template>
        <div class="cyber-panel-body ui-scroll" data-rail-scroller>
        <div class="global-context-modes" role="tablist" :aria-label="t('Context mode')">
          <button id="global-context-flights-btn" class="context-mode-button" v-class-toggle="{ active: ctx?.flightsActive }" type="button" role="tab" tabindex="0" :aria-selected="String(ctx?.flightsActive ?? false)" :aria-disabled="ctx && String(ctx.busy)" :aria-busy="ctx && String(ctx.busy)" aria-controls="context-flights-view" :aria-label="t('CONTACTS')" :title="t('Cycles the nearest contacts of whatever type you select — planes, vessels, installations. Satellites track independently.')">
            <span class="material-symbols-outlined" aria-hidden="true">radar</span>
            <span>{{ t('CONTACTS') }}</span>
          </button>
          <button id="global-context-missions-btn" class="context-mode-button" v-class-toggle="{ active: ctx?.missionsActive }" type="button" role="tab" tabindex="0" :aria-selected="String(ctx?.missionsActive ?? false)" :aria-disabled="ctx && String(ctx.busy)" :aria-busy="ctx && String(ctx.busy)" aria-controls="context-missions-view">
            <span class="material-symbols-outlined" aria-hidden="true">rocket_launch</span>
            <span>{{ t('SPACE MISSIONS') }}</span>
          </button>
        </div>
        <div id="context-mode-standby" class="context-mode-standby" :hidden="ctx?.enabled">
          <strong>{{ t('SELECT CONTEXT') }}</strong>
          <span>{{ t('CONTACTS — nearest planes · vessels · sites') }}<br>{{ t('SPACE MISSIONS — launches & orbital assets') }}</span>
        </div>
        <section id="context-flights-view" class="context-mode-view" role="tabpanel" aria-labelledby="global-context-flights-btn" :hidden="!ctx?.flightsActive">
          <div class="global-context-actions" :aria-label="t('Contact Context actions')">
            <button id="cockpit-entry" type="button" :hidden="!cockpit?.entryAvailable">
              <span class="material-symbols-outlined" aria-hidden="true">flight</span>
              <span>{{ t('COCKPIT') }}</span>
            </button>
            <button id="installations-search-btn" class="panel-layer-toggle" type="button" :aria-disabled="ctx && String(ctx.installationsBusy)" :aria-busy="ctx && String(ctx.installationsBusy)">{{ t('SEARCH NEARBY SITES') }}</button>
            <UiButton id="tr3b-toggle" class="tr3b-toggle" :pressed="!!cockpit?.tr3b?.converted" :hidden="!cockpit?.tr3b" :aria-label="t('Reclassify tracked contact as TR-3B')" :title="cockpit?.tr3b?.converted ? t('Restore real aircraft') : t('Reclassify as TR-3B')">🛸</UiButton>
          </div>
          <AwarenessPanel />
        </section>
        <section id="context-missions-view" class="context-mode-view" role="tabpanel" aria-labelledby="global-context-missions-btn" :hidden="!ctx?.missionsActive">
          <div id="space-mission-panel-host">
            <MissionRoster />
            <MissionDetail />
          </div>
        </section>
        </div>
    </RailPanel>
    <BhoteKoshiPanel />
    <!-- Sea Surface Temperature Panel -->
    <SstPanel />
    <!-- Scene Director Panel -->
    <RailPanel id="scene-panel" start-collapsed v-class-toggle="{ running: scene?.running, 'has-shots': scene?.hasShots }" :title="t('AUTHORING')" :hint="t('Create and edit scenes')" scroll>
        <p class="scene-step-heading">{{ t('SCENE') }}</p>
        <div class="scene-controls">
          <UiSelect class="gev-field" id="scene-select" :aria-label="t('Scene')" :disabled="off('select')" @update:model-value="scenes.act('selectScene', $event)"><SceneOptions /></UiSelect>
          <UiButton id="scene-new-btn" type="button" :disabled="off('new')" @click="scenes.act('create')" class="gev-action-button scene-btn" :title="t('Start a new, empty scene')">{{ t('NEW SCENE') }}</UiButton>
          <UiButton tone="alert" id="scene-delete-btn" type="button" :disabled="off('delete')" @click="scenes.act('deleteScene')" class="gev-action-button gev-action-button--danger scene-btn scene-btn-danger" :title="t('Delete this scene and all of its shots')">{{ t('DELETE') }}</UiButton>
        </div>
        <p class="scene-step-heading">{{ t('SHOTS') }}</p>
        <div class="scene-controls">
          <UiButton variant="primary" id="scene-capture-btn" type="button" :disabled="off('capture')" @click="scenes.act('capture')" class="gev-action-button scene-btn scene-btn-primary" :title="t('Add the current view, style and layers as the next shot')">{{ t('+ CAPTURE SHOT') }}</UiButton>
          <UiButton id="scene-update-shot-btn" type="button" :disabled="off('update')" @click="scenes.act('update')" class="gev-action-button scene-btn" :title="t('Replace the selected shot with the current view')">{{ t('UPDATE SHOT') }}</UiButton>
        </div>
        <SceneShotList />
        <p class="scene-shot-hint">{{ t('Click a shot to select it, double-click to rename.') }}</p>
        <p class="scene-step-heading">{{ t('PREVIEW') }}</p>
        <div class="scene-controls">
          <UiButton variant="primary" id="scene-start-btn" type="button" class="gev-action-button scene-btn scene-btn-primary" :title="t('Play from this scene through the rest of the project')" :disabled="off('start')" @click="scenes.act('start')">{{ scene?.playLabel ?? t('PLAY', { context: 'scene' }) }}</UiButton>
          <UiButton tone="alert" id="scene-stop-btn" type="button" :disabled="off('stop')" @click="scenes.act('stop')" class="gev-action-button gev-action-button--danger scene-btn scene-btn-danger" :title="t('Stop playback (Esc)')">{{ t('STOP') }}</UiButton>
          <UiButton id="scene-next-btn" type="button" :disabled="off('next')" @click="scenes.act('next')" class="gev-action-button scene-btn" :title="t('Play the shot after the selected one, moving on to the next scene when needed')">{{ t('NEXT') }}</UiButton>
        </div>
        <p class="scene-step-heading">{{ t('SAVE & SHARE') }}</p>
        <div class="scene-controls scene-file-controls">
          <UiButton id="scene-export-btn" type="button" :disabled="off('export')" @click="scenes.act('export')" class="gev-action-button scene-btn" :title="t('Download every scene as a JSON file you can import later')">{{ t('EXPORT') }}</UiButton>
          <UiButton id="scene-import-btn" type="button" :disabled="off('import')" @click="chooseImport($refs.sceneFile)" class="gev-action-button scene-btn" :title="t('Load scenes from an exported JSON file')">{{ t('IMPORT') }}</UiButton>
          <UiButton id="scene-download-btn" type="button" :disabled="off('download')" @click="scenes.act('download')" class="gev-action-button scene-btn" :title="t('Download the timing log of the last play')">{{ t('RUN LOG') }}</UiButton>
          <input ref="sceneFile" type="file" id="scene-import-file" accept="application/json,.json" hidden @change="importChosen" />
        </div>
        <div v-if="toolbar" data-director-authoring class="scene-controls">
          <UiButton type="button" class="gev-action-button scene-btn" :title="t('Edit anchors, data packs and shot details')" @click="toolbar.edit()">{{ t('EDIT DETAILS') }}</UiButton>
          <UiButton type="button" class="gev-action-button scene-btn" :title="t('Download this scene as JSON or an asset bundle')" @click="toolbar.share()">{{ t('SHARE SCENE') }}</UiButton>
        </div>
        <div class="scene-progress">
          <div id="scene-progress-fill" :style="scene ? { width: `${scene.progress}%` } : undefined">{{ scene?.progress ?? 0 }}%</div>
        </div>
        <div id="scene-status" role="status" aria-live="polite">{{ scene?.status ?? t('Ready') }}</div>
    </RailPanel>
    <!-- Internet radio: not a box of the dashboard. Hidden until selected (the radio
         control in the Context header, voice, a share link), then shown below the
         last tab. -->
    <RadioPanel data-radio-placement="rail" />
  </aside>

  <div id="scene-runtime" :class="{ active: !!sceneRuntime }">{{ sceneRuntime }}</div>
  <Teleport to="body">
    <SceneDialog v-if="dialog" :key="dialog.id" :view="dialog" />
  </Teleport>
</template>
