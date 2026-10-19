# God's Eye View — Testing Guide (voice map-annotation whiteboard + live tracking)

> [!NOTE]
> This is a **manual field-test scenario script** for the June-2026 whiteboard +
> tracking work. The AUTOMATED gates live elsewhere: `npm test` (unit),
> `npm run test:track` (tracking invariants), and the headless harnesses under
> `scripts/qa-*.mjs` — together these are the full automated test surface.

This guide covers the work hardened over **4 adversarial-review batches** on
`feat/annotate-hybrid`. Record a voice note + screenshots as you go; each scenario
lists what **✅ pass** looks like and (where it applies) the **❌ old bug** it replaces.

## Focus/horizon moving evidence

With the Vite development server already running on port 4173, capture all four
focus/recession scenarios with a deterministic virtual frame clock. (A dev
server that stopped on its own leaves the reason in `.gev-logs/dev-server.log`:
exit code or signal, a takeover by another dev server, or "unresponsive"; and
`http://localhost:4173/__gev/health` reports restarts, memory and handle
counts while it runs.)

```sh
node scripts/qa-focus-evidence.mjs --url http://localhost:4173 \
  --screenshots-dir qa-shots/focus-evidence \
  --json qa-shots/focus-evidence/report.json
```

For a quick operator loop, `--smoke` captures only S1 in six frames. For visual
sign-off, add `--headful`; this removes the SwiftShader launch flags and uses
the machine's real GPU. The harness brings its page to the foreground at the
start of every scenario so a headful Chromium run keeps streaming tiles.

Google 3D remains the default basemap. If its tile stream is the bottleneck
rather than the behavior under test, select an existing map stack explicitly:

```sh
--basemap bing-aerial
--basemap osm
```

Accepted values are `photoreal`, `bing-aerial`, `bing-labels`, and `osm`; Bing
stacks still require the app's usual Cesium ion token.

Tune both systems without editing source by adding, for example:

```sh
--params '{"focus":{"dimFloor":0.35,"nearerBehavior":"partial"},"horizon":{"scaleFloor":0.5,"alphaFloor":0.4}}'
```

The script never starts the server. During scenarios it pauses Cesium's default
render loop, advances focus time explicitly, and renders each frame before the
screenshot, so computed alpha/scale sequences repeat for identical parameters.
Headless Chromium still forces SwiftShader, so its pixels are relative CI/A-B
evidence only; headful real-GPU output is the sign-off surface. Screenshots use
scenario/frame names and the JSON report records effective tuning plus
per-contact alpha, scale, and screen data. Before each scenario's first capture,
the harness gives the active Google photoreal tileset up to 45 seconds to reach
Cesium's `tilesLoaded`/`allTilesLoaded` condition. Every frame records
`tilesSettled: true|false` and whether that gate applied; a timeout is recorded
as false, never promoted to a pass. Non-photoreal stacks record the gate as
settled and not applicable because no Google 3D tileset is active.

> [!IMPORTANT]
> Do not use a screenshot for visual judgment unless its report frame records
> `tilesSettled: true`.

## Setup

- **URL:** http://localhost:4173 — auto-flies to Austin on load. Give photoreal tiles ~10s.
- **Voice (the real feature):** click **GEV MIC** (bottom of screen) → wait for **LISTENING** →
  just talk. It marks the map _as it talks_, without announcing that it's drawing. Click
  **STOP** when done. (Needs `OPENAI_API_KEY`; `dev-fresh.sh` injects it from Keychain.)
- **Console (deterministic, no mic/live-data needed):** open DevTools (**Cmd-Opt-J**) and use:
  - `window.__gevAnnotations.tour()` — self-running narrated SF tour (camera + marks in sequence)
  - `window.__gevAnnotations.demo()` — lays the SF set down at once
  - `window.__gevAnnotations.clear()` — erase all marks
  - `window.__gevAnnotations.count()` — how many marks are live

---

## What changed (the list)

**Live aircraft tracking & camera (Batch D)** — civilian + military, mirrored:

- **R14** warm-up: tracked plane glides immediately (no freeze-then-jump / backward snap),
  via a display-layer reconciliation that smooths any position discontinuity over ~0.9s.
- **R15** framing: calibrated initial follow distance (altitude-scaled, 3–30 km).
- **R16** trail: head stays glued to the moving icon per-frame; never trails ~1s behind or
  pokes out in front of the nose.
- **R13** z-order: screen annotations fade where they'd cover the **tracked** plane + its label.

**Voice annotation — scoping & honesty (Batch B):**

- **R1** resolver scope: a place name resolves to the _right_ thing (building vs neighborhood
  vs natural feature vs city) instead of an oversized admin blob.
- **R2** boundary stitching: complex outlines no longer close with bay-spanning chords.
- **R6** route honesty: a routing outage draws a _labeled_ straight "direct line", never a
  silently faked road.
- **R12** partial honesty: if some targets fail, it says so — no masking partial as success.
- **R10** cache: transient failures aren't negative-cached for the whole session.

**Annotation rendering & motion (Batch C):**

- **R8** route flow: route dashes **animate** (flow along the path).
- **R9 / R17** perf: idle annotations stop their animation loop; height cache is bounded.
- **R11** no-freeze: large/complex boundaries simplify without locking the UI.

**Abuse guards (Batch A)** — mostly internal: input caps on `annotate_map`, clear/new-topic
cancellation, hardened Overpass + route proxies. Not much to see by hand (see §4).

---

## 1. Live aircraft tracking (Batch D) — the 3 issues you reported + z-order

> Needs a live plane. Track by **clicking a plane icon**; **Esc** (or click empty space) untracks.
> If you see no planes, scroll out once — Texas airspace is busy.

**1a · Warm-up smoothness (your issue #1 → R14)**

1. Click a moving plane. 📸 Snap the instant it locks, then watch ~2–3s.

- ✅ Starts gliding smoothly _immediately_. ❌ _Was:_ froze ~1s, then jumped forward.

**1b · Initial framing (your issue #2 → R15)**

1. On the same lock-on, look at how the camera frames the plane. 📸 Snap the initial view.

- ✅ Plane + label readable with context, no scrolling. ❌ _Was:_ jammed in too tight.

**1c · Trail glued to the plane (your issue #3 → R16)**

1. Keep tracking ~10s. 📸 Snap the cyan trail while it moves.

- ✅ Trail tail stays attached to the plane; nothing pokes out _in front_ of the nose; no ~1s lag.
  ❌ _Was:_ trail lagged a beat behind.

**1d · Military layer (same fixes, mirrored)**

1. Enable the **Military** layer (left column). Track an **amber** plane. Repeat 1a–1c.

- ✅ Identical smooth behavior.

**1e · Z-order: tracked plane stays on top (→ R13, trickiest to stage)**

1. While tracking a plane over Austin, GEV MIC: _"annotate downtown Austin."_
2. Orbit/zoom so the plane crosses the annotation's outline or label. 📸 Snap the overlap.

- ✅ The annotation **dims** where it covers the plane/label — plane stays visible on top.
  ❌ _Was:_ the annotation drew over and hid the plane.

---

## 2. Voice annotation — scoping & honesty (Batch B)

> All from the Austin default view (no camera move needed). Click GEV MIC, then speak.

**2a · Scope: building vs region (→ R1)** — say each, watch what gets outlined:

- _"annotate the Texas State Capitol"_ → ✅ the **Capitol building**, not the whole state.
- _"annotate Barton Creek"_ → ✅ the **creek / greenbelt**, not Barton Creek _Mall_ or the city.
- _"annotate downtown Austin"_ → ✅ the **downtown district**, a sensible neighborhood-size area.
- _"annotate the University of Texas at Austin"_ → ✅ the **campus**, not the city.
- 📸 Snap each outline. ❌ _Was:_ incidental names ballooned into giant county/state blobs.

**2b · Classic SF set (optional)** — first say _"take me to San Francisco,"_ then:

- _"annotate the Mission District"_ → neighborhood. _"...the Presidio"_ → the full former-base
  outline (not a single point, not a bay-spanning blob → R2). _"...Chinatown"_ → the district.

**2c · Route honesty (→ R6)**

1. _"draw a route from Austin-Bergstrom airport to the Texas Capitol."_

- ✅ A real **road** route with a flowing dashed line + a labeled callout.
- If a route ever comes back as a **straight** line, it should be **labeled** as a direct/approx
  line (not pretending to be a road). ❌ _Was:_ silent fake straight-line "routes."

**2d · Partial-failure honesty (→ R12)**

1. _"annotate the Texas Capitol and the Flibbergibbet Building."_

- ✅ It annotates the Capitol **and tells you** it couldn't find the other one.
  ❌ _Was:_ reported success and silently dropped the missing one.

**2e · Clear / new-topic race (→ R4)**

1. _"annotate downtown Austin"_ and, right as it starts, _"actually, clear everything."_

- ✅ Marks clear and **stay** cleared (the in-flight one doesn't pop back a second later).
- Sanity in console: `window.__gevAnnotations.count()` → `0` after a clear.

---

## 3. Annotation rendering & motion (Batch C) — deterministic, no mic

**3a · Full experience (smoke test)**

1. Console: `window.__gevAnnotations.tour()`. 📸 A couple of frames as it runs.

- ✅ Camera flies to SF; Palace highlight → arrow → Presidio **draped** outline → ILM pin →
  Crissy Field **route** appear in sequence; marks stay glued as the camera moves.

**3b · Route dashes animate (→ R8)**

1. During/after `tour()` (or `demo()`), watch the **route** line (Crissy Field shoreline).

- ✅ The dashes **flow** along the path (animated), not static. ❌ _Was:_ dashes never moved.

**3c · Draping & persistence**

1. After `demo()`, orbit the camera around the Presidio outline.

- ✅ The footprint **drapes onto** the 3D ground/buildings and conforms; callouts/rings/arrows
  are the hand-drawn SVG style and stay anchored to their real spot.

**3d · Large boundary, no freeze (→ R11)**

1. Console:
   `window.__gevAnnotations.annotate([{type:'area',target:'Travis County, Texas',label:'Travis County',color:'green',footprint:true}],{flyTo:true,persist:true})`

- ✅ The complex county boundary simplifies and draws **without** freezing/janking the UI.

---

## 4. Robustness / guards (Batch A) — mostly internal

These are server-side / defensive and don't have a clean visual tell. Light checks only:

- Rapid-fire several annotate commands, then a clear — UI should stay responsive and end clean
  (`count()` → `0`).
- Nothing here should change normal behavior; flag it only if something feels _broken_ (stuck
  spinner, marks that won't clear, errors in the console).

---

## 5. General feel — open feedback

While recording, call out anything in these areas — this is the feedback I most want:

- **Tracking feel:** does follow motion feel smooth/natural, or floaty/laggy/overshooting?
- **Framing:** is the initial tracked view a good "hero" shot, or too close/far?
- **Annotations:** do outlines land on the _right_ thing? Are labels readable / well-placed /
  not overlapping? Does the hand-drawn style read well over photoreal tiles?
- **Voice:** does it mark things _as it talks_ (not after), and confirm only what actually
  happened? Any command it misunderstood?
- **Anything that looks wrong, janky, or surprising** — screenshot it; that's the gold.

---

## 6. Live video CCTV (HTTPS HLS) — soak, no mic

> Requires the DelDOT pack (loads by default; `CCTV_DELDOT_ENABLED=0` disables it).

1. Turn on **CCTV**, fly to Dover, DE, and activate **DE 1 @ Main Toll Plaza**. ✅ Within ~30 s the monitor plane and the panel preview both show moving video,.
2. Leave it for **five minutes**. ✅ Continuous playback; at most a short hitch about once a minute (the agency restarts its stream on a timer). ❌ A freeze that does not recover, or the panel picture stopping while the plane keeps moving.
3. Toggle **PROJECTION** off. ✅ The panel keeps playing; the plane and the active camera's cone hide.
4. Switch to **DE 8 @ Saulsbury Rd**, then back. ✅ Each switch resumes within ~10 s with no stale frame from the previous camera.
5. Optional: DevTools → Network, filter `media/`. ✅ Playlist responses carry `X-CCTV-Source: hls-pull`; segments return `video/mp2t`.

## 7. Outbreak: every rail line on the globe (owner ruling 2026-10-12)

> The first outbreak request starts the world rail sweep: about 20,000 OpenFreeMap tiles, 6 at once, never a kept tile again. Allow 15 to 30 minutes the first time; later starts read the build from disk. Live API calls need the header `Origin: http://localhost:4173`.

1. **Before it is built.** Add Irkutsk and scan. ✅ The status line reads `World rail: N / M tiles …; rail works as before until it is done.` and moves every 10 s. ✅ `GET /api/outbreak/network?lat=52.29&lon=104.3&mode=rail` answers as before (`radiusKm: 500`, no `world`). ✅ The epidemic model's log says the world rail is still being found.
2. **The sweep.** Poll `GET /api/outbreak/rail-world/status`. ✅ `tilesDone` rises to `tilesTotal` (less `tilesFailed`). ✅ `tilesFetched` plus `tilesCached` equals `tilesDone`. ✅ The files in `.gev-cache/outbreak/rail-world/z8/` match `tilesDone`. ✅ `state` goes `sweeping` → `building` → `ready`.
3. **Built.** ✅ `railKm` is about 1.0 to 1.2 million. ✅ `byContinent` is non-zero for AF, AS, EU, NA, SA and OC. ✅ The log has one **WORLD RAIL** entry.
4. **Rail round a location.** The same `/network` call. ✅ `world: true`, `radiusKm: null`. ✅ `network.reachedKm` is thousands of km, no longer cut at 500. ✅ At 48 h and 60 km/h the orange reach is 2,880 km along the line. Saint John NB: ✅ `startKm` about 0.4 (the zoom-10 lines laid over).
5. **Rail after landing.** Scan a day out of Irkutsk. ✅ `POST /api/outbreak/air-rails` answers `world: true`, `skippedLandings: 0`. ✅ The lit km by continent are at least what they were before on every continent.
6. **Epidemic.** Run the model with the train on, then off, on the same seed. ✅ Train on: the log line `Rail: N daily rail routes, … travellers a day (World Bank …)`, more places, and earlier arrival along rail corridors (Irkutsk to Krasnoyarsk). ✅ Train off: the same result as before the change.
7. **Map.** Scan and pick hour 1. ✅ No orange rail anywhere the train reach or a landing has not got to by then; rail never reached is not drawn at all (no grey, no backdrop). ✅ Reached rail lights orange band by band as the hour moves. ✅ CLEAR DATA leaves no orange rail and no lit roads on the map, ticking Display spread on map included, until a new SCAN TRAVEL brings them back. ✅ The console shows no primitive errors.

## 8. Artificial Intelligence World Training Sim (owner request 2026-10-13)

> Start the app the usual way (explorer.exe `start-dev.cmd`). Data goes to the gitignored `.gev-data/`; the tab never deletes without its preview and a second press, and never from the phone.

1. **The tab.** ✅ ARTIFICIAL INTELLIGENCE WORLD TRAINING SIM is the last left tab, collapsed, and opens like the others (Escape closes it). ✅ TRAIN ON lists every Data Layers layer, then NEWS EVENTS, POPULATION DEMOGRAPHICS, OUTBREAK SIM EPISODES and YOUR DEVICES, each with its licence class. ✅ ALL ticks and unticks every row and shows a partial state when only some are ticked.
2. **Initialize.** Tick EARTHQUAKES and TRANSIT, press INITIALIZE. ✅ An estimate appears first (bytes a day, days to the cap, GPU). ✅ CONFIRM INITIALIZE starts it: the rows read RECORDING and `.gev-data/tape/earthquakes/…` and `…/transit/…` appear within a minute. ✅ `GET /api/ai-world/status` says `running`.
3. **Pause and continue.** ✅ PAUSE turns into CONTINUE, the rows read PAUSED and no new tape lines are written. ✅ CONTINUE resumes, and `.gev-data/tape/gaps.jsonl` holds the paused interval.
4. **Stop and delete.** STOP, then DELETE with ALL DATA. ✅ The preview lists each group with its files and size and a total. ✅ Only the red DELETE n FILES · X GB press deletes, and only those files; `.gev-data/ai-world/state.json` stays. ✅ Pressing DELETE while running is refused.
5. **The phone.** From the phone mirror: ✅ INITIALIZE, PAUSE, CONTINUE and STOP work, and ADD VIEW AS AREA adds an area. ✅ DELETE and an area's REMOVE do nothing and say nothing (`403 pc-only`), and the files and the area are still there on the PC.
   5a. **Areas.** Fly to a city with public cameras, press ADD VIEW AS AREA, tick CCTV, NEWS and TRAFFIC, then INITIALIZE. ✅ AREAS lists the place with its point. ✅ Within 15 minutes `.gev-data/tape/cctv/…` holds stills from cameras within 50 km (never more than 1,000, never a school, university, college or library camera) and NEWS records the area's brief. ✅ REMOVE takes it off the list; the tape stays. With no area, those rows read ERROR · NO AREA SELECTED.
6. **Sim episodes.** `npm run outbreak:world`, then `npm run outbreak:dataset -- --pilot 8 --runs 2 --days 10`. ✅ A world folder and shards under `.gev-data/outbreak/`, and a projection for the whole sweep. ✅ `py -3.13 -m ml.gevtape.check .gev-data/outbreak/datasets/<name>` passes. With recorded conditions: after `npm run world-tape:bin`, `npm run outbreak:dataset -- --drivers --pilot 8` ✅ starts every scenario on a binned day and its episodes say `drivers` in their JSON. From a box run: save an Outbreak run with DOWNLOAD RESULTS, then `npm run outbreak:dataset -- --from-export <file> --scenarios 8` ✅ prints the run's places, scan flights and days, and the episodes carry `preset: 'export'`.
   6a. **Backfill.** `npm run world-tape:backfill -- --from <a week ago> --to <yesterday> --feeds wind,weather-cyclones,earthquakes` ✅ about 3 MB a day of GFS grids under `.gev-data/tape/wind/`, a clear note that HURDAT2 has no season this recent, and USGS quakes; then `npm run world-tape:bin` ✅ fills the weather channels for those days, all 24 hours.
   6b. **Backfilled days.** With the job running after 6a: ✅ STATUS reads `TRAINING · WAITING · world · BINNING <oldest day> · N DAYS LEFT` and `.gev-data/bins/<world>/…` gains one day at a time, oldest first, with no `ml.gevtape.train` process until nothing is left; ✅ with fewer than three binned days it reads `NEEDS 3 BINNED DAYS · N SO FAR` and no trainer starts; ✅ at three the world model trains, and a trainer that fails is not started again until another day is binned.
7. **Restart.** With the recorder running, restart the dev server. ✅ The tab is running again and `gaps.jsonl` holds the downtime as `restart`.
8. **Predictions.** ✅ With no model yet, every domain reads LEARNING and nothing is drawn. ✅ After a model trains, ticking its domain draws on the globe, and unticking clears it.
9. **TensorFlow.** Run `npm run tensorflow:wsl-setup` once; ✅ its last line names the GPU. In the tab, ✅ the four sections (TENSORFLOW TRAINING, TENSORBOARD, EXPORT FOR TENSORFLOW, POST-TRAIN A TENSORFLOW MODEL) are folded and RUNS ON reads `GPU NVIDIA … · WSL2 UBUNTU · PYTHON 3.13.… · TENSORFLOW 2.21.0` (after CHECK AGAIN if the setup ran while the server was up). ✅ TRAIN shows `RUNNING · EPOCH … · LOSS …` with the GPU, an open section stays open while it polls, PAUSE turns into CONTINUE and CONTINUE carries on; at the end the model line gives `MAE … VS PERSISTENCE …` per domain and `.gev-data/ai-world/tensorflow/models/tf-world/model.keras` exists. ✅ START TENSORBOARD, then OPEN TENSORBOARD shows the `tf-world` run and, after the kit's trainer has run, `world`; it opens from the phone mirror too. ✅ EXPORT NOW writes a new folder under `.gev-data/ai-world/tensorflow/exports/` whose line ends `SAVEDMODEL + TFLITE (CHECKED) · THIS PC ONLY`, and the snippet in its `TENSORFLOW.md` reads the TFRecords. ✅ POST-TRAIN NOW with the default adapter and checkpoint ends with `HELD-OUT LOSS … → …`. ✅ With WSL2 shut down (`wsl --shutdown`), CHECK AGAIN, then TRAIN runs on the CPU and says CPU.
10. **MLflow.** `py -3.13 -m pip install mlflow`, then CHECK AGAIN: ✅ the six MLFLOW sections are folded and the line reads `MLFLOW 3.17.1 · PYTHON 3.13.… · SERVER …`. ✅ With TRACK EVERY TRAINING RUN ticked, a TensorFlow TRAIN starts the MLflow server by itself and, in OPEN MLFLOW, the experiment `ai-world/tensorflow-train` holds the run with its loss chart and held-out MAE and persistence; the kit's own trainer's runs appear under `ai-world/world`. ✅ REGISTER the kit's world model as CHAMPION, then the Keras one: MODEL REGISTRY lists both, SET ALIAS moves CHALLENGER. ✅ EVALUATE NOW lists both with `MAE … VS PERSISTENCE …` and one BEST. ✅ START SERVING a version, TEST: `TEST OK · SHAPE 1 × … × 4 × …`. ✅ With a custom LLM trained, ASK answers and OPEN THE TRACE shows the question and answer in `ai-world/llm-traces`. ✅ From the phone mirror OPEN MLFLOW works, but deleting a run in the MLflow UI does nothing (`403 pc-only`). ✅ STOP MLFLOW, then `netstat -ano | findstr :5000` shows nothing listening.

## 9. AI Distillation (owner request 2026-10-19)

> Paid calls: use a short list of questions. Data goes to the gitignored `.gev-data/distill/`; the guide is `docs/AI-DISTILLATION.md`.

1. **The tab.** ✅ AI DISTILLATION is the left tab after the AI World tab, collapsed, and opens like the others. ✅ TEACHERS lists the POWER UP LLMs, GROK BOT, OPENAI DOTS and every custom LLM trained here, each READY, PASTE or NOT SET UP with its route and THEN its fallbacks. ✅ The seven headings are folded and each opens to ADD HEADING.
2. **Heading 1.** Add a sub-heading, type two questions, ADD QUESTIONS, pick a teacher, SAVE SETTINGS. ✅ ESTIMATE reads `2 QUESTIONS FROM QUESTION 1 · 1 PAID CALLS EACH · 2 CALLS IN ALL` and nothing starts; ✅ CONFIRM START runs them one at a time and the sub-heading shows `2 GROUND TRUTHS`; ✅ EXPORT JSONL and EXPORT CSV download them. ✅ LOAD CSV with a `question` column adds its rows.
3. **Heading 2.** Tick two or three teachers and two reviewers, REVIEW on. ✅ Each record holds every answer, every grade and the best; with GROUND TRUTH set to the writer, the writer's answer is the ground truth.
4. **Headings 3-7.** One question each. ✅ The records hold two turns (3, 5) or three (4, 6, 7), each review prompt carrying the question, the response id and the response; ✅ 5, 6 and 7 refuse the same teacher twice; ✅ in 6, BACK TO TURN 1'S TEACHER sends turn 3 to the first teacher.
5. **Replies from the apps.** With no `GROK_BOT_API_KEY`, no gateway and no `OPENAI_DOTS_API_KEY`, Grok Bot and ChatGPT installed and signed in: ✅ both rows read `APP · THE REPLY COMES BACK BY ITSELF`; ✅ a heading 1 run with GROK BOT pastes the question into Grok Bot ending `[GEV-…]`, the run reads `GROK BOT IS ANSWERING: ITS REPLY COMES BACK BY ITSELF`, and about 15 seconds after the bot finishes the ground truth is its reply (route `desktop`, model `Grok Bot app`); ✅ the same with OPENAI DOTS: ChatGPT comes to the front, its Copy response is clicked, and the ground truth keeps ChatGPT's Markdown (`how: copy`); ✅ two bots in heading 2 take turns, never pasting at once.
   5a. **Paste-back.** Close Grok Bot while it answers (or run on a PC without the apps): ✅ the run reads `RUN · WAITING FOR YOUR PASTE` with `THE REPLY DID NOT COME BACK BY ITSELF (…)` and the prompt; ✅ OPEN GROK BOT AND PASTE opens the app with it; ✅ SUBMIT ANSWER carries the run on, and SKIP drops that question.
6. **Pause, stop, start over.** ✅ PAUSE finishes the question, then CONTINUE goes on at the next; ✅ STOP ends at once; ✅ START OVER FROM THE FIRST QUESTION begins at 1 again.
7. **Training.** ✅ In CUSTOM LLM TRAINING, DISTILLED ANSWERS (AI DISTILLATION) is a source, class RESTRICTED, and a run with it ticked trains on the ground truths.
8. **The phone.** From the phone mirror: ✅ adding a sub-heading, questions and a run work; ✅ CLEAR QUESTIONS, CLEAR DATASET and DELETE HEADING do nothing and say nothing (`403 pc-only`), and the files are still there on the PC.

## If something looks off

- **Grey globe / slow tiles:** wait a few seconds after a camera flight; photoreal streams in.
- **A voice mark didn't land:** the place may not geocode — try a more specific name
  (e.g. "Palace of Fine Arts, San Francisco").
- **No planes:** OpenSky data may be momentarily sparse; scroll out or wait a poll cycle.
- **No GEV MIC button / voice errors:** `OPENAI_API_KEY` didn't load — use the console API for
  the annotation tests and skip the voice-only ones (§2).

## Browser harness renderers

The first-run, view-target prewarm, cockpit-plates and floor-hold harnesses
select Metal on macOS and SwiftShader on other platforms. Cockpit-plates also
accepts `--swiftshader` on macOS; floor-hold retains `--angle=<backend>`.
Floor-hold explicitly selects 2D aircraft mode because it measures billboard
positions; the tracking suite covers the 3D handoff.
Software runs validate their assertions but do not establish real-GPU visual
correctness. Floor-hold retains both mesh and DEM checks: an unavailable mesh
oracle fails the run even when the DEM check passes. Record the backend with
any screenshots and run GPU visual checks separately when needed.

FIRMS refactoring can be checked without a configured server key using
`node scripts/qa-firms.mjs --url http://localhost:4173 --fixtures`. This explicit
fixture mode exercises populated display, aggregation, cards, keyless and stale
responses, and selection/camera handoff. It does not establish live-source
acceptance; omit `--fixtures` with a configured FIRMS key for that check.

Director authoring and sharing acceptance: `node scripts/qa-director-sharing.mjs`
checks installed import previews, draft validation, file-bundle round trips,
cancellation, resource ownership and narrow-screen controls. Run alongside the
scene-controls, camera, pack, interaction and timing harnesses.
