# Artificial Intelligence World Training Sim

The left-hand tab where the owner picks what the AI trains on, runs the heavy
work, and sees what it predicts (owner request, 2026-10-13: "Create new tab on
Left hand side called Artificial Intelligence World Training Sim … based on
population demographics, All Data layers such as Weather, travel, and news
events. Predict all actions on globe … give options to initialize,
pause/continue, Stop, Delete (showing data to be deleted). Display tick boxes
of all data layers, news events, for AI to train off of, and an ALL tick
box"). Its data format is in [WORLD-MODEL-DATA.md](WORLD-MODEL-DATA.md).

## What the tab holds

1. **TRAIN ON** — one tick box per data layer (from the DataManager), then
   the entries that are not layers: NEWS EVENTS, POPULATION DEMOGRAPHICS,
   OUTBREAK SIM EPISODES and YOUR DEVICES. ALL sits first and shows a
   partial state when only some are ticked. Each row carries its licence
   class (OPEN, NC, RESTRICTED, UNCLEAR, PERSONAL, STATIC) and its live
   status (RECORDING · size · last record). YOUR DEVICES records every
   personal feed: the owner's phone recordings, private cameras and local
   receivers.
2. **AREAS** — the places cameras, traffic, news, recent imagery, street
   level and the mapped static layers record around (at most 32). ADD VIEW
   AS AREA adds the place in the middle of the map; REMOVE stops recording
   there and keeps what was recorded. Until there is an area those feeds say
   NO AREA SELECTED.
3. **Controls** — INITIALIZE (shows an estimate first, then starts),
   PAUSE / CONTINUE (one button), STOP and DELETE (lists exactly what will
   be deleted, then a second press inside the panel deletes it).
4. **Status** — per stage (recording, sim episodes, training, predicting),
   storage against the cap, pauses as gaps, compute in use, then the
   measured links from `status.links` (`ml.gevtape.links`, run after each
   day is binned), one per line: who moves first, by how many hours, how
   strongly, and whether later hours agree, or why there is none yet.
5. **PREDICTIONS** — the domains to draw, the horizon, and each one's skill
   against persistence ("LEARNING · N DAYS RECORDED" until there is enough).
   The choice goes out as the `ai-world:predictions` event; the globe
   overlay (`src/aiWorldOverlay.js`, its own primitives on the viewer, not a
   map layer) fetches each domain and draws predicted places as heat and
   predicted tracks as ghost lines, and nothing for a domain still learning.
   PRICE MOVES (domain `markets`) is drawn at each asset's hub
   (`src/marketAssets.mjs`). Each hub gets a dot coloured by its biggest
   predicted move and a card on the world-overlay host listing every asset
   priced there (green up, red down). The predictor averages the per-place
   predictions of each asset's price and gives the signed percent move from
   the last recorded price; an asset with no home (crypto) is listed in
   `assets`, never placed.
6. **FINANCIAL ASSETS** — the latest quote of each of the 42 assets, with
   its predicted move at the horizon once the world model predicts markets.
7. **POST-TRAIN** — an adapter (`module:Class` in `ml/adapters/` or
   `.gev-data/ai-world/adapters/`) and an existing model's checkpoint
   inside `.gev-data/`. SAVE keeps them, POST-TRAIN NOW queues a run (the
   work must be running), and POST-TRAIN DAILY ON NEW DATA runs it a day
   after the last one. The line shows the last held-out loss before and
   after.
8. **INSTRUCTIONS** — the short steps, folded; the full guide is
   `docs/TRAINING-GUIDE.md`.
9. **TENSORFLOW** — four expandable sections (owner request 2026-10-17):
   TENSORFLOW TRAINING, TENSORBOARD, EXPORT FOR TENSORFLOW and POST-TRAIN A
   TENSORFLOW MODEL, under a line saying where the jobs run and the job's
   state with PAUSE / CONTINUE and STOP (`src/tensorflowSetup.js`, routes
   `/api/tensorflow`, [TENSORFLOW](#tensorflow-apitensorflow) below, part 5
   of `docs/TRAINING-GUIDE.md`). Mounted into `#tensorflow-tools`; hidden
   until its server routes answer. The sections are built once and updated
   in place, so an open one stays open while the status polls.
10. **CUSTOM LLM TRAINING** — last in the tab (moved from POWER UP on
    2026-10-17): a language model trained on the ticked recordings, custom
    URLs and local files, from a base model already on this PC
    (`src/llmTrainingSetup.js`, routes `/api/llm-training`, part 4 of
    `docs/TRAINING-GUIDE.md`). The tab mounts it into `#llm-training` and
    ends it with itself; it stays hidden until its server routes answer.

The study pairs (`src/trainingLinks.mjs`) are not listed in the tab; they go
beside the bins as `links.json` for `ml.gevtape.links`.

Like every dashboard box on desktop, the tab resizes from its bottom-right
corner (`src/ui/panelCornerResize.js`); open, it is 520 px wide by default.

Built in `src/aiWorldPanel.js` (controller), `src/aiWorldSelection.mjs`
(the list, ALL and the texts; pure) and `src/ui/styles/aiWorld.css`, with
the markup after the Outbreak panel in `src/ui/templates/layer-panels.html`
(CSS `order: 6`, the last left tab; hidden in Cockpit like Ask and Ultra).
Mounted with the overlay from `src/app/startupChrome.js`. The list scrolls
inside its own band so the four buttons stay in reach; ticks made while the
server is down are sent once it answers; a refused selection puts the
server's ticks back.

## Server routes (`/api/ai-world`)

Same-origin only (GETs as the Outbreak routes admit them; POSTs as
`/api/llm/ask` does). Every answer is JSON with `no-store`.

| Route                  | Body / query                                                                  | Answer                                                                                                                            |
| ---------------------- | ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `GET  /status`         | —                                                                             | `status` (below); answered before the rate limiter                                                                                |
| `GET  /catalog`        | —                                                                             | `{ items: CatalogItem[] }`                                                                                                        |
| `POST /selection`      | `{ selection: string[] }`                                                     | `status`; allowed in any state (a running recorder follows)                                                                       |
| `POST /estimate`       | `{ selection, capGb }`                                                        | `Estimate`                                                                                                                        |
| `POST /initialize`     | `{ selection, capGb, sim?: { scenarios, runs, days } }`                       | `status`; 409 unless idle or stopped                                                                                              |
| `POST /pause`          | `{}`                                                                          | `status`; 409 unless running                                                                                                      |
| `POST /continue`       | `{}`                                                                          | `status`; 409 unless paused                                                                                                       |
| `POST /stop`           | `{}`                                                                          | `status`; 409 when idle or stopped                                                                                                |
| `GET  /delete-preview` | `?scope=all\|tape\|bins\|datasets\|worlds\|models\|predictions\|demographics` | `DeletePreview`                                                                                                                   |
| `DELETE /delete`       | `{ scope, token }`                                                            | `{ deleted: { files, bytes } }`; 409 if running or the files changed since the preview; 403 `pc-only` from the owner's phone      |
| `GET  /predict`        | `?domain=&horizon=&bbox=w,s,e,n`                                              | `Prediction`                                                                                                                      |
| `GET  /areas`          | —                                                                             | `{ areas: Area[] }`                                                                                                               |
| `POST /areas`          | `{ lat, lon, name? }`                                                         | `{ areas }`; the same point again changes nothing; 400 for a point that is not one; 409 past 32 areas                             |
| `DELETE /areas`        | `{ key }`                                                                     | `{ areas }`; 403 `pc-only` from the owner's phone                                                                                 |
| `GET  /markets`        | —                                                                             | `{ quotes }`, the latest quote of each asset                                                                                      |
| `POST /posttrain`      | `{ adapter, checkpoint, daily, run? }`                                        | `{ posttrain }`; 400 for an adapter outside the adapter folders or a checkpoint outside `.gev-data/`; 409 `run` while not running |

### `status`

```js
{
  state: 'idle' | 'initializing' | 'running' | 'paused' | 'stopping' | 'stopped',
  since: 1760000000000,              // ms of the last state change
  selection: ['flights', 'transit', 'news', 'demographics', 'outbreak-sim'],
  capBytes: 600e9,
  feeds: [{
    id: 'transit',                   // a catalog item id
    state: 'recording' | 'paused' | 'off' | 'waiting' | 'error' | 'quota' | 'static',
    records: 0, bytes: 0,            // since the tab first initialized
    recordsToday: 0, bytesToday: 0,
    lastAt: null,                    // ms of the last record, or null
    error: null,                     // short text, or null
  }],
  stages: {
    recorder:  { state, feeds: 0, bytesPerDay: 0 },
    generator: { state, done: 0, total: 0, episodes: 0, etaMs: null, error: null },
    trainer:   { state, model: null, epoch: 0, epochs: 0, loss: null, error: null,
                 note: null },     // what it waits for: BINNING 2026-09-13 · 29 DAYS LEFT,
                                   // NEEDS 3 BINNED DAYS · 1 SO FAR, TRIED AGAIN WHEN A NEW DAY IS BINNED
    predictor: { state, domains: [], updatedAt: null, error: null },
  },                                 // stage state: 'off' | 'waiting' | 'running' | 'paused' | 'done' | 'error'
  storage: { usedBytes: 0, freeBytes: 0, byKind: { tape: 0, datasets: 0, worlds: 0, models: 0, predictions: 0 } },
  compute: { workers: 0, busy: 0, gpu: 'NVIDIA GeForce RTX 4060 Laptop GPU' | null },
  gaps: [{ from: 0, to: 0, reason: 'paused' | 'stopped' | 'quota' | 'restart' }],
  learning: { daysRecorded: 0, daysBinned: 0 },   // days since the first record (pauses taken out); finished days binned for the newest world
  areas: [Area],
  links: null | { generatedAt, hours, tested, reason, top: [/* ≤ 12 links.json results */], studyPairs },
  posttrain: { adapter: '', checkpoint: '', daily: false,
               last: null | { before, after, helped, trainedThrough, updatedAt } },
}
```

`stages.trainer.model` can also be `links` (the measured links) or
`posttrain` (another world model); neither has scores of its own, so the
world model's stay shown. `channelsGrown: true` means the world model met
new channels and was grown, keeping what it learned.

### `Area`

```js
{
  key: '43.6532,-79.3832',           // the point to 4 decimals: what the feeds and REMOVE know it by
  name: 'Toronto',                   // at most 80 characters; the point when none is given
  lat: 43.65321, lon: -79.38318,
}
```

### `CatalogItem`

```js
{
  id: 'transit',                     // layer id, or news | demographics | outbreak-sim | devices
  label: 'Transit',
  layers: ['transit'],               // DataManager layer ids this item stands for
  kind: 'feed' | 'static' | 'sim' | 'derived',
  class: 'open' | 'nc' | 'restricted' | 'unclear' | 'personal' | 'static',
  licence: 'Per-feed open licences (MBTA, CapMetro, Metro Transit, OVapi, Entur, TransLink, HSL)',
  cadenceMs: 30000,                  // null for static and sim items
  phase: 1,                          // the plan phase that records it
}
```

A layer the catalog does not know is still listed (from the DataManager) and
recorded as a one-off snapshot when it has a source (`kind: 'static'`).
Military flights, military awareness, and military installations are not
listed and cannot be ticked. ALL does not include them. The map layers
themselves are unchanged.

PREDICTIONS has one row per trained type the model can draw (the bin
groups, civil tracks, and the outbreak sim when that box is ticked), plus
ALL PREDICTIONS. `GET /predict?domain=all` returns `{ predictions }` of
those ready types. `domain` of a military id is refused.

INFER asks `POST /infer` with `{ kind, query, lat, lon, horizon }`. `kind`
is `location` (an empty query uses the map centre), `item`, `topic`, or
`event`. The match is taken from tape already on this machine. Military
tape is not read. No match, or not enough history, draws nothing and does
not invent a number. The answer is a Prediction plus `inferred`, `kind`,
`matched`, and `note`.

While the job is running, every finished UTC day that has tape and no bin
yet is binned, oldest first and one day at a time (today is left alone), so
backfilled history and a day the server slept through are not lost. The
world and civil track models train once nothing is left to bin; the world
model waits for three binned days (two to train on, one held out) and the
TRAINING line says so. A world checkpoint whose channel list differs is not
resumed. Further map sources for training will be added later, as new
catalog feeds.

### `Estimate`

```js
{ bytesPerDay, feeds: [{ id, bytesPerDay }], workers, gpu, capBytes, daysToCap }
```

### `DeletePreview`

```js
{
  scope: 'all',
  token: 'sha256 of every listed path, size and mtime',
  root: '.gev-data',
  groups: [{ kind: 'tape', id: 'transit', path: 'tape/transit', files: 1200, bytes: 123456789 }],
  totalFiles: 0,
  totalBytes: 0,
}
```

The delete removes exactly the files the preview listed. The server lists
them again at delete time and refuses (409) when anything differs, deletes
only inside `.gev-data/` (resolved paths, no symlinks out), and only when the
state is idle or stopped. It never touches `.gev-cache`, `config/` or the
repository.

### The owner's phone

The phone (the tailnet mirror) can read every route and initialize, pause,
continue and stop, and add areas. DELETE and REMOVE (an area off the list)
are refused like every removal (owner ruling 2026-10-11): the mirror
refuses any `DELETE`, the server answers 403 with
`X-GEV-Removal: pc-only` and `{"removal":"pc-only"}`, and the panel stays
silent about it (`src/ui/ownerRemoval.js`).

## Stages

Server side: `server/providers/aiWorld.js` (routes, admitted like Device
feeds: this machine's loopback and Host, exact Origin on writes, JSON,
same-origin fetches), `server/shared/aiWorldJobs.mjs` (the manager),
`server/shared/aiWorldDelete.mjs` (preview, token, containment),
`server/shared/worldTapeStore.mjs` and `worldTapeRecorder.mjs` (the tape),
`server/shared/worldTape/` (one adapter per feed, and the catalog).

- **Recorder** — records each ticked feed (WORLD-MODEL-DATA.md, World tape).
  Pause stops polling and writes the gap into `gaps.jsonl`, so training
  knows those hours are missing rather than quiet. PAUSE, STOP and an
  untick also cut a poll in flight short (its abort signal), which is not
  counted as a failure. Area-based feeds (cameras, traffic, news, recent
  imagery, street level, the mapped static layers) record around the areas
  in `.gev-data/ai-world/areas.json` (`Area[]`, kept by the AREAS routes)
  and say NO AREA SELECTED while it is empty.
- **Demographics** — when POPULATION DEMOGRAPHICS is ticked: the World Bank
  table, fetched once a month, and each world place's static features
  (WORLD-MODEL-DATA.md, Demographics).
- **Sim episodes** — when OUTBREAK SIM EPISODES is ticked: builds the world
  snapshot once, then generates episodes shard by shard. Pause lets the
  shards in flight finish; continue resumes from the index.
- **Training** — `py -3.13 -m ml.gevtape.train` as a child process (set
  `GEV_PYTHON`, for example `python3`, to use another interpreter). The
  outbreak model trains once a sim dataset is written; the world and tracks
  models once every finished day of tape is binned (oldest first, one day
  at a time, backfilled days included) and three binned days exist; each
  retrains daily while running. A trainer that fails is tried again when a
  new day is binned, not every quarter hour; the TRAINING line says what it
  waits for.
  Once the outbreak model exists and `npm run outbreak:real-data` has
  written the real data, `ml.gevtape.calibrate` calibrates it on real
  epidemics (OWID and OxCGRT): zero-shot, fine-tuned and from-scratch
  skill against persistence, in
  `.gev-data/ai-world/models/outbreak-real/calibration.md`. It draws
  nothing on the globe and runs again when the outbreak model retrains.
  Pause asks it to checkpoint and exit; continue relaunches it from the
  checkpoint (Windows has no SIGSTOP). Protocol below.
- **Predicting** — `py -3.13 -m ml.gevtape.serve` answers `/predict` once a
  model exists; without one `/predict` answers `learning` and the overlay
  draws nothing.

State survives a dev-server restart (`.gev-data/ai-world/state.json`): a
recorder that was running starts again, and the restart is written as a gap.

## Extra feeds

CCTV stills stay on the public-camera feed. `cctv-video` stores a short fragmented-MP4 clip from the app's own frame route, at most one an hour per camera, and never a school camera. An MPEG-TS stream stores nothing.

NEWS EVENTS in the tab is a list of up to 100 public https URLs (`POST /api/ai-world/news-urls`). The feed stores an RSS item's title and link, or an HTML page's title. The body is not stored. REMOVE is PC-only.

MARKETS records live quotes for the 42 assets of `src/marketAssets.mjs` every five minutes: currencies and the dollar index; the US 5-, 10- and 30-year yields; WTI, Brent, natural gas, gold, silver, copper, wheat, corn, soybeans, gasoline, heating oil, jet fuel and kerosene; the main stock indexes; the VIX, Bitcoin and Ether. Yahoo Finance, 20 symbols a request, covers the currencies, yields, futures, indexes, the VIX and crypto, and stands in for any series a cap or a missing key leaves out; Twelve Data (`TWELVE_DATA_API_KEY`, 800 credits a day and 8 a minute) covers forex and gold, and OilPriceAPI (`OILPRICE_API_KEY`, 50 a day unless a trial response reports more) WTI, copper and the fuels, while each cap has room. Jet fuel and jet kerosene have no Yahoo stand-in, so a missing print stays blank. Each key rides in a header, never the address. A price is written only when it or its exchange time changes. A missing price is left out. The section is a readout, not advice. `ALPHA_VANTAGE_API_KEY` stays unused here: 25 requests a day cannot cover this cadence. PREDICTIONS also lists SUPPLY, MARKETS, AIR QUALITY, and STREAM GAUGES. Each stays LEARNING until a world model was trained on that channel. The world-model loss averages each observed channel on its own, so a rare price or headline is not drowned by a channel that is present every hour. A channel with no observation that step is left out of the average. Training rolls forward the same number of hours the score uses, and feeds a prediction back only for a channel the context actually saw. After a restart the tab shows the last saved world-model score until the next run replaces it. When the bin channels changed, training says NEW CHANNELS, NEW MODEL and does not resume the old weights. A prediction row shows that domain's held-out score beside READY or LEARNING when the trainer has one. On the globe a place is sized by the magnitude of its prediction. A fall is the same size as a rise of that size, drawn dimmer. A blank prediction is not drawn. The LINKS list under Markets is the same study list as `links.json`.

Sea surface temperature and observed weather record a number at each of at most eight areas. The bin keeps temperature as `value`, and rain, wind, and cloud cover as their own channels when a reading has them. PM2.5 (`air-quality`, Open-Meteo / CAMS, hourly) and US stream-gauge discharge (`stream-gauges`, USGS, every 30 minutes, Alaska and Hawaii included, nowhere else) are further area numbers. A missing reading is left blank. Prices share an hour with news, ship classes, traffic, cameras, weather, and flights. That shared hour is not a claim that one moved the other. Tanker, food, metal, and container counts come only from AIS type or destination text. Other cargo stays cargo. Regional fuel use and crop yield are not metered, so they are not filled in. Jet fuel, jet kerosene, and gasoline are price prints. The study list is `links.json` beside the bins. Every other non-military number in the hour stays there too, so a link the list does not name can still be found.

## Child-process protocol (training and serving)

One JSON object per line on stdout; the server writes commands on stdin.

- Trainer → server: `{"event":"progress","model","epoch","epochs","step","loss"}`,
  `{"event":"checkpoint","path"}`, `{"event":"metrics","skill":{...}}`,
  `{"event":"paused"}`, `{"event":"done"}`, `{"event":"error","message"}`.
- Server → trainer: `{"cmd":"pause"}` (checkpoint, print `paused`, exit 0)
  and `{"cmd":"stop"}` (the same, then `done`).
- Server → server process: `{"id":1,"cmd":"predict","domain","horizon","bbox"}`;
  answer `{"id":1,"ok":true,"result":Prediction}` or
  `{"id":1,"ok":false,"error"}`.

### `Prediction`

```js
{
  domain: 'outbreak' | 'mobility' | 'weather' | 'hazards' | 'news' | 'tracks',
  horizonHours: 24,
  generatedAt: 0,
  skill: { metric: 'mae', model: 0.0, persistence: 0.0 } | null,
  learning: { daysRecorded: 0, daysBinned: 0, needed: 7 } | null,   // set until there is enough history
  points: [{ lat, lon, value, sd? }],                 // node channels as heat
  tracks: [{ id, kind, path: [[lat, lon, tMs]], sd? }],
}
```

## TENSORFLOW (`/api/tensorflow`)

The four TENSORFLOW sections (owner request 2026-10-17: "include tensorflow
functions in AI world tab as seperate expandape options within the tab";
ruling: all four, Python 3.13, the GPU through WSL2). The jobs run in
`server/shared/tensorflowJobs.mjs`, one at a time; the routes are
`server/providers/tensorflow.js`, admitted as the tab's other routes are.
The owner's phone may use all of it: nothing here removes anything.

**Where a job runs.** TensorFlow has had no GPU on native Windows since 2.11.
`npm run tensorflow:wsl-setup` (once; `scripts/tensorflow-wsl-setup.mjs` runs
`scripts/tensorflow-wsl-setup.sh` in WSL2, distro `GEV_WSL_DISTRO`, default
`Ubuntu`, no sudo) installs uv, Python 3.13 and `tensorflow[and-cuda]` into
`~/.gev/tf-venv`, and `scripts/tensorflow-wsl-run.sh` starts that Python with
the CUDA wheels' libraries on `LD_LIBRARY_PATH` (without them TensorFlow
cannot open `libcusolver` and drops to the CPU). The server asks both runners with `ml.gevtape.tf_probe` when the tab first asks for the status (a server that never shows the tab starts no Python), and again on CHECK AGAIN: WSL2 when it
has TensorFlow and a GPU, else the Windows Python 3.13 (`GEV_TF_PYTHON`, else
`GEV_PYTHON`, else `py -3.13`) on the CPU, else WSL2 on its CPU.
`GEV_TF_RUNNER=wsl|windows` picks one that has TensorFlow. Paths go to WSL2
as `/mnt/<drive>/…`; a repository or data folder without a drive letter
stays on Windows. TensorFlow takes GPU memory as it needs it, so the kit's
own PyTorch trainer can share the card.

| Section                       | Runs                                                                                                                                                                                                                                                                                                                                                                                                                                       | Writes                                                                                                                                        |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| TENSORFLOW TRAINING           | `ml.gevtape.tf_train`: a Keras world model (`ml.gevtape.tf_world`) on the same bins, held-out days and score as the kit's world model. Each place is read by itself (no neighbour graph); the model predicts a change from persistence that starts at zero, so an untrained model scores exactly as persistence does. A new channel grows the model (`tf_world.grow_model`). TRAIN carries on from the saved model; NEW MODEL starts over. | `.gev-data/ai-world/tensorflow/models/tf-world/`: `model.keras` (with its optimizer), `state.json`, `metrics.json`, `manifest.json`           |
| TENSORBOARD                   | TensorBoard on `127.0.0.1:6006` (`GEV_TENSORBOARD_PORT`) with `--path_prefix /api/tensorflow/board`, from the Python that has it (Windows first). OPEN TENSORBOARD goes through this app at `/api/tensorflow/board/`, so the phone mirror reaches it too.                                                                                                                                                                                  | reads `.gev-data/ai-world/tensorboard/<run>/`: `world`, `outbreak`, `tracks` (the kit's trainer, `--tensorboard`), `tf-world`, `tf-posttrain` |
| EXPORT FOR TENSORFLOW         | `ml.gevtape.tf_export`: everything `ml.gevtape.export` writes, with the same class filter (EVERY CLASS or OPEN ONLY), then TFRecords, the SavedModel and TFLite.                                                                                                                                                                                                                                                                           | a new `.gev-data/ai-world/tensorflow/exports/<UTC time>/` (below)                                                                             |
| POST-TRAIN A TENSORFLOW MODEL | `ml.gevtape.tf_posttrain` with an adapter (`keras_world:KerasWorldAdapter` by default, `ml/adapters/keras_world.py`) and a model inside `.gev-data/` (the TENSORFLOW TRAINING one by default). The last days are held out; the line gives the held-out loss before and after.                                                                                                                                                              | `.gev-data/ai-world/tensorflow/posttrain/`: `model/`, `metrics.json`, `posttrain-state.json`                                                  |

Every trainer writes TensorBoard scalars through `ml.gevtape.board`, a
standard-library writer (an Event protocol buffer framed as a TFRecord), so
the PyTorch trainer does not load TensorFlow for it: `train/loss`,
`held-out/mae`, `held-out/persistence`, and `domain/<domain>/mae` and
`/persistence`.

An export folder holds `tfrecord/YYYY-MM-DD.tfrecord` (one
`tf.train.Example` per hour: `hour_ms`, then the observed entries only as
`place`, `channel` and `value`, so a missing entry was never observed, not
zero), `tfrecord/spec.json` (the channel order, K, the features),
`savedmodel/` (signature `serve`), `model.tflite` (run against Keras on
held-out rows; `tensorflow.json` gives the largest difference), `TENSORFLOW.md`
(reading it with `tf.data`) and `tensorflow.json` (files, sizes, sha256, the
licence mix). The model learned from every class it trained on whatever the
export keeps, so an export is marked publishable only when the dataset and the
model are both open only; the owner decides each release.

| Route                              | Body                                                                                                                    | Answer                                                                                                            |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `GET  /status`                     | —                                                                                                                       | `{ runner, run, settings, posttrain, last, model, posttrained, exports, board }`                                  |
| `POST /check`                      | `{}`                                                                                                                    | status; asks both runners again                                                                                   |
| `POST /settings`                   | `{ epochs?, device?: 'auto'\|'cpu', classes?: 'all'\|'open', withModel?, posttrain?: { adapter, checkpoint, epochs } }` | status; 400 for a value out of range, an adapter outside the adapter folders or a checkpoint outside `.gev-data/` |
| `POST /train`                      | `{ fresh? }`                                                                                                            | status (`run.state` `starting` at once); 409 while a job runs                                                     |
| `POST /export`                     | `{}`                                                                                                                    | status; 409 while a job runs                                                                                      |
| `POST /posttrain`                  | `{}`                                                                                                                    | status; 400 with no model at the checkpoint; 409 while a job runs                                                 |
| `POST /pause`                      | `{}`                                                                                                                    | status; training and post-training only; 409 otherwise                                                            |
| `POST /continue`                   | `{}`                                                                                                                    | status; the paused job again with `--resume`; 409 unless paused                                                   |
| `POST /stop`                       | `{}`                                                                                                                    | status; `{"cmd":"stop"}` (an export is ended)                                                                     |
| `POST /board-start`, `/board-stop` | `{}`                                                                                                                    | status                                                                                                            |
| `*    /board/…`                    | TensorBoard's own                                                                                                       | passed through to TensorBoard (its POSTs only read curves; cookies are kept back); 503 while it is not running    |

`run` is `{ kind: 'train'|'export'|'posttrain', state: 'starting'|'running'|'paused'|'stopped'|'done'|'error', epoch, epochs, step, loss, stage, done, total, device, error, busy, result }`;
`runner` is `{ kind: 'wsl'|'windows'|null, distro, python, tensorflow, gpu, checking, checkedAt, wsl, windows }`.
The TensorFlow runners speak the trainers' child-process protocol above
(`ml.gevtape.protocol` holds it with nothing from either framework); the
first progress event of a training says what it runs on
(`{"device":"GPU NVIDIA …","tensorflow":"2.21.0"}`), an export's progress
carries a `stage` (`dataset`, `tfrecord`, `savedmodel`, `tflite`) and ends
with `{"event":"export",…}`.
