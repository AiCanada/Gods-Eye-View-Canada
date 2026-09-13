/** Cold-to-warm ramp; the SST box legend draws the same seven stops. */
const RAMP = [
  [44, 15, 122],
  [31, 95, 214],
  [34, 195, 230],
  [61, 220, 132],
  [242, 227, 59],
  [242, 139, 43],
  [215, 38, 61],
];

/** Colour for t in [0, 1] along the ramp. */
export function rampColor(t) {
  const x = Math.min(1, Math.max(0, t)) * (RAMP.length - 1);
  const i = Math.min(RAMP.length - 2, Math.floor(x));
  const f = x - i;
  return RAMP[i].map((channel, k) =>
    Math.round(channel + (RAMP[i + 1][k] - channel) * f),
  );
}

/**
 * Display range for one view: the 2nd-98th percentile of good cells, widened
 * to at least `minSpanC` so a calm patch of ocean is not stretched into noise.
 *
 * @returns {{min: number, max: number}|null}
 */
export function sstDisplayRange(sst, { minSpanC = 2 } = {}) {
  let count = 0;
  for (const value of sst) if (value === value) count += 1;
  if (!count) return null;
  const values = new Float32Array(count);
  let n = 0;
  for (const value of sst) if (value === value) values[n++] = value;
  values.sort();
  let min = values[Math.floor(0.02 * (count - 1))];
  let max = values[Math.ceil(0.98 * (count - 1))];
  if (max - min < minSpanC) {
    const mid = (min + max) / 2;
    min = mid - minSpanC / 2;
    max = mid + minSpanC / 2;
  }
  return { min: Math.round(min * 10) / 10, max: Math.round(max * 10) / 10 };
}

/** SST cells coloured along the ramp; cells without good data stay transparent. */
export function renderSstRgba(sst, width, height, range) {
  const rgba = new Uint8Array(width * height * 4);
  if (!range) return rgba;
  const span = range.max - range.min || 1;
  for (let i = 0; i < width * height; i += 1) {
    const value = sst[i];
    if (value !== value) continue;
    const [r, g, b] = rampColor((value - range.min) / span);
    const o = i * 4;
    rgba[o] = r;
    rgba[o + 1] = g;
    rgba[o + 2] = b;
    rgba[o + 3] = 255;
  }
  return rgba;
}

/**
 * Front cells in white; stronger fronts are more opaque. Everything else is
 * transparent so the layer sits over any SST colouring or basemap.
 */
export function renderFrontsRgba(strength, width, height, thresholdCPerKm) {
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    const value = strength[i];
    if (!(value > 0)) continue;
    const t = Math.min(1, value / (thresholdCPerKm * 4));
    const o = i * 4;
    rgba[o] = 255;
    rgba[o + 1] = 255;
    rgba[o + 2] = 255;
    rgba[o + 3] = Math.round(150 + 105 * t);
  }
  return rgba;
}
