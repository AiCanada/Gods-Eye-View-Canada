<script setup>
import { tl } from '../../../i18n/index.js';
import PanelCollapseButton from '../../rail/PanelCollapseButton.vue';
import { vPanelState } from '../../rail/panelState.js';
</script>

<template>
  <!-- God's Eye View Canada (the fork): the AI DISTILLATION box, moved from
       src/ui/templates/layer-panels.html when upstream rendered the templates as Vue views
       (#1499). Its markup is static, so the owner modules that fill it
       (ids, classes) and the data-i18n-local markers translated at boot and on
       each language switch work as they did; the root draws its state from the
       panel chrome store (v-panel-state) and the collapse button is the kit's. -->
  <!-- AI Distillation (owner request 2026-10-19): a left-stack box under
     the AI World Training Sim. Seven headings, each holding the owner's
     own sub-headings without limit; every sub-heading asks its teachers
     (the Ask panel's LLMs, Grok Bot and OpenAI Dots by every fallback,
     the custom LLMs trained here) one question at a time and keeps a
     ground truth answer to train off of. Filled by src/distillPanel.js
     from /api/distill (docs/AI-DISTILLATION.md). -->
<div id="distill-panel" class="panel-collapsible collapsed" data-panel-id="distill-panel" v-panel-state="'distill-panel'">
  <div class="panel-glow"></div>
  <div class="distill-panel-inner">
    <div class="panel-header">
      <span class="panel-title" data-collapsed-title="AI DISTILLATION" data-i18n-local-collapsed-title data-i18n-local>AI DISTILLATION</span>
      <span class="panel-divider"></span>
      <PanelCollapseButton target="distill-panel" :name="tl('AI DISTILLATION')" start-collapsed />
    </div>
    <div id="distill-status" class="ask-status distill-run" role="status" aria-live="polite"></div>
    <details class="distill-howto">
      <summary data-i18n-local>INSTRUCTIONS</summary>
      <ol class="distill-list">
        <li data-i18n-local>Open a heading and ADD HEADING: each sub-heading is its own run, with its own questions, teachers, prompts and dataset. Add as many as you like.</li>
        <li data-i18n-local>Type questions (one a line) or load a CSV file (a question column, or the first column).</li>
        <li data-i18n-local>Choose the teachers: the LLMs with a key in POWER UP, GROK BOT and OPENAI DOTS (their key, or their fallbacks), and the custom LLMs trained on this PC. SAVE SETTINGS.</li>
        <li data-i18n-local>Choose students too (none to all, from the same list): they answer each question first, and the teachers grade their answers, fix the errors and upgrade them into the ground truth.</li>
        <li data-i18n-local>ESTIMATE shows the paid calls; CONFIRM START runs one question at a time. PAUSE, CONTINUE and STOP work as in the other tabs.</li>
        <li data-i18n-local>The Grok Bot and ChatGPT apps' replies come back by themselves where this PC can; when one does not, the run waits: paste its reply and SUBMIT ANSWER.</li>
        <li data-i18n-local>Every ground truth goes to the sub-heading's dataset: EXPORT it as JSONL or CSV, or train on it in CUSTOM LLM TRAINING (DISTILLED ANSWERS).</li>
      </ol>
      <p class="distill-note" data-i18n-local>Full instructions: docs/AI-DISTILLATION.md</p>
    </details>
    <div id="distill-body" class="distill-body" hidden></div>
  </div>
</div>
</template>
