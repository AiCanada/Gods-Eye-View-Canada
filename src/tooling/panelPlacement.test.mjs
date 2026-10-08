// Where the collapsible panels live: AI Risk & Truth Assessment, Ultra and CCTV on the
// left stack; Data Layers (first), Context, Sea Temperature and Scenes on the
// right rail. The LLM box is a stack member with the shared collapse button,
// not a free-standing box with its own show/hide.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { expandApplicationHtml } from '../../build/application-html.js';

const html = expandApplicationHtml(readFileSync(new URL('../../index.html', import.meta.url), 'utf8'));
const between = (start, end) => {
  const from = html.indexOf(start);
  const to = html.indexOf(end, from);
  assert.ok(from >= 0 && to > from, start + ' .. ' + end);
  return html.slice(from, to);
};
const panelOrder = (section) => [...section.matchAll(/<(?:div|section) id="([a-z-]+-panel|pp-toggles)" class="panel-collapsible/g)].map((match) => match[1]);

test('left stack: AI Risk & Truth Assessment, CCTV, Ultra, Social Media Analysis, Outbreak; right rail: Data Layers first, then Context, Sea Temperature, Scenes; Radio below the last tab when selected', () => {
  const left = between('<div id="left-panel-stack">', '<aside id="right-context-rail">');
  assert.deepEqual(panelOrder(left), ['ask-panel', 'cctv-panel', 'street-level-panel', 'ultra-panel', 'social-panel', 'outbreak-panel']);
  // The rail's own closing tag is the two-space-indented one; the Contacts
  // aside inside Context closes deeper.
  const right = between('<aside id="right-context-rail">', '\n  </aside>');
  // Radio is the rail's last member, below Scenes, but never a tab. Weather and
  // Recent Imagery are hidden until a product or imagery day is chosen.
  assert.deepEqual(panelOrder(right), ['data-panel', 'weather-panel', 'recent-imagery-panel', 'global-context-panel', 'sst-panel', 'scene-panel', 'radio-panel']);
});

test('the LLM box collapses like the others and is titled AI Risk & Truth Assessment', () => {
  const ask = between('<div id="ask-panel"', '<div id="cctv-panel"');
  assert.match(ask, /class="panel-collapsible" data-panel-id="ask-panel"/);
  // The full name on the tab too (two lines), not a short form.
  assert.match(ask, /<span class="panel-title" data-collapsed-title="AI RISK &amp; TRUTH ASSESSMENT">AI RISK &amp; TRUTH ASSESSMENT<\/span>/);
  assert.match(ask, /<button class="panel-collapse-btn" data-collapse-target="ask-panel"/);
  assert.ok(!html.includes('id="ask-toggle"'), 'no private show/hide button');
});

test('the stack CSS orders the left members LLM, Ultra, CCTV, Social Media Analysis, Outbreak and knows the right members', () => {
  const scenes = readFileSync(new URL('../ui/styles/scenes.css', import.meta.url), 'utf8');
  assert.match(scenes, /#left-panel-stack > #ask-panel \{\s*order: 1;/);
  assert.match(scenes, /#left-panel-stack > #ultra-panel \{\s*order: 2;/);
  assert.match(scenes, /#left-panel-stack > #cctv-panel \{\s*order: 3;/);
  assert.match(scenes, /#left-panel-stack > #social-panel \{\s*order: 4;/);
  assert.match(scenes, /#left-panel-stack > #outbreak-panel \{\s*order: 5;/);
  const layers = readFileSync(new URL('../ui/styles/layers.css', import.meta.url), 'utf8');
  assert.match(layers, /#right-context-rail > #data-panel \{\s*order: -1;/);
  // Radio has no tab: unseen until selected, then below the last tab.
  const radioCss = readFileSync(new URL('../ui/styles/radio.css', import.meta.url), 'utf8');
  assert.match(radioCss, /#radio-panel\.collapsed,[\s\S]*?\{\s*display: none;/);
  assert.match(layers, /#right-context-rail > #radio-panel \{\s*order: 1;/);
  assert.match(layers, /#right-context-rail > #radio-panel\.collapsed \{\s*display: none;/);
  for (const id of ['data-panel', 'sst-panel', 'scene-panel']) assert.ok(layers.includes('#right-context-rail > #' + id + ':not(.collapsed)'), id + ' allocated on the rail');
  assert.equal(layers.includes('#right-context-rail > #social-panel'), false);
});
