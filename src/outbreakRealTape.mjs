/**
 * Real epidemics and real policy in the world-model schema (owner request
 * 2026-10-13: the sim plus other data). Our World in Data's COVID-19 data
 * (cases, deaths, hospital and intensive-care occupancy, tests,
 * vaccinations; CC BY 4.0) and the Oxford COVID-19 Government Response
 * Tracker's national policy indicators (CC BY 4.0) become one country-level
 * series per country, with the policy mapped onto the sim's action
 * vocabulary, so a model pretrained on sim episodes can be fine-tuned and
 * checked on 2020–2022. Latent compartments are never observed: only the
 * observation channels and a mask. Pure: the downloads are in
 * scripts/outbreak-real-data.mjs.
 */

export const REAL_SCHEMA = 'gev-outbreak-real/1';
export const REAL_OBS = Object.freeze([
  'newCases',
  'newDeaths',
  'hospital',
  'icu',
  'newTests',
  'peopleVaccinated',
]);
export const REAL_ACTIONS = Object.freeze([
  'lockdown',
  'travelBan',
  'testing',
  'tracing',
  'vaccination',
]);
/** OxCGRT indicator → its maximum (ordinal scale). */
export const OXCGRT_SCALES = Object.freeze({
  C1: 3,
  C2: 3,
  C3: 2,
  C4: 4,
  C5: 2,
  C6: 3,
  C7: 2,
  C8: 4,
  H2: 3,
  H3: 2,
  H7: 5,
});

/** RFC 4180 CSV: quoted fields may hold commas, quotes ("") and newlines. */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else quoted = false;
      } else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      row.push(field);
      field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else field += ch;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  const [header = [], ...body] = rows;
  return body.map((cells) =>
    Object.fromEntries(header.map((name, k) => [name.trim(), cells[k] ?? ''])),
  );
}

const num = (v) => {
  if (v === '' || v == null) return NaN;
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
};
const isoDate = (v) => {
  const s = String(v || '').trim();
  if (/^\d{8}$/.test(s))
    return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
};
/** The first column whose name starts with `prefix` (and holds `part`). */
const column = (names, prefix, part = '') =>
  names.find((n) => n.startsWith(prefix) && n.toLowerCase().includes(part)) ??
  names.find((n) => n.startsWith(prefix));

/**
 * OWID rows → { ISO2: { date: [obs…], population } } (aggregates, which have
 * no ISO3 code or an OWID_ one, are left out).
 */
export function owidSeries(rows, iso3to2) {
  const out = {};
  for (const r of rows) {
    const iso3 = r.iso_code || r.code || r.country_code || '';
    const iso2 = iso3to2[iso3];
    const date = isoDate(r.date);
    if (!iso2 || !date) continue;
    out[iso2] ??= { days: {}, population: NaN };
    out[iso2].days[date] = [
      num(r.new_cases),
      num(r.new_deaths),
      num(r.hosp_patients),
      num(r.icu_patients),
      num(r.new_tests),
      num(r.people_vaccinated),
    ];
    const pop = num(r.population);
    if (Number.isFinite(pop)) out[iso2].population = pop;
  }
  return out;
}

/**
 * OxCGRT national rows → { ISO2: { date: [actions…] } }, each action the
 * share (0–1) of its indicator's scale: lockdown is the mean of C1–C7, the
 * travel ban C8, testing H2, tracing H3, vaccination H7.
 */
export function oxcgrtSeries(rows, iso3to2) {
  if (!rows.length) return {};
  const names = Object.keys(rows[0]);
  const col = Object.fromEntries(
    Object.keys(OXCGRT_SCALES).map((key) => [
      key,
      column(names, `${key}`, key.startsWith('C') ? 'numeric' : ''),
    ]),
  );
  const out = {};
  for (const r of rows) {
    if (r.Jurisdiction && r.Jurisdiction !== 'NAT_TOTAL') continue;
    const iso2 = iso3to2[r.CountryCode || r.country_code || ''];
    const date = isoDate(r.Date || r.date);
    if (!iso2 || !date) continue;
    const share = (key) => {
      const v = num(r[col[key]]);
      return Number.isFinite(v)
        ? Math.min(1, Math.max(0, v / OXCGRT_SCALES[key]))
        : NaN;
    };
    const lockdownParts = ['C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7']
      .map(share)
      .filter(Number.isFinite);
    out[iso2] ??= {};
    out[iso2][date] = [
      lockdownParts.length
        ? lockdownParts.reduce((s, x) => s + x, 0) / lockdownParts.length
        : NaN,
      share('C8'),
      share('H2'),
      share('H3'),
      share('H7'),
    ];
  }
  return out;
}

/**
 * The aligned arrays over days [from, to] and the given countries:
 * obs float32 [T, C, 6], actions float32 [T, C, 5], masks uint8 (1 where
 * observed), population float64 [C].
 */
export function realArrays({ owid, oxcgrt, countries, from, to }) {
  const dates = [];
  for (
    let t = Date.parse(`${from}T00:00:00Z`);
    t <= Date.parse(`${to}T00:00:00Z`);
    t += 86_400_000
  )
    dates.push(new Date(t).toISOString().slice(0, 10));
  const T = dates.length;
  const C = countries.length;
  const O = REAL_OBS.length;
  const A = REAL_ACTIONS.length;
  const obs = new Float32Array(T * C * O).fill(NaN);
  const actions = new Float32Array(T * C * A).fill(NaN);
  const obsMask = new Uint8Array(T * C * O);
  const actionMask = new Uint8Array(T * C * A);
  const population = new Float64Array(C).fill(NaN);
  countries.forEach((code, c) => {
    const o = owid[code];
    const p = oxcgrt[code];
    if (o) population[c] = o.population;
    dates.forEach((date, t) => {
      const row = o?.days?.[date];
      if (row)
        row.forEach((v, j) => {
          if (Number.isFinite(v)) {
            obs[(t * C + c) * O + j] = v;
            obsMask[(t * C + c) * O + j] = 1;
          }
        });
      const act = p?.[date];
      if (act)
        act.forEach((v, j) => {
          if (Number.isFinite(v)) {
            actions[(t * C + c) * A + j] = v;
            actionMask[(t * C + c) * A + j] = 1;
          }
        });
    });
  });
  return {
    dates,
    obs: { data: obs, shape: [T, C, O] },
    actions: { data: actions, shape: [T, C, A] },
    obs_mask: { data: obsMask, shape: [T, C, O] },
    actions_mask: { data: actionMask, shape: [T, C, A] },
    population: { data: population, shape: [C] },
  };
}

/** ISO3 → ISO2 from the bundled Natural Earth countries (iso, iso2). */
export function isoTable(naturalEarth) {
  const out = {};
  for (const f of naturalEarth?.features || [])
    if (/^[A-Z]{3}$/.test(f?.iso || '') && /^[A-Z]{2}$/.test(f?.iso2 || ''))
      out[f.iso] = f.iso2;
  return out;
}
