// Voice reach for every on-screen control. The purpose-built tools cover the
// map; these two cover the rest of the app (Outbreak, Ultra, Social Media,
// Street Level, POWER UP, settings): list what is on screen, then press, set
// or toggle one control by its label, as a hand on the mouse would.

import {
  ownerRemovalRefusalCount,
  ownerRemovalRefusedSince,
} from '../ui/ownerRemoval.js';

const CONTROL_SELECTOR = [
  'button',
  'select',
  'textarea',
  'input:not([type="hidden"])',
  '[role="button"]',
  '[role="tab"]',
  '[role="switch"]',
  '[role="menuitem"]',
  '[role="option"]',
  'summary',
].join(',');

// The voice control itself stays out of reach: a spoken "stop" must not end
// the session through its own mic button half-way through a tool call.
const EXCLUDED_ROOTS = '#gev-voice-control';

// The box or panel a control belongs to, for listing and disambiguation.
const PANEL_SELECTOR =
  '[data-panel-id], .panel-collapsible, [role="dialog"], #location-bar, #control-panel, #pp-toggles, #command-dock';

// Pressing these changes or loses data, or reaches outside the app; the model
// must ask the user and repeat the call with confirmed=true.
const RISKY_WORDS =
  /\b(delete|remove|clear|erase|wipe|reset|revoke|forget|sign\s*out|log\s*out|logout|send|post|publish|submit|share|purchase|buy|pay|upload|disconnect|unpair|overwrite|discard)\b/i;

// Keys and passwords are typed by the user; a spoken one would pass through
// the voice provider's transcript.
const SENSITIVE_WORDS =
  /(api[\s_-]*key|token|secret|password|passcode|passphrase|credential|private[\s_-]*key)/i;

const MAX_LABEL = 80;
const MAX_LIST = 120;
const DEFAULT_LIST = 60;
// A one-panel listing shows the whole panel up to this, so a big box (the
// Outbreak box has over 100 controls) is never cut at the 60th.
const PANEL_LIST = 150;
const MAX_OPTIONS = 16;

/** Lower-case words only, for matching spoken labels to written ones. */
export function normalizeControlLabel(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/&amp;/g, '&')
    .replace(/[^a-z0-9&%]+/g, ' ')
    .trim();
}

function clean(value, max = MAX_LABEL) {
  const text = String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function attr(el, name) {
  return el?.getAttribute?.(name) ?? null;
}

function tagOf(el) {
  return String(el?.tagName || '').toLowerCase();
}

/** What kind of control this is: button, select, checkbox, range, text… */
export function controlKind(el) {
  const tag = tagOf(el);
  const role = attr(el, 'role');
  if (tag === 'select') return 'select';
  if (tag === 'textarea') return 'text';
  if (tag === 'input') {
    const type = String(el.type || attr(el, 'type') || 'text').toLowerCase();
    if (type === 'checkbox') return 'checkbox';
    if (type === 'radio') return 'radio';
    if (type === 'range') return 'range';
    if (type === 'number') return 'number';
    if (['button', 'submit', 'reset', 'image'].includes(type)) return 'button';
    if (type === 'file') return 'file';
    if (type === 'password') return 'password';
    if (type === 'color') return 'color';
    return 'text';
  }
  if (role === 'switch') return 'switch';
  if (role === 'tab') return 'tab';
  return 'button';
}

function labelledBy(el) {
  const ids = String(attr(el, 'aria-labelledby') || '')
    .split(/\s+/)
    .filter(Boolean);
  const doc = el.ownerDocument;
  return ids
    .map((id) => doc?.getElementById?.(id)?.textContent || '')
    .join(' ');
}

function labelFor(el) {
  const labels = el.labels ? Array.from(el.labels) : [];
  if (labels.length) return labels.map((label) => label.textContent).join(' ');
  const id = attr(el, 'id');
  if (id) {
    const doc = el.ownerDocument;
    const label = doc?.querySelector?.(`label[for="${id}"]`);
    if (label) return label.textContent;
  }
  const wrap = el.closest?.('label');
  return wrap ? wrap.textContent : '';
}

/** The words a person would use for this control. */
export function controlLabel(el) {
  const kind = controlKind(el);
  const candidates = [attr(el, 'aria-label'), labelledBy(el)];
  if (kind === 'button' || kind === 'tab' || kind === 'switch') {
    candidates.push(tagOf(el) === 'input' ? el.value : el.textContent);
  } else {
    candidates.push(labelFor(el));
  }
  candidates.push(
    attr(el, 'title'),
    attr(el, 'placeholder'),
    attr(el, 'name'),
    attr(el, 'id'),
  );
  for (const candidate of candidates) {
    const text = clean(candidate);
    // A lone symbol (+, ◀, ×) says nothing; the title usually does.
    if (text && /[a-z0-9]/i.test(text)) return text;
  }
  return '';
}

function panelOf(el) {
  const panel = el.closest?.(PANEL_SELECTOR);
  if (!panel) return { id: '', title: '' };
  const id = attr(panel, 'data-panel-id') || attr(panel, 'id') || '';
  const title =
    attr(panel.querySelector?.('.panel-title'), 'data-collapsed-title') ||
    panel.querySelector?.('.panel-title')?.textContent ||
    '';
  return { id, title: clean(title, 60) };
}

function isSensitive(el, label) {
  const kind = controlKind(el);
  if (kind === 'password' || kind === 'file') return true;
  if (!['text', 'number'].includes(kind)) return false;
  return [label, attr(el, 'id'), attr(el, 'name'), attr(el, 'autocomplete')]
    .filter(Boolean)
    .some((value) => SENSITIVE_WORDS.test(value));
}

function computedHidden(el) {
  const view = el.ownerDocument?.defaultView;
  if (typeof view?.getComputedStyle !== 'function') return false;
  try {
    const style = view.getComputedStyle(el);
    return style.visibility === 'hidden' || style.display === 'none';
  } catch {
    return false;
  }
}

/** Shown on screen right now (not inside a collapsed or hidden box). */
export function controlVisible(el) {
  if (!el?.isConnected && el?.isConnected !== undefined) return false;
  if (el.hidden || attr(el, 'aria-hidden') === 'true') return false;
  if (el.closest?.('[hidden], [aria-hidden="true"], [inert]')) return false;
  if (typeof el.getClientRects === 'function' && !el.getClientRects().length)
    return false;
  return !computedHidden(el);
}

/** The collapsed panel hiding this control, when that is all that hides it. */
function collapsedPanelOf(el) {
  const panel = el.closest?.('.panel-collapsible.collapsed');
  if (!panel) return null;
  const id = attr(panel, 'data-panel-id') || attr(panel, 'id');
  if (!id || panel.hidden || attr(panel, 'hidden') !== null) return null;
  return id;
}

function controlDisabled(el) {
  return Boolean(
    el.disabled ||
    attr(el, 'aria-disabled') === 'true' ||
    el.closest?.('fieldset[disabled]'),
  );
}

function controlState(el, kind, sensitive) {
  if (sensitive) return {};
  if (kind === 'checkbox' || kind === 'radio') return { checked: !!el.checked };
  if (kind === 'switch' || attr(el, 'aria-pressed') !== null) {
    const pressed = attr(el, 'aria-checked') ?? attr(el, 'aria-pressed');
    if (pressed === 'true' || pressed === 'false')
      return { on: pressed === 'true' };
  }
  if (kind === 'tab') return { selected: attr(el, 'aria-selected') === 'true' };
  if (kind === 'select') {
    const options = Array.from(el.options || []);
    const chosen = options[el.selectedIndex] || null;
    return {
      value: clean(chosen?.textContent || el.value, 60),
      options: options
        .slice(0, MAX_OPTIONS)
        .map((option) => clean(option.textContent || option.value, 40)),
      ...(options.length > MAX_OPTIONS
        ? { moreOptions: options.length - MAX_OPTIONS }
        : {}),
    };
  }
  if (kind === 'range' || kind === 'number') {
    const out = { value: String(el.value ?? '') };
    for (const key of ['min', 'max', 'step']) {
      const value = attr(el, key);
      if (value !== null) out[key] = value;
    }
    return out;
  }
  if (kind === 'text' || kind === 'color')
    return { value: clean(el.value, 60) };
  return {};
}

/**
 * The page's controls with stable references. `refs` maps each reference
 * back to its element until the next listing.
 */
export function createUiControlRegistry({ root = globalThis.document } = {}) {
  let refs = new Map();
  let ids = new WeakMap();
  let next = 1;

  const refOf = (el) => {
    const id = attr(el, 'id');
    if (id) return `#${id}`;
    let ref = ids.get(el);
    if (!ref) {
      ref = `c${next++}`;
      ids.set(el, ref);
    }
    return ref;
  };

  function scan({ includeHidden = false } = {}) {
    const all = Array.from(root?.querySelectorAll?.(CONTROL_SELECTOR) || []);
    const out = [];
    for (const el of all) {
      if (el.closest?.(EXCLUDED_ROOTS)) continue;
      const visible = controlVisible(el);
      const hiddenBy = visible ? null : collapsedPanelOf(el);
      if (!visible && !(includeHidden && hiddenBy)) continue;
      const label = controlLabel(el);
      if (!label) continue;
      const kind = controlKind(el);
      const sensitive = isSensitive(el, label);
      const ref = refOf(el);
      refs.set(ref, el);
      const panel = panelOf(el);
      out.push({
        el,
        ref,
        label,
        kind,
        panelId: panel.id,
        panel: panel.title,
        disabled: controlDisabled(el),
        sensitive,
        visible,
        hiddenBy,
      });
    }
    return out;
  }

  const describe = (control) => ({
    ref: control.ref,
    label: control.label,
    kind: control.kind,
    ...(control.panelId ? { panelId: control.panelId } : {}),
    ...(control.panel ? { panel: control.panel } : {}),
    ...(control.disabled ? { disabled: true } : {}),
    ...(control.sensitive ? { typeYourself: true } : {}),
    ...(control.visible ? {} : { inCollapsedPanel: control.hiddenBy }),
    ...controlState(control.el, control.kind, control.sensitive),
  });

  /** Controls on screen, optionally only one panel's or matching words. */
  function list({ panelId = '', query = '', limit } = {}) {
    refs = new Map();
    const panel = String(panelId || '').trim();
    const words = normalizeControlLabel(query).split(' ').filter(Boolean);
    const fallback = panel ? PANEL_LIST : DEFAULT_LIST;
    const ceiling = panel ? PANEL_LIST : MAX_LIST;
    const cap = Math.max(1, Math.min(ceiling, Number(limit) || fallback));
    const matches = scan({ includeHidden: Boolean(panel || words.length) })
      .filter((control) => !panel || control.panelId === panel)
      .filter((control) => {
        if (!words.length) return true;
        const text = normalizeControlLabel(`${control.label} ${control.panel}`);
        return words.every((word) => text.includes(word));
      });
    return {
      total: matches.length,
      controls: matches.slice(0, cap).map(describe),
      ...(matches.length > cap ? { truncated: true } : {}),
    };
  }

  /** The best match for a reference or spoken label, or why there is none. */
  function find({ ref = '', label = '', panelId = '' } = {}) {
    const wantRef = String(ref || '').trim();
    const panel = String(panelId || '').trim();
    const controls = scan({ includeHidden: true }).filter(
      (control) => !panel || control.panelId === panel,
    );
    if (wantRef) {
      const byRef =
        controls.find((control) => control.ref === wantRef) ||
        controls.find((control) => control.el === refs.get(wantRef));
      if (byRef) return { control: byRef };
      if (!label) return { error: `No control ${wantRef} on screen now.` };
    }
    const want = normalizeControlLabel(label);
    if (!want) return { error: 'Say which control.' };
    const scored = [];
    for (const control of controls) {
      const score = labelScore(want, control);
      if (score > 0) scored.push({ control, score });
    }
    if (!scored.length)
      return { error: `No "${clean(label, 40)}" control on screen.` };
    scored.sort(
      (a, b) =>
        b.score - a.score ||
        Number(b.control.visible) - Number(a.control.visible) ||
        Number(a.control.disabled) - Number(b.control.disabled),
    );
    const best = scored[0].score;
    const top = scored.filter((entry) => entry.score === best);
    const distinct = new Set(
      top.map(
        (entry) =>
          `${normalizeControlLabel(entry.control.label)}|${entry.control.panelId}`,
      ),
    );
    if (distinct.size > 1) {
      return {
        error: `More than one "${clean(label, 40)}" control; say which.`,
        candidates: top.slice(0, 8).map((entry) => describe(entry.control)),
      };
    }
    return { control: top[0].control };
  }

  return { list, find, describe };
}

// Words people add around a label: "press the scan button".
const FILLER_WORDS = new Set([
  'the',
  'a',
  'an',
  'please',
  'button',
  'tab',
  'my',
]);

function labelScore(want, control) {
  const label = normalizeControlLabel(control.label);
  if (!label) return 0;
  if (label === want) return 5;
  const withPanel = normalizeControlLabel(`${control.panel} ${control.label}`);
  if (withPanel === want) return 5;
  const shorter = Math.min(label.length, want.length);
  if (shorter >= 3 && (label.startsWith(want) || want.startsWith(label)))
    return 4;
  const said = want.split(' ');
  const words = said.filter((word) => !FILLER_WORDS.has(word));
  if (!words.length) return 0;
  const text = ` ${withPanel} `;
  if (words.every((word) => text.includes(` ${word} `))) return 3;
  if (words.every((word) => text.includes(word))) return 2;
  return 0;
}

function fire(el, type) {
  const view = el.ownerDocument?.defaultView || globalThis;
  const EventType = view.Event || globalThis.Event;
  if (typeof EventType === 'function')
    el.dispatchEvent?.(new EventType(type, { bubbles: true }));
}

function setNativeValue(el, value) {
  // Frameworks that track the value property still see the change.
  const proto = Object.getPrototypeOf(el);
  const setter = proto && Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (setter) setter.call(el, value);
  else el.value = value;
}

const ON_WORDS = new Set([
  'on',
  'true',
  'yes',
  'checked',
  'enable',
  'enabled',
  '1',
]);
const OFF_WORDS = new Set([
  'off',
  'false',
  'no',
  'unchecked',
  'disable',
  'disabled',
  '0',
]);

function wantOn(value) {
  const word = normalizeControlLabel(value);
  if (ON_WORDS.has(word)) return true;
  if (OFF_WORDS.has(word)) return false;
  return null;
}

function chooseOption(el, value) {
  const want = normalizeControlLabel(value);
  const options = Array.from(el.options || []);
  const exact = options.find(
    (option) =>
      normalizeControlLabel(option.textContent) === want ||
      normalizeControlLabel(option.value) === want,
  );
  if (exact) return exact;
  const starts = options.filter((option) =>
    normalizeControlLabel(option.textContent).startsWith(want),
  );
  if (starts.length === 1) return starts[0];
  const contains = options.filter((option) =>
    normalizeControlLabel(`${option.textContent} ${option.value}`).includes(
      want,
    ),
  );
  return contains.length === 1 ? contains[0] : null;
}

const settle = () =>
  new Promise((resolve) => {
    const raf = globalThis.requestAnimationFrame;
    if (typeof raf === 'function') raf(() => resolve());
    else setTimeout(resolve, 0);
  });

/**
 * Press, set or toggle one control. `openPanel(panelId)` opens a collapsed
 * panel first when the control is inside one.
 */
export async function useUiControl(
  registry,
  args = {},
  { openPanel = null, removalWaitMs } = {},
) {
  const action = String(args.action || 'press').toLowerCase();
  if (!['press', 'set', 'toggle'].includes(action))
    return failure(`Unknown control action: ${action}.`);
  const found = registry.find(args);
  if (found.error)
    return failure(
      found.error,
      found.candidates ? { candidates: found.candidates } : {},
    );
  let { control } = found;
  const named = control.label;
  if (control.sensitive)
    return failure(
      `${named} takes a key or password; type it yourself so it never goes through voice.`,
      { control: registry.describe(control), typeYourself: true },
    );
  if (control.kind === 'file')
    return failure(`${named} picks a file; choose it yourself.`);
  if (control.disabled)
    return failure(`${named} is greyed out right now.`, {
      control: registry.describe(control),
    });
  const risky = RISKY_WORDS.test(`${control.label}`);
  const changes =
    action !== 'set' ||
    !['text', 'number', 'range', 'select', 'color'].includes(control.kind);
  if (risky && changes && args.confirmed !== true)
    return failure(`${named} needs the user's yes first.`, {
      needsConfirmation: true,
      control: registry.describe(control),
      say: `Should I ${action === 'press' ? 'press' : action} ${named}?`,
    });

  if (!control.visible && control.hiddenBy) {
    if (typeof openPanel === 'function') {
      openPanel(control.hiddenBy);
      await settle();
    }
    const again = registry.find({
      ...args,
      ref: control.ref,
      label: control.label,
    });
    if (again.control) control = again.control;
    if (!control.visible)
      return failure(
        `${named} is inside the closed ${control.panel || control.hiddenBy} box.`,
      );
  }

  const el = control.el;
  const kind = control.kind;
  // A removal the owner's phone asks for is refused by the PC with no text;
  // the press that led to one answers with nothing to say.
  const refusalsBefore = ownerRemovalRefusalCount();
  let done;
  if (
    kind === 'checkbox' ||
    kind === 'radio' ||
    kind === 'switch' ||
    (kind !== 'select' && controlState(el, kind, false).on !== undefined)
  ) {
    const before =
      kind === 'checkbox' || kind === 'radio'
        ? !!el.checked
        : controlState(el, kind, false).on;
    let target =
      action === 'toggle' || action === 'press' ? !before : wantOn(args.value);
    if (action === 'press' && kind === 'radio') target = true;
    if (action === 'set' && target === null)
      return failure(`Say on or off for ${named}.`);
    if (target !== before) el.click();
    done = target ? 'on' : 'off';
  } else if (kind === 'select') {
    if (action !== 'set' || args.value === undefined || args.value === '')
      return failure(`${named} is a menu; say which option.`, {
        control: registry.describe(control),
      });
    const option = chooseOption(el, args.value);
    if (!option)
      return failure(`${named} has no option "${clean(args.value, 40)}".`, {
        control: registry.describe(control),
      });
    if (RISKY_WORDS.test(option.textContent) && args.confirmed !== true)
      return failure(
        `${clean(option.textContent, 40)} needs the user's yes first.`,
        {
          needsConfirmation: true,
          say: `Should I choose ${clean(option.textContent, 40)}?`,
        },
      );
    el.value = option.value;
    fire(el, 'input');
    fire(el, 'change');
    done = clean(option.textContent || option.value, 40);
  } else if (['text', 'number', 'range', 'color'].includes(kind)) {
    if (action !== 'set')
      return failure(`${named} is a field; say what to put in it.`);
    let value = String(args.value ?? '');
    if (kind === 'range' || kind === 'number') {
      const number = Number(value);
      if (!Number.isFinite(number)) return failure(`${named} takes a number.`);
      const min = Number(attr(el, 'min'));
      const max = Number(attr(el, 'max'));
      let clamped = number;
      if (Number.isFinite(min)) clamped = Math.max(min, clamped);
      if (Number.isFinite(max)) clamped = Math.min(max, clamped);
      value = String(clamped);
    }
    el.focus?.();
    setNativeValue(el, value);
    fire(el, 'input');
    fire(el, 'change');
    if (args.pressEnter === true) {
      const view = el.ownerDocument?.defaultView || globalThis;
      const Keyboard = view.KeyboardEvent || globalThis.KeyboardEvent;
      if (typeof Keyboard === 'function') {
        for (const type of ['keydown', 'keyup'])
          el.dispatchEvent?.(
            new Keyboard(type, { key: 'Enter', code: 'Enter', bubbles: true }),
          );
      }
      el.form?.requestSubmit?.();
    }
    done = clean(value, 40);
  } else {
    if (action === 'set')
      return failure(`${named} is a button; press it instead.`);
    el.click();
    done = 'pressed';
  }
  await settle();
  const state = controlState(el, kind, false);
  if (
    await ownerRemovalRefusedSince(refusalsBefore, {
      timeoutMs: removalWaitMs,
    })
  )
    return {
      ok: true,
      action: 'use_ui_control',
      control: registry.describe({ ...control, el }),
      result: done,
      ...state,
      say: null,
      schedule: 'silent',
      quiet: true,
    };
  return {
    ok: true,
    action: 'use_ui_control',
    control: registry.describe({ ...control, el }),
    result: done,
    ...state,
    say:
      done === 'pressed'
        ? `Pressed ${named}.`
        : done === 'on' || done === 'off'
          ? `${named} ${done}.`
          : `${named} set to ${done}.`,
  };
}

function failure(message, extra = {}) {
  return {
    ok: false,
    action: 'use_ui_control',
    error: message,
    say: extra.say ?? message,
    ...extra,
  };
}

/** The list_ui_controls result for the voice model. */
export function listUiControls(registry, args = {}) {
  const listed = registry.list(args);
  return {
    ok: true,
    action: 'list_ui_controls',
    ...listed,
    say: null,
  };
}
