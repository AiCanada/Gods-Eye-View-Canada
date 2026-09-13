// Shared converter for the 511 sites that run the same traveller-information
// platform (511.alberta.ca, 511on.ca). Their /cctv page is a DataTables list
// backed by /List/GetData/Cameras?query=<json>&lang=en-US, which pages 100
// camera sites at a time with exact points and needs no key.
//
// A camera site can carry several views (a pole looking both ways along the
// highway), and each view has its own still at https://<host>/map/Cctv/<id>,
// so every switched-on view becomes one pack entry.

const COMPASS = {
  N: 0, NORTH: 0, NE: 45, NORTHEAST: 45, E: 90, EAST: 90, SE: 135, SOUTHEAST: 135,
  S: 180, SOUTH: 180, SW: 225, SOUTHWEST: 225, W: 270, WEST: 270, NW: 315, NORTHWEST: 315,
};

// Only a label that is nothing but a direction ("North", "Road W", "Eastbound",
// "Looking East") is a view bearing. "SE" inside a Calgary street name is a
// quadrant, "East side of HWY" says where the pole stands, and "Toronto Bound"
// names a destination, not a compass point.
export function headingFrom(label) {
  const m = String(label || '').trim().match(/^(?:road\s+|looking\s+)?([a-z]+?)(?:bound)?$/i);
  if (!m) return null;
  const deg = COMPASS[m[1].toUpperCase()];
  return Number.isFinite(deg) ? deg : null;
}

// "POINT (lon lat)"
function pointFrom(site) {
  const m = String(site.latLng?.geography?.wellKnownText || '').match(/POINT\s*\(\s*(-?[\d.]+)\s+(-?[\d.]+)\s*\)/i);
  return m ? { lon: Number(m[1]), lat: Number(m[2]) } : null;
}

/**
 * @param {object[]} sites  the `data` rows of every list page
 * @param {object} opts
 * @param {string} opts.host        e.g. '511on.ca'
 * @param {string} opts.idPrefix    e.g. 'on511'
 * @param {string} opts.cityId      province code used by the pack
 * @param {string} opts.provider    provider label shown per camera
 * @param {string} opts.operator    operator named in each entry's license
 * @param {string} opts.regionFallback  city label when a site names no region
 * @param {{latMin:number,latMax:number,lonMin:number,lonMax:number}} [opts.bounds]
 */
export function listSitesToEntries(sites, opts) {
  const out = [];
  const skipped = {};
  const skip = (why) => {
    skipped[why] = (skipped[why] || 0) + 1;
  };
  const { bounds } = opts;

  for (const site of sites) {
    const point = pointFrom(site);
    if (!point || !Number.isFinite(point.lat) || !Number.isFinite(point.lon)) { skip('no coordinates'); continue; }
    if (bounds && (point.lat < bounds.latMin || point.lat > bounds.latMax || point.lon < bounds.lonMin || point.lon > bounds.lonMax)) {
      skip('outside the province');
      continue;
    }
    // A view the operator has switched off is kept: cameras drop out for
    // minutes or days and come back, and the proxy already backs off from a
    // still that fails and shows the placeholder card until it returns.
    const views = (site.images || []).filter((view) => {
      if (!/^\/map\/Cctv\/\d+$/.test(String(view.imageUrl || ''))) { skip('no still'); return false; }
      return true;
    });
    const location = String(site.location || site.roadway || `${opts.provider} site ${site.id}`).trim();
    views.forEach((view, index) => {
      const label = String(view.description || '').trim();
      const meaningful = label && !/^(n\/a|c\d+)$/i.test(label) && label.toLowerCase() !== location.toLowerCase();
      const heading = headingFrom(label) ?? (views.length === 1 ? headingFrom(site.direction) : null);
      const name = views.length > 1
        ? `${location} (${meaningful ? label : `view ${view.sortOrder ?? index + 1}`})`
        : location;
      out.push({
        id: `${opts.idPrefix}-${view.id}`,
        name,
        city: String(site.region || opts.regionFallback).trim(),
        cityId: opts.cityId,
        provider: opts.provider,
        sourceKind: 'configured',
        feedType: 'image',
        url: `https://${opts.host}${view.imageUrl}`,
        lat: point.lat,
        lon: point.lon,
        headingDeg: heading,
        headingConfidence: heading === null ? 'unknown' : 'estimated',
        pitchDeg: -6,
        fovDeg: 70,
        rangeM: 500,
        mountHeightM: 10,
        groundElevationM: 10,
        license: `${opts.operator}${site.roadway ? `: ${String(site.roadway).trim()}` : ''}`,
        coordConfidence: 'exact',
        country: 'CA',
      });
    });
  }
  return { entries: out, skipped };
}

export function summary(name, entries, siteCount, skipped) {
  const withHeading = entries.filter((c) => c.headingConfidence === 'estimated').length;
  return `${name}: ${entries.length} camera views from ${siteCount} sites (${withHeading} with a heading)` +
    `${Object.keys(skipped).length ? `; skipped ${JSON.stringify(skipped)}` : ''}\n`;
}
