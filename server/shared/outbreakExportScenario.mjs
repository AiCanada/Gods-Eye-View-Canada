/**
 * An Outbreak box run, downloaded (DOWNLOAD RESULTS, src/outbreakEpiExport.mjs),
 * as the base of a world-model sweep (owner request 2026-10-13, plan S4):
 * the run's pathogen and settings, its outbreak places, its window and the
 * flights its scan found, rebuilt on a frozen world. The network is the
 * world's (airport-anchored, no outbreak-specific places), so the result
 * is the same scenario on that world, not the box's numbers again.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { cleanProfile, distanceKm } from '../../src/outbreakCore.mjs';
import { cleanEpiProfile, flightPassengers } from '../../src/outbreakEpi.mjs';
import { placeIndex } from '../../src/worldTapeBin.mjs';

/** How far an outbreak place may be from the world place standing for it. */
export const EXPORT_PLACE_REACH_KM = 300;

/** A downloaded run and the sha256 of its bytes. */
export function readExport(file) {
  const bytes = fs.readFileSync(file);
  const doc = JSON.parse(bytes.toString('utf8'));
  if (!doc || typeof doc !== 'object' || !doc.request)
    throw new Error(`${file}: not an Outbreak DOWNLOAD RESULTS file`);
  return {
    doc,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}

/**
 * The scenario a downloaded run describes, on `world`.
 * @param {{request: object}} doc The downloaded JSON.
 * @param {{nodes: object[]}} world loadWorldSnapshot()
 * @returns {{profile: object, origins: number[], startMs: number, untilMs: number, days: number, flights: object[], flown: string[], dropped: {locations: number, flights: number}}}
 */
export function exportBase(doc, world) {
  const request = doc?.request || {};
  const startMs = Number(request.startMs);
  const untilMs = Number(request.untilMs);
  if (!Number.isFinite(startMs) || !(untilMs > startMs))
    throw new Error('The download has no window (startMs, untilMs).');
  const index = placeIndex(world.nodes);
  const origins = [];
  let droppedPlaces = 0;
  for (const place of Array.isArray(request.locations)
    ? request.locations
    : []) {
    const i = index.nearest(
      { lat: Number(place?.lat), lon: Number(place?.lon) },
      EXPORT_PLACE_REACH_KM,
    );
    if (i < 0) droppedPlaces += 1;
    else if (!origins.includes(i)) origins.push(i);
  }
  if (!origins.length)
    throw new Error(
      `No world place within ${EXPORT_PLACE_REACH_KM} km of the run's outbreak places.`,
    );
  const byCode = new Map();
  world.nodes.forEach((node, i) => {
    const code = String(node.code || '').toUpperCase();
    if (code && !byCode.has(code)) byCode.set(code, i);
  });
  const flights = [];
  const flown = [];
  let droppedFlights = 0;
  for (const f of Array.isArray(request.flights) ? request.flights : []) {
    const from = byCode.get(String(f?.from || '').toUpperCase());
    const to = byCode.get(String(f?.to || '').toUpperCase());
    const departMs = Number(f?.departMs);
    const arriveMs = Number(f?.arriveMs);
    if (
      from === undefined ||
      to === undefined ||
      from === to ||
      !Number.isFinite(departMs) ||
      !(arriveMs > departMs)
    ) {
      droppedFlights += 1;
      continue;
    }
    // Passengers as the box's own route counts them.
    const passengers = flightPassengers(
      distanceKm(world.nodes[from], world.nodes[to]),
      1,
    );
    flights.push({ from, to, departMs, arriveMs, passengers });
    flown.push(`${from}>${to}|${Math.round(departMs / 1_800_000)}`);
  }
  const raw = request.profile || {};
  return {
    profile: { ...cleanProfile(raw), ...cleanEpiProfile(raw) },
    origins,
    startMs,
    untilMs,
    days: Math.max(1, Math.ceil((untilMs - startMs) / 86_400_000)),
    flights,
    flown,
    dropped: { locations: droppedPlaces, flights: droppedFlights },
  };
}
