# World-model data

What the Artificial Intelligence World Training Sim
([AI-WORLD-TAB.md](AI-WORLD-TAB.md)) and its tools write, for training world
models on the Outbreak sim plus every live feed (owner request, 2026-10-13:
"I would like to train future world models based on this SIM + other data";
"live data for vehicles and trains, weather, ect."; "use all feeds").
Everything lives under `.gev-data/` (gitignored) and stays on this machine;
nothing is published without the owner's say for that release.

```
.gev-data/
  outbreak/worlds/<worldId>/        frozen world graph
  outbreak/datasets/<name>/         sim episodes
  tape/<feed>/YYYY/MM/DD/…          every live feed, as recorded (and backfilled)
  bins/<worldId>/YYYY/MM/DD.*.npy   the tape binned onto the world graph
  demographics/                     World Bank age structure and urban share
  real/owid-oxcgrt/                 real epidemics and policy, 2020–2022
  ai-world/state.json               the tab's job state
  ai-world/areas.json               areas for the area-based feeds (cameras, imagery)
  ai-world/models/<model>/          checkpoints, metrics
  ai-world/predictions/<domain>.json  the latest prediction per domain
```

All arrays are little-endian `.npy` (version 1.0), readable with
`numpy.load`; writers are dependency-free (`src/outbreakEpiShard.mjs`). All
times are UTC milliseconds unless a name says otherwise.

| Tool                              | npm script            | Writes                                           |
| --------------------------------- | --------------------- | ------------------------------------------------ |
| `scripts/outbreak-world.mjs`      | `outbreak:world`      | a world snapshot                                 |
| `scripts/outbreak-dataset.mjs`    | `outbreak:dataset`    | sim episodes (resumable, `--pilot`)              |
| `scripts/world-tape-bin.mjs`      | `world-tape:bin`      | bins for complete days                           |
| `scripts/world-tape-backfill.mjs` | `world-tape:backfill` | past USGS, FIRMS, GFS, HURDAT2 and VIIRS records |
| `scripts/outbreak-real-data.mjs`  | `outbreak:real-data`  | the OWID + OxCGRT arrays                         |
| `scripts/outbreak-env.mjs`        | `outbreak:env`        | nothing: a closed-loop environment on stdio      |

The tab runs the recorder, the dataset job, demographics, training and
prediction itself; the tools are the same code for use by hand.

## Licence classes

Every dataset, tape record and model carries the classes it was built from.

| Class        | Meaning                                                                                                     |
| ------------ | ----------------------------------------------------------------------------------------------------------- |
| `open`       | public domain, CC0, PDDL, CC BY, ODbL, national open licences (attribution or share-alike noted per source) |
| `nc`         | non-commercial use only (OpenSky, Open-Meteo's free API, Google News, TeleGeography)                        |
| `restricted` | the terms bar storage or derived use (TomTom, adsbdb, social-swarm model outputs)                           |
| `unclear`    | no or unconfirmed terms (AISStream, many CCTV operators)                                                    |
| `personal`   | the owner's own devices                                                                                     |
| `static`     | a layer recorded as a daily snapshot                                                                        |

Only `open` data may ever enter something published, and only with the
owner's say. The rest is for local training.

## World snapshot (`outbreak/worlds/<worldId>/`)

The places, routes and commuting the epidemic model runs on, built once from
`.gev-cache/outbreak` with no outbreak location (every scheduled airport,
the GeoNames towns near an airport or on the world rail) by the same
assembly the Outbreak route uses (`server/shared/outbreakEpidemicWorld.mjs`).
Built 2026-10-13 from the real caches: 76,690 places, 243,749 air and rail
routes, 5,000 tracked, 236 countries, in about 8 s.

| File                | Shape / type   | Content                                                                                                                                                                                                              |
| ------------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `world.json`        | JSON           | `schema: 'gev-outbreak-world/1'`, `worldId`, `builtAt`, `node`, `v8`, `counts`, `countries[]`, `sources[]` (cache file, sha256, bytes), `rail` (build time, version, speed), `railSource`, `railStats`, `licences[]` |
| `nodes.npy`         | float64 [n, 8] | lat, lon, population, kind (0 airport, 1 city, 2 origin), size (0, 1 M, 2 L), country index, UTC offset hours (NaN: by longitude), tracked index (−1 if not tracked)                                                 |
| `node_ids.json`     | JSON           | `{ id: [], code: [], name: [] }`, n each                                                                                                                                                                             |
| `countries.json`    | JSON           | ISO2 codes, sorted, then `''` (no country)                                                                                                                                                                           |
| `routes.npy`        | float64 [R, 7] | from, to, timeOfDayMs, lengthMs, passengers a day, mode (0 air, 1 rail), km (NaN for air)                                                                                                                            |
| `links_offsets.npy` | int32 [n + 1]  | gravity commuting, CSR                                                                                                                                                                                               |
| `links_j.npy`       | int32 [L]      |                                                                                                                                                                                                                      |
| `links_share.npy`   | float64 [L]    |                                                                                                                                                                                                                      |
| `tracked.npy`       | int32 [K]      | every large airport (busiest first), then the most populous, up to K (default 5,000)                                                                                                                                 |

`worldId` is the first 16 hex digits of a sha256 over every file but
`world.json`: for each file name in sorted order, the name, then the file's
bytes. The same caches always give the same world. `world.json` also
carries `classes: ['open']`. Limits: a
remote outbreak location never becomes its own place, towns more than 300 km
from every airport but near a typed location are not places, and there are
no scan flights (OpenSky's terms are non-commercial).

## Sim episodes (`outbreak/datasets/<name>/`)

```
dataset.json   schema 'gev-outbreak-dataset/1'; generator (package version,
               git commit, sha256 of src/outbreak*.mjs, node, v8), worldId,
               spec (seed, scenarios, runs, days, perShard, compareShare,
               policyMix; drivers {binsRoot, startDays} for recorded
               conditions; fromExport {file, sha256} for a box run's
               sweep), channels, licences, classes (['open'], plus the
               bins' classes with recorded conditions), counts
README.md      the dataset card
index.jsonl    one line per episode: key, shard, scenario, run, arm, pair,
               worldId, preset, policy, compare, labels
shards/shard-<n>.tar.gz   per episode: <key>.json and <key>.<array>.npy
```

An episode is one run of one sampled scenario (`src/outbreakEpiScenarios.mjs`:
a prefix-stable R_d sweep over the box's presets, menus with unset as a
choice of its own, origins among the tracked places, season, the comparison
arm and the policy). Its key is `s<scenario>-r<run>-<arm>` (`s000123-r05-A`);
arm `B` is the paired comparison (`counterfactualParams`), which draws the
same xoshiro128** stream as arm A (common random numbers). The index's
`pair` is the key without the arm (`s000123-r05`), the same for both arms. A shard is a fixed
slice of scenarios, so a dataset is the same whatever the scheduling, a
resumed shard is written again byte for byte, and `--pilot N` writes the
first scenarios and projects the size and time of the sweep. Measured on the
world above: about 270 KB per compressed 10-day episode.

Two options change where scenarios come from (`scripts/outbreak-dataset.mjs`):

- `--drivers` starts every scenario on a day the world tape binned onto the
  world (the list is frozen in the spec when the sweep starts, so a resume
  draws the same dates) and runs it under the conditions recorded then
  (Recorded conditions as sim drivers, below). Each episode says so:
  `drivers: { from: 'bins', kinds, recordedDays }` in its JSON and
  `recordedDays` in the index.
- `--from-export run.json` takes an Outbreak box run saved with DOWNLOAD
  RESULTS as every scenario's base: its pathogen and settings, its outbreak
  places (the nearest world place within 300 km), its window and the flights
  its scan found (by airport code, passengers as the box's route counts
  them), on the frozen world. Scenarios differ only in policy and random
  stream (preset `export`, `fromExport: { sha256, flights }` in the JSON); a
  changed file is refused on resume.

T is the number of days; row 0 of every `[T + 1, …]` array is the state
before hour 0; C counts the world's countries plus one for none.

| Member                    | Shape / type          | Content                                                                                                                                                                                                                                                                                                                         |
| ------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<key>.json`              | JSON                  | `schema: 'gev-outbreak-episode/1'`, the scenario (profile, origins, startMs, untilMs, policy, policySeed, streamKey), `labels` (extinct, infected, deaths, reported, peakDay, peakNew, peakWard, reached, countriesReached, switches, flags), `constants` (the run's fixed intervention settings), each array's shape and dtype |
| `global.npy`              | float64 [T + 1, 20]   | `GLOBAL_CHANNELS`                                                                                                                                                                                                                                                                                                               |
| `country_state.npy`       | uint32 [T + 1, C, 15] | `STATE_CHANNELS` summed per country                                                                                                                                                                                                                                                                                             |
| `country_cum.npy`         | uint32 [T + 1, C, 7]  | `CUM_CHANNELS` per country                                                                                                                                                                                                                                                                                                      |
| `place_state.npy`         | uint32 [T + 1, K, 15] | `STATE_CHANNELS` per tracked place                                                                                                                                                                                                                                                                                              |
| `place_cum.npy`           | uint32 [T + 1, K, 7]  | `CUM_CHANNELS` per tracked place                                                                                                                                                                                                                                                                                                |
| `place_aux.npy`           | float32 [T + 1, K, 6] | `AUX_CHANNELS` per tracked place                                                                                                                                                                                                                                                                                                |
| `actions_global.npy`      | float32 [T, 9]        | `GLOBAL_ACTIONS` for day d                                                                                                                                                                                                                                                                                                      |
| `actions_country.npy`     | float32 [T, C, 2]     | `COUNTRY_ACTIONS`                                                                                                                                                                                                                                                                                                               |
| `actions_place.npy`       | float32 [T, K, 3]     | `PLACE_ACTIONS`                                                                                                                                                                                                                                                                                                                 |
| `controls_window.npy`     | uint32 [T]            | bit k: the intervention window was on at hour 24d + k                                                                                                                                                                                                                                                                           |
| `controls_magnitudes.npy` | float64 [T, 4]        | `MAGNITUDE_CONTROLS` the day's control set (lockdown, travelBan, testsPer1000Day, vaccinePer1000Day), NaN where it left the scenario's own setting; written by newer generators, optional for readers                                                                                                                           |
| `controls_switch.npy`     | int32 [M, 3]          | (day, node, 1 on / 0 off): every per-place switch change at a tick, anywhere in the world                                                                                                                                                                                                                                       |
| `controls_flags.npy`      | int32 [F, 2]          | (day, country index): countries flagged at a tick                                                                                                                                                                                                                                                                               |
| `flows.npy`               | int32 [G, 6]          | (day, from node, to node, mode, kind, people)                                                                                                                                                                                                                                                                                   |
| `events.npy`              | int32 [E, 4]          | (hour, node, kind, value)                                                                                                                                                                                                                                                                                                       |

`controls_*` replay the run exactly: fed back as a control
(`replayPolicy`), the same seed gives the same episode, byte for byte
(tested on every scenario of the matrix). `actions_*` are the same
decisions as dense features for learning. Flows reconcile each day: the
change in the run's in-transit count is boarded − caught at exit − caught at
entry − landed − found at the gate, and the change in isolated is the
three catches.

Channels (the order is the column order):

- `STATE_CHANNELS`: S, E, P, Is, Ia, H, U, R, D, V, E2, P2, Is2, Ia2, Rx.
  S, R, V are caught up for places the hourly loop has not touched (the
  engine's own catch-up arithmetic, on copies).
- `CUM_CHANNELS`: infected, reported, admitted, imported, local, reinfected,
  infected2.
- `AUX_CHANNELS`: switchOn, compliance, caution, contactsLeft, testsUsed,
  saturated.
- `GLOBAL_CHANNELS`: infected, reported, deaths, ward, icu, admitted,
  restrictedPeople, vaccinated, countriesClosed, imported, reinfected,
  distancing, bedsShort, restrictedPlaces, icuAdmitted, infected2,
  inTransit, pendingAdmit, isolated, globalSignal.
- `GLOBAL_ACTIONS`: windowShare, tracingIsolate, tracingPresym,
  exitScreening, entryScreening, quarantine, importDetect, lockdownEverywhere,
  travelBanEverywhere. windowShare is the share of that day's simulated
  hours inside the window (a partial last day counts its own hours); the
  others are their setting times windowShare, 0 outside the window — except
  importDetect, which the model never gates by the window, so it is the
  detection share every day.
- `COUNTRY_ACTIONS`: borderScope (its international legs are in the
  policy's reach), flagged.
- `PLACE_ACTIONS`: lockdown (intensity before compliance), banned (the
  travel restriction applies to its legs), vaccineTarget (share protected).
- `FLOW_KINDS`: 0 boarded, 1 caught at exit screening, 2 caught at entry
  screening or quarantine (also at a hub before flying on), 3 landed,
  4 found at the gate, 5 flew on from a hub. Modes: 0 air, 1 rail, 2 onward.
  `from` is −1 where the leg's origin is unknown.
- `EVENT_KINDS`: 0 first arrival (value: 1 seed, 2 air, 3 ground), 1 first
  report, 2 first death, 3 ten cases, 4 beds overwhelmed, 5 switch on,
  6 switch off, 7 country flagged (node −1, value: country index),
  8 second strain seeded (node −1).

Policies (`src/outbreakEpiActions.mjs`): `rules` (the model's own triggers,
thresholds sampled), `random` (the window on and off in runs of days,
places switched, countries flagged, and the magnitudes held for runs of
days — lockdown level 0–0.9, ban share 0–1, a quarter to twice the
scenario's tests, none to twice its campaign's doses — from a generator of
their own: exploration, so actions are not caused by cases), `none`
(nothing ever on). The `actions_*` features use the magnitudes as applied
that day, and `vaccineTarget` is the engine's own target.

## World tape (`tape/`)

Every ticked feed is recorded through the app's own `/api/` routes (the
layers' portable sources, `src/tools/services.js`), so the providers'
caches, rate limits, per-host budgets and keys apply, at or below each
layer's own cadence (`server/shared/worldTape/feeds/*.mjs`). Recent imagery
and plate-reader cameras have no app route; their sources fetch NASA and the
OpenStreetMap extract directly, as the browser does. Feeds that record
around places (cameras, traffic, news, imagery, street level, the mapped
static layers) use the tab's AREAS (`ai-world/areas.json`).

```
tape/<feed>/YYYY/MM/DD/HH.ndjson.gz      records: one gzip member per write
tape/<feed>/YYYY/MM/DD/HH/<file>         frames, rasters and grids
tape/<feed>/YYYY/MM/DD/manifest.jsonl    one line per poll: {t, hour, records, bytes, files}
tape/gaps.jsonl                          {from, to, reason, feeds}: pauses, stops, restarts
```

Every record is one JSON object with `t` (ms), `feed`, `class`, `licence`,
then the feed's own fields (earthquakes: id, lat, lon, depth, mag, place,
time; transit: region, the vehicle's own GTFS-Realtime fields, and `mode`
with `modeInferred`; wind: one int16 grid file per model, cycle, step and
field — u10, v10, t2m, msl, q2m (2 m specific humidity, kg/kg) and prate
(GFS's time-mean precipitation rate, mm/h, with the `window` it averages in
forecast hours and as `windowStartIso`/`windowEndIso`) — each record giving
`grid`, `units`, `scale` and `offset` (value = q × scale + offset);
flights: hex, callsign, lat, lon, alt (m), speed (m/s), track (°), vrate
(m/s), ground, source (`opensky` or `adsb.lol`, whose rows carry their own
`class` and `licence`), seen (ms), country, and on OpenSky rows `auth`, the
OpenSky account the proxy used (`anon`, `basic` or `oauth`) — anonymous
OpenSky (about 400 credits a day) is recorded at most once an hour,
signed-in every 5 minutes; street-level: a record per Mapillary sequence
(area, sequence, image, capturedAt, pano, onFoot, quality, bbox, start,
end, points) and, with `kind: 'image'`, a record per image (id, capturedAt
(ms), lat, lon, compass (degrees: Mapillary's computed angle when it has
one, else the camera's), sequence, isPano, cameraType, area), each recorded
once, from 0.05° cells around each area, nearest first, at most 32 searches
an area a day (a truncated cell is split down to 0.0125°); others as their
adapter documents). The tape's feed names are the DataManager layer ids
(`server/shared/worldTape/catalog.mjs`): `earthquakes`, `transit`,
`flights`, `military`, `ais-live-vessels`, `traffic`, `cctv`,
`weather-radar`, `weather-satellite`, `weather-lightning`, `wind`,
`weather-cyclones`, `local-firms`, `fire-perimeters`, `satellites`,
`rocket-launches`, `bikeshare`, `radio`, `recent-imagery`, `street-level`,
`local-adsb`, `device-feeds`, `private-cctv`, the daily snapshots of the
static layers, plus `news` and `flight-enrichment`. A poll that found
nothing new still writes a manifest line, so a quiet hour reads as
observed, not missing; a poll cut short by PAUSE or STOP writes nothing. Backfilled records carry
`backfill: true` and sit under their own past hour. At the storage cap or a
feed's quota, that feed stops and says so; nothing is ever deleted except
by the tab's DELETE, with its preview. Never recorded: basemaps (Google 3D
tiles, Esri, map stacks), radio audio, and school, university, college or
library cameras.

### Backfill

`scripts/world-tape-backfill.mjs` (`npm run world-tape:backfill -- --from
YYYY-MM-DD --to YYYY-MM-DD [--feeds …] [--area lat,lon[,name]]…`) fills past
days from sources that keep an archive, in the live feeds' own record
formats. Every record carries `backfill: true` and sits under the hour it
shows. The tool fetches; the server never does.

- `earthquakes`: the USGS FDSN catalogue, M2.5+, each event under its hour.
- `local-firms`: NASA FIRMS VIIRS SNPP NRT by day (your own MAP_KEY; recent
  months), each detection under its acquisition hour.
- `wind`: the NOAA GFS archive on AWS, the bucket and object keys the Wind
  proxy reads, kept in this layout from the 2021-03-22 12Z cycle (GFS v16;
  the bucket's earlier 2021 cycles have no `atmos/` folder and are skipped).
  For each 00, 06, 12 and 18Z cycle: the analysis's (f000) u10, v10, t2m,
  msl and q2m under the cycle's hour, and f006's 0–6 h mean prate (with its
  `window`) under the middle of its window (cycle + 3 h), resampled to 1°
  and converted exactly as the proxy serves them and written by the live
  feed's own `gridFile` (`model: 'gfs'`, `step` 0 or 6). About 3.1 MB a day
  on the tape (24 grids of 130 KB) from about 23 MB of byte ranges, about
  5 s a day. A cycle missing from the bucket, or failing, is skipped and
  logged. The binner also reads the next day's first grids, so a day's last
  hours take the next 00Z analysis.
- `weather-cyclones`: NHC HURDAT2 best tracks, Atlantic (from 1851) and
  Northeast and North Central Pacific (from 1949), the newest file of each
  in the NHC listing. One record per fix: `id` (`al092023`), `name`,
  `basin`, `classification` (HURDAT2's status: TD, TS, HU, EX, SD, SS, LO,
  WV, DB), `lat`, `lon`, `windKt`, `pressure` (hPa; null where missing),
  `positionAt`, `recordType` (L landfall, P minimum pressure, I intensity
  peak, …) and `source: 'HURDAT2'`, under the fix's hour. A season is
  published months after it ends, so the latest dates have none yet.
- `recent-imagery`: NASA GIBS's VIIRS (NOAA-21, the satellite the live feed
  records) daily true-colour image of each AREA (`ai-world/areas.json`, or
  `--area`), with the box, size, file name and record the live feed makes
  (`product: 'VIIRS'`, `quality: 'overview'`), under 12:00 UTC of its day.
  GIBS holds it from 2023-02-10; a day it has no image of
  (`Data-Present: false`) and a day not yet over are skipped.

## Bins (`bins/<worldId>/`)

`scripts/world-tape-bin.mjs` (`src/worldTapeBin.mjs`) turns each complete
UTC day of tape into hourly features on the world's tracked places:
`YYYY/MM/DD.<group>.npy`, float32 [24, K, channels], with `channels.json`.
A point counts for the nearest tracked place within reach (60 km for
mobility, 300 km for quakes, 100 km for news). NaN means not observed (a
feed not ticked, or a gap), never zero. `YYYY/MM/DD.classes.json` lists the
licence classes each group was built from that day (`{ group: [classes] }`).
Counts do not grow with how often a feed was polled: in each hour an
aircraft, vessel or vehicle counts once, where it was last seen
(`lastBy`), take-offs count at each ground-to-air change, a bike station
is its mean over the hour's polls, a revised quake or fire perimeter counts
once, and traffic segments count per poll.

| Group      | Channels                                                                                                                 |
| ---------- | ------------------------------------------------------------------------------------------------------------------------ |
| `mobility` | aircraft, aircraftOnGround, aircraftDepartures, vessels, transitVehicles, transitBuses, transitMeanSpeed, bikesAvailable |
| `trains`   | railVehicles, railMeanSpeed                                                                                              |
| `traffic`  | speedRatio, segments                                                                                                     |
| `weather`  | t2m, humidity, precip, u10, v10, mslp                                                                                    |
| `hazards`  | quakes, quakeMaxMag, fireRadiativePower, fireDetections, perimeterAcres, cycloneDistanceKm                               |
| `news`     | articles                                                                                                                 |

Military travel is never data (owner ruling 2026-10-15). Military flights are not a bin source and not a track-training source. The civil flights and local ADS-B feeds drop every airframe the app's military list names before recording. AIS military vessels (ship type 35) are never recorded. Mobility has no military column (bins written before 2026-10-16 have a ninth, empty one, and a model trained on them is grown to the new channels when it post-trains). Any other non-military feed that is not already a source of these groups is appended as its own group with a `count` channel and, when the record has a number, a `value` channel (the mean at that place). Sea surface temperature and observed weather use `value`. `markets` copies each live quote onto every tracked place for that hour, including gasoline, jet fuel, and jet kerosene when a print exists. `news-urls` is a count of new titles that hour, also on every place. `news-markets` counts headlines that name a price series: a local story on the nearest place, a URL title with no coordinates on every place. A title that does not name a series adds nothing. `Europe` is not counted as the euro. An extra feed's channels are `count` plus each of `value`, `precipitationMm`, `windKph`, `cloudCoverPct`, `pm25`, and `dischargeCfs` that the day's records actually contain. AIS adds a `supply` group: tankers, food cargo, metal cargo, container cargo, and other cargo, counted only when the type or destination says so. `links.json` names the hours those channels share with prices. A shared hour is not a cause, and a blank side stays blank. Dams, datacenters, and submarine cables are not given a motion channel. A later map source is another feed in that list.

Where the channels come from:

- **Weather** is sampled (bilinear) at each place from the grids the `wind`
  feed recorded that day: in each hour, each field from the grid valid
  nearest the middle of the hour, within 3 hours (a time mean counts at
  the middle of the hours it averages), GFS before ECMWF IFS.
  Units: t2m °C, humidity kg/kg (2 m specific humidity, the q of the
  season driver), precip mm/h (GFS's time-mean rate), u10 and v10 m/s,
  mslp hPa. A grid in a unit the binner does not know is left out, never
  guessed (`WEATHER_FIELDS` in `src/worldTapeBin.mjs`).
- **Trains** are transit vehicles whose `mode` is tram, subway or rail. The
  transit feed stamps each vehicle with the mode the layer paints it in (the
  operator's route-id rules, else the feed's default, with `modeInferred`
  saying which); speeds are GTFS-Realtime `speedMps`.
- **Traffic** `speedRatio` is the traffic feed's per-area `speedShare` (the
  length-weighted ratio of flow to free-flow speed) and `segments` the road
  segments measured in that area that hour.

### `assets.json` and the measured links

`assets.json` (written beside `channels.json` and `links.json`) names every
asset behind the `markets.<id>` and `news-markets.<id>` channels, from
`src/marketAssets.mjs`:

```json
{
  "tsx": {
    "label": "S&P/TSX Composite",
    "group": "equity",
    "unit": "points",
    "symbol": "^GSPTSE",
    "hub": { "name": "Toronto", "lat": 43.6481, "lon": -79.3815 }
  }
}
```

`hub` is where the benchmark is priced or delivered; it is null for an asset
with no home (crypto). The predictor places each predicted move there.

`ai-world/models/links/links.json` (`ml.gevtape.links`) holds the measured
layer-asset links. For every channel and asset it tests lags from -24 h to
+24 h (a positive lag means the channel moves first), fitted on the first
70 % of the hours and checked on the rest. Each result has `channel`,
`asset`, `lagHours`, `r`, `n`, `p`, `q` (Benjamini-Hochberg), `rTest`,
`nTest` and `holds` (the later hours agree in sign with at least half the
strength), plus `studyPairs`, the best link for each pair in `links.json`.
Hourly series are autocorrelated, so `holds` is the stronger evidence.

### A training set to take elsewhere (`ml.gevtape.export`)

`py -3.13 -m ml.gevtape.export --data .gev-data --out <new folder>
[--classes open] [--days FIRST:LAST]` copies the bins (only the groups whose
classes are all allowed), `channels.json`, `places.json` (the K tracked
places: name, lat, lon, population, country, UTC offset), `assets.json`,
`links.json` and `links-measured.json`. It also writes `manifest.json` (every
file's size and sha256, the licence mix, `publishable`, what the class filter
left out) and a `DATASET.md` card. numpy alone reads it.

### Reinforcement learning (`ml.gevtape.world_env`)

`WorldMarketEnv(data_root, split="train"|"test", context=24,
episode_hours=168, cost_bps=1.0, model=None)` steps through the recorded
hours. The observation is `layers`/`mask` `[context, K, C]`, `prices`
`[context, A]`, `position` `[A]` and `hour`. The action is a weight per
asset in -1 to 1, scaled to no leverage. The reward is the next hour's
portfolio return minus turnover cost; a closed market earns nothing. With
`model=` (any `model(window, time_ms) -> next hour`, or `KitWorldModel` for
the kit's own) the episode is imagined from a recorded start.

### Post-training (`ml.gevtape.posttrain`)

An adapter (a class in `ml/adapters/` or `.gev-data/ai-world/adapters/`)
loads an existing world model, takes `train_step(batch)` and
`evaluate(batch)`, and `save(folder)`s it. The batch is the same windows the
kit's model trains on. The last recorded days are held out, and
`ai-world/models/posttrain/metrics.json` gives the loss before and after.
The kit's own world model post-trains daily by itself, and grows when the
channels change (`models.grow_world_model`).

### Custom LLM data (`llm/`)

`llm/<name>/data/` (`ml.gevtape.llm_data`) holds `train.jsonl` and
`heldout.jsonl` (one example in twenty, by a hash of its text). Each line is
`{"text": …}` or `{"messages": […]}`, plus `source` and `class`.
`manifest.json` gives counts by source, classes, bytes and `dataThrough`.
`llm/<name>/model/` (`ml.gevtape.llm_train`) holds `adapter.safetensors`
(the LoRA weights) and `adapter.json`: base, rank, alpha, targets, the
dataset manifest, the held-out loss before and after, and
`postTrainedFrom`. `llm/sources/urls/` keeps the custom URLs' text, and
`llm/state.json` the section's settings.

## Recorded conditions as sim drivers

`src/outbreakEpiDrivers.mjs` makes the epidemic model's optional
`drivers` input from bins: `season(i, d)` from the absolute humidity a place
had (Shaman & Kohn 2009; Shaman et al. 2010: R0(t) = exp(a·q(t) + log(R0max −
R0min)) + R0min, a = −180), relative to a reference humidity, and
`travel(i, d, mode)` from the departures recorded at a place against its own
typical day (aircraft for air, rail vehicles for rail), and `commute(i, d)`
from the transit vehicles in service there against its typical day,
scaling its residents' commuting. Days and places with nothing recorded
keep the model's own values, and places that are not tracked take the
nearest tracked place's (within 300 km). Unset drivers leave the model
bit-identical. `server/shared/outbreakDatasetDrivers.mjs` keeps a small
per-day summary of each binned day for the dataset workers.

## Demographics (`demographics/`)

`worldbank.json`: each country's share of people aged 0–14, 15–64 and 65+
and its urban share (World Bank WDI `SP.POP.0014.TO.ZS`,
`SP.POP.1564.TO.ZS`, `SP.POP.65UP.TO.ZS`, `SP.URB.TOTL.IN.ZS`; CC BY 4.0),
fetched from the API the rail volumes already use and kept thirty days in
`.gev-cache/outbreak/worldbank-demographics.json`.
`places-<worldId>.npy`: float32 [n, 5] per world place — log10 population,
then the four shares (NaN where the country has no figure).

`abundance-<worldId>.npy` and `.json` (the GLOBAL ABUNDANCE row of TRAIN
ON, owner request 2026-10-23): float32 [n, 17] per world place, by its
country — the GLOBAL ABUNDANCE MAP's sixteen indicators as the country's
place among the others (0 the least abundant, 1 the most), then their mean;
NaN where the country has no figure. The `.json` names the channels
(`abundance_gdp` … `abundance`) and the sources (World Bank WDI and Our
World in Data, CC BY 4.0; the OECD regional database, OECD terms). Written
by `server/shared/abundanceData.mjs` whenever the row is ticked and a world
exists; read by `ml.gevtape.reader.load_abundance` and attached to the world
as `abundance` / `abundance_columns`, beside `demographics`.

## Real epidemics and policy (`real/owid-oxcgrt/`)

Our World in Data's COVID-19 data and the Oxford COVID-19 Government
Response Tracker's national indicators (both CC BY 4.0), aligned by day and
country (ISO2, through the bundled Natural Earth table): `obs.npy` float32
[T, C, 6] (newCases, newDeaths, hospital, icu, newTests, peopleVaccinated),
`actions.npy` float32 [T, C, 5] (lockdown = mean of C1–C7 as shares of
their scales; travelBan = C8/4; testing = H2/3; tracing = H3/2; vaccination
= H7/5), `obs_mask.npy` and `actions_mask.npy` uint8 (1 where observed),
`population.npy`, and `meta.json`. Built 2026-10-13: 227 countries × 1,096
days (2020–2022); cases and deaths 98 % observed, policy 80 %. `domain:
'real'`: latent compartments are never observed.

## Closed-loop environment (`scripts/outbreak-env.mjs`)

One JSON object per line in and out (client: `ml/gevtape/env.py`). The
engine runs in a worker thread and waits at each day's end for the next
day's action (shared memory), so it needs no change.

- `{"cmd":"reset","scenario":<object|null>,"seed":<int>}` →
  `{"ok":true,"obs":{"day":0,"global":[…],"country_state":[[S,E,P,Is,Ia,H,U,R,D,V]…]},"info":{…}}`
  (`global` is the 20 `GLOBAL_CHANNELS` every day; on day 0 only the seeds
  and the four in-transit, admission, isolation and signal values are set)
- `{"cmd":"step","action":{"window":<24-bit mask|null>,"switch":{"<node>":0|1},"flag":[<country index>…]}}`
  → `{"ok":true,"obs":{…},"done":<bool>,"info":{…}}`; the action may also
  carry the day's magnitudes (`lockdown` and `travelBan` 0–1,
  `testsPer1000Day` and `vaccinePer1000Day` ≥ 0), each left out to keep the
  scenario's own
- `{"cmd":"close"}` → `{"ok":true}`

## Models and predictions (`ai-world/`)

`ai-world/models/<model>/` (`outbreak`, `world`, `tracks`) holds
`checkpoint.pt`, `metrics.json` (skill against persistence on held-out
days) and `manifest.json` (the data it trained on and its licence classes).
`ai-world/predictions/<domain>.json` is the latest `Prediction` of
AI-WORLD-TAB.md. Training and prediction are `ml/` (Python, run with
`py -3.13`, or `GEV_PYTHON`).
