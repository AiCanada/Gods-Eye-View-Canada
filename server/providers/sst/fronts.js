/**
 * Thermal front detection on a gridded SST field.
 *
 * A front is where temperature changes fast over distance. For each cell with
 * a complete 3x3 neighbourhood of good data, a Sobel filter gives the
 * gradient in °C per km (cell size shrinks with latitude east-west). Cells at
 * or above the threshold are thinned to one-cell-wide ridges by keeping only
 * local maxima across the gradient, and ridges shorter than `minCells`
 * (speckle, cloud-edge noise) are dropped.
 */

const KM_PER_DEGREE = 111.32;
/** 0.06 °C/km: about 0.3 °C across one 4 km cell pair, a clear surface front. */
export const FRONT_THRESHOLD_C_PER_KM = 0.06;
/** Shortest connected front kept, in cells. */
export const FRONT_MIN_CELLS = 6;

/**
 * Sensitivity levels offered in the SST box; the ids match
 * SST_FRONT_SENSITIVITIES in src/data/sstProducts.js. Strong is the default:
 * on real Gulf of Maine data it keeps the shelf, bay-mouth and eddy fronts and
 * drops the weak open-water gradients the lower thresholds trace.
 */
export const FRONT_SENSITIVITY = Object.freeze({
  strong: Object.freeze({ thresholdCPerKm: 0.15, minCells: 10 }),
  moderate: Object.freeze({ thresholdCPerKm: 0.1, minCells: 10 }),
  all: Object.freeze({
    thresholdCPerKm: FRONT_THRESHOLD_C_PER_KM,
    minCells: FRONT_MIN_CELLS,
  }),
});
export const DEFAULT_FRONT_SENSITIVITY = 'strong';

/**
 * @param {object} input
 * @param {Float32Array} input.sst °C, NaN where there is no good data.
 * @param {number} input.width
 * @param {number} input.height
 * @param {Float64Array|number[]} input.latitudes Centre latitude of each row.
 * @param {number} input.cellDegrees Cell size in degrees.
 * @returns {{strength: Float32Array, cells: number, maxGradientCPerKm: number, thresholdCPerKm: number, minCells: number}}
 */
export function detectThermalFronts({
  sst,
  width,
  height,
  latitudes,
  cellDegrees,
  thresholdCPerKm = FRONT_THRESHOLD_C_PER_KM,
  minCells = FRONT_MIN_CELLS,
}) {
  const total = width * height;
  const gx = new Float32Array(total);
  const gy = new Float32Array(total);
  const magnitude = new Float32Array(total);
  const dyKm = cellDegrees * KM_PER_DEGREE;

  for (let y = 1; y < height - 1; y += 1) {
    const cosLat = Math.cos((latitudes[y] * Math.PI) / 180);
    const dxKm = cellDegrees * KM_PER_DEGREE * Math.max(0.05, cosLat);
    for (let x = 1; x < width - 1; x += 1) {
      const i = y * width + x;
      const a = sst[i - width - 1];
      const b = sst[i - width];
      const c = sst[i - width + 1];
      const d = sst[i - 1];
      const e = sst[i];
      const f = sst[i + 1];
      const g = sst[i + width - 1];
      const h = sst[i + width];
      const k = sst[i + width + 1];
      // NaN compares false, so one missing neighbour skips the cell.
      if (!(a === a && b === b && c === c && d === d && e === e)) continue;
      if (!(f === f && g === g && h === h && k === k)) continue;
      const sx = (c + 2 * f + k - (a + 2 * d + g)) / (8 * dxKm);
      const sy = (g + 2 * h + k - (a + 2 * b + c)) / (8 * dyKm);
      gx[i] = sx;
      gy[i] = sy;
      magnitude[i] = Math.hypot(sx, sy);
    }
  }

  // Thin to ridges: keep a cell only if it is the maximum across the front.
  const ridge = new Uint8Array(total);
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const i = y * width + x;
      const m = magnitude[i];
      if (m < thresholdCPerKm) continue;
      const angle =
        ((((Math.atan2(gy[i], gx[i]) * 180) / Math.PI + 180) % 180) + 180) %
        180;
      let before;
      let after;
      if (angle < 22.5 || angle >= 157.5) {
        before = i - 1;
        after = i + 1;
      } else if (angle < 67.5) {
        before = i - width - 1;
        after = i + width + 1;
      } else if (angle < 112.5) {
        before = i - width;
        after = i + width;
      } else {
        before = i - width + 1;
        after = i + width - 1;
      }
      if (m >= magnitude[before] && m >= magnitude[after]) ridge[i] = 1;
    }
  }

  // Drop short ridges (8-connected components under minCells).
  const strength = new Float32Array(total);
  const seen = new Uint8Array(total);
  const stack = new Int32Array(total);
  const component = [];
  let cells = 0;
  let maxGradient = 0;
  for (let start = 0; start < total; start += 1) {
    if (!ridge[start] || seen[start]) continue;
    component.length = 0;
    let top = 0;
    stack[top++] = start;
    seen[start] = 1;
    while (top > 0) {
      const i = stack[--top];
      component.push(i);
      const x = i % width;
      const y = (i - x) / width;
      for (let dy = -1; dy <= 1; dy += 1) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) continue;
        for (let dx = -1; dx <= 1; dx += 1) {
          const nx = x + dx;
          if ((dx === 0 && dy === 0) || nx < 0 || nx >= width) continue;
          const j = ny * width + nx;
          if (ridge[j] && !seen[j]) {
            seen[j] = 1;
            stack[top++] = j;
          }
        }
      }
    }
    if (component.length < minCells) continue;
    for (const i of component) {
      strength[i] = magnitude[i];
      if (magnitude[i] > maxGradient) maxGradient = magnitude[i];
    }
    cells += component.length;
  }

  return {
    strength,
    cells,
    maxGradientCPerKm: Math.round(maxGradient * 1000) / 1000,
    thresholdCPerKm,
    minCells,
  };
}
