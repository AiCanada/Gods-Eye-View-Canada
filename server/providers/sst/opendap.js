/**
 * Reading OceanColor MODIS Aqua Level-3 mapped SST through OPeNDAP.
 *
 * The 4 km Level-3 grid is 4320 rows (row 0 at the north edge) by 8640 columns
 * (column 0 at 180° W), 24 cells per degree. OPeNDAP returns any striding
 * subset in DAP2 binary: a text header, "Data:\n", then each array as a
 * big-endian count written twice followed by its values. Int16 values travel
 * as 4-byte integers; Byte arrays travel as raw bytes padded to 4.
 */

export const L3_CELLS_PER_DEGREE = 24;
export const L3_ROWS = 4320;
export const L3_COLS = 8640;
/** Largest image side the server renders for one view. */
export const L3_MAX_CELLS_PER_SIDE = 1024;
/** Kilometres per grid cell at the equator (1/24 degree). */
export const L3_CELL_KM = 111.32 / L3_CELLS_PER_DEGREE;

const SST_SCALE = 0.005;
const SST_FILL = -32767;
const SST_VALID_MIN = -1000;
const SST_VALID_MAX = 10000;
const QUALITY_FILL = 255;
/** Quality levels 0-2 are good; 3 and above are cloud-edge or suspect retrievals. */
export const L3_MAX_QUALITY = 2;

/**
 * Parse "west,south,east,north" (degrees) into a clamped box. A box that
 * crosses the antimeridian or spans the globe widens to every longitude.
 *
 * @returns {{west:number, south:number, east:number, north:number}|null}
 */
export function normalizeBbox(value) {
  const parts = String(value ?? '')
    .split(',')
    .map((part) => Number(part.trim()));
  if (parts.length !== 4 || parts.some((part) => !Number.isFinite(part)))
    return null;
  let [west, south, east, north] = parts;
  south = Math.max(-90, Math.min(90, south));
  north = Math.max(-90, Math.min(90, north));
  if (north <= south) return null;
  west = Math.max(-180, Math.min(180, west));
  east = Math.max(-180, Math.min(180, east));
  if (east <= west || east - west >= 360) {
    west = -180;
    east = 180;
  }
  return { west, south, east, north };
}

/**
 * Grid rows/columns covering a box, strided so neither image side exceeds
 * `maxCellsPerSide`. Pixel k covers cells [start + k*stride, start + (k+1)*stride).
 */
export function gridIndexRange(
  bbox,
  { maxCellsPerSide = L3_MAX_CELLS_PER_SIDE } = {},
) {
  const clampRow = (value) => Math.max(0, Math.min(L3_ROWS - 1, value));
  const clampCol = (value) => Math.max(0, Math.min(L3_COLS - 1, value));
  const row0 = clampRow(Math.floor((90 - bbox.north) * L3_CELLS_PER_DEGREE));
  const row1 = Math.max(
    row0,
    clampRow(Math.ceil((90 - bbox.south) * L3_CELLS_PER_DEGREE) - 1),
  );
  const col0 = clampCol(Math.floor((bbox.west + 180) * L3_CELLS_PER_DEGREE));
  const col1 = Math.max(
    col0,
    clampCol(Math.ceil((bbox.east + 180) * L3_CELLS_PER_DEGREE) - 1),
  );
  const spanRows = row1 - row0 + 1;
  const spanCols = col1 - col0 + 1;
  const stride = Math.max(
    1,
    Math.ceil(Math.max(spanRows, spanCols) / maxCellsPerSide),
  );
  const rows = Math.ceil(spanRows / stride);
  const cols = Math.ceil(spanCols / stride);
  return {
    row0,
    col0,
    stride,
    rows,
    cols,
    rectangle: {
      west: -180 + col0 / L3_CELLS_PER_DEGREE,
      south: Math.max(-90, 90 - (row0 + rows * stride) / L3_CELLS_PER_DEGREE),
      east: Math.min(180, -180 + (col0 + cols * stride) / L3_CELLS_PER_DEGREE),
      north: 90 - row0 / L3_CELLS_PER_DEGREE,
    },
  };
}

/** DAP2 binary URL asking for SST and its quality over one grid range. */
export function opendapSubsetUrl(opendapUrl, range) {
  const lastRow = range.row0 + (range.rows - 1) * range.stride;
  const lastCol = range.col0 + (range.cols - 1) * range.stride;
  const slice = `%5B${range.row0}:${range.stride}:${lastRow}%5D%5B${range.col0}:${range.stride}:${lastCol}%5D`;
  return `${opendapUrl}.dods?sst${slice},qual_sst${slice}`;
}

/**
 * Decode an SST + quality DAP2 response for `range`. Cells that are fill,
 * out of range, or worse than `maxQuality` become NaN.
 *
 * @returns {{sst: Float32Array, latitudes: Float64Array, validCells: number}}
 */
export function parseDap2SstQuality(
  buffer,
  range,
  { maxQuality = L3_MAX_QUALITY } = {},
) {
  const marker = buffer.indexOf('Data:\n');
  if (marker < 0) throw new Error('OPeNDAP response has no data section');
  const cells = range.rows * range.cols;
  let offset = marker + 'Data:\n'.length;

  const need = (bytes) => {
    if (offset + bytes > buffer.length)
      throw new Error('OPeNDAP response is truncated');
  };
  const count = (expected, what) => {
    need(8);
    const n = buffer.readUInt32BE(offset);
    if (buffer.readUInt32BE(offset + 4) !== n || n !== expected) {
      throw new Error(`OPeNDAP ${what}: expected ${expected} values, got ${n}`);
    }
    offset += 8;
    return n;
  };
  const skipFloats = (expected, what) => {
    const n = count(expected, what);
    need(n * 4);
    offset += n * 4;
  };

  const raw = new Int32Array(cells);
  count(cells, 'sst');
  need(cells * 4);
  for (let i = 0; i < cells; i += 1) {
    raw[i] = buffer.readInt32BE(offset);
    offset += 4;
  }
  const latitudes = new Float64Array(range.rows);
  count(range.rows, 'sst latitude');
  need(range.rows * 4);
  for (let i = 0; i < range.rows; i += 1) {
    latitudes[i] = buffer.readFloatBE(offset);
    offset += 4;
  }
  skipFloats(range.cols, 'sst longitude');

  count(cells, 'quality');
  const padded = cells + ((4 - (cells % 4)) % 4);
  need(padded);
  const quality = buffer.subarray(offset, offset + cells);
  offset += padded;
  skipFloats(range.rows, 'quality latitude');
  skipFloats(range.cols, 'quality longitude');

  const sst = new Float32Array(cells);
  let validCells = 0;
  for (let i = 0; i < cells; i += 1) {
    const value = raw[i];
    const q = quality[i];
    const usable =
      value !== SST_FILL &&
      value >= SST_VALID_MIN &&
      value <= SST_VALID_MAX &&
      q !== QUALITY_FILL &&
      q <= maxQuality;
    sst[i] = usable ? value * SST_SCALE : Number.NaN;
    if (usable) validCells += 1;
  }
  return { sst, latitudes, validCells };
}
