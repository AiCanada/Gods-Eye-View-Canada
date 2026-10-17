// CUSTOM LLM TRAINING lives at the bottom of the ARTIFICIAL INTELLIGENCE
// WORLD TRAINING SIM tab (owner request 2026-10-17), not in POWER UP.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { AiWorldPanel } from './aiWorldPanel.js';

/** Just enough of an element for the panel and the section. */
class Node {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.attrs = {};
    this.dataset = {};
    this.listeners = new Map();
    this.className = '';
    this.hidden = false;
    this.disabled = false;
    this.checked = false;
    this.value = '';
    this.text = '';
  }

  get textContent() {
    return this.tagName === '#TEXT'
      ? this.text
      : this.children.map((child) => child.textContent).join('');
  }

  set textContent(value) {
    this.children = [];
    if (String(value ?? '')) this.append(String(value));
  }

  append(...nodes) {
    for (const node of nodes) {
      const child =
        typeof node === 'string'
          ? Object.assign(new Node('#text'), { text: node })
          : node;
      child.parentNode = this;
      this.children.push(child);
    }
  }

  appendChild(child) {
    this.append(child);
    return child;
  }

  replaceChildren(...children) {
    this.children = [];
    this.append(...children);
  }

  setAttribute(name, value) {
    this.attrs[name] = String(value);
  }

  getAttribute(name) {
    return name in this.attrs ? this.attrs[name] : null;
  }

  addEventListener(type, fn) {
    this.listeners.set(type, [...(this.listeners.get(type) || []), fn]);
  }

  removeEventListener(type, fn) {
    this.listeners.set(
      type,
      (this.listeners.get(type) || []).filter((entry) => entry !== fn),
    );
  }

  all() {
    return [this, ...this.children.flatMap((child) => child.all())];
  }
}

const settle = async () => {
  for (let i = 0; i < 8; i += 1)
    await new Promise((resolve) => setImmediate(resolve));
};

const STATUS = {
  state: 'idle',
  config: {
    name: 'gev-llm',
    base: 'Qwen/Qwen3.5-0.8B',
    sources: ['news'],
    epochs: 1,
  },
  bases: [{ id: 'Qwen/Qwen3.5-0.8B', label: 'QWEN3.5-0.8B', onMachine: true }],
  baseOnMachine: true,
  sources: [{ id: 'news', label: 'NEWS HEADLINES', class: 'open' }],
  urls: [],
  paths: [],
  models: [],
  limits: { urls: 100, paths: 50 },
};

test('the template puts CUSTOM LLM TRAINING last in the AI World tab', () => {
  const html = readFileSync(
    new URL('./ui/templates/layer-panels.html', import.meta.url),
    'utf8',
  );
  const start = html.indexOf('<div id="ai-world-panel"');
  const output = html.indexOf('id="ai-world-output"', start);
  const host = html.indexOf('<div id="llm-training"', start);
  assert.ok(start >= 0 && output > start && host > output);
  // Nothing after it but the box's closing tags.
  assert.match(
    html.slice(host),
    /^<div id="llm-training" class="ai-world-llm" hidden><\/div>\s*<\/div>\s*<\/div>/,
  );
});

test('POWER UP no longer carries the section', () => {
  const source = readFileSync(
    new URL('./keySetup.js', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(
    source,
    /llmTrainingSetup|initLlmTrainingSetup|llm-training/,
  );
});

test('the tab mounts the section in its own style and ends it with itself', async () => {
  const root = new Node('div');
  const host = new Node('div');
  host.hidden = true;
  const nodes = new Map([
    ['ai-world-panel', root],
    ['llm-training', host],
  ]);
  const document = {
    getElementById: (id) => nodes.get(id) || null,
    createElement: (tag) => new Node(tag),
  };
  const calls = [];
  const fetch = async (url) => {
    calls.push(String(url));
    const ok = String(url) === '/api/llm-training/status';
    return {
      ok,
      status: ok ? 200 : 404,
      headers: { get: () => null },
      json: async () => (ok ? STATUS : { error: 'Not found' }),
    };
  };
  const panel = new AiWorldPanel({
    document,
    fetch,
    storage: null,
    timers: { setTimeout: () => 0, clearTimeout: () => {} },
  });
  await settle();
  assert.ok(calls.includes('/api/llm-training/status'));
  assert.equal(host.hidden, false);
  assert.match(host.textContent, /CUSTOM LLM TRAINING · ON THIS MACHINE/);
  assert.match(host.textContent, /INITIALIZE TRAINING/);
  const all = host.all();
  assert.ok(all.some((node) => node.className === 'cctv-summary-label'));
  const buttons = all.filter((node) => node.tagName === 'BUTTON');
  assert.ok(buttons.length > 0);
  for (const button of buttons)
    assert.match(button.className, /\bscene-btn\b/, button.textContent);
  panel.destroy();
  assert.equal(host.textContent, '');
});
