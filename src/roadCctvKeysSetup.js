/**
 * POWER UP → ROAD511 → GENERIC ROAD CCTV API KEYS.
 *
 * Any number of keys, each for one camera site and added to every picture the
 * CCTV layer asks that site for. Each key is a row in the same format as the
 * other POWER UP keys (light, name, MANAGE link, "saved — paste to replace",
 * REMOVE). The site is picked from the camera sites the program already loads
 * (GET /api/road-cctv-keys?sites=1), so no address is ever typed. Rendered
 * from GET /api/road-cctv-keys, which never returns a key, only its last four
 * characters. "+ ADD GENERIC ROAD CCTV API KEYS" opens one empty row.
 */

const ENDPOINT = '/api/road-cctv-keys';
const DEFAULT_PARAM = 'key';

function el(documentRef, tag, { className = '', text = '', attrs = {} } = {}) {
  const node = documentRef.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  for (const [name, value] of Object.entries(attrs))
    node.setAttribute(name, value);
  return node;
}

function field(
  documentRef,
  name,
  placeholder,
  { secret = false, value = '' } = {},
) {
  const input = el(documentRef, 'input', {
    attrs: {
      name,
      type: secret ? 'password' : 'text',
      placeholder,
      'aria-label': placeholder,
      autocomplete: 'off',
      spellcheck: 'false',
    },
  });
  input.value = value;
  return input;
}

/** "1 camera" / "1,234 cameras". Pure, exported for tests. */
export function roadCctvCameraCount(count) {
  const n = Math.max(0, Math.floor(Number(count) || 0));
  return `${n.toLocaleString('en-US')} ${n === 1 ? 'camera' : 'cameras'}`;
}

/**
 * The site choices for one row: every listed site, plus the row's own saved
 * site when the catalogue does not list it (another country, not loaded yet).
 * Pure, exported for tests.
 * @param {Array<{host: string, cameras: number}>} sites
 * @param {string} [savedHost]
 */
export function roadCctvSiteChoices(sites, savedHost = '') {
  const list = Array.isArray(sites) ? sites : [];
  if (!savedHost || list.some((site) => site.host === savedHost)) return list;
  return [{ host: savedHost, cameras: 0 }, ...list];
}

/**
 * @param {{documentRef?: Document, fetchImpl?: Function, host: HTMLElement, onSections?: Function}} options
 * @returns {Promise<{refresh: Function} | null>}
 */
export async function initRoadCctvKeysSetup({
  documentRef = globalThis.document,
  fetchImpl,
  host,
  onSections,
} = {}) {
  if (!host || !documentRef?.createElement) return null;
  const doFetch = fetchImpl || globalThis.fetch?.bind(globalThis);
  let keys = [];
  let sites = null; // null while the catalogue's site list is loading
  let adding = false;
  // The site pickers on screen, refilled in place when the list arrives so
  // nothing already typed into an open row is lost.
  let pickers = [];

  const request = async (method, body, query = '') => {
    const response = await doFetch(`${ENDPOINT}${query}`, {
      method,
      cache: 'no-store',
      ...(body
        ? {
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          }
        : {}),
    });
    const data = await response.json().catch(() => null);
    if (!response.ok)
      throw new Error(
        String(data?.error || 'This computer did not keep that key.'),
      );
    return data;
  };

  const fillPicker = (select, savedHost) => {
    const chosen = select.value || savedHost;
    const choices = roadCctvSiteChoices(sites || [], savedHost);
    select.textContent = '';
    select.append(
      el(documentRef, 'option', {
        text:
          sites === null
            ? 'CAMERA SITE · loading the sites in the program…'
            : `CAMERA SITE · choose one of ${choices.length.toLocaleString('en-US')}`,
        attrs: { value: '' },
      }),
    );
    for (const site of choices)
      select.append(
        el(documentRef, 'option', {
          text: site.cameras
            ? `${site.host} · ${roadCctvCameraCount(site.cameras)}`
            : site.host,
          attrs: { value: site.host },
        }),
      );
    select.value = chosen;
  };

  /** One key, in the format of the other POWER UP rows. */
  const keyRow = (row, note) => {
    const section = el(documentRef, 'section', {
      className: 'key-setup-row road-cctv-key-row',
    });
    section.dataset.set = String(Boolean(row));
    const head = el(documentRef, 'div', { className: 'key-setup-row-head' });
    head.append(
      el(documentRef, 'span', {
        className: 'key-setup-led',
        attrs: { 'aria-hidden': 'true' },
      }),
      el(documentRef, 'strong', {
        text: row ? row.label : 'NEW ROAD CCTV API KEY',
      }),
    );
    const get = el(documentRef, 'a', {
      className: 'key-setup-get',
      text: row ? 'MANAGE ↗' : 'GET KEY ↗',
      attrs: { target: '_blank', rel: 'noopener noreferrer' },
    });
    // Only a host the server accepted or the catalogue listed, over https.
    const pointGet = (site) => {
      if (site) get.setAttribute('href', `https://${site}/`);
      else get.removeAttribute('href');
      get.hidden = !site;
    };
    pointGet(row?.host || '');
    head.append(get);

    const unlocks = el(documentRef, 'p', {
      className: 'key-setup-unlocks',
      text: row
        ? `Added to every ${row.host} camera picture as ?${row.param}=…${row.keyEnd || '••••'}.`
        : 'Pick the camera site and paste its key: every camera on that site uses it.',
    });

    const fields = el(documentRef, 'div', { className: 'key-setup-fields' });
    const label = field(documentRef, 'label', 'NAME (E.G. NEW YORK 511)', {
      value: row?.label || '',
    });
    const site = el(documentRef, 'select', {
      attrs: { name: 'host', 'aria-label': 'CAMERA SITE' },
    });
    fillPicker(site, row?.host || '');
    pickers.push({ select: site, savedHost: row?.host || '' });
    site.addEventListener('change', () => pointGet(site.value));
    const apiKey = field(
      documentRef,
      'apiKey',
      row ? 'API KEY saved — paste to replace' : 'paste API KEY',
      { secret: true },
    );
    const param = field(
      documentRef,
      'param',
      `KEY PARAMETER · ${row?.param && row.param !== DEFAULT_PARAM ? row.param : `default ${DEFAULT_PARAM}`} (type another to change)`,
    );
    const actions = el(documentRef, 'div', {
      className: 'road-cctv-key-actions',
    });
    const save = el(documentRef, 'button', {
      className: 'key-setup-remove road-cctv-key-save',
      text: 'SAVE KEY',
      attrs: { type: 'button' },
    });
    save.addEventListener('click', async () => {
      note.textContent = 'Saving…';
      try {
        const data = await request('POST', {
          ...(row ? { id: row.id } : {}),
          label: label.value,
          host: site.value,
          param: param.value.trim() || row?.param || '',
          apiKey: apiKey.value,
        });
        apiKey.value = '';
        keys = Array.isArray(data?.keys) ? data.keys : keys;
        adding = false;
        paint('Saved. Cameras on that site use it from their next picture.');
      } catch (error) {
        apiKey.value = '';
        note.textContent = error.message;
      }
    });
    actions.append(save);
    if (row) {
      const remove = el(documentRef, 'button', {
        className: 'key-setup-remove',
        text: 'REMOVE',
        attrs: { type: 'button', title: `Remove ${row.label}` },
      });
      remove.addEventListener('click', async () => {
        // Same two-step as the other POWER UP rows.
        const ok =
          typeof globalThis.confirm !== 'function' ||
          globalThis.confirm('Remove this key from your saved configuration?');
        if (!ok) return;
        note.textContent = 'Removing…';
        try {
          const data = await request('DELETE', { id: row.id });
          keys = Array.isArray(data?.keys)
            ? data.keys
            : keys.filter((entry) => entry.id !== row.id);
          paint('Removed.');
        } catch (error) {
          note.textContent = error.message;
        }
      });
      actions.append(remove);
    } else {
      const cancel = el(documentRef, 'button', {
        className: 'key-setup-remove',
        text: 'CANCEL',
        attrs: { type: 'button' },
      });
      cancel.addEventListener('click', () => {
        adding = false;
        paint();
      });
      actions.append(cancel);
    }
    fields.append(label, site, apiKey, param, actions);
    section.append(head, unlocks, fields);
    return section;
  };

  function paint(message = '') {
    host.textContent = '';
    pickers = [];
    host.append(
      el(documentRef, 'div', {
        className: 'private-cams-heading',
        text: 'GENERIC ROAD CCTV API KEYS',
      }),
      el(documentRef, 'p', {
        className: 'private-cams-note',
        text: 'One API key covers every CCTV camera on its site: pick the site, no addresses needed. Add as many as you need. A key is sent only to its own site, over https.',
      }),
    );
    const note = el(documentRef, 'p', {
      className: 'private-cams-note',
      text: message,
    });
    for (const row of keys) host.append(keyRow(row, note));
    if (adding) host.append(keyRow(null, note));
    const add = el(documentRef, 'button', {
      className: 'scene-btn private-cams-add',
      text: '+ ADD GENERIC ROAD CCTV API KEYS',
      attrs: { type: 'button' },
    });
    add.addEventListener('click', () => {
      adding = true;
      paint();
    });
    host.append(add, note);
    // Counted like the other POWER UP sections: on once it holds a key.
    onSections?.([{ id: 'road-cctv-keys', set: keys.length > 0 }]);
  }

  async function loadSites() {
    try {
      const data = await request('GET', null, '?sites=1');
      sites = Array.isArray(data?.sites) ? data.sites : [];
    } catch {
      sites = [];
    }
    for (const { select, savedHost } of pickers) fillPicker(select, savedHost);
  }

  async function refresh() {
    try {
      const data = await request('GET');
      keys = Array.isArray(data?.keys) ? data.keys : [];
      paint();
    } catch {
      host.textContent = '';
      return;
    }
    if (sites === null) await loadSites();
  }

  await refresh();
  return { refresh };
}
