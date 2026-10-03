/**
 * POWER UP → ROAD511 → GENERIC ROAD CCTV API KEYS.
 *
 * Any number of keys, each for one camera site (a host such as 511ny.org) and
 * sent to it as one query parameter when the CCTV layer asks it for a picture.
 * Rendered from GET /api/road-cctv-keys, which never returns a key, only its
 * last four characters. "+ ADD GENERIC ROAD CCTV API KEYS" opens one empty
 * entry; each saved entry can be edited (a new key replaces the old) or removed.
 */

const ENDPOINT = '/api/road-cctv-keys';

function el(documentRef, tag, { className = '', text = '', attrs = {} } = {}) {
  const node = documentRef.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, value);
  return node;
}

function field(documentRef, name, placeholder, { secret = false, value = '' } = {}) {
  const input = el(documentRef, 'input', {
    className: 'road-cctv-key-input',
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

/**
 * @param {{documentRef?: Document, fetchImpl?: Function, host: HTMLElement, onCount?: Function}} options
 * @returns {Promise<{refresh: Function} | null>}
 */
export async function initRoadCctvKeysSetup({ documentRef = globalThis.document, fetchImpl, host, onCount } = {}) {
  if (!host || !documentRef?.createElement) return null;
  const doFetch = fetchImpl || globalThis.fetch?.bind(globalThis);
  let keys = [];
  let adding = false;

  const request = async (method, body) => {
    const response = await doFetch(ENDPOINT, {
      method,
      cache: 'no-store',
      ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
    });
    const data = await response.json().catch(() => null);
    if (!response.ok) throw new Error(String(data?.error || 'This computer did not keep that key.'));
    return data;
  };

  const entryForm = (row, note) => {
    const form = el(documentRef, 'div', { className: 'road-cctv-key-form' });
    const label = field(documentRef, 'label', 'NAME (E.G. NEW YORK 511)', { value: row?.label || '' });
    const site = field(documentRef, 'host', 'CAMERA SITE (E.G. 511ny.org)', { value: row?.host || '' });
    const param = field(documentRef, 'param', 'KEY PARAMETER (DEFAULT key)', { value: row?.param || '' });
    const apiKey = field(documentRef, 'apiKey', row ? `API KEY (SAVED …${row.keyEnd || '••••'}; TYPE TO REPLACE)` : 'API KEY', { secret: true });
    const save = el(documentRef, 'button', { className: 'scene-btn', text: 'SAVE KEY', attrs: { type: 'button' } });
    save.addEventListener('click', async () => {
      note.textContent = 'Saving…';
      try {
        const data = await request('POST', {
          ...(row ? { id: row.id } : {}),
          label: label.value,
          host: site.value,
          param: param.value,
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
    form.append(label, site, param, apiKey, save);
    return form;
  };

  function paint(message = '') {
    host.textContent = '';
    host.append(el(documentRef, 'div', { className: 'private-cams-heading', text: 'GENERIC ROAD CCTV API KEYS' }));
    host.append(el(documentRef, 'p', {
      className: 'private-cams-note',
      text: 'One key per camera site, as many as you need. A key is sent only to its own site, over https, as one address parameter.',
    }));
    const note = el(documentRef, 'p', { className: 'private-cams-note', text: message });
    for (const row of keys) {
      const item = el(documentRef, 'div', { className: 'road-cctv-key' });
      item.append(el(documentRef, 'span', {
        text: `${row.label} · ${row.host} · ?${row.param}=…${row.keyEnd || '••••'}`,
      }));
      const remove = el(documentRef, 'button', { className: 'scene-btn', text: 'REMOVE', attrs: { type: 'button' } });
      remove.addEventListener('click', async () => {
        note.textContent = 'Removing…';
        try {
          const data = await request('DELETE', { id: row.id });
          keys = Array.isArray(data?.keys) ? data.keys : keys.filter((entry) => entry.id !== row.id);
          paint('Removed.');
        } catch (error) {
          note.textContent = error.message;
        }
      });
      item.append(remove);
      host.append(item, entryForm(row, note));
    }
    if (adding) host.append(entryForm(null, note));
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
    onCount?.(keys.length);
  }

  async function refresh() {
    try {
      const data = await request('GET');
      keys = Array.isArray(data?.keys) ? data.keys : [];
      paint();
    } catch {
      host.textContent = '';
    }
  }

  await refresh();
  return { refresh };
}
