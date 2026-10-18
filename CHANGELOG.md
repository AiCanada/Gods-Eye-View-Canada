# Changelog

- TENSORFLOW in the AI World tab (owner request 2026-10-17; ruling: all
  four, Python 3.13, the GPU through WSL2): four expandable sections near the
  bottom of the tab (`src/tensorflowSetup.js`, routes `/api/tensorflow`,
  `server/shared/tensorflowJobs.mjs`). TENSORFLOW TRAINING trains a Keras
  world model (`ml.gevtape.tf_world`, `tf_train`) on the kit's bins, holds
  out the same days and scores it against persistence per domain; it starts
  as persistence, carries on from its saved model and grows to new channels.
  TENSORBOARD serves the curves of every trainer, the kit's PyTorch ones
  included, through `/api/tensorflow/board/` (the phone mirror reaches it);
  the curves are written by `ml.gevtape.board`, a standard-library writer, so
  the PyTorch trainer does not load TensorFlow. EXPORT FOR TENSORFLOW adds
  TFRecords (observed entries only), a SavedModel and a TFLite file checked
  against Keras to the licence-filtered training set (`tf_export`). POST-TRAIN
  A TENSORFLOW MODEL brings a Keras model up to date through an adapter
  (`tf_posttrain`, `ml/adapters/keras_world.py`). Jobs run on the GPU in
  WSL2 when `npm run tensorflow:wsl-setup` has set it up
  (`scripts/tensorflow-wsl-setup.sh`, `tensorflow-wsl-run.sh`: TensorFlow
  2.21 with its CUDA wheels, no sudo), else on the CPU with `py -3.13`. The
  child-process protocol moved to `ml/gevtape/protocol.py` and the adapter
  loader to `ml/gevtape/adapters.py` (both still imported through `train` and
  `posttrain`), and `torch_data` imports without torch. New strings in Quebec
  French, Inuktitut and Ancient Egyptian.

- AI World tab (owner request 2026-10-17): the LINKS section is gone, with
  its seven study-pair lines and the TICK LINK FEEDS button; the measured
  links (`MEASURED: …`, from `ml.gevtape.links`) now show last under STATUS,
  one per line, once there is a report. `src/trainingLinks.mjs` keeps the
  study pairs, which `scripts/world-tape-bin.mjs` still writes beside the
  bins, and the measured-link text; the 36 strings only the removed lines
  used are gone from the Quebec French, Inuktitut and Ancient Egyptian
  catalogs.

- Hover help in Ancient Egyptian and Inuktitut (owner request 2026-10-17): a
  mouse that rests two seconds on hieroglyphs or syllabics shows the English
  the text was translated from, in a small box above the pointer. While either
  locale is active, the i18n core keeps the English of each line it translates
  (`shownEnglish()`, values filled in, a translated value read back too; the
  latest 4,000 lines with values are kept), and `src/i18n/backToEnglish.js`
  reads anything else back from the catalog: whole lines, lines with values
  (matched against their pattern) and lines joined from translated pieces.
  `src/ui/englishHint.js` follows the pointer: mouse only, a 6-pixel rest
  tolerance, hidden on any move, click, key or scroll. Every other language,
  and the phone page, are unchanged.

- Upstream merge, 2026-10-17 (third): the 45 upstream commits after
  1df2a272, up to 93ea088f, all taken. Launch pads without coordinates stay
  unknown instead of drawing at 0°N 0°E, and a missing stage flight number no
  longer reads "FLIGHT 0" (#1186); satellite catalog numbers written in
  Alpha-5 decode (`A0000` is 100000) instead of colliding as NaN (#767), and a
  TLE set whose two lines name different satellites is skipped (#1101); one
  shared great-circle distance, `src/geoDistance.js` with `{ lat, lon }`
  points, replaces the local copies (#287); the dev server stops watching
  `.gev-cache` and `.gev-logs` (#761); dompurify, sharp and source-map-js move
  to their patched releases (#1094); nine Spanish city bike systems join the
  bike-share registry, underscores in station names read as spaces, and PBSC
  capacity counts docks, not the geofenced area; plus earthquake-record tests
  (#867) and documentation fixes (#839, #1196). Fork fits: the flight,
  military and traffic location switches use `greatCircleKm` from
  `src/geoDistance.js` (#287 removed the four-argument copies they imported
  from `routePlausible.js` and `trafficBounds.js`), and the `military-flights`
  package lists it; the dev watcher also skips `.gev-data`, where the AI World
  recorder writes its tape and models; the new watcher test builds its config
  from the isolated temp root like its neighbours. A checkout picks up the new
  package versions with `npm ci`.

- Ancient Egyptian, shown as **Ancient Egyptian**, is a new interface
  language in the language picker (owner request 2026-10-17), added the way
  Inuktitut was, the five tabs on the left included:
  `src/i18n/locales/egy.json` with all 4,525 messages in hieroglyphs, `egy`
  in `LOCALES`, `LOCALE_NAMES` and `src/i18n/fork-locales.json`, its catalog
  in `src/i18n/index.js` and `scripts/package-boundaries.json`, its
  kept-as-English list in `src/i18n/same-as-english.json`, and its notes in
  `docs/translations/egy.md` (sources, script, the dual plural, glossary).
  The language of the Old Kingdom is preferred: each word takes an Old
  Kingdom spelling from the Thesaurus Linguae Aegyptiae corpus where one is
  attested, else a later one, else Wikidata's TLA lemma. Signs come from the
  Unicode base block only, written in a plain line; Hieratic and Demotic have
  no Unicode encoding, and Coptic, a much later stage, is not used. `Intl`
  has no Egyptian plural rules, so `pluralRulesLocale()` counts Egyptian as
  Inuktitut (one, two for the dual, other), in the page and in
  `npm run i18n`; numbers and dates follow Canadian English (`1,234.5`).
  Pages in Ancient Egyptian name the fonts that carry hieroglyphs (Noto Sans
  Egyptian Hieroglyphs, which `index.html` now loads from Google Fonts and
  the browser fetches only when a hieroglyph is drawn, Segoe UI Historic,
  Aegyptus, NewGardiner), and the CCTV control row wraps for it. The
  translation is a first draft; it needs an Egyptologist's review. Spanish,
  Russian, Quebec French and Inuktitut are unchanged.

- Inuktitut, shown as **Inuktitut**, is a new interface language in the
  language picker (owner request 2026-10-17), added the way Quebec French
  was, the five tabs on the left included: `src/i18n/locales/iu.json` with
  all 4,525 messages in syllabics, `iu` in `LOCALES`, `LOCALE_NAMES` and
  `src/i18n/fork-locales.json`, its catalog in `src/i18n/index.js` and
  `scripts/package-boundaries.json`, its kept-as-English list in
  `src/i18n/same-as-english.json`, and its notes in
  `docs/translations/iu.md` (spelling, the dual plural, glossary). Counts
  take Inuktitut's three forms (one, two, other). `Intl` has no Inuktitut
  number or date data, so numbers and dates follow Canadian English
  (`1,234.5`) whatever the browser is. Pages in Inuktitut name the system
  fonts that carry syllabics (Pigiarniq, Euphemia UCAS, Gadugi, Noto Sans
  Canadian Aboriginal), and the CCTV control row wraps for it as for Spanish
  and Quebec French. The translation is a first draft, checked word by word
  against the Nunavut Hansard parallel corpus; it needs a fluent speaker's
  review. Spanish and Russian are unchanged.

- The five tabs on the left are in Quebec French too (owner request
  2026-10-17): AI RISK & TRUTH ASSESSMENT, ULTRA SECURITY PACKAGE, SOCIAL
  MEDIA ANALYSIS, OUTBREAK LOCATIONS & PREDICTED SPREAD and the ARTIFICIAL
  INTELLIGENCE WORLD TRAINING SIM, with what they draw on the globe (AI World
  predictions and market cards, the outbreak layer, Ultra photos and videos),
  the panels' corner resize grip and the POWER UP chip's count. Their text is
  marked with `tl()`, `tln()`, `msgl()` and `data-i18n-local*`, which
  translate only into the locales listed in `src/i18n/fork-locales.json`
  (Quebec French): Spanish and Russian keep these tabs in English, and their
  catalogs are unchanged. Code the server shares (the outbreak and epidemic
  summaries, the Ultra help request, the world tape) takes its words from a
  `say` argument, so a model or a message still gets English. The AI World
  row labels and licence notes, and the custom LLM's data sources and base
  models, come from the server; the tabs list them for translation, and tests
  fail when a list drifts from the server's. `fr-CA.json` now holds 4,525
  messages. Still English in every language: SST, POWER UP's device, home and
  business camera and road CCTV key sections, and what the server writes
  (model answers, a forecast's reasons). How to mark text in these tabs:
  `docs/I18N.md`, "The fork's own tabs".

- Quebec French, shown as **Français Québécois**, is a new interface
  language in the language picker (owner request 2026-10-17), added the way
  Spanish and Russian were: `src/i18n/locales/fr-CA.json` with all 2,627
  messages, `fr-CA` in `LOCALES` and `LOCALE_NAMES`, its catalog in
  `src/i18n/index.js` and `scripts/package-boundaries.json`, its kept-as-
  English list in `src/i18n/same-as-english.json`, and its notes in
  `docs/translations/fr-CA.md` (Quebec vocabulary, French spacing, plurals,
  glossary). A tag with a region is matched exactly first, and any French
  (`fr`, `fr-FR`) opens in Quebec French, the only French shipped. Dates and
  numbers follow Canadian French. The CCTV control row wraps for it as it
  does for Spanish. Russian is unchanged.

- ULTRA SECURITY PACKAGE moved from POWER UP → YOUR DEVICES to the bottom of
  the ULTRA SECURITY PACKAGE tab (owner request 2026-10-17). The package
  cards are laid out like the tab's other sections (its heading with the
  count, its notes, rows and buttons); the tab mounts them and ends them with
  itself, and they stay hidden until `/api/device-feeds` answers. Every
  control, saved field, route and rule is unchanged: how a phone or tracker
  connects, its address and login, the report-in key and lines, NEW KEY,
  SAVE PACKAGE and REMOVE PACKAGE (refused quietly on the owner's phone, as
  before). POWER UP keeps the drones, robots, marine drones and GPS trackers,
  and its count no longer includes the package. One device is followed at a
  time, so a save in either place redraws the other when it changes what
  that one shows. The SMS relay and help-network directory keys stay in
  POWER UP with the other keys.

- Tests are isolated from this machine's data, caches and private config
  (owner rule 2026-10-17: isolate a test; never move its fixtures out of the
  way). A file-access sweep of `npm test` found `previewServing.test.mjs`
  booting every provider on this checkout: each run appended two `restart`
  gaps to the world tape and rewrote the AI World job state and market files
  beside the running app. Other tests read the live Overpass, camera live-pack
  and road CCTV key files, the Ultra token key, help network and inbox, the
  private camera feed config, the integrity store and `.env`. Each now works
  in an empty temp folder (`src/tooling/isolatedCwd.mjs`, imported first), or
  passes a temp root, or both: `localProviderPlugins` and the app's Vite config
  take an optional `sourceRoot` (without one nothing changes), the camera
  server keys its stills from its own checkout, help-network pins are served
  only for the Ultra module's own checkout, and two Vite test builds load no
  `.env` (`envDir: false`). The media provenance test runs on a catalogue
  with no live packs and checks that only its two fixture hosts are asked.

- CUSTOM LLM TRAINING moved from POWER UP to the bottom of the ARTIFICIAL
  INTELLIGENCE WORLD TRAINING SIM tab (owner request 2026-10-17). It is laid
  out like the tab's other sections (its headings, notes, tick boxes, lists
  with REMOVE and buttons), the tab mounts it and ends it with itself, and it
  stays hidden until `/api/llm-training` answers. The settings, sources, runs
  and trained models are unchanged; POWER UP no longer shows the section. The
  tab's INSTRUCTIONS, `docs/TRAINING-GUIDE.md` part 4, `docs/AI-WORLD-TAB.md`
  and `DATA_SOURCES.md` say where it is now.

- Upstream merge, 2026-10-17 (second): the 44 upstream commits after
  a571142d, up to 1df2a272, all taken. The map retries the real imagery and
  terrain provider after a boot-time fallback instead of keeping OSM or a flat
  globe for the session (#1111); `geo:` URIs resolve offline in location
  search (#1071); camera snapshots call Street View fallback imagery
  historical (#1118; the fork's frame route sends the same provenance
  values); the TomTom routes refuse cross-site requests before they spend the
  daily tile budget (#973; the phone's tiles through the mirror are
  same-origin and still load); tracked aircraft publish their vertical rate
  (#718); the scene director's save status and run counts are accurate
  (#1135); fire-perimeter queries and cards handle the antimeridian (#1142);
  and rocket-launch normalization has edge-case tests (#1136). Upstream's
  #718 dropped three earlier changelog entries (FM seek, Bogotá and
  Santiago, Barcelona) by accident; this changelog keeps them.

- Upstream merge, 2026-10-17 ("True Up"): the 57 upstream pull requests
  merged into gods-eye-view main after the 2026-10-14 merge, up to a571142d.
  What came in:
  - Interface localization (#602): Spanish and Russian, an EN | ES | RU
    switch, `npm run i18n` and its catalog test. The fork's own features keep
    English text for now: their panels carry `data-i18n-skip` and their
    modules are listed in `src/i18n/fork-english-only.json`, which the
    unmarked-text check skips (every catalog check still runs). A few fork
    strings that sit in upstream's flows are translated: the startup flight
    ("Flying to {city}..."), the two whole-app voice tools' plan steps and the
    Cockpit refusal for flying to a call for help.
  - New layers: GNSS integrity with emergency-squawk highlighting (#1108,
    share token `3`) and Air quality, Canada's AQHI (#568, token `4`); the
    fork's tokens stay at `zz`, `zy` and `zx`. Panoramax as a fourth street
    level provider (#1134), dropping your own GeoJSON, KML, KMZ or GPX file on
    the globe (#1122), a Docker install path bound to 127.0.0.1 (#208), a web
    app manifest and home-screen icons (#636), Google geocoding through the
    server (#693), nine Ontario transit feeds (#634), bike share for Toronto,
    Brazil, Norway, Detroit, Pittsburgh, Aspen, Kona, Barcelona, Bogotá and
    Santiago (#641, #359, #946, #1082, #1176, #1063), a satellite cloud filter
    slider (#1084), SDR playback fixes (#1183), camera model specs (#452 with
    #645's model and manufacturer fields), `/api/cctv/media` refusing still
    cameras (#595), bounded upstream body reads (#581), changelog fragments in
    `changelog.d/` (#787) and the smaller fixes.
  - Left out: the live camera loaders for Toronto RESCU (#640), WSDOT (#644),
    King County (#645), Lithuania (#607) and Catalonia (#595). The fork's
    packs already hold those cameras, and each loader adds a per-pack camera
    cap; King County's also drops offline cameras.
  - Fitted to the fork: the AI World recorder's bike share feed keeps itself
    to 60 requests a minute, half of `/api/gbfs`'s new per-client limit (#690),
    because the registry grew from 19 to 52 systems; its PM2.5 feed is paired
    with the new Air quality layer, and GNSS integrity shows in the tab as
    STATIC until a feed records it. The voice prompt ceiling is 53,000
    characters (52,848 with both sides' tools and rules).
  - On this machine: Overpass cache entries now carry the configured
    `OVERPASS_UPSTREAMS`, so the existing cache is fetched again once (#937).
    Geocoding no longer uses the browser's Google key, which can now be
    limited to Map Tiles and the Maps JavaScript API.

- Ultra box, the phone's camera and the mirror (owner report 2026-10-16:
  TAKE PHOTO and TAKE VIDEO did nothing, and the map would not load on the
  phone). What the log and the live machine showed, and what changed:
  - The map: this PC had no Tailscale address for hours at a time (from the
    morning reboot until the early afternoon), so the mirror that serves the
    dashboard on it could not listen and nothing from the phone arrived; the
    mirror only looked again every 30 s and a restart inside that window
    cancelled the look. It now looks every 3 s, retries a failed listen
    (saying so once, then once a minute), closes the phone's sockets when it
    goes down, keeps an unanswered owner check for 15 s instead of five
    minutes, and logs each refused address. Keeping Tailscale connected on
    the PC (its "Run unattended" setting) is what keeps the phone's page up.
  - A phone that opens the mirror by this machine's MagicDNS name got the
    page but a dead Ultra box: the owner stamp binds to the address, so every
    owner route answered 403 by name. The mirror now sends a by-name request
    (302) to the address form, so an old bookmark keeps working.
  - The camera link in the box carried this machine's LAN address whenever
    the Tailscale address was missing at the listener's start, and Windows
    Firewall blocks node on the Wi-Fi's Public profile. The listener now
    lists the Tailscale address first and looks at its addresses again every
    15 s, so the link moves to the address the phone can reach without a
    restart; with no listener it hands out no link at all.
  - The box's status line said LIVE VIDEO as soon as a button was pressed,
    while the command only waited for a phone page that was not open (the
    page polls every second; the box only queues the press). It now says LIVE
    VIDEO only while the page is polling; otherwise ASKED with what is
    missing (the page, the listener, or this PC's Tailscale address), NOT
    TAKEN once a press has waited fifteen minutes (it is dropped rather than
    fired whenever the page opens), and TAILSCALE · THIS PC HAS NO TAILSCALE
    ADDRESS while the mirror is on and the listener has none. The phone side
    is unchanged: the page needs the chrome://flags "Insecure origins treated
    as secure" entry for the Tailscale addresses (Mirror README) to take the
    still itself; without it the page offers one tap.
  - With two phones saved (two Ultra packages), a press went to whichever
    phone's tracker app reported last, and so did the camera link. A CELL
    select above the camera buttons now picks the phone (owner request
    2026-10-16; kept with the phone model, route `/camera-cell`); AUTO goes
    to the phone whose camera page is open, else the last reporter, and the
    link names the package it is for.
  - No page needed (owner request 2026-10-16): with no camera page open on
    the chosen phone, a press goes to the phone's camera app instead (IP
    Webcam on port 8080, DroidCam on 4747, as the box already tried once).
    TAKE PHOTO pulls one still and keeps it as the photo; TAKE VIDEO reads
    the app's stream for the recording time, shows it live on the map card
    (LIVE VIDEO · CAMERA APP) and keeps its first frame, since this machine
    has no video encoder to write a clip with. When neither answers, the box
    says so and names both ways.
  - Checked end to end on the owner's phone over Tailscale (the debug bridge
    only to read the page): the page is a secure context with the flag set,
    the live camera runs, a press from the box is taken within seconds and
    the still is stored and listed.
  - Also: the AI World job state no longer declares `selection` twice (an
    esbuild warning at every start).
- Fixed, AI World tab (2026-10-16): the running job binned only the newest
  finished day, so backfilled history (thirty days of earthquakes from
  `world-tape:backfill`) and any day the server slept through at midnight
  were never binned, and the world model kept saying one day recorded.
  Every finished day with tape and no bin is now binned, oldest first and
  one day at a time, and `learning.daysBinned` counts them (LEARNING shows
  the binned days when they exceed the recorded ones). The world model is
  launched only once three binned days exist (two to train on, one held
  out); until then the TRAINING line reads WAITING with what it needs,
  instead of a torch process starting and failing every fifteen minutes and
  STATUS showing ERROR. A trainer that does fail is tried again when a new
  day is binned. `docs/AI-WORLD-TAB.md` lost its duplicated paragraphs and
  now describes the 42-asset MARKETS feed as it is.
- Fixed: three leftovers of the 2026-10-14 upstream merge that failed five
  unit tests. The NYC DOT camera pack's 250-camera cap
  (`DEFAULT_NYC_MAX_SOURCES`, `CCTV_NYC_MAX_SOURCES`, the borough anchors
  and a `prioritizeSources` that no longer existed, so the pack could never
  load) is gone: once enabled, every online NYC camera loads and the area
  cap bounds what is served, as for every other pack. Mapillary's orbit
  guard is back: no overview dots are fetched or drawn from orbit (owner
  ruling 2026-10-09); the shared line coverage takes `overviewDots`. The
  right rail's merged-in test asserted the one-box "exclusive" mode the
  fork turned off (owner ruling 2026-09-27); it now checks the fork's rule:
  the other tabs stay in reach, and a panel an older version auto-collapsed
  is released once the HUD is away.
- OpenRouter's default model is NVIDIA: Nemotron 3.5 Super VL (free) (owner
  ruling 2026-10-16; `nvidia/nemotron-3.5-super-vl:free`, 120 B parameters
  with 12 B active, replacing Nemotron 3 Ultra of 2026-09-27). It is asked
  the way NVIDIA's own sample call asks it: thinking on, temperature 1,
  top_p 0.95, seed 42, and a 16,384-token budget so the thinking leaves room
  for the answer (`MODEL_SAMPLING` in `server/providers/llm/ask.js`). The
  same settings apply to OpenRouter's paid id for the model and to NIM's
  `nvidia/nemotron-3.5-super-vl-120b-a12b`, which the NVIDIA NIM MODEL box
  now suggests. On NIM the chat template switches the thinking on, so no
  `reasoning_effort` is sent. Every other model keeps temperature 0.3 and
  the usual budget. The panel still shows the finished answer only: the
  upstream call is not streamed, and the thinking is not shown. Checked
  live: OpenRouter answered in 1.8 s and an Overview-style question in
  10.5 s, at no cost; NIM answered in 1.1 s.

- POWER UP · CUSTOM LLM TRAINING: the default base model is Qwen3.5-0.8B
  (owner ruling 2026-10-16; `Qwen/Qwen3.5-0.8B`, Apache-2.0, 1.7 GB, trains
  on the GPU alone). Qwen3.6-35B-A3B is the large option (owner ruling
  2026-10-16, "use Qwen3.6-A3B"; `Qwen/Qwen3.6-35B-A3B`, Apache-2.0, about
  72 GB). A list under the base box offers both, says which are on this PC,
  and any other id or folder can be typed. A base is found in
  `.gev-data/llm/base/<name>`, the Hugging Face cache or a named folder, and
  never downloaded by the app; untouched settings on the earlier default
  move to the new one. Checked on this PC: Qwen3.5-0.8B trained on the GPU in
  84 s on a small set (held-out loss 4.43 → 0.08), and the trained model
  answered from it.
  - A base too big for the GPU is split across GPU and RAM, with gradient
    checkpointing (`--placement auto`; `gpu`, `split` and `cpu` force one).
    A base that fits neither together is refused.
  - LoRA now also adapts the gated-delta linear-attention projections
    (`in_proj_qkv`, `in_proj_z`, `out_proj`) that most of Qwen3.6's layers
    use.

- Dashboard boxes resize from a corner on desktop (owner requests
  2026-10-16). Every box in the left stack has a grip at its bottom-right
  corner, and every box on the right rail has one at its bottom-left: that
  rail is anchored to the screen's right edge, so the box grows onto the map.
  Drag to set the width and height, use the arrow keys (Shift for bigger
  steps), or double-click for the box's own size. A size stays on screen,
  is fitted again where a box opens, and is remembered per box in this
  browser (`gev:panel-size:<panel id>`). A floating CCTV or Street Level
  window keeps its own edge resizing. Phone-width layouts are unchanged
  (`src/ui/panelCornerResize.js`, `panel-resize.css`). Open, the AI World tab
  is now 520 px wide instead of 360.
- AI World tab, financial assets and price moves (owner request 2026-10-15).
  FINANCIAL ASSETS records 42 assets every five minutes:
  - currencies and the dollar index;
  - US 5-, 10- and 30-year yields;
  - WTI, Brent, natural gas, gold, silver, copper, wheat, corn, soybeans,
    gasoline, heating oil, jet fuel and kerosene;
  - the S&P 500, Dow, Nasdaq, TSX, FTSE, DAX, CAC 40, Nikkei, Hang Seng,
    Shanghai, Sensex, ASX 200 and Bovespa;
  - the VIX, Bitcoin and Ether.

  Yahoo Finance is read 20 symbols a request. The Twelve Data key now goes in
  a header, not the address. Each asset carries the place its benchmark is
  set (`src/marketAssets.mjs`, `assets.json` beside the bins). PRICE MOVES
  draws the world model's predicted move there: a dot and a card on the
  world-overlay host, green up, red down, biggest move first. The FINANCIAL
  ASSETS list shows each quote with its predicted move. Not advice.

- AI World tab, military travel left out entirely (owner request
  2026-10-15). The flights and local ADS-B feeds drop every airframe the
  app's military list names before recording, and hold their poll (an error,
  so the hour is not read as quiet) when no list newer than 6 hours can be
  had. AIS military vessels (ship type 35) are never recorded. The bins'
  empty `military` mobility column is gone, as is the track model's
  military kind.
- AI World tab, measured links. `ml.gevtape.links` measures every recorded
  channel against every asset's hourly returns, from 24 hours before to 24
  hours after, after each day is binned. It fits on the earlier hours, checks
  on the later ones, and applies a false-discovery rate. LINKS shows the
  strongest links in plain words, and each study pair's best one. A
  correlation is not a cause.
- AI World tab, post-training (owner request 2026-10-16: "update existing
  World models via Post training to keep the most up to date"). The world
  model meeting new channels (a new layer or asset) is now grown, keeping
  what it learned (`models.grow_world_model`), instead of starting over.
  POST-TRAIN keeps another world model up to date through an adapter
  (`ml.gevtape.posttrain`; template `ml/adapters/kit_world.py`, owner adapters
  in `.gev-data/ai-world/adapters/`): now, or daily on new data, scored on
  held-out days before and after.
- AI World tab, for someone training a new model of their own:
  - `ml.gevtape.world_env.WorldMarketEnv`, a reinforcement-learning
    environment over the recorded hours (data layers in, asset weights out,
    time-split train and test, imagined episodes with any world model);
  - `ml.gevtape.export`, a self-contained, licence-filtered training set
    with its `DATASET.md` card;
  - an INSTRUCTIONS block in the tab, and `docs/TRAINING-GUIDE.md`.
- POWER UP, CUSTOM LLM TRAINING (owner requests 2026-10-16). Pick a base
  model already on this PC (default Qwen/Qwen3-0.6B; nothing is downloaded
  but the custom URLs). Tick the data sources: recorded headlines, asset
  prices, headlines with next-day moves, measured links, hourly readings,
  custom URLs and local files or folders. Then INITIALIZE TRAINING:
  - the URLs are fetched, public https only, every redirect checked;
  - a dataset is built, with one example in twenty held out;
  - LoRA adapters are trained, with PAUSE, CONTINUE and STOP;
  - the held-out loss is shown before and after.

  POST-TRAIN FROM continues an earlier model, and POST-TRAIN DAILY
  post-trains it on what was recorded since. Routes `/api/llm-training`. The
  owner's phone may add and run, never remove (`server/shared/llmTraining.mjs`,
  `ml.gevtape.llm_data`, `ml.gevtape.llm_train`, `ml.gevtape.llm_chat`,
  `src/llmTrainingSetup.js`).

- Fixed: the news-URL feed followed redirects blindly, so a public page could
  send the request to an address on the owner's network. Redirects are now
  followed by hand, each address checked after DNS
  (`server/shared/publicFetch.mjs`). Also fixed:
  - observed weather never recorded anything (a wrong import path, caught
    silently);
  - a blank prediction was drawn as 0;
  - three AI World tests had fallen behind the feed list and the bin files.

- CCTV, Toronto and Catalonia frames (owner request 2026-10-15). Toronto's
  `ComparisonImages/loc<n><direction>.jpg` addresses are 2016 reference
  stills (Last-Modified June 2016), not frames. Each camera's four direction
  rows become one entry on its live view, `CameraImages/loc<n>.jpg`. In the
  Canada pack that is 955 rows into 248 cameras; 247 of them are already
  live in the inventory pack, so the two share one still and show once. In
  the inventory pack, 188 stills of cameras it already lists live go, and 7
  cameras become live entries. All 318 answered live (HTTP 200) on
  2026-10-15. Catalonia SCT's `RenderService` links (196, each of 98 cameras
  listed twice) never loaded over https: that host's TLS fails in Node
  (`ERR_SSL_DH_KEY_TOO_SMALL`), and it redirects to plain http anyway. They
  now name the frame directly,
  `http://mct.gencat.cat/mct2bo/TransitCamera?nom=<id>` (all 98 answer, 38
  showing the operator's "no images" card while offline), refreshing every
  3 minutes. A Terrassa link lost its trailing `%20&#13;`. The catalogue
  applies the same rules to every source at load (`liveStillUrl` and
  `decodeNumericEntities` in `cctv/normalize.js`, ported from upstream
  #595), so a pack that still carries an old link is fixed too. Not ported
  from #595: the `/media` video-only guard, since the panel still links
  stills through `/media`.

- Share links: the fork's own layers moved to the top of the token range,
  so a new upstream layer can never take one of their tokens again (owner
  request 2026-10-15). Your Devices `5` → `zz`, Private CCTV Cams `3` →
  `zy`, Outbreak `4` → `zx`; upstream counts up from the free digits and
  `00`, the fork counts down from `zz` (`FORK_LAYER_STATE_IDS`,
  `nextForkLayerStateToken`, `npm run layer-token:next -- --fork <id>`).
  The digits freed go to upstream's GNSS integrity (`3`) and air quality
  (`4`) at the next merge. Saved layer state keeps layer names, so nothing
  saved changes. A share link made before this with one of those three
  layers on no longer restores its layers (an unknown token voids the whole
  layer list, by design); after the merge, `3` and `4` in such a link open
  upstream's layers instead.
- CCTV: a CCTV window minimizes to the rail. Collapsed, its tab docks in the
  right rail with the dashboard's other tabs, the same size and never over an
  open box (before, it stayed on the map at the width it was resized to).
  Opened, it comes back as the window where it was, at the size chosen for
  it; pulled out of the rail, the minimized tab opens where it is dropped.
  Open, it moves and resizes from every edge as before
  (`panelPositionControls.js` `minimizeToRail`, `controls.css`).
- ARTIFICIAL INTELLIGENCE WORLD TRAINING SIM (owner request 2026-10-13): a
  new left tab, last in the stack, to train world models on the Outbreak sim
  plus every live feed. TRAIN ON lists a tick box per data layer plus NEWS
  EVENTS, POPULATION DEMOGRAPHICS, OUTBREAK SIM EPISODES and YOUR DEVICES,
  with ALL; INITIALIZE (after an estimate), PAUSE / CONTINUE, STOP, and
  DELETE, which lists what it would remove and deletes only that, never from
  the owner's phone (`pc-only`). Routes `/api/ai-world/*`
  (`server/providers/aiWorld.js`); the world tape records each ticked feed
  through the app's own API with its licence class
  (`server/shared/worldTape*`); sim episodes come from a frozen world graph
  on worker threads (`scripts/outbreak-world.mjs`,
  `scripts/outbreak-dataset.mjs`); training and prediction run `ml/`
  (Python, `py -3.13`); PREDICTIONS draws each ready domain on the globe
  (`src/aiWorldOverlay.js`). AREAS holds the places cameras, traffic, news,
  imagery and street level record around (ADD VIEW AS AREA takes the middle
  of the map; REMOVE is the PC's alone); YOUR DEVICES records every personal
  feed. Camera stills go through `/api/cctv/frame/<id>` and its 511 host
  budget (the catalogue now names each still's `budgetHost`), at most the
  nearest 1,000 per area within 50 km, never a school, university, college or
  library camera. STREET LEVEL also records per-image Mapillary metadata
  (`kind: 'image'`, at most 32 searches an area a day, no pixels) through a
  new cached, same-site route `GET /api/mapillary/images?bbox=w,s,e,n`
  (boxes ≤ 0.05°, the token only in an `Authorization` header to
  `graph.mapillary.com`); FLIGHTS records hourly under anonymous OpenSky and
  tags OpenSky rows with `auth`. The Wind layer's GFS proxy gained opt-in
  `humidity` (2 m specific) and `precipitation` (time-mean rate) overlays,
  which the tape records. The calibration on real epidemics
  (`ml.gevtape.calibrate`) runs from the tab once the outbreak model and the
  real data exist. Data lives in the gitignored `.gev-data/`
  (docs/WORLD-MODEL-DATA.md, docs/AI-WORLD-TAB.md), which the dev server
  neither serves nor watches (it had been readable as static files).
- Outbreak EPIDEMIC MODEL, for world models: optional `tape` (each run as an
  episode: state of every country and 5,000 tracked places each day,
  interventions exactly and as features, every infected leg, first events),
  control of the three decisions the model makes (window, per-place
  switches, border flags; a run's own logged decisions replay it byte for
  byte), `stream` (xoshiro128** keyed streams for datasets; the box keeps
  mulberry32) and `drivers` (recorded humidity, departures, trains and
  transit service: `season`, `travel`, `commute`). A day's control may also
  set the magnitudes — lockdown level, travel-ban share, tests a day and
  the campaign's doses a day — logged exactly (`controls_magnitudes`) so a
  replay stays byte for byte; a steady dose rate given each day vaccinates
  exactly as the closed form does. All absent by default, and then
  bit-identical (the golden master). The network assembly moved from the
  route to `server/shared/outbreakEpidemicWorld.mjs` unchanged.
- Sim datasets: `--drivers` starts scenarios on days the world tape binned
  and runs them under the conditions recorded then; `--from-export` makes a
  box run saved with DOWNLOAD RESULTS the base of a sweep (its pathogen,
  places, window and scan flights on the frozen world, the policy and random
  stream varying). DOWNLOAD RESULTS now keeps the scan's flights. The random
  policy also explores the magnitudes, from its own generator; the
  closed-loop environment takes them in its actions.
- World tape tools: `npm run world-tape:bin` (hourly features per tracked
  place; weather sampled from the recorded GFS and ECMWF grids, trains by
  the transit layer's own modes; each aircraft, vessel or vehicle counted
  once an hour, whatever the polling), `world-tape:backfill` (USGS
  catalogue, FIRMS archive, the NOAA GFS archive on AWS, NHC HURDAT2 best
  tracks, past VIIRS images of the AREAS),
  `outbreak:real-data` (OWID COVID-19 and OxCGRT policy, CC BY 4.0, in the
  same schema), `outbreak:env` (a closed-loop environment on stdio for
  reinforcement learning).
- Outbreak EPIDEMIC MODEL: a leg that lands within the hour it boards now
  lands the next hour (owner ruling 2026-10-13). Each simulated hour handles
  its landings before its departures board, so a half-hour train, a
  20-minute hop, or a short flight in a window that starts past the hour
  (the box's `now − d days`) was filed under an hour already read. Those
  infected travellers stayed in transit for good, and the place was never
  reached that way. Dated flights and daily routes now land at
  `max(h + 1, …)` (`src/outbreakEpi.mjs`). Results change for short legs
  only; every longer leg gives the same result on the same seed. A golden
  master (`src/outbreakEpiGolden.test.mjs`) now pins the full result of a
  20-scenario matrix (`src/testSupport/outbreakEpiMatrix.mjs`), the guard
  for the world-model work.
- OPENAI BOT SWARM / OPENAI DOT SWARM without an OPENAI DOTS key (Social
  Media, Outbreak SOCIAL SEARCH, and CONFIRM ULTRA TOKEN SKILLS) copies
  the ChatGPT task, opens ChatGPT, and pastes it into the focused composer
  and sends it (`POST /api/social/openai-dots/open` with
  `{ paste: true, text }`), the same last-resort as GROK BOT SWARM. The
  server writes the task to the clipboard itself (stdin to
  `scripts/paste-openai-dots.ps1`). Window hunt covers ChatGPT Classic and
  ChatGPT (EnumWindows, because MainWindowHandle is often 0). OPEN CHATGPT
  still posts `{}` and only opens. Swarm buttons still do not POST the
  Chief of Staff webhook.
- GROK BOT SWARM without a key or computer (Social Media, Outbreak SOCIAL
  SEARCH, Ultra, and CONFIRM ULTRA TOKEN SKILLS) still copies the Chief of
  Staff task and opens Grok Bot, and now pastes that task into the focused
  Grok Bot composer and sends it (`POST /api/social/grok-bot/open` with
  `{ paste: true, text }`). The server writes the task to the clipboard
  itself (stdin to `scripts/paste-grok-bot.ps1`) so a phone-mirror share
  sheet is not mistaken for the PC clipboard. The paste waits for Grok Bot
  to come to the front (2.5 s after open, then the window, then the
  composer) and sends Ctrl+V / Enter with SendInput from an STA PowerShell
  that is not CREATE_NO_WINDOW (a hidden console cannot inject keys). The
  PowerShell `-File` path is quoted so a repo folder with spaces still
  runs the paste script. Grok Bot stays HWND_TOPMOST until after Enter so a
  Chrome window in front does not eat the click; clicks use SetCursorPos in
  the same DPI space as the window (150% DPI SendInput ABSOLUTE was landing
  in the front app). OPEN GROK BOT still
  posts `{}` and only opens. Swarm buttons still do not POST the Chief of
  Staff webhook. `grokbot://` links still cannot carry a prompt.
- Ultra: CONFIRM ULTRA TOKEN SKILLS sends GROK BOT SWARM, OPENAI DOT
  SWARM, or LLM. LLM asks every ready Ask-panel model POWER UP has a key
  for (`GET /api/llm/providers`, `POST /api/llm/ask`), or one named model
  when the list has more than one. The Grok Bot computer / clipboard task
  is the short Chief of Staff check (sites, today, the person, short
  rules, and "Is this token Skill claimed trust worthy?"). Per-bot swarm
  prompts stay the longer public-page rules.
- Ultra: CONFIRM ULTRA TOKEN SKILLS sits below the token REMOVE rows and
  above HELP NETWORK. Apps to search are selectable options filled from
  the known sites (LinkedIn, X, GitHub, Facebook, and the rest).
- Ultra: CONFIRM ULTRA TOKEN SKILLS takes a pasted Ultra Token and decrypts
  the skills it carries (a clear `.s.` suffix on this page; an encrypted
  `.e.` suffix with this machine's token key). The form has Alias/AKA under
  the name. Verdicts are shown, not kept. The details help the bots or LLM
  find the right person.
- Ultra: CONFIRM ULTRA TOKEN SKILLS. The button sits below the token REMOVE
  rows and above HELP NETWORK. The form takes the skills to check, and optional
  details to find the right person: name, location, age, male/female/other,
  profession, their URLs and the apps to search. GROK BOT SWARM or OPENAI DOT
  SWARM sends one bot each to LinkedIn, X, Facebook, Instagram, Threads,
  TikTok, licence registries, and news and the web, plus one for their own
  links and apps (`POST /api/social/swarm/skill-check`). Without a Grok Bot
  key, the whole check goes to the Grok Bot computer, or the Chief of Staff
  task is copied and its pasted report is read back. Each skill comes back
  CONFIRMED, NO CONFIRMATION or REJECTED CLAIM, with the public links behind
  it. Finding nothing is never a rejection, a verdict with no link counts as
  nothing found, and a contradiction wins over a confirmation (marked MIXED).
  The verdicts are shown in the form. A last check kept on a home-list
  row (`config/ultra-network.json`) still shows on that row. The details typed in
  are only sent with the press and are never kept. The bots check the
  claimed skills only, read public pages only, never sign in, and never
  report anything else about the person; age and sex only tell people with
  the same name apart. Costs: one search request per bot on the swarm's own
  key, 8 or 9 a check.
- Outbreak tab: the yellow boat/vehicle reach circle from a northern
  outbreak (Irkutsk) stops at the south pole, in Antarctica. Train and road
  circles are unchanged: they still grow to the far-side antipode. The boat
  ring used to close on that antipode too, which for Irkutsk is southern
  Chile.
- Outbreak world rail: the crossing kernel (where two lines meet) can run on
  an NVIDIA GPU. `node scripts/build-outbreak-rail-cuda.mjs` (or
  `npm run outbreak:rail-cuda`) builds `native/outbreak-rail-cuda/rail_cross`
  when nvcc is present. The world-rail worker uses it for 4096+ pairs; a
  missing binary, `GEV_OUTBREAK_RAIL_CUDA=0`, or a failed spawn stays on the
  same CPU path. The rest of the graph (snap, joins, Dijkstra) stays on CPU.
- Outbreak tab: a new SCAN TRAVEL drops leftover roads, rail and assumed air
  traffic from the last run at once (the same drop as CLEAR DATA), so they
  cannot stay on the map or come back under the new run; PLAY and MAP FUTURE
  SPREAD grey out while a scan, search or epidemic run is working; world-rail
  progress stays on the travel note while SCAN DONE holds the status line;
  SOCIAL SEARCH names every outbreak location.
- Outbreak tab: the spread moves smoothly along the roads and rail on the
  map, in PLAY and MAP FUTURE SPREAD alike. Each piece of a line lights at
  the reach its far end is reached at, not all of its band at once (past
  48 h a band of the roads and rail after a landing spans 6 hours, past 10
  days a whole day, so the map stood still for several steps and then jumped),
  and between steps the lit edge slides forward frame by frame instead of
  jumping. Still never lit before the spread gets there.
- Outbreak tab: the reach circles keep growing all the way round the globe,
  past the south pole, closing in on the far side of the Earth, instead of
  stopping at 10,000 km, a quarter of the way round.
- Outbreak tab: every rail line on the globe is now found once in the
  background (OpenFreeMap z8, about 20,000 land tiles, cached on disk, 6 at a
  time, progress shown) and joined into one world network. Rail lights by
  reach from every outbreak and every landing across the whole network
  instead of stopping at 500 km or 200 km, with finer z10 detail kept within
  100 km. Rail is drawn only orange once reached: never grey, no backdrop of
  the world's rail, and each band lights only once the spread has passed it,
  so no rail shows at the start of a run before the spread gets there; each
  piece is banded by its far end, and rail and roads after a landing are cut
  at every hour band, so no part of a piece lights hours early. Rail and
  roads round an outbreak location start only once the spread has got from
  the location to them at road speed. CLEAR DATA
  removes every lit road and rail line, and an air-traffic answer still on
  its way when it is pressed no longer brings the old flights back. Roads out of a landing airport
  light up green. The epidemic model now carries rail travellers between the
  places rail connects (national rail passenger-km, World Bank; P1P2/D along
  the line, Zipf 1946), and towns on rail far from airports become places.
  Until the world network is ready, rail works as before.
- Outbreak tab: FIND FUTURE SPREAD LOCATIONS now looks the full 30 days ahead
  by default, in windows (24 h, 48 h, 3, 7, 14 and 30 days), and a menu beside
  it picks a shorter reach; places past 48 h assume each route flies daily.
  RUN EPIDEMIC MODEL, DOWNLOAD RESULTS and DOWNLOAD CSV sit on their own row
  below the model settings, at the same size. The results list, log, CSV and
  JSON carry every place reached, with no limit, and the whole result is kept
  across a reload. Only one yellow boat-reach ring shows on the map at a time,
  as an outline with nothing inside.
- Outbreak epidemic model: an optional second strain (seeded on a chosen day
  and airport, with its own transmissibility, severity and cross-immunity,
  replacing drift and takeover when on), a paired comparison against fewer
  measures using the same random numbers (infections, deaths and hospital peak
  averted, with intervals), Rt from the runs on the model's own generation
  interval, a time limit that now stops a run cleanly instead of failing, a
  blue ring on the map where beds run short in most runs, and voice that lists
  every control of one box (up to 150). With the new options unset, results
  are unchanged.

- Mirror of PC GEVC on Cell: your own phone over Tailscale now has every PC
  function, writes included: saving POWER UP keys, road CCTV keys and social
  logins, the Ultra box (tokens, contacts, number, home list, SEND HELP,
  STAND DOWN), private camera and device settings, CCTV alignment saves,
  ChatGPT OAuth voice and `/mcp`. The mirror stamps each request from a
  device Tailscale names as yours with an in-memory token and its own
  address, and writes still need the exact Origin and JSON. By owner ruling,
  removing or deleting anything stored on the PC stays PC-only: from the
  phone it is refused with no message (403, `X-GEV-Removal: pc-only`,
  `{"removal":"pc-only"}`) and the item stays as it was. On the phone, hold the mic
  to talk, double-tap where the PC double-clicks, long-press a panel header to
  move it, and twist two fingers to turn a CCTV thumbnail. Copy falls back
  when the clipboard is blocked, downloads finish before their link is
  released, and voice and location errors on a plain-http page point to the
  chrome://flags setting. Fonts, sizes, buttons and tap areas are unchanged.

- Outbreak epidemic model: hospital and intensive-care occupancy with bed
  shortages, recovered and waning immunity, vaccination (prior coverage and
  campaigns), susceptibility variation, per-place restriction triggers with end
  dates and compliance fatigue, country border policies and imported-vs-local
  cases, two-way commuting, local departure times, hub transfers, testing
  capacity, peak and cost lines, Monte-Carlo intervals, a random-seed box and
  JSON/CSV export. Random streams are now per run, so seeded results differ
  once from earlier builds.

- The tracked-aircraft descriptor now publishes `verticalRateMps`, on both the
  civil and military layers, so a consumer reading `getTrackedInfo()` no longer
  has to reach past it into the raw poll record for climb/descent. Reported,
  never derived: an aircraft that has not transmitted a rate reads as `null`
  rather than a level-flight `0`.

- Local FM seek finds stations after wrapping around 87.5–108 MHz, covers both
  band edges, skips the starting station and rejects spectra from an earlier
  tune (Aditya, @Rohilalala, #1174).
- Local RTL-SDR keeps USB reads queued in order and bounds pending decoder
  work. A stalled or overloaded decoder stops with an explicit error; stopping
  terminates its worker and rejects late audio. FM playback buffers short
  scheduling gaps, caps its audio queue at 256 ms, and reduces display updates
  and spectrum calculations while listening.

- Add Bogotá (Tembici, 250 stations) and Santiago de Chile (Bike Itaú, 200
  stations) to the GBFS bikeshare registry, the layer's first stations in
  Colombia and Chile. Both are PBSC feeds like the Brazilian Bike Itaú cities,
  so no proxy change is needed. Both feeds also list depot stations on other
  continents (São Paulo, Madrid) as in service; stations outside a city's load
  radius are now dropped instead of drawn as live docks.

- Add Barcelona's bike share to the GBFS registry: Bicing (543 stations, the
  city's PBSC system) and AMBici (237 e-bike stations across the metropolitan
  area, run by nextbike). Both are keyless GBFS 2.3 feeds listed in
  MobilityData's systems catalogue; AMBici's is CC0. `gbfs.nextbike.net` joins
  the proxy allowlist. These are the layer's first stations in Spain.

- Add nine Ontario transit feeds: TTC, MiWay, Hamilton HSR, Durham Region,
  YRT/Viva, Guelph, Burlington, Barrie and Kingston, each carrying its own
  licence quote and attribution. A feed can now name its own modes, so Toronto's
  trams read "Streetcar" while Helsinki's stay "Tram", and a feed whose route ids
  are internal keys can translate them to the number a rider would say. TTC
  vehicles take their mode from the fleet number first, so replacement buses on
  streetcar routes read as buses and out-of-service streetcars stay streetcars.

- CCTV cameras with identified hardware show the model's datasheet specs. When a
  source names a camera model found in the vendored CCTV Camera Database records
  (CC0), the HUD meta line adds its resolution, night vision and PTZ capability.
  A fixed single-lens model's horizontal FOV fills in when the source states no
  FOV and the pose is not curated (`FOV n° (DATASHEET)`); a PTZ or varifocal
  range is what the lens can do, not its current zoom, so those cameras keep the
  estimate and show `SPEC FOV min–max° (CAPABILITY)` beside it (bassem chagra,
  #452).

- Ship a web app manifest and raster home-screen icons, so adding the app to a
  phone home screen or installing it on desktop uses the God's Eye View mark
  instead of a blank tile. The icons are generated from `public/logo.svg` by
  `node scripts/generate-icons.mjs` and committed, so a plain `vite build` needs
  no image toolchain. The existing SVG favicon still serves the browser tab.
  Manifest paths are relative to the manifest, so a build served under a path
  prefix installs and launches inside that prefix.

- Cyclone advisories no longer go dark while NHC publishes an advisory ahead
  of its nominal time: advisory and position times up to 90 minutes ahead of
  the server clock are accepted (previously 5 minutes), so the whole feed is
  not rejected for about half an hour each advisory cycle.

- Flights age out vanished aircraft again. OpenSky's routine position-less rows
  no longer mark every snapshot partial, which had kept vanished and landed
  aircraft at full opacity for up to five minutes; those rows retain only their
  own aircraft, and a likely-landed one still leaves on the landed limit.

- Refuse still-image cameras on the CCTV media relay. `/api/cctv/media` is the
  live-feed route, but it also relayed any registered still camera through an
  ordinary fetch that followed redirects to any host, passed through whatever
  content type came back and had no cap on the body, bypassing every protection
  `/api/cctv/frame` applies to the same URL. Only HLS, MP4, WebM and MJPEG
  feeds are relayed now; a still camera, or an unknown id, gets a JSON 404
  without an upstream request and is served only through `/api/cctv/frame`.
  The client already loaded stills through `/frame`, so nothing it requests
  changes.

- Stop one retired bikeshare feed from reporting the whole layer as failed.
  City feeds are fetched independently, but failure was recorded in a single
  flag that only a successful _activation_ cleared — and an already-loaded city
  never activates again. A dead feed re-entering camera range therefore latched
  LOAD FAILED permanently over a map still drawing every other city's stations.
  Failure is now tracked per city: a city that fails beside others still
  drawing marks the layer DEGRADED, polls that all fail over previously drawn
  points read STALE without advancing freshness, and LOAD FAILED is reported
  only when nothing is left to draw. A city that recovers clears its own
  failure, a failure is dropped once its city leaves range or the camera rises
  above the activation altitude, and late results from superseded requests are
  ignored.

  Repointed the three feeds whose operators had moved: Reddy Bikeshare (Buffalo)
  to Social Bicycles, Tugo (Tucson) and Trinity Metro (Fort Worth) to PBSC.
  Dropped CoGo (Columbus) and Broward B-cycle (Fort Lauderdale), whose systems
  have wound down — CoGo's feed reports no stations and last moved a bike in
  March 2025. The three repointed feeds were verified live.

- Add seven Brazilian Bike Itaú (Tembici) cities to the GBFS bikeshare registry:
  São Paulo, Rio de Janeiro, Salvador, Recife, Porto Alegre, Brasília and
  Curitiba (about 1,000 stations in total). These are the layer's first stations
  in South America.

- Add Bike Share Toronto (1,069 stations) to the bikeshare registry. The system
  publishes the same PBSC GBFS v2 feeds as the Austin, Honolulu and Chattanooga
  entries, so it needs no new plumbing; a registry test now holds every city's
  feed URLs against the proxy host and path allowlists, so a city the proxy
  would refuse fails the suite instead of rendering an empty layer.

- GBFS v3 station names use English translations when available, then the first
  usable translation or short name. Empty or malformed names no longer appear as
  `[object Object]` or interrupt station loading; legacy string names remain
  supported in the globe and bike-share tools. Thanks to
  [Kristóf Kékesi](https://github.com/KristofKekesi) (#61).

- Overpass and military-installation disk caches no longer serve answers from a
  previously configured `OVERPASS_UPSTREAMS` instance after it is repointed.

- A Radio Browser mirror answering 204, 205 or 304, or a status outside
  200–599, no longer crashes the local dev/preview server. Null-body statuses
  get an empty body; anything else that cannot become a response fails that
  mirror so the next one is tried.

- Snow flakes sway within a fixed range instead of drifting sideways faster the
  longer the app runs; the Wind setting still scales the sway.

- The right rail ignores panels that other CSS hides, such as during an event
  view, so they no longer force one-panel-at-a-time layout or collapse visible
  panels. Panels the rail collapses itself are still restored.

- Coordinate searches refuse empty latitude or longitude components instead of navigating to an unintended location.

- Bing Aerial and Bing Labels request HTTPS tiles on HTTP localhost through
  their ion-backed providers, retaining ion and per-tile attribution without
  widening the Content Security Policy.

- Add New York City traffic cameras from the NYC DOT Traffic Management Center
  as an opt-in CCTV pack. NYC DOT requires a data-sharing agreement for the
  camera feed, so the pack is off unless `CCTV_NYC_ENABLED=1` is set by an
  operator who holds one; otherwise no request reaches NYC DOT. NYC DOT's
  requested disclaimer is in the Data attribution popover. The camera list is one keyless JSON request to
  `webcams.nyctmc.org/api/cameras`; frames are stills synthesized from each
  camera UUID on that same host, so a catalog field cannot steer the proxy
  off-host. Offline cameras are dropped. Once enabled, the 250 cameras nearest
  the five borough cores load and `CCTV_NYC_MAX_SOURCES` changes the cap. The catalog-wide ceiling is
  unchanged; extra cameras share it round-robin with the other packs.

- Spanish interface (`es`), translated by @meirm (#602) and reviewed against the
  current English.

- Interface localization, starting with Russian. UI text is marked with
  `t()`, `tn()` (plurals) and `msg()` in code and `data-i18n*` in markup, keyed
  by the English text itself; each language is one flat JSON catalog
  (`src/i18n/locales/ru.json`). The language comes from `?lang=`, the language
  picker (the globe button in the bottom-right corner), then the browser
  language; English stays the default and the fallback. `npm run i18n`, also
  run by `npm test`, fails on missing, unused or broken translations. Built on
  the i18n foundation by @meirm (#601), with the Russian catalog started
  from #312. It also fails on UI text that is not marked at all.
- Street Level counts unique tiles before ranking so overlapping dateline halves
  in polar views do not waste slots in the 16-tile overview budget.

- Directions no longer shows a truncation notice for a route with exactly 200
  turns, and a roundabout at the 200th turn keeps its exit distance.

- Weather records keep missing conditions unknown and refuse summaries without a measured temperature.

- Tool string length validation counts Unicode characters correctly, including characters outside the basic multilingual plane.

- Director timeline seeks cross the dateline along the short longitude arc.

- Keep unknown GBFS availability counts neutral instead of turning null or empty
  values into zero bikes.

- Recent Imagery continues past malformed records in full catalog pages, respects the requested record limit, and reports results as truncated when that limit drops valid records.

- Regional articles retain unknown publication times when compact source dates do not identify a real calendar instant.

- Add Detroit (MoGo), Pittsburgh (POGOH), Aspen (WE-cycle) and Kona & Hilo
  (HIBike) to the GBFS bikeshare registry, the layer's first stations in
  Michigan.

- Treat explicitly current, complete empty vessel coverage as a successful update,
  clearing obsolete contacts while retaining stale or incomplete snapshots.

- Custom Street Level provider switches survive share links and stored state
  using URL-safe stable provider IDs and a shared boolean-switch codec; existing
  Mapillary links keep their meaning. Explicit provider toggles reach durable
  state without adopting unrelated live switch changes.

- Directions and Recent Imagery accept replaceable acquisition sources, including
  route transport, imagery catalog, thumbnails, tile templates and attribution.
  Explicitly removing either source leaves its layer unavailable; standalone
  defaults preserve the existing providers.

- Catalog source availability no longer modifies layer objects; unavailable
  tooltips use layer display names.

- Street Level with no providers uses the shared unavailable state and refuses
  activation before initialization, while keeping its layer identity visible.

- Application source configuration accepts replacements and explicit removal.
  Missing catalog feeds leave their layers unavailable without blocking startup
  or making fallback requests; malformed supplied feeds remain configuration errors.

- Street Level providers are optional in application composition. Omitting a
  Mapillary source no longer prevents startup; callers can inject a different
  provider list or an empty list without changing layer identities or share links.

- Vector tile sources take their allowed tile origin from the configured
  `tileJsonUrl`, so repointing only that URL at a mirror loads tiles from the
  mirror or fails visibly instead of silently using OpenFreeMap. Thanks to
  [daikaginza](https://github.com/daikaginza) (#935).

- MCP setup examples use the app's default port, `4173`. Thanks to
  [Huanyi Xie](https://github.com/xiehuanyi) (#934) and
  [shirunjies8-png](https://github.com/shirunjies8-png) (#959) for the same fix.

- Voice revisits numbered analyst records through current layer snapshots and
  preserves resolved pin coordinates. Requested analyst lists and rankings can
  speak returned items alongside the exact count and coverage caveats. Failed
  actions settle the voice card without reviving cancelled turns. Coverage
  benchmarks reject invalid calls before accepting semantic matches.

- Street Level is included in the voice layer manifest for visibility toggles;
  imagery is not exposed as countable analyst records.

- Voice debug logs omit complete tool-result bodies and serialized function
  outputs by default, including location queries and generated spoken replies.
  `GEV_VOICE_LOG_CONTENT=1` retains them for explicit content debugging.

- Unqualified Alps searches use the bundled European range for navigation
  and annotations instead of a same-named peak returned by a geocoder.
  Coordinates, supplied presets and geographically qualified place names
  keep their precedence; annotation proximity and containment guards remain.
- Contacts analyst follow-ups retain the snapshot's distance ranking rather
  than switching to the camera. Requested radii and explicit scopes remain
  authoritative, and a request for a list still requires an analyst query.
  Analyst speech names stale or degraded feeds and withholds authoritative
  counts when unavailable. The existing NOTES disclosure preserves complete,
  deduplicated coverage and source caveats, including crowded results.
- The voice card shows analyst counts ("At least 250,000 aircraft …") with
  their scope, feed window and caveats, and marks partial answers. Analyst
  speech uses the same deterministic headline, preserves lower bounds and says
  when an answer is partial. Follow-ups retain unanswered-layer coverage, and
  keep the original scope label when they narrow a remembered result.
  Contacts-window answers read one immutable panel snapshot, mark a 20,000-row
  layer cap as a lower bound, and commit that displayed cohort only after
  cancellation checks pass. Concurrent analyst calls from one model response
  remain independent; a stopped or replaced user turn still cancels them.
- Voice answers are shorter and fill slow work instead of going silent. Slow
  or multi-step requests may open with one short spoken plan; instant ones
  just happen. Tool results carry a code-built `say` line and a `display`
  card: sources and notes stay on screen, a caveat is spoken only when it
  changes the answer, and "at least" and partial answers are always said. A card above the mic shows captions, the plan's steps and the
  result. When a tool that reports steps (layers, place lookups, outlines,
  nearest-aircraft) is still running after 1.5 s its current step is spoken
  once; others say "still working" once after 8 s. A soft
  tick plays in push-to-talk. Holding Space while the assistant talks cuts it
  off. Each turn writes latency and speech figures to the debug log
  (`node scripts/voice-turn-spans.mjs`). Captions of what you say are
  counted in the voice cost meter; the debug log leaves out what was said
  unless `GEV_VOICE_LOG_CONTENT=1`.
- Point and ask: hold Space with the cursor on an aircraft, ship or spot on
  the map and say "what's that", "track that one" or "how many flights
  around here". A reticle marks the point and the voice card shows what
  "this" meant. In open mic it works when you have just moved the cursor
  there. "The second one" picks from the last numbered list. Asking about
  "the last one" resolves to the last of the five rows actually shown, and
  referent-only tracking calls are accepted while empty targets are rejected.
  Asking about
  bare ground up close gives the assistant a small crop of the map around the
  point. A slow render gets one bounded second frame request, while hidden,
  stale, moved-camera, invalid and oversized captures still fail closed.

## [Unreleased]

- The dev server stays up on its own. `npm run dev` now runs a supervisor
  (`scripts/dev-server.mjs`) that starts Vite as a child, relaunches it after a
  crash, a hang or a restart that never came back, and writes every exit with
  its code, signal and uptime to `.gev-logs/dev-server.log`. It stops cleanly
  on `q`, Ctrl+C, when another dev server of the same checkout takes over, or
  after ten launches in a row died inside a minute. On a classic Windows
  console it turns QuickEdit off for the session, so a click in the window no
  longer freezes the server (`GEV_DEV_KEEP_QUICKEDIT=1` leaves it alone).
  `/__gev/health` answers with the pid, uptime, memory, live handles, restart
  count, listener and AIS store sizes; the supervisor probes it and restarts a
  server that stops answering for about 70 s (`GEV_DEV_HANG_RESTART=0` turns
  that off). Each in-process restart leaves its old modules in memory, so once
  `/__gev/health` reports 30 restarts and 2 GB resident the supervisor
  relaunches the server right after a good probe (`GEV_DEV_RECYCLE=0` turns
  that off). An uncaught exception that is a dropped socket is logged and
  survived; anything else exits 70 for a relaunch. A restart that is not
  listening 30 s later exits 75 for the same reason. Port 4173 is now strict:
  a busy port fails the start instead of silently moving to 4174 (`PORT=`
  chooses another). Provider caches, logs, builds, QA captures, Ultra media
  and device recordings are no longer watched, and the caches and logs are
  never served; terrain and aircraft caches survive restarts without stacking
  timers; the AIS store sweeps every 5 s instead of on every message, with the
  same rows served, and keeps a vessel's name, type, destination and IMO for a
  day so a returning vessel has them at once. The log is capped at 8 MB with
  one older generation kept (`dev-server.log.1`); each exit is one
  `[dev-server] exited code=… signal=… after …s` line followed by what the
  supervisor decided. The launcher chain the server watches is now always
  printed at start, so `GEV_DEV_WATCH_DEBUG=1` is no longer needed.
  `npm run dev:raw` is the old direct Vite command.

- Voice controls the whole program. Two new tools, use_ui_control and
  list_ui_controls, press any button, choose any menu option, tick, move a
  slider or fill a field by its on-screen label, in every box, opening a closed
  box first. Buttons that delete, clear, reset, send, post or share ask for a
  spoken yes; key and password fields are never filled by voice; the mic
  button itself stays out of reach. Open and close now reach the Ask, Street
  Level, Ultra, Social Media, Outbreak and sea temperature boxes too.

- ChatGPT sign-in for voice now starts on Windows. USE CHATGPT OAUTH ran plain
  `codex`, which Windows only has as an npm `codex.cmd` shim that Node will not
  start without a shell. The button now runs Codex's own `codex.exe`, or the
  shim's `codex.js` with Node, always by full path and with no console
  window. `CODEX_BIN` on Windows must be a full path.

- Add a keyless Air quality layer to the Weather group, with Environment and
  Climate Change Canada's AQHI as the first registered provider. Readings carry
  `{ provider, scale, value, band }` so another network can be added without
  inventing a shared numeric meaning across indices that do not share one; the
  row and readout both state that coverage is Canada only. The WEATHER card
  shows the band legend and the highest readings currently in view. AQHI is
  reported as an integer from 1 with an open-ended "10+", so readings round to
  that published form rather than the decimal precision the API returns.
  Readings older than six hours are dropped, and the layer reports `stale`
  through `getStats()` (also when every observation was dropped) so feed
  provenance cannot describe an aged feed as live. Voice can switch it on and
  query readings by value, band, station and observation time.

- Bound six upstream body reads (FIRMS CSV, CelesTrak TLE groups, adsb.lol
  `/v2/mil`, TomTom flow tiles, OpenSky `states/all` and adsbdb lookups) with
  streaming size caps that cancel the body at the cap or the route's deadline;
  the adsb.lol military poll gains a deadline of its own. An oversized OpenSky
  snapshot is not retried, and an OpenSky 429 starts its cooldown before the
  body is read.

- Keep later satellites when a TLE catalog entry is missing an orbital line.
  The parser skips the incomplete set and resumes at the next complete named
  set, instead of losing the rest of the group (#906).

- Satellite clouds keep Clouds only / Full as quick endpoints and add a continuous
  cloud-filter slider: 0% is Full, 100% is the existing brightness key, and
  intermediate values blend the keyed alpha. The slider commits on release to
  avoid restaging imagery for every drag event. Filter percentages round-trip in
  share links; legacy mode codes retain their old endpoint meanings. Background
  panel refreshes preserve the pending drag value until release. Contributed by
  [NotProniss](https://github.com/NotProniss) (#1084).

- Street Level: Panoramax is the fourth provider, keyless. Light its chip
  (orange; off by default, one provider at a time): from orbit dots show
  where the federated commons has pictures, and below about 60 km its
  sequences draw as lines from `api.panoramax.xyz` vector tiles. A click on a
  line opens that sequence's picture nearest the click without moving the
  camera, flat or 360°, with cones along the sequence around it and ‹ › /
  ← → following the picture's own links. The 360° and since filters apply,
  in the lines and in the lookup. The caption names each picture's author
  and licence (CC BY-SA 4.0, Licence Ouverte 2.0…) and links to it in the
  Panoramax viewer. HD originals load once, only when the viewer is wider
  than the 2,048 px version (a panorama: expanded), and every download stops
  when the photo changes; an image whose header declares more than 64 MP is
  refused before it decodes. Share links carry it as
  `0.m.0_0.r.google-0*kartaview-0*panoramax-1` (`0.m.0_0.r.panoramax-1` works
  too). KartaView's photo viewer
  is now shared (`photoViewer.js`, `panorama.js`); in it, for KartaView too,
  Esc clears the selected drive before it collapses the panel. Lines are
  simplified and drawn within a point budget (a tile's unsimplified lines
  over Paris hung the tab), decoded in slices so the globe keeps moving,
  and kept; the cones' tiles have their own connection, and the open
  picture's tile draws its cones before its neighbours arrive.

- Flights and Military Flights highlight emergency transponder broadcasts in
  fleet billboards, 3D models and Cockpit contacts. Colors update when a status
  starts or clears. Emergency squawks outrank ADS-B priority statuses; GEV
  reports minimum fuel and lifeguard without red tint. Cockpit names the code
  or ADS-B status, and analyst/voice results retain broadcast provenance and
  the latest known contact time. One omitted ADS-B status poll during a source
  switch may retain the previous status if the squawk is unchanged; an explicit
  clear takes effect immediately. Broadcasts are not confirmed incidents.
  Contributed by [Leo Pechnicki](https://github.com/leopechnicki) (#856).

- Street Level: KartaView is the third provider, keyless. Light its chip
  (purple; off by default, one provider at a time) and zoom in below about
  6 km: the lines are the streets KartaView has photos of (z13–14 tiles from
  `api.kartaview.org`). A click on a line opens the photo nearest the click
  without moving the camera, flat or 360° (a small WebGL panorama: drag to
  look, wheel to zoom), with cones along its drive and ‹ › / ← → to step
  through it. The caption links to the full-size photo (KartaView's photo
  pages fail for signed-out visitors), and the globe credits "© KartaView
  contributors, CC BY-SA 4.0". Share links carry it in the provider
  switches (`0.m.0_0.r.google-0*kartaview-1`). Archived photos (KartaView
  answers 409) are skipped by the click and by ‹ ›. Shift+← →, ↑ ↓, + − and
  pinch look around a 360° photo. The open photo's marker is a purple view
  cone pointing along the drive (KartaView's own compass headings are often
  0 or far off). The IMAGERY (ALL / 360° / FLAT) and SINCE filters apply to
  KartaView as to Mapillary: its lines are filtered by KartaView's own
  server (its filtered PNG tiles, as a mask over the JSON lines), and the
  photo a click opens, and the cones, by each photo's projection and upload
  date. KartaView's SINCE is the upload date (all its server can filter by);
  a note under the slider says so while KartaView is lit (`sinceBasis:
'upload'` in the provider contract).
  Mapillary's line coverage and sequence cones are now shared by both
  (`lineCoverage.js`, `sequenceCones.js`).

- Street Level: Google Street View is the second provider. On the Google 3D
  map (Google's terms keep it off other maps), light its chip (off by
  default: every panorama is billed to the Google Maps key, which needs the
  Maps JavaScript API) and click a street, or press OPEN STREET VIEW, to
  open Google's own panorama in
  the panel, with its arrows, the address and month in the caption, a link
  to Google Maps and FOLLOW. Share links carry it in the provider switches
  (`r.google-1`). One provider is lit at a time (lighting one switches the
  other off), Mapillary by default since it is free. Street View's panoramas
  are all 360°, so the IMAGERY and SINCE filters and the legend apply to
  Mapillary only and hide while GOOGLE STREET VIEW is lit; its globe marker
  is a Google-blue view cone.

- Add an experimental ChatGPT/Codex OAuth option for cloud voice in Provider
  Settings. API-key voice remains the default. Local sign-in can start from
  the auth button and reports completion, failure, timeout, or expired
  credentials. OAuth credentials stay on the server; local routes require
  loopback access and same-site requests. OAuth sessions retain usage data
  and show unknown cost; caption transcriptions are counted rather than
  priced into the API-key cap. The auth button keeps keyboard focus after a
  mode change, and pending sign-in does not discard text in the key fields.
  Thanks to [Shayan Khan](https://github.com/devv-shayan) for #621 and
  [TheSmokeDev](https://github.com/TheSmokeDev) for the credential handling
  from #653.
- GROK BOT SWARM now sends from GEVC and writes the answers in GEVC. Social
  Media GROK BOT SWARM, Outbreak SOCIAL SEARCH (Grok Bot), and the new Ultra
  GROK BOT SWARM button each POST seven bots on `GROK_BOT_API_KEY` and put
  every report in that panel's log. Without that key, POWER UP → GROK BOT —
  COMPUTER (`GROK_BOT_GATEWAY_URL` and `GROK_BOT_GATEWAY_TOKEN`, usually
  `http://127.0.0.1:1340`) sends the same sweep to a bot on your Grok Bot
  computer and writes its report in the panel. Without a key or a computer
  the press copies the Chief of Staff task, opens Grok Bot, and keeps the
  task in the log. The press does not POST the Chief of Staff webhook.
  OPEN GROK BOT stays a manual opener.

- **Docker install path.** `docker compose up` builds on CI's Node 24.14.0 image,
  pinned by digest, and serves the app on `http://localhost:4173` with no local
  Node install. The repo is bind-mounted and the container runs as the host user
  (never root), so `.env`,
  `.gev-cache`, and `.gev-logs` persist on the host exactly as they do under
  `npm run dev` — Provider Settings included. The launcher
  (`scripts/docker-start.mjs`) trusts the container's gateway address for that
  panel, since that is where Docker delivers the host's own browser from; the
  opt-in behind it, `GEV_KEY_SETUP_TRUSTED_PEERS`, takes exact addresses only
  and is unset (so loopback-only, unchanged) under every other launcher.
  Thanks to [jklaze](https://github.com/jklaze) for finding and diagnosing the
  container-to-host 403, and to [14traits](https://github.com/14traits),
  [PoBruno](https://github.com/PoBruno) and [milu70hub](https://github.com/milu70hub)
  for testing on Apple silicon, Docker Engine on Linux, and NAS hosts.

- Stdio servers from one install share a panel key so a page read from one
  process can make requests through another. Concurrent malformed-key repairs
  now select one winner; unavailable storage or a busy repair retains the
  logged per-process fallback. Thanks to [Jibran Tahir](https://github.com/jibraaan)
  for #958, [MarvinNL046](https://github.com/MarvinNL046) for the report and
  proposed diagnosis in #927, and [kvnloo](https://github.com/kvnloo) for identifying
  the repair race. Windows/Claude Desktop Cowork confirmation remains outstanding.

- Street Level: a street-level imagery layer modelled on the iD editor's photo
  overlay, with Mapillary as its first provider (free client token, CC BY-SA 4.0
  imagery). One right-rail panel holds a chip per provider, shared 360°/flat and
  captured-since filters, and an embedded viewer with EXPAND, FIT/FILL and
  FOLLOW (Google 3D only). Coverage lines and image cones are drawn from orbit
  down to a single street; on Google 3D they sit on the bare earth, refined
  against the rendered mesh near the camera, so trees and buildings hide them.
  Share links carry the provider switches, the filters and the panel's collapsed
  state. A server proxy caches Mapillary coverage tiles (24 h, 1 GiB on disk),
  refuses cross-site requests, rate-limits per IP and backs off when Mapillary
  rejects the token or rate-limits.

- The CCTV and Street Level panels are portable: drag the header to float the
  panel, resize it from any edge or corner, and double-click the header to dock
  it again. The position persists across reloads.

- Add Norway's city bikes to the Bike Share layer: Oslo, Bergen and
  Trondheim Bysykkel (Urban Sharing), Kolumbus Bysykkel in Stavanger and
  Farte Bysykkel in Skien/Porsgrunn (Entur Mobility), and Bysykkel
  Lillestrøm (JCDecaux), about 760 stations in all. Every feed is keyless
  GBFS. `gbfs.urbansharing.com`, `api.entur.io` and `api.cyclocity.fr` join
  the proxy allowlist; the last two are kept to their GBFS paths. The proxy
  now sends `Client-Identifier: gods-eye-view` on every request and
  `ET-Client-Name: gods-eye-view-bikeshare` to Entur, as the operators ask,
  and accepts Entur's extensionless feed paths. Attributed under NLOD and
  Licence Ouverte. `get_bike_share` covers the six systems too.

- Add Norway's road cameras from Statens vegvesen as a CCTV pack. The camera
  list is one keyless GeoJSON request to the agency's OGC API view of its
  DATEX 3.1 CCTV table, so no DATEX account is needed. Every working camera
  loads (~850; faulty ones are dropped) under one "Norway" category, and the
  ~135 working cameras that publish HLS play as live video through the existing in-memory
  relay with the still as fallback. Frames and manifests are pinned to each
  camera's own path on the agency hosts. `CCTV_VEGVESEN_ENABLED=0` disables
  the pack, `CCTV_VEGVESEN_MAX_SOURCES` caps it (keeping cameras nearest the
  largest cities) and `CCTV_VEGVESEN_VIDEO=0` keeps stills only. Attributed
  under NLOD 2.0.

- Import your own GeoJSON, KML, KMZ and GPX files from DISPLAY or by dropping
  them onto the app. Show, hide, fly to or remove each file for the session.
  GeoJSON/GPX draw on the ground; KML retains its styles and explicit heights.
  Large repeated-style exports use shared local pins, while recorded track
  vertices and segment gaps stay intact. Imports respect newer camera gestures,
  leave the shared clock alone, and report malformed or oversized files.
  File bytes stay on the device; rendered overlays may appear in shared map
  screenshots. Thanks to [Chase Mills](https://github.com/kapturner) (#925).

- GNSS Integrity (Events, voice-addressable, share token `3`) draws navigation
  accuracy scores from a keyless regional adsb.lol sample; aircraft-level analyst
  queries are unavailable for these aggregate cells. Cells do not intercept
  map clicks. Pan/zoom refreshes automatically; feed failures retain the display
  and explain the next retry. Aircraft-reported quality includes MLAT-positioned
  contacts after GPS loss, excludes TIS-B/MLAT-derived quality, and locates GPS-loss
  evidence at the last good GNSS position when available. Scores discount one
  bad aircraft per cell and retain 30 minutes of visited-view evidence; they
  do not confirm jamming. See [method and limits](DATA_SOURCES.md#gnss-integrity).
  Contributed by [Leo Pechnicki](https://github.com/leopechnicki) (#855).

## October 3, 2026

**Unlimited generic road CCTV API keys in POWER UP.** Right under the ROAD511 key, a GENERIC ROAD CCTV API KEYS section keeps any number of keys, like the Ultra packages: **+ ADD GENERIC ROAD CCTV API KEYS** opens a new entry with a name, the camera site it is for (for example `511ny.org`; an address is cut to its host), the address parameter that carries it (`key` unless the site names another) and the key itself, in a masked box. Each saved key shows only its last four characters, can be replaced in place or removed, and lives in `config/road-cctv-keys.json`, which is git-ignored and written owner-only. When the CCTV layer asks that site, or one of its subdomains, for a still or a stream over https, the key rides along as that parameter. It never goes to another site, never over plain http, and never overrides a parameter the address already has. The route that keeps them answers only this computer's own page.

**HELP DELIVERY for the gig and delivery platforms.** A new section in the Social Media box chooses the help item to be delivered: Medicine (up to two medications), Transportation (from the current location to Home or to Hospital), Food, Liquid or Items (up to two types each, for example a heart defibrillator). SAVE MY DEFAULT keeps the choice as this computer's own default, in this browser only, and fills the form with it next time, so every GEVC user sets their own. Nothing is sent: sending HELP through the delivery and gig platforms is under development, and the section says so.

**API keys and Power Ups in the Social Media box.** Each platform with a public developer API takes an API key beside its user id and password: Facebook (Graph API), Instagram, Threads, X (X API v2), TikTok, Uber (Uber Developers) and Lyft (Lyft Concierge API). Truth Social publishes no API, so it takes a login only. SAVE LOGIN stores what is typed, a login, an API key or both, and keeps whatever was already saved for that platform. The key is sealed with the login in the encrypted store on this computer, never listed or shown again. A button opens the saved sites: its menu picks ID & Pass (the default), API or All, and the button is named for the choice (OPEN ID & PASS SITES, OPEN API SITES, OPEN ALL SAVED SITES). A saved login opens the platform's site, and a saved key opens its developer console. At the top of the box, with no space between, sit the note "Your API Keys, User Id's and Passwords stay encrypted on this computer for integrating AI Tools", a fluorescent-green count such as "1/25 Power Ups Attained", and the heading. The count gives each platform with anything saved one Power Up, even when it has both a login and a key. The location note adds "If allowed by 3rd Party.", and the "Enter looks up public news…" note is gone.

- Live HLS cameras play on a page opened over plain HTTP from another machine
  (`HOST=0.0.0.0`). The client lease id came from `crypto.randomUUID`, which
  browsers only expose in secure contexts, so starting a live feed threw
  before playback. The id now falls back to a v4 UUID built from
  `crypto.getRandomValues`, which the server's lease check accepts.

- Move Google geocoding behind the local server. Forward and reverse lookups now
  go through `/api/google/geocode` and `/api/google/reverse-geocode` with the
  server key, joining Places and Street View. Google's Geocoding web service
  refuses referrer-restricted keys, so the previous browser call left
  `SECURITY.md`'s advice and working search mutually exclusive: the bundled
  browser key had to be unrestricted for search to work at all. That key now
  needs only the Map Tiles API and the Maps JavaScript API (Street View). Keyless sessions and the Photon/Nominatim
  fallback order are unchanged.

## [0.2.1] — 2026-10-02 — God's Eye View through Your Agent (with security fixes and other features)

- Ship each bundled data pack once. The region, marine, admin-boundary,
  county, military-name and neighborhood packs were emitted twice by the
  production build, as the JSON the browser fetches and as an unused
  JavaScript copy; `dist/` drops from 54 MB to 42 MB. Under Node the loader
  reads the JSON file directly (reporting that Node 24.14 or newer is needed
  on a runtime too old to do so), and a test keeps app code from importing a
  pack as a module.

- Apply the Host check before the app's own routes. Vite installs its Host
  check after the middleware that plugins add, so the provider and `/api`
  routes used to answer any Host, including a DNS-rebinding name, in every
  mode. A first-running middleware now applies the same allowed hosts on the
  dev and preview servers.

- Refuse cross-site browser requests to the cost-bearing and log endpoints
  (`/api/realtime/token`, `/api/openai/hud-summary`,
  `/api/google/nearby-places`, `/api/google/text-search`,
  `/api/realtime/debug-log`): a foreign or opaque
  Origin, a cross-site `Sec-Fetch-Site`, or proxy forwarding headers get 403,
  while loopback tools and LAN use keep working. The dev and preview servers
  send one shared Content-Security-Policy (James Sumpter, #242).

- The voice debug log records the server's own time: a record can no longer
  supply its `loggedAt`. The dev and preview servers also send
  `X-Content-Type-Options: nosniff` (findings by Sunil, #710).

- Keep the Host-header check when binding to all interfaces. `HOST=0.0.0.0`
  used to accept any Host; the dev and preview servers now accept IP
  addresses, `localhost` and the LAN hostnames listed in `GEV_ALLOWED_HOSTS`
  (suffix and wildcard entries are ignored), which also keeps DNS-rebinding
  names out in LAN mode. The `.local` suffix is no longer accepted by default;
  list such a name explicitly (Puspo Aditya, #97, fixes #21).

- Throttle the cost-bearing proxies by default instead of on request. The
  OpenAI endpoints (`/api/realtime/token`, `/api/openai/hud-summary`) now allow
  30 requests per minute per client IP and the Google Places endpoints
  (`/api/google/nearby-places`, `/api/google/text-search`) 120 — the caps the
  Pinokio build already ships, so the packaged app is unaffected and only an
  unconfigured server changes, from unlimited to what the product already runs
  with. `GEV_RATELIMIT_OPENAI_PER_MIN` and `GEV_RATELIMIT_GOOGLE_PER_MIN` still
  override the caps, and exactly `0` disables them; a value that cannot be read
  as a number now falls back to the default rather than to unlimited, so a typo
  cannot silently disarm the guard (daikaginza, #683).

- Tighten the local MCP server and embed mode. The panel's `panel_request`
  needs the key in its MCP server's panel page, and refuses Provider
  Settings, credential and model endpoints, `/mcp` and development server
  routes in any letter case, encoding or dot suffix; panels on one server share six
  requests in flight, and further requests wait their turn. `/mcp` applies Provider Settings' proxy and sharing checks,
  requires a Host on the port it reached and an Origin from that host, and
  times out request bodies after 30 seconds; stdio honors
  `notifications/cancelled`. Embed mode is no longer framable unless
  `GEV_EMBED_FRAME_ANCESTORS` allows the framing page, and view answers go
  only to the origin that sent the view. SECURITY.md describes the MCP surface
  and the panel's browser keys.

- Cockpit now enters on the existing matching map style while keeping one fixed,
  duplicate-free carousel over `Normal / CRT / NVG / FLIR / Anime / Noir / Snow`.
  Normal remains a real unfiltered option; Cockpit-only choices still restore
  the captured map style through both Exit Cockpit and Reset.
- Cyber's compact right-rail and Cockpit utility buttons now center their glyphs
  vertically and share the same inset and edge alignment.
- Keep Cyber Voice help/error popups and Location/Visual Presets pins clear of
  their decorative frames. Leave space above attribution for its full logo row.
- Add an intentionally future-facing, opt-in panel surface contract for new
  panels to inherit compatible Normal, Cyber and Cockpit styling. Its first
  production adopter will land separately after this change.
- Restore the user's previous visual preset when they explicitly switch from
  Cyber to another HUD layout, without overriding scene or shared-link state.
- Move the aligned Cyber side-panel rails upward on desktop so the left stack
  clears the lower coordinate card; keep Cockpit's independent visor layout.

## [0.2.0] — 2026-10-02 — God's Eye View through Your Agent

- Show God's Eye View inside AI conversations. Answers that can be shown
  include a view (camera, layers, style, map, marks, something to follow),
  and `show_in_gods_eye_view` displays it as the live globe in clients that
  support MCP Apps, such as Claude Desktop and the Codex and ChatGPT desktop
  apps, and as a link everywhere else. The panel loads the app's panel build
  (`npm run build:panel`) and its data through the MCP server, so a local
  server needs no HTTPS or tunnel. `?embed=1` shows the globe alone for pages
  that frame the app.

- Add tools for language-model clients and a local MCP server, served over
  stdio by `npm run mcp` and over HTTP at `/mcp` on the development and preview
  servers for local requests only. `npm run mcp`
  serves earthquake, active-fire, launch, aircraft, ship, satellite, camera, radio,
  place, routing, bike-share, transit, traffic, weather, cyclone, fire-perimeter,
  terrain, installation and map-feature queries, plus a situation brief, over
  stdio to clients such as Claude Code, reading
  from a running app. Tools are defined
  once in `gods-eye-view/tools`, reuse the layers' source factories, and are
  exposed through the protocol adapter in `gods-eye-view/tools/mcp`. The
  catalog also covers weather maps, wind, recent imagery, submarine cables,
  license plate reader cameras, datacenters and dams, the Bhote Koshi flood,
  military awareness and links that open the app over an area with layers on.
  Voice offers the same queries next to its app actions.

- Public Overpass instances are no longer used by default. Street Traffic
  roads come from TomTom flow tiles, OpenFreeMap vector tiles, or both, chosen
  on the layer row (TomTom / OSM / Hybrid) or with `?trafficRoads=`. With a
  TomTom key the default is Hybrid: TomTom roads with live flow, plus
  OpenFreeMap roads TomTom does not cover, simulated. Without a key every
  choice draws OpenFreeMap roads. TomTom mode shows only roads with flow; OSM
  mode matches TomTom flow onto OpenFreeMap roads for congestion colors,
  speeds and closures, and unmatched roads stay simulated. Road failures name
  OpenFreeMap and retain HTTP status or timeout reasons separately from TomTom.
  Flow coverage counts
  rendered dots on roads with flow; mapped military areas come from OpenFreeMap and
  follow settled camera changes with cached tiles and retained site entities.
  Superseded requests preserve the next view’s pending load.
  Tile and API transports can be injected independently; the optional Overpass
  ALPR adapter remains available.
  OSM-derived layers share one attribution entry and a persistent inline map credit,
  including routing, Warendorf cameras, datacenters, dams and the Nepal locator.
  Military areas use bundled Overture/OSM names; wide views show bounded,
  decluttered named points that follow camera motion while Contacts holds a subject,
  using the shared world-overlay host for wide-point and polygon titles. Polygons appear while names load; cancelled views
  cannot publish late names, and stalled name downloads can retry. Merged groups
  keep their identity and parent name when a pan hides the largest member. Late
  names reconcile ids across zooms while retaining selection and marker ownership. Wide
  named points remain visible until matching close polygons take over. Installation
  titles share datacenter/dam card arbitration and keep incumbents while panning.
  Selecting an installation replaces its label with one card; deselection restores it.
  Selected footprints receive a translucent fill draped on the active map surface.
  ALPR cameras come from an hourly OpenStreetMap extract (US and Canada). Features
  without a replacement say they are unavailable; area and footprint
  annotations check once whether an Overpass instance is configured and skip
  the query when none is. Area annotations outline countries, states and provinces
  (Natural Earth, including UK constituent countries) and US counties (US Census Bureau) from bundled data, with no
  lookup. County names are disambiguated across countries by aliases, qualifiers
  and geography. `OVERPASS_UPSTREAMS` sets an
  Overpass instance you run or pay for. The cockpit regional brief resolves
  regions from bundled Natural Earth data instead of Nominatim. Traffic starts on enable and paints
  locally grounded roads incrementally, shares concurrent tile requests and
  reuses validated heights across pans. Camera moves and arriving tiles retain
  existing traffic dots on their roads; budget changes fade in/out incrementally,
  height refinements ease vertically, and live flow changes color and speed in
  place. The traffic footprint follows the reticle square at oblique angles, with
  cached detailed near tiles and coarse distant roads. Failed detail tiles retain
  coarse roads and retry at most three times. Road-pass deadlines also cancel
  queued tile paints and terrain callbacks;
  off-screen height corrections cannot hold loading open, and visible corrections
  stay pixel-limited at canvas and camera-plane boundaries. Completed road snapshots replace
  streamed previews without duplicating roads. Unresolved previews no longer delay or suppress detailed street roads.
  Road admission excludes private, parking, walking and unknown traffic categories;
  OpenStreetMap service ways and tunnels no longer receive surface vehicles.
  Detail tiles load alongside previews, arrival bypasses the movement debounce,
  and geographically validated rendered depth avoids repeated mesh redraws.
  Traffic releases surface-frame listeners on disable/destroy and reuses unchanged
  surface identities without frame-by-frame allocations.
  Grounded dots respect building occlusion instead of drawing through roofs,
  and the traffic status chip reports completion without a delayed text animation.
  Short road chunks and local surface elevation keep the budget on visible
  streets in elevated cities. Congestion and closures respect travel
  direction. ALPR distinguishes unsupported coverage from empty results and
  asks for zoom-in before exceeding its tile budget. Installation footprints
  retain visible fragments without joining separate parcels across zooms or
  across quantization gaps between different mapped identities. Keyless
  terrain tiles retry HTTP 429 and transient gateway failures with bounded,
  shared backoff. Operator-configured Overpass area and footprint queries
  retain relation member geometry so their outlines remain available.
  Contacts filters mapped installations to a true 100 km surface radius around
  the current tracked subject,
  including in Cockpit, instead of "?" or nothing. Search arrivals frame against the resolved
  ground and lift the eye above the rendered surface, so Camp Mabry and Denver
  no longer land underground (Milan Khanal, #118). Arrival corrections yield to
  new camera owners and are cancelled on layer/app teardown. ALPR floor preparation
  and marker placement share terrain requests, cancelled when the layer is disabled.
  Map-source changes reposition every ALPR marker without replacing entities. ALPR loads
  whole-city views from z9-z12 tiles, drops native ground wedges and clamping,
  keeps frame time with ALPR on within a few percent of ALPR off, seats nearby
  badges on the rendered surface and says when no loaded camera is on screen.

- CCTV cameras whose bearing is a guess now say so. Packs mark bearings derived
  from a hash of the camera id as `headingConfidence: 'low'`, but nothing read the
  flag, so roughly 70% of a default catalog rendered like surveyed facings. The HUD
  now reads `HDG n° (ESTIMATED)` and the coverage wireframe draws dashed; manual
  calibrations and curated poses are never marked estimated (bassem chagra, #643).

- Report which upstream declined a Street Traffic road load. The layer row now
  reads `Overpass rate-limited`, `Overpass timed out`, or
  `Overpass refused the road query (HTTP 406)` instead of a general
  "Road data temporarily unavailable", so a reader is not sent to check a
  TomTom key when the public OpenStreetMap mirrors are the side that failed.
  The proxy's own 502 (every mirror unreachable) and 503 (local limiter busy)
  read `Overpass mirrors unreachable` and `Overpass temporarily unavailable`.
  Failures the layer cannot classify keep the general line (daikaginza, #665).

- Bound the client terrain-height cache at 20 000 entries with least-recently-used eviction, so a long session no longer retains every coordinate it ever resolved. Consumer reads promote their entry and a batch still reports every point it resolved (Pedro Lobato, #594).

- Release CCTV media streams whose upstream falls silent after answering. The
  15-second media deadline covered only the wait for response headers, so a
  camera that replied and then stopped sending held both the proxy connection
  and its upstream socket open for as long as the camera host allowed; the
  declared `Content-Length` ceiling was the only body bound, and a chunked or
  length-less body had none. A 30-second idle deadline now bounds the gap
  between upstream chunks and releases a body that has gone silent. It is
  rescheduled while the response is still waiting to drain, so a viewer on a
  slow link is not mistaken for a dead camera; live feeds are unaffected
  (Ethan Stoner, #688).

- Aircraft track backfill (`/api/opensky-track`, `/api/adsblol/trace`) now
  answers 502 when the upstream body exceeds the 5 MB cap, instead of a 200
  whose error body the client read as an empty track. The failure is cached
  like other upstream errors, so retries inside the 60 s window do not spend
  OpenSky credits (Raushankumar0720, #720, #722).

- Saving a key from Provider Settings works again on Macs where Nix or
  Homebrew coreutils sit ahead of `/bin` on `PATH`. The credential hardener
  now spawns Apple's `/bin/chmod -N` by absolute path; GNU `chmod` has no `-N`,
  so the ACL strip failed closed and every save was refused (Arthur Bogaart, #694).

- Render on iPad and iPhone instead of stopping with "An error occurred while
  rendering." Cesium's per-vertex model atmosphere binds shader `out`
  parameters directly to varyings, which Apple's Metal/ANGLE backend cannot
  link, so the program failed and the render loop was torn down. The stage is
  now kept out of the pipeline on affected devices by clearing
  `scene.fog.renderable`, which leaves `fog.enabled` — and the fog density that
  drives 3D Tiles refinement — untouched. Detection is a WebGL2 link probe of
  the same pattern, so a future driver fix restores the effect with no code
  change, with iOS/iPadOS detection as a backstop. Sky atmosphere and the
  ground-atmosphere fragment path route through locals and are unaffected;
  affected devices lose distance fog on 3D tiles and on the globe basemaps.
  `src/app/atmosphereCompat.test.mjs` pins the probe, the platform matrix and
  the `renderable`-not-`enabled` choice (KnottyDyes, #705).

- Make share-link layer tokens durable allocations instead of ad hoc picks.
  Existing one-character mappings are pinned permanently, while new layers use
  the next free single-character digit, then two-character base-36 tokens.
  Authors record each token in the permanent JSON ledger after running
  `npm run layer-token:next -- <layer-id>` on a rebased branch.
  `npm run layer-token:check -- --base-ref origin/main` guards published
  assignments and allocation order in
  pull-request CI. Existing v2 links keep their exact meaning.
  Malformed enabled-layer lists now reject the whole layer payload instead of
  restoring a partial list. A QA-only browser fixture exercises the future
  two-character path after a fixture-only exhausted-digit scenario, without
  reserving `00` in production.

- Region scopes in voice analyst queries ("in the Gulf of Mexico", "over
  the Alps") work again in the dev server: the bundled Natural Earth and
  neighborhood packs are fetched as JSON in the browser
  (`src/data/bundledJson.js`). When a region is not in the bundled packs, the
  geocode and admin-boundary fallback answers `region-timeout` after 3 s
  instead of holding the reply.

- Transit and Directions rows repaint as soon as their data lands again:
  `refreshLayerStats()` now lives on the layer lifecycle, not only on the
  compatibility facade. `scripts/qa-radio.mjs` uses it instead of a private
  panel method.
- On phones the title bar sits 16 px from the top so both Radio broadcast
  waves stay on-screen.
- Keep Cyber right-rail panels mutually exclusive and Display, CCTV and Context
  headers and frames fixed during content scrolling. Restore Radio's nested Context placement and compact
  player. Add Cyber Sonar voice controls with settings and effect-state readback.
  Keep keyboard-focus outlines visible inside Cyber's clipped map and cockpit
  expand/collapse buttons, with a matching red hover border.

- Add the opt-in Cyber HUD layout with coordinated map and cockpit panel
  styling. Display exposes Sonar on/off, rings, range, power, opacity and sector.
  Native point, billboard and label highlighting uses GPU draw commands; there
  is no scene-dimming effect selector. Unsupported shaders retain native contact
  rendering, and leaving Cyber restores the standard shell and contact treatment.

- Add a **Recent Imagery** data layer (NASA GIBS · HLS + VIIRS, keyless).
  Select a box (drag, the current view, or around a pin; up to 1,000 km a
  side) and the right-rail panel lists the last 30 days of Sentinel-2 /
  Landsat (30 m) and, when switched on, VIIRS daily overview imagery over it,
  with thumbnails and scene cloud. Three modes: IMAGE shows one day, VS
  BASEMAP swipes it against the map, A / B swipes two days; a SHOW or A / B
  chip on each day card pins it, arrow keys preview the focused day while a
  slot is empty, and no control moves when anything changes. While imagery is
  shown on Google 3D the map switches to Esri and comes back when it is
  cleared. Either image exports as a PNG; box, pins, mode and split travel in
  share links; the NASA acknowledgement is in the credits and
  `DATA_SOURCES.md`. The swipe is now shared with the Nepal scene
  (`src/ui/imagerySplit.js`, `src/maps/imageryComparison.js`), and
  `MapSourceController.subscribe()` reports every settled map switch.

## Unreleased — voice reaches every layer; honest analyst answers

- Voice can switch on every shipped data layer (the two scene-driven
  Bhote Koshi layers stay scene-only), including transit, Recent
  Imagery, wind, the weather layers, cyclones and mapped installations, and
  understands their spoken names ("buses", "hurricanes", "military bases").
  One voice manifest (`src/voice/layerManifest.js`) generates the tool enums
  and aliases, and a unit test fails when a new layer has no entry.
- `analyst_query` counts up to 250,000 loaded records per layer instead of the
  first 2,000, and says when a layer went past that (`complete: false`). It
  also answers over bikeshare stations, transit vehicles, rocket launches,
  cyclones, ALPR cameras, mapped installations, local ADS-B aircraft and fire perimeters; fire
  records carry their sensor (VIIRS or MODIS).
- Unknown fields, operators, units, value types, scope kinds and invalid
  centres are refused with the allowed values instead of answering zero or widening to anywhere. A
  layer that is off, still loading or unavailable is reported as such, not
  as a count of zero; a partly answerable query is marked `partial`.
  Distance sorts honour `sortDir`, a written unit such as `altitudeM(ft)`
  converts, and large rankings no longer sort the whole set.
- Results carry `lat`/`lon` for each item and a `display` object with the
  scope, the feed window (earthquakes and fires cover the last 24 h) and any
  caveat for the screen. The model is asked to answer in one short phrase.
- The weather and Recent Imagery panels can be opened by voice.

## Unreleased — local receiver feeds

### Local receiver feeds

- The Local ADS-B layer also reads local 1090 MHz and 978 MHz UAT decoder
  feeds: the `aircraft.json` that dump1090-fa, readsb, tar1090 or skyaware978
  serves. Configure them server-side with `LOCAL_RECEIVER_FEEDS`
  (`band=url`, comma-separated); there is no feed editing in the browser.
  Hosts must be loopback, RFC1918, `localhost` or `*.local`, the scheme http or
  https and the path must end in `aircraft.json`; any other entry is logged at
  startup, reported `invalid` and never fetched.
- Add `GET /api/local-receivers/aircraft`. It reads every configured feed in
  parallel (2 s timeout, redirects refused, 2 MB body cap, about 1 s of shared
  cache) and reports each feed `live`, `stale` (its own `now` is over 10 s old),
  `unreachable` or `invalid`. Unconfigured, it answers
  `{ configured: false }` and fetches nothing. Upstream error text is never
  returned.
- The layer merges browser-SDR and feed aircraft by ICAO, keeping the newest
  position, polls the route every second only while it is enabled, and remembers
  which bands and sources heard each aircraft in the last 60 s. The click card
  names them (for example "Heard by your receiver · 978 MHz UAT · decoder
  feed"); aircraft heard only on 978 MHz carry a thin ring. The row status
  covers both inputs ("2 feeds live · 14 heard", "feed 978 unreachable"), and
  the Local RTL-SDR card shows a read-only decoder-feed line.
- While any input is producing aircraft (the browser receiver streaming, or a
  feed live), the Local ADS-B row stays ON and lists feeds that are not live as
  a trailing note ("3 heard · USB 5.8 msg/s · feed 1090 stale") instead of
  showing DEGRADED.
- Records carry `band` (`1090`/`978`) and `source` (`webusb`/`feed`).
- See `docs/LOCAL-RECEIVERS.md`.

### Local RTL-SDR and Local ADS-B

- Add a Local RTL-SDR card to the Radio panel. It connects a USB RTL-SDR in
  desktop Chrome or Edge through WebUSB and receives broadcast FM (tune, seek,
  volume) or 1090 MHz ADS-B. Local FM and internet-radio playback never play
  together: starting one stops the other.
- Add a gain control: AUTO or a manual R820T step, remembered per mode. ADS-B
  defaults to 28.0 dB (the earlier 20.7 dB gave about 1 msg/s against about 9
  at 28.0 dB on the same antenna; a stored choice still wins), FM to AUTO;
  changes apply without reconnecting. In
  ADS-B mode the card shows CRC-valid messages per second, aircraft heard,
  aircraft positioned and the IQ level.
- Prefer the ADS-B/1090 MHz channel of a dual-channel receiver, remember an
  explicitly chosen device per mode, and add CHANGE DEVICE to reopen the
  WebUSB picker.
- Add the Local ADS-B layer (`local-adsb`, off by default, not part of share
  links). Aircraft heard by the receiver draw in magenta beside public Flights;
  a marker drops when its position is 60 s old and the aircraft is forgotten
  after 60 s without a message. Clicking one opens a card; markers are not
  camera-followed. Voice `set_layer_visibility` accepts `local-adsb`.
- Normalize local ADS-B into one record shape, with a pure adapter for
  dump1090/readsb `aircraft.json` documents.
- Add `@jtarrio/webrtlsdr` and `@jtarrio/signals` (Apache-2.0); see
  `THIRD_PARTY_NOTICES.md`.

### Weather review

- On 3D Tiles, draw a 4096×2048 detail window around the view on each
  observed-weather shell except global infrared, sampled by the shell's own
  surface. It follows the view on camera move end, keeps its place while the
  view stays near its centre, and hides until its image is ready after a move;
  an older frame's detail stays over at most one newer frame. The image proxy
  accepts a 2:1 `bbox` inside the product bounds, rounded to 0.25°.
  Lightning's whole-extent image is now 4096×2048; each shell caches up to
  128 MiB of decoded images.

- On 3D Tiles, show observed weather and the wind color field as raised,
  translucent shells (5.0–6.6 km, lightning highest) with one full-extent image
  per frame instead of draping onto tiles; they show at any camera height.
  Globe hosts are unchanged. The weather image proxy serves every product
  (radar and regional infrared up to 4096×2048, lightning and global infrared
  up to 2048×1024) with a size parameter and a 16 MiB cap. Accept bounded tile
  sizes in the proxy with separate immutable cache entries.

- Cache exact-time weather images and tiles for 24 hours. Retain up to 6 decoded
  global mosaics per renderer and warm the next observation during playback;
  tile prefetch is bounded to eight requests and cancels when suspended.

- Move weather times, coverage, legends and cyclone advisory details into keyed
  right-rail cards; left rows keep status and configuration. Use one native
  observed-history timeline with local preview and coalesced drag commits.
- Add reusable rail card and timeline components. Keep panel collapse, count,
  hidden-empty behavior and first-appearance expansion.
- Show wind unit controls beside speed legends and inside inspection readings;
  changing units preserves the sampled location and open reading.
- Name satellite imagery Satellite clouds, with Clouds only / Full image modes
  and explicit regional coverage. Existing share parameters are unchanged.

- Share one observed history clock across radar, infrared and lightning. Step
  through their union timeline with bounded nearest-at-or-before selection;
  hide products without an eligible frame. Latest uses each product's newest
  observation; playback waits for all frame loads to settle before advancing.
- Label wind as a forecast that does not follow observed history. Keep history
  transient and product readouts synchronized.

- Keep Google 3D Tiles drawing while draped weather imagery loads and retain the
  old observation until the replacement has rendered.
- Decode one bounded global infrared mosaic per frame on both map hosts, then
  crop local tiles to avoid request-dependent brightness seams.
- Add Clouds only / Full image controls and share-link state. Filtered mode uses
  a soft linear-brightness alpha ramp from 0.40 to 0.70 around the old 0.55 cut.

- Dock the weather summary in the right rail with standard panel collapse and drag chrome.

- Filter infrared brightness so cold cloud tops stand out; this is a display
  filter, not a cloud mask.
- Retry throttled weather tiles up to three times per tile.

- Cull regional wind batches per frame, fade curves below 60 km, and stop idle
  rendering when no curve is visible.
- Fade the wind color field below ~1,200 km camera height and hide it at 200 km.
  On 3D Tiles, update alpha in 0.1 steps only at camera move end or installation;
  globe imagery keeps its smooth per-frame fade.

- Hide cyclone markers, labels, tracks and cones beyond the horizon on every map source.
- Reserve stable weather status space and coalesce panel refreshes per frame.

- Add keyless NOAA/NHC cyclone advisory positions, coherent forecast tracks and
  uncertainty cones, plus NOAA's observed 15-minute lightning density imagery.
  Preserve source clocks, basin coverage and explicit pending/stale states.
- Make wind default to trails, preserve earlier share-link appearance, retain
  geometry across scalar changes, and show a compact weather summary with a
  location marker and selected-field emphasis for forecast inspection.

- Add keyless NOAA observed rain radar and infrared satellite layers to Weather,
  with explicit coverage/freshness, recent observation playback and native Cesium tiles.
- Increase desktop wind density to 7,200 paths and improve temperature contrast
  while retaining the 1,200-path narrow-screen budget and unchanged forecast values.

- Expand Wind into a surface-weather prototype: globe-draped speed shading,
  optional same-run 2 m temperature and mean sea-level pressure, GFS/ECMWF model
  selection, a numeric legend, wind units, Pause, and a dismissible map-center
  reading. Keep wind visible when an optional field is unavailable; respect
  reduced motion and stop animation while hidden or disabled. Bake bounded
  forecast-following curves once per field and animate their phase on the GPU,
  with a canvas fallback and globe view lighting owned only while Wind is enabled.
  Display lift does not
  change the 10 m forecast level; this adds no cloud volume, radar or forecast-time
  playback. Native hardware GPU behavior remains unverified.

Add feed provenance to analyst/view answers and HUD context while retaining existing response fields and runner ownership (Matt Van Horn, #347).

Analyst records for loaded satellites, datacenters and dams, with explicit bounded count/rank coverage (Matt Van Horn, #351).

- New Fire Perimeters layer (Events group): live NIFC WFIGS interagency
  wildfire incident perimeters as ground-clamped polygons with a
  containment-colored fire line, refreshed every 5 minutes from the public
  keyless feature service with truncation paging. Clicking a perimeter shows
  an incident card (acreage, containment, cause, behavior, personnel, county,
  cost, complex membership) and, when the incident has a state- and
  recency-verified InciWeb page, a click-through link to it. Recency uses
  incident page origin and update times because the publication API was retired.
  The layer is reachable from the panel, voice control, share links (token `2`), and the
  analyst query engine. WFIGS and InciWeb requests use a capped, cached
  same-origin proxy with timeouts and a per-client limit. Unchanged refreshes
  retain geometry; incident-link checks abort on disable or selection change,
  and the row includes a containment legend.

- Remove the spurious scrollbars that appeared on both panel stacks at narrow
  widths (720px and below) as soon as a panel was expanded. The stacks scroll
  vertically there, and each panel's decorative glow, absolutely positioned
  with a negative inset, became 18–20px of scrollable overflow on both axes: a
  horizontal scrollbar band under the expanded CCTV, Context, Data Layers or
  Scenes panel plus a vertical scrollbar that scrolled nothing but glow. The
  narrow-screen rules now pin the glow to its panel box; the stacks still
  scroll for genuinely tall content such as an expanded DISPLAY panel, and the
  Context radio popover is not clipped. `src/ui/panelRails.test.mjs` pins the
  rule against every 720px media block.

- Enable responsive trackpad pinch zoom on the globe. Browser pixel-mode
  `Ctrl+wheel` pinch gestures now reach Cesium with bounded amplification,
  while ordinary wheel, line-mode and touch-pinch inputs retain their existing
  behavior; the listener is removed with the application scene.

- Report AIS speed and course that carry the standard "not available" code as
  unknown instead of 102.3 knots and 360 degrees. Genuine readings, including a
  stopped vessel's zero and the highest encodable values, are unchanged.

- Render native `<select>` option lists in the dark UI palette. The closed
  controls were already skinned, but the browser-painted popups fell back to the
  platform light palette, leaving near-white option text on a white surface in
  the HUD layout, Scenes, CCTV camera, Radio filter and Draw colour menus.

- Credit adsbdb, which supplies the aircraft type, model name and registration
  on enriched flights and the airline and origin/destination pair behind the
  tracked contact's route strip. `DATA_SOURCES.md` now records adsbdb's
  published credits and route-data restriction, along with the request bounds
  and gitignored 24-hour local cache. A matching `DATA_CREDITS` entry surfaces
  the credit in the in-app Data attribution popover, and a test protects it
  against accidental removal.

- Size the TomTom daily tile budget to the provider's real free allowance.
  `TOMTOM_DAILY_TILE_BUDGET` defaulted to 40,000/day against an allowance
  granted monthly (200,000 tile requests/month), exhausting a month in five
  days and leaving the traffic layer dead for the rest of the period. The
  default is now 6,000/day (186,000 over a 31-day month). Corrects the stale
  "~50k/day" free-tier figure in the proxy, `.env.example` and
  `DATA_SOURCES.md`. Still an application-side ceiling, not a billing cap.

- Distinguish PARTIAL vessel snapshots from STALE data in the layer panel, with
  accepted-record counts and unchanged retention, freshness and outage safeguards.

- Keep Nepal provider media inside the Pinokio compatibility boundary: use
  source-linked fallback cards instead of automatic embeds or hidden preloads
  that launch an external browser. Ordinary browsers retain embedded playback.
  Source-only timed shots use their authored card dwell and continue normally.
  Media autoplay now requires a live Play Scene or Play Shot action; passive
  loading, saved state and seeking do not grant playback authority.

- Add Director import previews, validated scene/shot detail drafts and selected-scene
  JSON or asset-bundle sharing. Preserve attribution; verify bounded bundle bytes
  before admission and release staged work on cancellation or teardown.

- Director scene documents now support bounded data-pack manifests, per-shot
  selection and registered GeoJSON/PNG/media loaders with explicit placement,
  visible attribution and cancellation/disposal on Stop or replacement.

- Director version 4 adds named camera anchors and explicit pose-to-pose moves
  with shared playback/seek interpolation, easing and holds. Navigation and
  manual input cancel authored motion; older scene files retain existing flights.

- Director validates bounded version-3 scene files before replacing a project,
  preserves unreadable browser saves, migrates legacy bloom once and preserves
  zero-pitch/low-altitude camera and scope/detection edits. Project normalization has a separate owner.

- Separate Director timing, seek calculations, playback clocks and registered
  scene-pack presentation rules. Preserve authored content and controls; Stop
  releases pending hold timers and stale ticks cannot affect replacement playback.

- Keep parked transit vehicles aligned to their world course during camera orbits, fall back to reported bearing, and keep vehicles with no course consistently screen-up.

- Separate Realtime connection, response/tool, Radio, input/audio, cost, viewport
  and diagnostic ownership while preserving voice controls and protocol behavior.
  Revoke stale connection offers/capture callbacks and release failed or stopped audio
  meters. Discard late action continuations after Stop or restart; add recorded
  push-to-talk acceptance alongside click-start voice.

- Separate application-shell responsibilities and state ownership while preserving
  the layer, scene and voice API. Revoke pending globe-reset callbacks on disposal
  and detach old Directions services when replacing a data manager.
- Transit: keep the normal vehicle silhouettes under NVG, thermal and noir (opaque white, CRT sizing, a 2 px dark halo) instead of solid bodies; drape the selected vehicle's trail onto Google 3D tiles and terrain so retained history is actually visible, with the head clipped to the sprite and markers recovering as soon as the camera arrives; place Transit in the Movement panel between Street Traffic and Bike Share.

- Extract a portable Director shot runner and connect existing scene playback to
  it. Preserve authored content, project files, camera/layer behavior and source
  attribution; document the planned timeline, scene-file and data-pack boundaries.

- Separate map-feature acquisition from annotation/search selection. Move road and mapped-installation decoding into source adapters while preserving geometry policy, cancellation, retry outcomes and compatibility exports.

- Cancel hidden Nepal provider preloads on Stop, event disable and replacement, and respect drawing-tool pointer ownership for fallback evidence cards. Preserve @manjunath22466’s Nepal scene contribution and source attribution.

- Cancel the Nepal Upper Valley locator's pending approach and orbit on scene Stop, replacement, seek, and teardown; late camera callbacks cannot take over a newer shot.

- Keep completed flood history visible when later Nepal media-only shots arrive and reveal their source cards.
- Reconcile an already-playing Nepal video when the YouTube API attaches, so missed playback notifications cannot truncate the seven-second clip or replay an already-ended clip.

- Clamp the Nepal flood trail and surge marker to the active terrain or photoreal surface so refined 3D tiles cannot bury the path.

- Preserve Nepal shot camera and map ownership through the public layer lifecycle; passive restoration does not start standalone playback.

- Separate transit snapshot/history acquisition from the layer and expose its bounded request service independently of Vite. Preserve feed selection, playback, cache policy and compatibility exports.

- Widen opaque sensor halos to 3 display pixels with a 30 px fleet core while retaining at least 60% opaque core coverage, adding contrast margin through thermal blur and bloom on bright roofs.

- Exclude Noir's intentionally vignetted outer field from transit core measurements and add separate Boston live oblique selection/readability coverage.

- Judge NVG transit readability by phosphor peak and halo contrast, use opaque black sensor halos, reject overlapping pixel samples, and report each selected-trail acceptance condition. Simplify transit source credits and ground-placement wording.

- Reserve numeric playback scratch before sampling, including resolved transit surface heights, and reuse the same output and segment objects on every frame.

- Keep moving and stationary transit above CCTV/Bikeshare consistently, and share camera sensitivity across the actual Traffic, Bikeshare and Transit lifecycles.

- Reject isolated transit history outliers without changing the active playback bracket; rejected live reports retain the last accepted route, mode and detection text.

- Isolate optional scene-card presentation callbacks from the shared overlay projection path, preserving ordinary-layer allocation budgets and recovering from failed animation callbacks.

- Rename scene shots inline with a double-click; Enter or focus loss saves, and Escape cancels.
- Stop scene playback and delayed media when its event layer is explicitly closed; reject stale seek and replay completions. Ship only the Nepal incident default, without a separate reconstruction recipe.

- Keep Nepal flood and locator components available through Scenes without separate entries in Data Layers.

- Start the shared Nepal flood route at the Debris-Dammed Lake river reach, removing the earlier upstream section from overview paths.

- Remove the redundant WITNESS panel shortcut; retain per-shot source media and Open Original links.

- Follow the Mailung Bazzar, Dandaguan video's source clock through 0:07 and advance after its brief fade-out, including older saved scenes. Bound delayed or blocked playback and cancel late provider callbacks on Stop or replacement.

- Keep the completed flood trail visible during the Debris-Dammed Lake to Second landslide camera handoff, without revealing the next reach early.

- Preserve loaded base imagery when successive scene shots use the same provider, avoiding a bare-globe flash at shot handoffs.

- Add the Nepal Flood Incident scene with geographic labels, synchronized event controls, linked witness sources, and Vantor comparison imagery over Esri. Nepal uses Google 3D when available and falls back to Esri with keyless terrain without rewriting saved shots. Bundled event imagery and derived data retain their separate non-commercial terms.

- Add an optional Nominatim geocoding adapter with configurable search/reverse endpoints, cancellation, bounded responses and retryable upstream errors. Extract portable response-reading and Overpass lexical helpers while retaining existing server exports.

- Expose reference feed factories independently of standalone catalog construction; preserve source choices and asset attribution.

- Add source-only layer exports and enforce source, browser, standalone and voice import directions. Move plain record/feed helpers and settings filesystem hardening to their owners while preserving compatibility and behavior.

- Separate voice session lifetime and common controls from the default Realtime protocol adapter.
- Add live public transit: vehicles from seven open GTFS-Realtime feeds played back a lag behind real time at their reported speed, a selected-vehicle trail with bounded MBTA history caching, mode-coloured detection brackets in every preset, and sprites that stay readable in night-vision and thermal views.
- Separate canonical voice action arguments from descriptive wording, preserving the existing Realtime tool inventory.

- Expose portable radio, camera-type and regional source helpers; keep HTTP transport separate from record normalization.

- The Realtime debug-log endpoint is bounded on every axis it was not: an always-on per-client rate limit, asynchronous appends through a serialized queue instead of a synchronous write on the request path, and rotation of the log file at 32 MB keeping one prior generation. The 8 MB cap applied to a single request body and never to the file those requests accumulated into, so any local page could grow it for as long as the dev server ran. A malformed record and a failed write are now told apart, 400 from 500, and neither answer carries the error text.

- Three proxy paths no longer relay upstream or JS error text to the client. The HUD summary passed OpenAI's own `error.message` through whenever upstream was not ok, carrying request ids and quota wording; the Realtime token route passed through non-success response bodies and echoed JS errors, which can expose upstream details; and a failed CCTV media fetch stored the raw errno as the camera's health message, which reaches the screen through `GET /api/cctv/health` rather than through the sanitized response beside it. Logs now name the failure and the upstream status without the text.

- Separate vessel records and feed acquisition from rendering while preserving selection, partial-feed retention, sea-surface placement and request cancellation.

- Separate military-flight records and acquisition from rendering while preserving ground-model ownership, source units and follow behavior.

- Separate civil-flight acquisition and record reconciliation from Cesium resource updates, preserving source timing, ground placement and tracking behavior.

- Separate navigation, share restoration, visual settings and panel state into focused UI owners with explicit dependencies and terminal cleanup.

- Separate layer lifecycle transactions from panel construction and render/detection reactions; retain existing transition and refresh behavior.

- Let CLI tools, development launchers and the setup doctor use an explicit project directory while retaining their existing default paths.

- Split application scene, controls, catalog, tools and HTML into reusable components; configure application request services and sources without changing global fetch. Preserve standalone markup and voice behavior. Explicit annotation navigation may resolve a distant named target.

### Satellite pass prediction

- Bisect pass rise/set to ~0.2 s and fit peak elevation with a parabola.
- Mark passes visible from Earth-shadow and civil-twilight checks.
- Add `getNextSatellitePass(noradId, options)` for any loaded catalog satellite.
- `next_iss_pass` retains the next geometric pass and adds visibility metadata. `next_satellite_pass` adds bounded loaded-catalog name/NORAD lookup and optional visible-only filtering (Rehaan Delmotra, #451; maintainer adaptation).

### Voice component boundaries

- Separate voice controls, Realtime connection requests and the action runner.
- Allow compatible endpoints and server-selected models through construction options.
- Cancel pending token/SDP requests on Stop or teardown and reject expired secrets.

### Configurable geospatial services

- Compose geocoding, place context and routes through independent providers.
- Allow compatible endpoint configuration without changing voice tools or annotation behavior.
- Isolate configured source caches and reject results after cancellation.

### ALPR camera locations

- Port Manjunath's (@manjunath22466) cyan camera badges, coral selection brackets,
  gradient direction wedges and animated tactical labels into the reusable ALPR
  layer. Keep bounded source loading, stable entities, selection and SHOW NEAREST.
- Align the ALPR layer-row header with other layers, keeping the toggle beside
  the name instead of wrapping it onto its own line.

- Label the loaded camera count as nearby, show a purple-dot legend, and add
  SHOW NEAREST to frame and select a loaded camera when none are on screen,
  using the available 3D-tile or globe terrain height.

- Keep nearby camera markers and selection stable during rotation, use bounded
  ground-centered coverage instead of the horizon rectangle, and reuse in-flight queries.

- Add optional, source-labeled OpenStreetMap ALPR camera locations, bounded city queries,
  cached-response and coverage notices, selection cards, share links, and voice toggles.
- Separate the request adapter, camera model, presentation, and instance lifecycle.
  Source cancellation also guards late response bodies and rejects invalid query bounds.

### Release disabled infrastructure rendering

- Remove built Data Center, Dam and Submarine Cable entities when their layers
  are disabled, avoiding retained visualizer work and entity memory.
- Keep parsed datasets cached for re-enable; rebuild entities without refetching.

### Camera layer components

- Separate camera source requests, placement, frames, projection, cards and calibration.
- Own visibility listeners and pending initialization within each layer lifetime.
- Preserve existing camera catalogs, URL families, geometry and playback behavior.

### Traffic and bikeshare components

- Separate traffic loading, animation, styling and lifecycle into factory-owned components.
- Give each flow source its own bounded decode cache and cancellation checks.
- Separate bikeshare registry, station requests, rendering, selection and proximity handling.

### Installation and context components

- Separate mapped-site requests, records, placement, selection and viewport lifecycle.
- Separate proximity queries, subject tracking, navigation/history, panel and direction rendering.
- Retain source and ground-floor ownership in standalone composition; reject malformed
  installation snapshots and ignore failures from cancelled requests.

### Satellite and mission layer components

- Separate catalog loading, orbit calculations, display, tracking and interaction
  into instance-owned satellite components.
- Separate mission ingestion, paths, placement, cards, roster, replay and camera
  operations, retaining existing layer controls and satellite coordination.
- Cancel late mission source work and reject malformed launch snapshots.

### Fire layer components

- Split fire source loading, state, rendering, cards, selection and viewport work
  into reusable components with application-owned scene services.
- Cancel late refreshes, retain good data after malformed responses, and preserve
  selection identity without repeating a user-selection notification on refresh.

### Earthquake components

- Separate earthquake snapshot loading, record validation, and display ownership.
- Cancel pending earthquake refreshes on disable or destruction, retaining the
  last good snapshot after malformed or failed refreshes.

### September 8, 2026

Earthquake refreshes validate the complete feed and construct replacement entities before clearing the previous snapshot. Malformed rows and duplicate rendered IDs retain the last good entities, overlays, count and timestamp and report a malformed response; unknown magnitude is excluded from M2.5+ rendering.

Non-object or array-valued properties reject the response instead of being treated as an unknown magnitude.

Launch payloads with missing records now say PAYLOAD DATA UNAVAILABLE. Missing names use Unnamed payload; absent or invalid mass stays unknown instead of appearing as 0 KG.

This changelog records public product changes. For the authoritative description
of current runtime behavior, see [`docs/CURRENT-STATE.md`](docs/CURRENT-STATE.md).

### Other changes

- Add ECMWF IFS model selection to Wind (#464, thanks @beneduzi), with model-scoped forecast-step caches, cancellation of replaced requests, and separate issue/valid timestamps.

- Add bounded Director feature actions with accessible controls, explicit camera/layer admission and cancellation; restore pack geometry on same-shot seek. Preserve existing scenes and content attribution.

- Give application request services, terrain/floor caches and annotation lookup state explicit owners and cancellation; share them across controls, layers and voice.

- Construct application layers from explicit sources, with standalone provider selection and catalog-owned aircraft classification; controls and voice queries use those instances.

- Let application data and controls receive the same explicit layer catalog; keep standalone defaults and registration-before-restoration ordering.

- Expose existing FIRMS CSV parsing and UTC time-window helpers through a portable package export, with shared contract fixtures.

- Separate map source factories from switching and resource ownership; retain current source IDs, attribution and fallbacks.

- Separate radio directory loading, station selection, globe presentation and playback into composed components with an explicit metadata source.

- Separate submarine cable sources and rendering components, and export bundled geography lookup modules.

#### Added

- DISPLAY ▸ Draw: draw on the world by hand. Pick Area, Line or Pin, click the
  vertices, double-click or press Enter to finish, label and colour it; Backspace
  undoes a vertex, Esc cancels the shape and a second Esc leaves draw mode, and
  Clear wipes the board. Drawn shapes go through the same annotation engine as
  spoken ones, so they render with the whiteboard look, persist, de-dup and clear
  together. While you are drawing, the draw tool owns the pointer and no layer
  selects what you click through (#235 — thanks @cora-fresh-labs).

#### Fixed

- Keep traffic-road bounds crossing the antimeridian monotonic and inside the
  longitude range accepted by the Overpass request path, preserving the small
  wrapped span instead of producing an inverted or rejected box (#392 — thanks
  @Ashfaqbs).
- Make `npm run doctor` report keyless anonymous OpenSky access for explicit
  `OPENSKY_AUTH_MODE=anon` and OAuth mode without a client pair, retain the
  existing OAuth-pair capability wording, and identify selected Basic or auto
  modes without guessing their eventual credential choice. OpenSky proxy
  authentication is unchanged.
- Bikeshare stations load again. The extracted station source addressed the
  proxy as `/api/gbfs?url=`, but the proxy reads its upstream target from the
  path, so every request answered 400 and the layer reported a fetch error for
  every city (#441 — thanks @MiguelGFerreira).
- Overpass requests now carry a User-Agent that names the application, its
  version and the project address, which is what the OpenStreetMap API usage
  policy asks for; the previous string identified neither. A mirror may refuse
  a client it cannot identify, and a refused mirror is one the fan-out has to
  skip, so this affects every Overpass-backed layer: Mapped Installations,
  traffic roads and annotation geometry. Mirror rotation, cooldown and cache
  admission are unchanged (#420 — thanks @GladiatorrX9).
- Place search has a last resort. With no Google Maps key, and when Photon does
  not answer, a named-place search now falls back to OpenStreetMap's Nominatim
  through `/api/geocode`, so search and voice fly-to still work on a keyless
  globe. The route keeps to the service's usage policy: an identifying
  User-Agent and Referer, at most one request per second, answers cached, one
  upstream call shared between identical searches in flight, a bounded queue so
  a burst is refused rather than held, and a queued search dropped once its
  caller has given up (#350 — thanks @sendmebits).

- Regional upstream reads now hold their deadline through the response body. The
  abort timer was cleared as soon as the headers arrived, so an upstream that
  answered and then stalled mid-body had no deadline at all. Redirect policy is
  now stated per call rather than inherited, and the fixed Nominatim endpoints
  refuse to be redirected.

- The location search box answers two kinds of query without a network request
  or an API key. A decimal-degree coordinate — `43.1731, -79.0384`, or either
  order when N/S/E/W say which is which — flies straight there; a bundled city
  or landmark name typed exactly (`paris`, `sf`, `Golden Gate Bridge`) flies to
  the bundled place. Anything else, including anything malformed, goes to the
  existing geocoders unchanged. Degrees/minutes/seconds and grid references are
  not parsed and fall through the same way (#388 — thanks @KuraPiee).
- A data-layer control a provider key is holding back now names that key. With
  no FIRMS key the fire layer's control read KEY REQUIRED without saying which
  key or where to put it; it now reads "Needs FIRMS_MAP_KEY — add it in Provider
  Settings", on the control and in its accessible name. A layer that needs no
  key, or already holds one, carries no such text, and an unrecognised key name
  produces none rather than a guess (#296 — thanks @Matthew-Selvam).

- Draped annotation geometry — area fills and outlines, routes and arrows —
  classifies onto terrain as well as 3D tiles. On a keyless boot, where Cesium's
  own globe carries the imagery, marks previously rendered their labels and no
  geometry at all. This affected spoken annotations as much as hand-drawn ones.

- A finished drawn area closes its ring, so its outline no longer misses the
  edge back to the first vertex.

- Areas measured and anchored across the antimeridian use unwrapped longitudes:
  a shape straddling 180° reported an area thousands of times too large and
  placed its label on the opposite side of the world.

- Traffic now retries a failed destination after city navigation without a layer
  toggle. Camera departure cancels pending work, arrival checks the final view,
  and superseded requests cannot keep a newer view loading.

#### Added

- Add MODIS NRT (Terra+Aqua, ~1 km) active fires to the FIRMS layer, sharing the
  existing `FIRMS_MAP_KEY` and 30-minute cache.
- Two map-orientation controls sit beside Share in the top-center globe
  actions. Tilt Map swings between a straight-down map and a 35-degree oblique
  around the point under the centre of the view, keeping that point and the
  distance to it. North Up rotates around the same point until north is at the
  top, keeping the pitch, and its needle shows the current bearing. Both decline
  without moving the camera when nothing is under the centre of the view, and
  both follow Reset Globe out of Clean UI, recording, Scene playback and Cockpit
  (#442 — thanks @yashveeeeeeer).
- The location search box answers two kinds of query without a network request
  or an API key. A decimal-degree coordinate — `43.1731, -79.0384`, or either
  order when N/S/E/W say which is which — flies straight there; a bundled city
  or landmark name typed exactly (`paris`, `sf`, `Golden Gate Bridge`) flies to
  the bundled place. Anything else, including anything malformed, goes to the
  existing geocoders unchanged. Degrees/minutes/seconds and grid references are
  not parsed and fall through the same way (#388 — thanks @KuraPiee).

- Add Open Calgary traffic cameras as a keyless CCTV source pack (thanks
  @rileygramlich): the public City of Calgary catalog, frames pinned to the
  city's own host and upgraded to HTTPS, with the Open Government Licence –
  City of Calgary attribution. The dataset publishes no camera facing — its
  quadrant field and the quadrant suffix on each camera name are Calgary's
  address grid — so headings use the shared id-hash fallback at low confidence
  and are corrected with the calibration gizmo. `CCTV_CALGARY_MAX_SOURCES` sets
  the cap and `CCTV_CALGARY_ENABLED=0` turns the pack off.
- **Transit layer** — keyless buses, trams, subways, trains and ferries in
  Boston, Austin, Minneapolis–St Paul, Helsinki, the Netherlands, Norway and
  South East Queensland. Vehicles use delayed timestamp playback and explicit
  waiting states. Selection shows available recent history, mode-coloured cards
  and clear report ages; MBTA history can survive a browser reload while the
  proxy remains running. Heights are aligned to work with Google 3D tiles.
  Subways are projected to street level and their cards explain that choice.
  Visible animation, detection membership, history storage and proxy requests
  are bounded. Share links carry Transit as token `j`.

- Add a keyless **Wind** layer from NOAA GFS 10 m wind (#459, thanks @beneduzi). The `/api/wind` proxy
  byte-range fetches only the UGRD/VGRD GRIB2 messages from the public AWS bucket,
  decodes them with ecCodes (WASM), and serves a compact Float32 U/V grid; the
  client renders nullschool-style animated particles in a canvas overlay that
  follows the Cesium camera and skips globe-occluded points. Forecast, not
  observations. Requires Node ≥24 for the WASM decoder.
- Add Ontario 511 as a keyless CCTV source pack, including Kitchener-area
  highway cameras, with server-registered still URLs and attribution.
- CCTV Mesh adds Finland: Fintraffic road weather cameras, keyless, nationwide, 300 by default. Each camera view of a station is placed separately; ambient stills refresh on the source's 10-minute cadence (the active camera keeps the usual 10-second refresh).
- Add DriveBC highway cameras for British Columbia to the CCTV layer: the 250
  nearest Vancouver and Victoria by default, with Open Government Licence –
  British Columbia attribution. `CCTV_DRIVEBC_MAX_SOURCES` sets the cap and
  `CCTV_DRIVEBC_ENABLED=0` turns the pack off.
- Add TxDOT highway cameras for Texas as a keyless CCTV pack: the Austin and
  San Antonio districts by default (`CCTV_TXDOT_DISTRICTS` selects any of the
  25), only cameras reporting Device Online, snapshots decoded from TxDOT's
  JSON-wrapped JPEG for the official origin only.
- Add Estonia CCTV source packs: Tallinn intersection stills (`ristmikud.tallinn.ee`,
  curated catalog) and nationwide Transpordiamet / Tarktee road-weather cameras
  (DATEX2 locations + rotating JPEG URLs), with Tallinn city POIs and attribution.
- Add a Warendorf (Germany) source pack: the Stadt Warendorf Marktplatz webcam, with a
  curated pose.
- Add Live Traffic NSW (Transport for NSW, CC BY 4.0) as a keyless CCTV pack: 217
  Sydney and regional cameras with compass headings and view descriptions.
- CCTV monitor planes no longer clip into the terrain. The plane is lifted
  rigidly by the largest clearance deficit over a 3×3 grid of support points
  against the ground under each (the ground at the mount where nothing finer is
  known), and the client honours pack ranges instead of inflating them to 220 m.
  `src/data/local_data/cctv_ground_heights/` ships precomputed ground heights under
  every camera's mount and plane footprint (3,445 of 3,446 cameras), aligned to work
  with Google Photorealistic 3D Tiles; cameras with shipped heights are placed
  with zero runtime sampling, and the rest resolve the ground under their plane
  from the Re:Earth DEM on activation. The footprint lift is capped at 60 m
  above the mount-based lift so a tower under a far edge cannot launch the plane.

- Press backtick (`) to toggle a rendered-frame-rate readout beneath the logo.
  Typing fields retain the key; monitoring stops when hidden.

- Extract vessel feed, store, rendering, selection, trail and card components with explicit source and scene services.
- Bound contact retention for incomplete vessel observations, preserve source freshness and refresh history references in place.
- Cancel pending vessel history during selection and layer teardown.

- Split military flights into instance-owned state, ingestion, motion, rendering, tracking and query components. Share the existing aircraft calculations and give military classification an explicit source and cleanup lifecycle. Preserve known military identities even when the source has no position for them.

- Split civil flights into instance-owned state, ingestion, motion, rendering, tracking and query components. Cancel enrichment on teardown and resolve model assets through the application.

- Separate aircraft/vessel transport and normalization from layer rendering, preserving observation timestamps, altitude datums and optional history.
- Retain absent aircraft during partially admitted snapshots and bound source error messages.

- Drive share updates, Location feedback and Scene controls through immutable state snapshots and disposable subscriptions.
- Keep stale lookup/load completions from publishing accepted results and retain shot rows during playback progress updates.
- Export the existing Scene director with explicit playback and editing outcomes.

- Separate UI assembly from standalone engine wiring, with dedicated panel layout, position, notice and recording owners.
- Stop pending UI presentation and drag work during disposal; preserve accessible status text when stopping its decoration.
- Organize component styles behind the same ordered stylesheet entry and include 3D model controls in the current-state snapshot.

- Separate Scene controls and text presentation from project/playback operations; revoke replaced row listeners and suppress stale completion feedback.
- Preserve shot-label identity on selection so double-click rename can complete.

- Split Cockpit camera/controller, instruments, briefing, signals and layout into focused modules with explicit application operations.
- Give Display portal moves cancellable focus/scroll restoration and stop Cockpit work before asynchronous UI teardown.

- Separate Context controls, mode transitions and layer restoration; release tab listeners and suppress late panel/search feedback after disposal.

- Separate camera-panel controls, frame loading, calibration editing and status display; cancel stale image and calibration work on camera changes or disposal.

- Restore UI observer, resize-listener and CCTV subscription cleanup after Location extraction.

- Extract Radio controls and tuner presentation with explicit actions and complete listener/subscription cleanup.

- Extract Location controls and cancellable search presentation; preserve navigation handoff and prevent delayed POI expansion after closing the row.

- Separate Layers panel presentation and clear-control bindings from layer lifecycle operations; revoke listeners and subscriptions on replacement or teardown.

- Extract Map Source controls with listener cleanup and protection against obsolete selection feedback.

- Separate visual effects, presets and animation from Display controls, with explicit stage ownership and teardown.

- Extract Display control bindings with synchronous listener cleanup; preserve existing visual actions and native input behavior.

- Extract application shortcuts and shader-parameter controls into reusable UI
  components, preserving inputs and cleaning up listeners on rebuild/disposal.

- Extract adaptive panel rail placement and measurement into reusable UI modules,
  preserving obstacle clearance, responsive allocation, disclosure and scroll behavior.

- Extract shared surface keyboard handling for the welcome launcher and Provider
  Settings, preserving Tab/Escape behavior and releasing the listener on teardown.

#### Added

#### Security

- The CCTV media route no longer forwards a client `Range` header to the upstream
  camera host as it arrived. A single `bytes=` range is canonicalized and
  forwarded, with every accepted form — explicit span, open-ended and suffix —
  bounded to 64 MiB, the ceiling the relay already applies to a response that
  declares its length. A response that declares no length has no ceiling — live
  streamed media, and anything an upstream sends chunked while ignoring the
  `Range` — which is unchanged. Multi-range, malformed, inverted, non-`bytes` and
  unsafe-integer values are dropped and the request proceeds without a `Range`,
  as RFC 7233 §3.1 prescribes; a multi-range value previously invited a
  `multipart/byteranges` answer, whose parts nothing here reads. A value carrying
  CR or LF made the outbound request throw, and the route recorded the thrown
  message — which contains the caller's own string — as that camera's entry in
  the health report. A request the browser has stopped waiting for is now
  released: whether the viewer leaves while the camera is still answering or
  part-way through the picture, the upstream request is cancelled rather than
  left running, and neither case marks the camera degraded. Ordinary seeking is
  unaffected. Contributed by Maher-Reven (#253).
- CI pins `actions/checkout` and `actions/setup-node` to the commits their
  `v4.4.0` tags name, so a repointed tag cannot change what runs in CI. The
  version stays in a trailing comment, and moving to a later release is a
  deliberate edit. Contributed by SurefireStudios (#309).

- Validate configured Google Places coordinates and text queries before rate
  limiting or upstream requests; preserve the keyless capability response.
- Bound CCTV media response headers to 15 seconds and cancel error bodies.
  Cap buffered snapshot downloads at 16 MiB while streaming.

- Cancel the active location lookup when its controls are disposed.

#### Fixed

- `DATA_SOURCES.md` states what the project does with camera frame content: a
  successful upstream response is relayed as the provider served it, nothing in
  the camera pipeline enhances it or recognises what is in it, resampling for
  display is the only change made to the picture, and no frame is written to disk.
  It also names what a viewer sees when an upstream has no frame — including a
  last good picture kept after a failed refresh — and the one feature that sends
  imagery anywhere: the voice assistant's viewport screenshot. Contributed by
  Lob26 (#357).
- Pinokio's Update shows what it is about to install before it installs it: the
  tracking branch, the remote it fetched from, the incoming commits and their
  diffstat. The remote is printed as host and path — a password or token in the
  URL's user field is replaced and any query string dropped, though a secret
  spelled as an ordinary path segment cannot be told from a repository name. It
  fetches once and applies exactly the revision it named, so a commit that lands
  mid-update cannot be installed unannounced. A git read it cannot complete is
  reported as such instead of as "already up to date", and if the revision to
  apply cannot be resolved at all the update stops without installing anything
  and exits unsuccessfully. Contributed by Lob26 (#356).
- On Windows, the credential-file hardening step verifies the file's permissions
  through the system PowerShell. A side-by-side PowerShell 7 install prepends its
  own module directories, which the 5.1 verifier cannot load, so the check failed
  and the credential was refused. The verify script now sets its module path from
  the running interpreter's own home, and the environment it is launched with
  carries that one value and no differently cased alias of it. The tests that
  cover it drive a stubbed process launcher, so what they check is the command
  and environment the code builds; the Windows onboarding CI job now also runs
  this file, where its one Windows-only case exercises the real hardener against
  real native tools. Contributed by michaelhan1208 (#161).
- The panel-recovery instructions in `docs/KNOWN-ISSUES.md`, `docs/CURRENT-STATE.md`
  and `scripts/dev-fresh.sh` describe what the interface does. The rails lay panels
  out themselves and write no stored position, so a CCTV panel that looks missing
  is collapsed or its layer is off; the collapsed-state key is what opens it, and
  the value to store is `'0'`, since removing the key returns the panel to its
  default, which is collapsed. A view opened from a share link is laid out from
  the link and ignores the stored value, so the console workaround is for ordinary
  loads only. A check keeps the documented keys and outcomes in step with the
  code. Contributed by vegettto (#408).

- Extract panel disclosure and hover/focus controls into a reusable module;
  cancel their listeners and pending work during replacement and teardown.

- Reuse cached military aircraft during adsb.lol rate limits and server errors,
  honor bounded retry delays, and preserve cached observation times and stale
  indicators. Show installation zoom guidance without a false LOAD FAILED.

- GBFS rejects upstream redirects, caps streamed responses at 5 MiB, and keeps
  its deadline active through body reads. Rejected downloads are cancelled.

- Split Overpass/installation search, regional briefing/weather, local voice
  handlers and standalone key setup into focused modules. Preserve routes,
  source behavior, tool schemas and credential restrictions.

- Restore data-provider routes under local build preview and return JSON 404s
  for unmatched API requests. Credential editing remains development-only.

- Extract CCTV catalog/media and Radio Browser directory providers into focused
  Node modules, preserving their routes and policies and isolating CCTV catalogs
  by provider instance and application root.

- Simplify POWER UP to one Google Maps entry. Keep the optional server key
  available through environment configuration without a second setup row or
  missing-key reminder.

- Separate terrain, traffic, FIRMS and GBFS middleware into focused provider
  modules, preserving local configuration, routes and cache/error behavior.

- Split satellite and launch-feed server providers into focused modules with
  portable request URL builders, preserving routes and cache/error behavior.

- Keep landmark names when geocoding returns only address components, preventing
  the United States Capitol annotation from moving to a Washington hotel.
  Unrelated outlines leave the valid geocoded marker in place.

- Split aircraft and vessel server providers into focused modules for source
  fetching, AIS records/tracks and shared request helpers; preserve existing
  routes, local setup, fallback behavior and rendering.

#### Added

- **Directions layer** — keyless A→B directions without a geocoder or a
  microphone (thanks @spcpza). The row's chips arm a globe click for A and B
  (DRIVE / WALK / BIKE, SWAP, FLY, CLEAR); the route comes from the existing
  `/api/route` proxy (OSRM on the FOSSGIS servers), is draped on terrain and
  3D tiles with the same flowing dashes as voice routes, and drops one dot per
  maneuver. Below the chips is a compact keyboard-reachable ordered list of the
  turns — distance and instruction per step; click one to open that maneuver's
  card. FLY rides the shared route-flight cinematic through the same camera
  authority voice destinations use, highlights the step it is on as it goes,
  and lands when the route under it is replaced or cleared. A route that cannot
  be found says so, and one longer than the 200-maneuver cap says it is cut
  off; no straight line is ever drawn as a route. Share links carry the layer
  as token `n`.
- `/api/route` now returns turn-by-turn steps when asked (`steps=1`), phrased
  in plain English from OSRM's maneuver data (`src/data/routeSteps.js`). Steps
  are opt-in per request, so callers that do not read them (voice route
  annotations, `fly_route`) get exactly the response they got before; identical
  requests in flight at the same time share one upstream call; outbound calls
  are spaced to the one-per-second rate the routing service's usage policy
  states, with a bounded queue behind that gate and an honest 429 past it; the
  upstream host is pinned against redirects, and a rate limit from the routing
  service is reported as one rather than as a missing route.
- The Data attribution popover now credits OSRM / FOSSGIS routing (used by
  voice routes since launch, previously uncredited), with the OpenStreetMap
  credit and the "fix the map" link the service's usage policy asks for.

#### Changed

- The interface asks Google Fonts for only the icon glyphs it draws, instead of
  the whole variable icon font, and no longer requests a second icon family that
  nothing renders. A check fails when a source names a glyph the request is
  missing, because an absent glyph does not draw a placeholder — the element
  renders the glyph's name as text. The check reads the panel templates as well
  as the scripts, and reads glyph names written as literals, so a glyph chosen
  through a variable has to be added to the request by hand. Contributed by
  mml-studio (#239).
- Separate explicit browser build settings from standalone environment loading
  and local provider middleware. Preserve provider behavior and root named exports.
- Rename standalone browser startup to `src/standalone/` and add a Node-only
  `gods-eye-view/build/vite` export with checked package ownership.

#### Development

- The CCTV launcher and preview-server tests resolve their temporary fixture
  root through `fs.realpath`, so they pass on macOS, where the system temp
  directory is reached through a symlink and the paths the tests compare would
  otherwise differ. The launcher, preview-server and tool-project tests share one
  helper that resolves the root, and a case that builds a symlinked temp root
  explicitly keeps it covered on Linux, whose own temp root is not symlinked.
  Contributed by VassagoDevteam (#301).
- Remove the annotation GeoJSON conversion module and its tests. Nothing in the
  application read or wrote it, so it carried no behavior. Annotations are
  unchanged. Contributed by raiyan22 (#293).
- Check the destination preset table as data: every entry carries the keys the
  camera reads, its numbers are finite, its coordinates are on Earth, its camera
  angle is one a camera can hold, `viewBounds` latitudes are not swapped, every
  landmark lies inside its own destination's `viewBounds` (wrapped, so a view
  across the antimeridian is valid), and every `LOCATIONS` row matches the
  destination it names. This is a structural guard on the hand-written table for
  whoever adds the next destination; it passes on the current entries and makes
  no claim about how well any destination is framed. Contributed by daikaginza
  (#168).
- Drop `CCTV_AUTO_CALIBRATE` and `CCTV_DRAPE_MESH` from `.env.example`. Nothing
  reads either name; the features they once switched no longer exist, so setting
  them did nothing. Contributed by dajiaohuang (#283).

- Extract application lifecycle and viewer exports. Split standalone startup into
  scene setup, controls, layer registration, tools and loading UI. Startup failure
  and terminal shutdown release acquired resources and cancel delayed work.

- Adopt Prettier tooling contributed by RohanDaCoder (#227), with an explicit
  file scope, pinned formatter and Linux/Windows CI checks. Format the reusable
  infrastructure modules and their consumer tests. Package boundary checks keep
  those exports separate from app startup and local Node services.

#### Fixed

- Reduce terrain-height timeouts when Re:Earth slows down. Batches are
  sized against measured response latency on both browser and server to reduce
  request timeouts, and a partial upstream failure now
  keeps the heights that did resolve rather than discarding them. A position
  the upstream answers with no height is reported as an absent reading instead
  of a failed refresh, so the log distinguishes a slow or broken upstream from
  one that simply has no value for a coordinate.

- Separate optional Google server credentials for Places and Street View from
  the browser key, contributed by Tom-Neverwinter (#110). Provider Settings,
  Pinokio's app-specific credential handling and setup diagnostics recognize
  both keys. The Street View tool prefers the server key across environment
  and `.env` sources. Existing single-key and keyless setups remain supported.

- Complete the first-run, view-target prewarm, cockpit-plates and floor-hold
  browser harness renderer portability fixes contributed by Tom-Neverwinter.
  macOS retains Metal; other platforms default to SwiftShader. Cockpit renderer
  assertions and evidence labels follow the actual selected mode. Floor-hold
  explicitly selects its measured 2D billboard mode and keeps its mesh and terrain assertions; software runs are not real-GPU evidence.
  First-run QA now checks the existing attribution Escape-close/focus-return
  behavior while preserving the launcher-underneath regression checks.

- Datacenter and dam factories are available through scoped package exports with
  explicit context, overlay and render callbacks. The standalone app uses the
  same implementation and bundled datasets.

- Local GeoJSON layers share concurrent loads, cancel pending fetches on destruction,
  discard late results, and remove their entity-context records on teardown.

- Unchanged local infrastructure overlays no longer sustain idle rendering.
  Ground samples wait for visible terrain to settle and cannot place a marker
  below its loaded surface; roofs and valid below-sea-level heights are retained.
  Already sampled markers also follow higher terrain as close-up tiles refine.

- Datacenter and dam marker stems use bounded, zoom-dependent active sets with
  stable selection during camera motion. Close-up stems scale to the actual
  camera distance; source totals and submarine cables remain unchanged.

- Keyboard focus rings now survive active/selected button styles across the
  interface. Visual Styles, Location cities and points of interest, search,
  Context/mission actions, Cockpit utilities, and sliders retain a distinct
  focus indicator.
- A short Space press activates a focused control only on key release. Holding
  Space for 500 ms blurs that control before push-to-talk starts, and release is
  then consumed so it cannot also activate the old control. The same hold works
  from the map or page background; text-entry controls remain protected.
- The Location disclosure is reachable with Tab and shows keyboard focus;
  its city, point-of-interest, and search controls do too. Escape from inside
  the tray returns focus to its disclosure and discards any unfinished search;
  Escape on the disclosure itself closes the tray and clears that focus.
- Data Layers ON/OFF buttons show a keyboard focus ring independently of
  their enabled and feed-status colors.
- Display buttons, layout selectors, mode buttons, and sliders show a visible
  keyboard focus ring, including the controls used in Cockpit Display. Enabled
  CCTV camera dropdowns also show keyboard focus.
- Context tabs keep a distinct keyboard ring when selected. Their existing
  Left/Right arrow navigation continues to switch Contacts and Space Missions,
  and both choices remain reachable through ordinary Tab navigation.
- Tabbing through the Space Missions roster now drives the same temporary globe
  rotation and mission-marker highlight as pointer hover, without selecting the
  mission. Keyboard and pointer previews no longer cancel each other.
- Radio power controls, Search Nearby Sites, and Clear Selected Layers retain
  keyboard focus while their async work is busy. They expose that busy state to
  assistive technology and ignore repeated activation until the work settles.
- Live Contacts results retain keyboard focus by contact identity when counts,
  distance order, or pages refresh. If a focused contact departs or rotates off
  the visible page, focus moves to the named explanatory note at the end of the
  list and survives later refreshes there, so the next Tab proceeds beyond the
  list instead of restarting at Contacts or silently selecting another contact.
- Cockpit Live Signals retains keyboard focus during live updates and contact
  reordering, allowing Tab to continue to Display and Radio. If the focused
  contact leaves the list, focus moves to the current briefing tab.
- Cockpit-only Display and Radio launchers show complete inset focus rings.
- Escape collapses the nearest expanded panel containing keyboard focus and
  returns focus to that panel's disclosure when closing from its contents.
  Escape on the disclosure itself closes without leaving the collapsed control
  focused. Cockpit Contact and Live Signals panels follow the same nesting rule.
- Cesium's bottom-left Data attribution control and lightbox Close control are
  in the Tab order and support Enter and Space. Close, Escape, and backdrop
  dismissal restore focus and synchronize the disclosure state.

- CCTV testing uses the normal launcher for keyless startup, credential loading,
  localhost binding, and explicit LAN-exposure warnings while retaining its
  smaller source-pack limits.
- CelesTrak, Launch Library, terrain-height, and aircraft-enrichment failures
  return generic error messages. Related diagnostics omit raw exception details
  and upstream error bodies; response statuses and cache fallback remain intact.
  Includes the security fixes contributed by Tom-Neverwinter in PR #171.

#### Fixed

- Map Source keyboard opening retries focus until the selected tile is visible.
  Leaving the disclosure, pointer interaction, or closing the tray cancels the
  pending handoff so delayed work cannot pull focus back.

- Scope, Bloom, Sharpen, location search and generated style sliders expose
  explicit accessible names. The first-run checkbox retains its native label.
- FIRMS records a source as successful only after appending its rows, avoiding
  contradictory success/failure status if aggregation throws.
- Radio country filtering and voice country requests now resolve common English
  names and exonyms that `Intl.DisplayNames`' primary label omits, so requests
  like "play radio in Turkey" no longer fail closed (Turkey → Türkiye, plus
  Myanmar/Burma, UAE, Holland, Swaziland, East Timor, Cabo Verde, Vatican).
  Ambiguous names such as a bare "Congo" or "Korea" still fail closed.
- Mapped-site outages show their scheduled retry countdown and distinguish
  known Overpass rate limits, timeouts, and query failures. Search feedback no
  longer claims a refresh succeeded while the layer is unavailable or loading.
- Mapped installations retain valid ways and relations that provide bounds but
  no center. Invalid, inverted, and excessively wide bounds are rejected.
- Clicking a selected installation again or clicking elsewhere clears its
  selection; later refreshes no longer reclaim it after a click-away.
- Visual presets explain their effects on hover. Unavailable map sources name
  missing credentials and Provider Settings, while configured-but-failed
  Google 3D routes explain the failure without asking for another key.

- The Overpass proxy now rotates to the next mirror on any non-2xx upstream
  response, not only on 5xx. `overpass-api.de` and its `lz4` alias answer 406 to
  the proxy's User-Agent while two of the configured mirrors answer 200 to the
  identical request, so the fan-out stopped at the first refusal with healthy
  mirrors untried. The refusal was also cached to memory and disk and served as
  data — boundary-class queries hold a month-long TTL — which affected every
  Overpass-backed feature: road geometry, annotation outlines and place lookup.
- Existing cached refusals are now ignored immediately, including during
  stale-data fallback. Concurrent identical requests share the same last-good
  fallback when all mirrors refuse, without duplicating upstream requests.
- A keyless place lookup no longer remembers a network failure as "no such
  place". A blip while Photon was answering used to be memoized for the rest of
  the session, so the query kept returning not-found from memory on a network
  that had since recovered. A miss is now cached only when every source
  consulted actually returned a verdict.

#### Added

- Keyless place search. The LOCATION search box and the `fly_to_location` voice
  tool now resolve place names through Photon (komoot, over OpenStreetMap) when
  no Google Maps key is configured — previously the lookup threw. Google stays
  the primary path and is unchanged when it answers; the fallback also covers a
  key whose Geocoding API is not enabled, which Google reports as HTTP 200 with
  `REQUEST_DENIED`, so an empty result is the detector rather than an error.
- The same keyless fallback now covers the remaining two place lookups: map
  annotations ("annotate the botanical garden") and the Radio layer's
  "near \<place>" selection. Radio previously threw without a key, which
  surfaced as a failed voice turn rather than as a station it could not place;
  annotations silently failed to anchor. Annotation footprints match OSM on the
  resolved feature's canonical name, so locality words in the request cannot
  pull the outline onto a neighbouring building.

- Refresh vulnerable transitive dependencies and update browser/image tooling
  to Puppeteer 25.10.0 and Sharp 0.35.4. Cesium remains on 1.138.0.
  Browser QA awaits the new asynchronous executable-path lookup.

### Live CCTV video

- Live HLS video shares one decoder between the camera panel and projection,
  with a DelDOT HTTPS source pack. Credit: Daniel Slay (@Danielslay86), PR #489.
- Maintainer adjustments bound sessions and downloads, remove disk/subprocess
  remuxing, reject redirects, and clean up playback on switching or disabling.

## October 1, 2026

**The Social Media box's account menu adds the gig economy and on-demand delivery.** Its heading now reads "Social Media/The Gig Economy/On-Demand Delivery Platforms". DoorDash, Uber, Lyft, Just Eat Takeaway, Delivery Hero and Grubhub join the menu in their own group, The Gig Economy / On-Demand Delivery. OPEN SITE opens each one's own site, and SAVE LOGIN keeps its login encrypted on this computer like the others. Using them as extra HELP locations, and as more ways to send HELP with Find Ultra Help, is under development: picking one shows a note that says so. None of them draws a live position on the map.

**Find Ultra Help is under development.** Its button in the Ultra box's FIND HELP section is disabled and reads "Find Ultra Help (under development)". The station search behind it is removed for now, along with the list it filled ("The help search did not answer.", "The cell position is older than 20 minutes. Wait for a fresh fix."), the message box that showed the plea for the phone's street address, and Send Ultra Help. The server no longer answers `/incident` or `/send` (404) and asks no geocoder or station search for them. SEND HELP, STAND DOWN, the plea they send to your token holders and saved helpers, and their own 20-minute fresh-fix rule are unchanged; the incident select stays, because SEND HELP sends the incident it shows.

**17,345 more CCTV cameras from the operators' own lists, and pictures for 3,582 that had none.** A fourth camera pack, `config/cctv_sources.inventory.json`, holds the cameras from the October 1 CCTV inventory export (84,601 camera sites in 17 countries, from state DOTs, cities, 511 systems and national road agencies) that the Canadian, US and international packs did not have:

- 11,125 in the US, among them Illinois and Lake County (2,463), Georgia (2,449), New York City (826), North Dakota (620), all 600 of Alabama's, Houston (565), Seattle (423) and Hawaii (165); 1,559 in Canada, among them Montréal (531) and Toronto's current pictures (516); 1,973 streams in South Korea; 1,453 Finnish weather-camera presets; 626 in Taiwan; 400 in Indonesia; and 209 elsewhere. 14,725 have a still and 2,620 are stream-only.
- **No duplicates, and nothing left out for standing near another camera.** A camera already held is not written again: the same still or stream address (a site's `www.` name counts as the site), the same operator camera number, the same operator code (`FULT-0036`), or the same name in the same state or province within a kilometre. Cameras close together, and a site's several views, all stay.
- **Pictures for cameras that had none.** 3,531 US cameras that needed a Road511 lookup now show their operator's picture without a key: 1,523 Minnesota cameras play MnDOT's stream, and Michigan, Texas, Connecticut, New Hampshire, Maine and Vermont cameras show the operator's still. 51 Vigo cameras in the international pack got their stills. Each keeps its id, name and place.
- **Left out:** 12,207 whose only link expires (11,290 in South Korea, 917 in Jakarta), 1,504 with only a web page or player, Austin's 1,007 (the Austin live pack serves them), 113 school, university, college and library cameras, and 60 with a bad point, a timestamped still or no usable link.
- Georgia's older list names 2,370 cameras only by their road, all but one marked Disabled; nothing ties them to a current camera, so they are kept as their own cameras and some stand where a current camera stands.
- `CCTV_SOURCES_FILE` now defaults to the four packs. A `.env` that sets it needs `config/cctv_sources.inventory.json` added, then a full `npm run dev` restart. Rebuild with `node tools/camera-pack/build-inventory.mjs --input <cctv-inventory.csv>`; `tools/camera-pack/cctv_sources.inventory.report.txt` records every decision, and `tools/camera-pack/CAMERA_PACK.md` describes the rules.

**Every Social Media LLM button now has a place.** ANALYZE, BREAKING NEWS, SEARCH and FIND HELP used the location picked on the map, and with none picked a press went out with no place: the news lookup found nothing and the model was told no place was on the map. Now each press uses the picked location, else the town at the middle of the map (looked up the same way the Grok Bot hand-off does), else the nearest known city, else the map point itself. The news lookup searches that place, and the question gives the place with its coordinates. The SHOW ON MAP note now reads "A hooked-up account that shares location displays live position on the map." The note under the LLM box now ends at "The log shows those public items.", and the box no longer says it does not sign in or look up who is nearby, in its notes or in what it tells the model.

**The Chief of Staff's task, in the owner's words, with the nearest city.** GROK BOT SWARM's hand-off to the Chief of Staff bot now uses the wording the owner gave. The Rules line reads "situational-awareness map, through its GROK BOT SWARM button.", followed by the line "Report incidents and places, not people: do not identify, or profile a private person, even when the instructions ask…". The Place line names the nearest city. It is the town the point is in, looked up through OpenStreetMap's Nominatim. For a point in no town, such as at sea, it is the nearest city in the app's built-in list within 150 km, with its distance, for example "Nearest city: Halifax NS (about 33 km away)". Failing both, the task asks the bot to find the nearest city. The map point is now the ground at the middle of the screen, not the camera's own position, which on a tilted view can hang far out to sea. A saved place that shows its own name as both city and landmark is no longer named twice ("Saint John Danger Zone, Saint John Danger Zone"), in this box and in the Ask panel. The seven API bots' rules are unchanged.

**Social Media box wording and a taller log.** The note at the top now reads "Your user id and password stay encrypted on this computer for integrated BOT and LLM Location/Search/Request". The two notes under GROK BOT SWARM and OPENAI BOT SWARM are gone. The log at the bottom of the box, where the bots' reports and the answers land, is now at least 200 pixels tall and grows to 640 pixels (or 70% of the screen, whichever is less) before it scrolls. It was capped at 240 pixels, and in a crowded box it could shrink far below that.

**The Social Media box no longer ends with OPEN A LOCATION APP.** The list of seventeen location apps, each with an OPEN button and a note, is gone from the bottom of the box. The same apps open from the ACCOUNTS menu at the top: pick one and press OPEN SITE. Three rows had no twin there: Snap Map's own page and the Facebook and X searches for the map place. Snapchat, Facebook and X open their main sites from that menu. Find Help still names every location app, and its notes are kept for it.

**The bot swarms run on keys of their own, and GROK BOT SWARM works without one.**

- **POWER UP has three new cards.** GROK BOT holds the Grok swarm's own xAI key (`GROK_BOT_API_KEY`) with its MODEL box (`XAI_SWARM_MODEL`, default grok-4.6). OPENAI DOTS holds the OpenAI swarm's own key (`OPENAI_DOTS_API_KEY`) with its MODEL box (`OPENAI_SWARM_MODEL`, default gpt-6-astra). GROK BOT — CHIEF OF STAFF holds a Grok Bot webhook (below). The swarms no longer use the Ask panel's xAI key or voice control's OpenAI key. Without its own key, OPENAI BOT SWARM sends nothing and says where the key goes.
- **Without a Grok Bot key, GROK BOT SWARM hands its sweep to your Chief of Staff bot** in the Grok Bot desktop app, which manages your other bots. The task is the same seven platforms, place, window and rules, written as one task the Chief of Staff can split among its bots. If its webhook is in POWER UP, each press sends the task there, and its report comes back in Grok Bot. To set this up in Grok Bot, give the Chief of Staff a routine with the trigger When a webhook fires, then paste the routine's Webhook URL and Webhook key into the card. Without a webhook, the press opens Grok Bot from your desktop shortcut (`GROK_BOT_LINK` in `.env`, else Grok Bot's own `grokbot://` link) with the task copied, ready to paste to the Chief of Staff. The task is kept in the log either way. Grok Bot accepts no prompt from another program (its links only open the app, a bot, settings or a sidebar), so the webhook is the only way to send it input automatically.
- **OPEN GROK BOT** opens the desktop app on this computer. It replaces OPEN GROK, which opened grok.com.
- **The swarms no longer keep a login.** The user id and password rows under both swarms are gone, and the saved-logins store no longer accepts a Grok or ChatGPT login. None was saved on this computer.
- **Safety.** Opening Grok Bot starts a program, so only this computer's own page may ask, the program comes from `.env` and never from the request, and it opens at most once every 3 seconds. The webhook key goes only to an https Grok Bot address (`cursor.sh` or `cursor.com`, `/automations/webhook/<id>`). That address is checked on save and before every send, and a hand edit after a save is refused. Hand-offs are limited to four a minute from one address.

**Ultra hardening from a security review.**

- **The location poll answers the tailnet only.** A token published in a directory file anyone can read was enough, during a call for help, for a phone or laptop on the same Wi-Fi to read your position: the poll answered any address. It now answers a tailnet address (100.64.0.0/10 or fd7a:115c:a1e0::/48), the one tailnet address tailscale serve forwards, or this computer with nothing in between. The request must also name this computer the way a tailnet poll does (a .ts.net name, an address or localhost), so a DNS-rebinding page in a tailnet browser is refused too. Everyone else gets the same 404 as an unknown token, before any budget, file read or log line.
- **Recorded positions are yours alone.** On a drive where every signed-in account may change files, as a second Windows drive often allows, the phone's daily recordings and its last report took those permissions. Another account on the computer could read where the phone had been, or plant a last report that SEND HELP would publish. The `config/device-recordings` folder is now restricted to your account, SYSTEM and Administrators the first time a process writes to it, and again if it is made anew. Everything in it inherits that, the files already there included. If the Ultra inbox file is deleted while the server runs, it is now made again through the same owner-only path.
- **A device looping wrong requests can no longer flood the terminal or the server.** A refused report is logged once a minute per address. Forwarding headers are shown only from tailscale serve's own socket, cut to 64 characters. Unknown phone keys are limited to 20 a minute per address, then 429. A key the server last read still gets through, so a phone's new link works while an old tab still asks with the retired key. The report port holds at most 256 connections, and phone keys are compared in constant time.
- **A live view that stops reading no longer fills the server's memory.** Every frame used to be buffered for a slow viewer, and part of a frame could be skipped. Each frame is now written whole, and a viewer still taking one skips the next frames until it catches up. At most 16 live views stay open, the oldest closing first, and a phone may send 25 pictures a second.
- **A phone picture is served as what it is.** Its type is read from the picture's own first bytes (JPEG, PNG or WebP), never repeated from the upload's header, which could name a web page after a comma. Other sites may no longer embed any Ultra answer.
- **A damaged device file no longer quotes itself into the log.** The parser's message showed the text around the fault, which can be a device password. The log now says only that the file is not valid JSON.
- **Names from other GEVCs stay on one line and in reading order.** Bidi overrides and isolates, C1 controls and line separators are removed from every name, label and place, and line breaks from everything but message texts. A right-to-left override in a peer's name would have shown the street after it reversed, in the relayed SMS too.
- **Street lookups for a call read at most a megabyte.** A larger answer counts as a failed lookup.

**Social Media hardening.**

- **The paid model and swarm routes refuse a DNS-rebinding page.** `/api/llm/ask`, the voice routes and `/api/social/swarm` compared the page's Origin with the Host, and a page on a name pointed at this computer passes that check. They now answer only a Host this server serves, an exact Origin when one is sent, and a same-origin fetch.
- **Ask, Overview and Risk Assessment take 20 questions a minute from one address.** A 21st waits a minute (429). Only a question that would be sent counts. `GEV_RATELIMIT_OPENAI_PER_MIN` still applies on top when set.
- **The public news lookup answers this page only.** Another site's image tag or a rebinding page could make it search from your address and use up the lookup's shared limit. It now refuses a cross-site request and a Host this server does not serve, and its answers are never cached or sniffed.
- **A phone number is no longer kept as a public handle.** Find My, Bump and Blink log in by phone number. One typed into the handle box would have gone to the news lookup and the model on every press. A handle of seven or more digits, with only phone punctuation between them, is refused, and one saved before is dropped.

**Four device fixes from the code review.**

- **NEW KEY keeps a device's fixed position.** It sent only the key request, and the save read the missing position as "remove it". The JSON paths of a polled device were cleared the same way. A field left out of a save now keeps what is saved. An empty box on the card still clears it.
- **Two Ultra packages no longer show each other's camera.** Every package's map card used to load the picture of whichever phone reported last. Each card now loads its own phone's picture, from `/api/ultra-help/picture/device-<package id>`. The live stream has the same per-package form, and the Ultra box still shows the newest phone.
- **A report dated in the future no longer blocks the reports after it.** A phone clock set ahead, or a time read in the wrong unit, made every true report after it look older and get dropped, silently, even after a restart. A future time now counts as now when a report arrives and when a saved report is reloaded, as the Ultra phone link already did.
- **The report port stays shut once the last reporting device is removed.** If the port was busy when the listener started, a retry still waiting could open it after the device was gone. Removing the device now cancels that retry. A start that ran out of retries no longer leaves the next start with none.

**Social Media Analysis has a Grok bot swarm and an OpenAI bot swarm.** Each swarm has an instructions box, its button, and OPEN GROK BOT or OPEN CHATGPT. A press sends seven bots at once, one each for X, Facebook, Instagram, Threads, TikTok, Truth Social and local news. The button reads SPINNING UP SWARM… until they are all back. Each bot is one request to the provider's Responses API on that swarm's own key in POWER UP (see below). Grok's X bot searches X itself with X Search. Grok's other bots use Web Search kept to that platform's own site, and OpenAI's bots do the same with web search. With the instructions box empty, every bot looks for threat incidents near the map place in the last 24 hours: crime, violence, fires, crashes, hazards, police or emergency activity, evacuations, severe weather and unrest. Typed instructions replace that task. Every bot is told to search public posts only and to report incidents and places, not people: it does not identify, locate or profile a private person, even when asked. It gives a link for every item and answers NOTHING FOUND rather than inventing anything. Each bot's list and links land in the log as it comes back, and the status line ends with SWARM DONE and the counts. Each press costs seven paid requests: xAI charges $5 per 1,000 X posts fetched and $5 per 1,000 web searches at the time of writing, OpenAI charges per search, and both charge for tokens. The route takes JSON from this page only and sends at most 14 bots a minute from one address. It gives each bot 150 seconds and stops a bot whose tab was closed. OpenAI's dots live inside ChatGPT, where OPEN CHATGPT takes you, and cannot be started from this console.

**A web page can no longer replace a saved social login.** The saved-logins route now answers only this machine's own page, the way POWER UP does: a loopback socket, a local Host, an exact local Origin, and JSON on a save. Before, a web page open in the same browser could send a plain form post to it and overwrite a stored login. It could never read one back.

**Two Ultra notes have new wording.** The HELP NETWORK note's last line now reads "Net Work activated when Tail Net + Ultra Encryption Token is released via HELP request." The note under PUBLISH MY TOKEN now says that anyone who can read the directory sees where your phone is and the threat type while you have pressed SEND HELP and have Network On.

**An Ultra token carries your location and incident type, and nothing else.** The page a token holder could open, its status and its message box are gone. A token now reaches one route: the location poll. It answers only "not now" until you press SEND HELP. Then it gives your name, position, times and incident type until STAND DOWN, and only while that token's Network is on. Every other path under a token gets the same 404 as an unknown link, and that 404 does not count against the holder's address. GENERATE NEW TOKEN no longer has SMS and Voice ticks. Token rows no longer have SMS and VOICE buttons or a message count. Those only worked the page. Existing tokens keep the two flags in the file, where the token's check covers them, but they open nothing. Your number (SAVE MY #) is never shown to anyone. It is where calls for help from your home list are texted, when an SMS relay is set up. Help messages already in your inbox stay until you remove them.

## September 30, 2026

**An Ultra token opens nothing unless its Network is on and SEND HELP is pressed.** Before, during a call, a token with Network off still opened its help-message page, its status and its message box. Now every route a token reaches needs both conditions. The location poll needs Network on and answers only "not now" until SEND HELP. A token with Network off answers the same 404 as an unknown link, and that 404 does not count against the holder's address. Its row in the box says OPENS NOTHING UNTIL NETWORK ON. Your location and incident type still go out only through the location poll, and only while both conditions hold. A GEVC that receives your call learns your name, position, times and incident, never a phone number. It texts only its own owner's SAVE MY # number. Your own link is never in your own home list, so your call is never relayed back to your cell. The phone link page now shows STAND DOWN all the time too. A tap with no call on ends nothing and says it stood down.

**STAND DOWN sits beside SEND HELP all the time, and the HELP NETWORK note names Hugging Face.** The Ultra box shows STAND DOWN next to SEND HELP whether or not a call for help is on. A press with no call on ends nothing. When the answer shows no call running on this machine, the status line says STOOD DOWN · NO CALL FOR HELP IS ON. A call another package still has keeps its own line. With no directory saved, the HELP NETWORK note says the directory can be on GitHub, Hugging Face or a private server, and that only https Tail Net links are accepted. Its last line, on a line of its own, says Net Work activated when Tail Net + Ultra Encryption Token is inserted. A Hugging Face file page or download address is read from its raw address. The download address answers with a redirect, and the directory is read with no redirect followed. No Hugging Face token is sent, so that file must be public.

**Encrypted Ultra tokens open only while SEND HELP is pressed.** The token section is SHARE ENCRYPTED ULTRA TOKENS. The skill headings are Your Gifts or Skills Encrypted into Token String and Your Custom Gifts or Skills Encrypted into Token String. The name field is Name of Ultra Token Holder. The SEND HELP note names the incident classification and the encrypted token holders. A token's page, status, and message box open only while that package's call for help is on. A stored flag that used to keep a token open is ignored, and a new token stores that flag false. The location poll still answers that nothing is released when Network is on and no call is running. With Network on, that poll carries the position and the incident classification to another GEVC. Social Media Analysis menus use dark letters on the light dropdown. The one-time location share option is gone. The map pin is still this device when SHOW ON MAP is ticked and a saved login is for a platform that shares location.

**A hooked-up account that shares your location shows this device on the map.** When a saved login on this computer is for Instagram, Snapchat, Apple Find My, Google Maps, Bump, Blink, or Life360, Social Media Analysis draws your live position from this browser and updates it as you move. SHOW ON MAP starts on. Uncheck it and the next visit stays off until you check it again. The marker is you. The password stays in the encrypted store. The console does not sign in, does not read anyone else's location, and does not send this position to the model, to Google, or to GDELT. If the browser will not share a location, the map is left as it is. A public handle, a nearby-people app, and a one-time share do not place the marker.

**Social Media Analysis sits on the left, and a login stays encrypted on this computer.** The box is the last member of the left stack, under CCTV. It still collapses the same way. For each platform in the account menu, the user id and password are sealed with AES-256-GCM under `config/social-accounts.key` and kept in `config/social-accounts.json`. A changed or swapped row does not open. The password is not shown again, and it is not sent to the model, to Google, or to GDELT. A user id that is a public handle is still included in the public-news lookup. An email stays in the encrypted store and is not sent to that lookup. The box still does not sign in, and it does not read private messages or private locations. Find Help still does not look up who is nearby.

**Social Media Analysis looks up public news before it asks the model.** Analyze, Breaking News, and Search ask this machine for public items about the current map place, then send those items with the question. The lookup uses Google News and, when that is empty, GDELT. It tries a public page the news index already lists on the platform's own site, then a news article that names the platform, then headlines about the place. The log says which of those three came back. If nothing comes back, or the lookup does not finish, the model is told that and told not to invent posts. Breaking News and Search use the past 7 days. Analyze uses the past 30 days. A saved public handle for the platform you picked is included in the lookup. Find Help still drafts the message and opens the official app. The box still does not sign in.

**Social Media Analysis is a box on the right rail.** It sits with Data Layers, Context, Sea Temperature, and Scenes, and it collapses the same way. A public handle can be saved on this computer for Facebook, Instagram, Threads, X, Truth Social, Snapchat, TikTok, and the location apps below. The box does not take a password or a key, and it does not sign in. Analyze, Breaking News, Find Help, and Search each send one question to a model that already has a key in POWER UP. The note you type is that question. Analyze, Breaking News, and Search also attach the public news items this machine just looked up. Analyze and Breaking News have a platform menu: all of them, or one. Breaking News is Facebook, Instagram, Threads, X, Truth Social, and TikTok. Analyze adds Snapchat. Search sends one question that covers the analysis menu, the news menu, and the location menu together. Find Help names Apple Find My, Google Maps, Snap Map, Bump, Blink, Life360, Radarly, Buzzly, Vicinity, NearJoy, Happn, Pure, Sniffies, Instagram Map, public check-ins on Facebook, Instagram, and X, and a one-time location share. Open leaves this console and opens that product's own site, where you sign in yourself. The question tells the model to stay on public information, not to invent posts, and not to enter a private account or locate a person who has not published where they are.

**Claude, Custom LLM, OpenRouter, Grok, and NVIDIA can run the same voice control.** The mic's provider control picks OpenAI, Claude, Custom LLM, OpenRouter, Grok, or NVIDIA. OpenAI stays on its realtime session. Grok opens its own realtime voice socket with a short-lived secret minted on this machine; the xAI key stays here, and the same map tools run in the browser. Claude and NVIDIA listen and speak with the browser's speech, and the chosen model's chat route runs the same tools. OpenRouter transcribes and speaks on its audio routes, then uses its chat route for the tools. A custom endpoint uses those same audio routes when it has them, and the browser's speech when it does not. A provider key that was changed and no longer matches its check is refused before anything is sent, with the same sentence POWER UP already uses. The OpenAI spend cap stays on OpenAI sessions. Grok, Claude, Custom LLM, OpenRouter, and NVIDIA are billed by those providers. A viewport screenshot stays on the OpenAI session.

**A changed report address, camera site, or OpenSky sign-in is not used.** The address a phone is told to report to, the public name beside it, and the listener certificate paths now have a check in `config/local-integrity.json`, under `config/local-integrity.key`. That check is written when you save a device. A status poll does not write it, and the home-list poller never writes it. Until you have saved a device, there is no check and the address is still shown. Change `DEVICE_REPORT_PUBLIC_BASE`, `DEVICE_REPORT_PUBLIC_HOST`, `DEVICE_REPORT_TLS_CERT`, or `DEVICE_REPORT_TLS_KEY` and leave the old check, and after the next start that address is left off the device card and the certificate is not loaded, until you save a device again. The port and the interface are not part of the check. The camera site file `config/private_cctv_feed.local.json` is checked when you save a camera. Until that save, there is no check and the file is still used. Change that site and leave the old check, and a camera picture is not fetched until you save a camera again. A relay that is already paired still answers. Which OpenSky sign-in is used is part of that provider's check. Change `OPENSKY_AUTH_MODE` and leave the old check, and the OpenSky key is not sent until you save OpenSky again from POWER UP. A check saved before the sign-in was part of it does not match until that save. Deleting the check file, or a canary that will not open, trusts the new value. A section with no check, while another section has one, is still trusted. A missing or invalid key file trusts them. An account that can replace both the key file and this check file, or change this program, is still outside what the check can do.

**A changed camera, tracked device, or provider key is not used.** Home and business cameras, drones, robots, marine drones, GPS trackers, and the provider keys saved from POWER UP now have a check under `config/local-integrity.key`, kept in `config/local-integrity.json`. That file holds only the checks. It is written when you save a camera, a device, or a key from POWER UP. A status poll does not write it, and the home-list poller never writes it. Until you have saved that setting, there is no check and the value is still used. Change a camera's address, login, certificate pin, or paired relay and leave the old check, and the picture is not fetched and the relay is not admitted. Asking to pair still waits for you. Where the map last put the camera is not part of the check. Change a drone, robot, marine drone, or tracker's address, picture address, or login and leave the old check, and it is not fetched and a report is refused. A phone package stays on its own check. Where the map last put the device is not part of the check. Change a provider key, or the address it is sent to, and leave the old check, and that provider is not used until you save it again from POWER UP. A hand edit of `.env` is not used after the next start until that save. A check file that cannot be read is left as it is, and while the key file is valid that section is not used. Deleting the check file, or a canary that will not open, looks like a setting that was never saved, so the new value is trusted: that is the hole a check stored beside the setting cannot close. One section with no check, while another section has one, is still trusted. A missing or invalid key file trusts them, and a save while the key file is invalid leaves that section's check off. Replacing the key and then saving one section makes the other sections' old checks fail until you save them again. An account that can replace both the key file and this check file, or change this program, is still outside what the check can do.

**A changed directory address, SMS relay, or phone package is not used.** The directory address and its write token, the SMS relay (Twilio and a gateway saved beside it), and each phone package's key, address, picture address and login now have a check under `config/ultra-tokens.key`, kept in `config/ultra-outbound.json`. That file holds only the checks. It is written when you save the directory from the box, the relay from POWER UP, or a device. A status poll does not write it, and the home-list poller never writes it. Until you have saved that setting, there is no check and the value is still used. Change the directory address or the write token and leave the old check, and UPDATE HOME LIST and PUBLISH MY TOKEN refuse and nothing is fetched or written. Change the relay, including a gateway that is saved while Twilio is the one sending, and TEST SMS and help texts refuse until you save the relay again from POWER UP. Change a phone package's key, address, picture address or login and leave the old check, and the phone is not admitted, its position and picture are not fetched, and a report is refused. Where the map last put the phone is not part of the check, so moving it on the map still works. A drone or a tracker is not part of the check. The box says which of the three was changed. A check file that cannot be read is left as it is, and while this key opens a seal the directory, the relay and the phone are not used. Deleting the check file, or wiping every check in it, looks like a setting that was never saved, so the new value is trusted: that is the hole a check stored beside the setting cannot close. One section with no check, while another section has one, is still trusted. A key that opens nothing still trusts them. A save while the key file is missing leaves that section's check off. Replacing the key and then minting a token makes the old checks fail until you save that setting again. An account that can replace both the key file and this check file, or change this program, is still outside what the check can do.

**A copied help token no longer takes the real one's place, and a deleted check is no longer written back from the flags in the file.** Two records with the same hash are both kept. The link follows the one whose seal still opens and whose check still matches. The other row says TAMPERED and offers only REVOKE and REMOVE. Deleting the check on one token while any other token still has a check answers the same 404 as a flipped flag, and that 404 does not count as a wrong guess. The next status load leaves that check missing. Editing a row that says TAMPERED is refused; REVOKE and REMOVE still work, and minting another token does not fill the missing check in. A file in which no token has a check yet still admits, and the next status load or holder request fills the check in from whatever the file says then. Wiping the check on every token looks the same as that older file, so those flags are trusted: that is the hole a check stored in the token file cannot close. A seal that will not open is still admitted while this key opens nothing else in the file, which is what deleting or replacing the key looks like. Once any live token's seal opens under the current key, a live token whose seal will not open answers 404. Replacing the key and then minting a new token therefore stops the older links. A revoked token whose seal will not open stays revoked. An account that can replace both the key file and the token file, or change this program, is still outside what the check can do.

**A changed home-list address is not polled, a changed helpers file is not used, and a changed help message is not shown.** Each home-list entry now has a check under `config/ultra-tokens.key` over its id, the address it is polled at, and the hash of the token sealed there. Change that address and leave the old check, and the opened token is not sent there, including while a call is still running; the row says TAMPERED. Adding another link does not fill that check in. Deleting one entry's check while another entry still has one does the same, and a later add leaves it missing. A home list in which no entry has a check yet is still polled, and the next owner write fills the checks in from whatever the file says then. Wiping the check on every entry looks the same as that older file, so a changed address is trusted on the next poll: that is the hole a check stored in the home list cannot close. Pasting a copy of an entry above the real one, with a different address, is not fetched, the row says TAMPERED, and the real later row is gone until it is removed and added again. A new id carrying a copied seal is not fetched either, and drops the real row. The home list is still written only by an owner action, never by the poller. The helpers file has one check over the saved number, each helper, and each stored call, not the phone model. A file with no check is still used, and the next save of the number, a helper, or the phone model fills the check in. Change the number or plant a call and leave the old check, while this key opens a seal, and the file is not used for texts or for reloading a call: nothing is texted to the rewritten number, and the box says the helpers file was changed and is not being used. The next save replaces the file with what the box is showing and writes a new check. A save while the key file is missing leaves the check off. Each help message has a check over the text and the fields the box shows. A message whose check fails is not shown, counted, or read aloud when another message still has a check, or when a seal on this machine opens. A file in which no message has a check is still shown and read. Wiping every message check looks the same as that older file. A change this program makes to a message writes a new check on that message. Replacing the key so it opens nothing still trusts the home list, the helpers file, and the inbox. An account that can replace both the key file and those files, or change this program, is still outside what the check can do.

## September 29, 2026

**Share help tokens can carry skill sets, and Encrypt hides that list inside the token.** GENERATE NEW TOKEN now has the thirteen named skill sets (Doctor, Paramedic, First Responder, Lifeguard, Firefighter, Search and Rescue (SAR) Specialist, Brave, Strong, Crisis Counselor, Enforcer, Animal Control, Hazardous Materials (HAZMAT), Ranger), five custom skill boxes, and an Encrypt tick. Leave them all off and the token stays the short `uht1.` plus 43 characters it has always been. Tick any skills and those codes are written into the token string after `.s.`, in catalog order, then up to five custom slugs; the link still admits only with that whole string, so stripping or rewriting the skills makes a different token. Encrypt seals the same list under this machine's token key inside `.e.` instead, so a copied link does not spell the skills out; the row here still shows them, and another GEVC that is given the link sees ENCRYPTED and not the names. Skills are fixed when the token is made. A custom name is cut on a word to what the link can carry (24 characters); a word that fits inside that budget is kept. The row shows that short name, and the line under the boxes says so before the token is made. Two different names that would become the same code are refused, and GENERATE does not send a custom list it already knows will be refused. A code the string cannot carry refuses the mint instead of being dropped, and named skills are written in catalog order.

**While the token key still opens the seal, a flag edit in the token file is refused.** Each help token now has a per-record check under `config/ultra-tokens.key` over its name, package, SMS, Voice, Network, Anytime, directory-only flag, encrypt flag and revocation. Change one of those in `config/ultra-tokens.json` and leave the old check in place, and the holder gets the same 404 as an unknown link. That refusal does not count as a wrong guess. The row says TAMPERED and offers only REVOKE and REMOVE. A token file in which no token has a check yet still admits, and the next status load or holder request fills those checks in. Skill names are read from the opened token. The token file keeps the encrypt flag and an empty skill list. At most 200 help tokens are kept, counting revoked ones; minting another asks you to remove one. The holder page sends `X-Frame-Options: DENY` and a content security policy that forbids framing. Losing the key file, or replacing it, still admits existing links by hash while that key opens nothing in the file: the check runs only when the current key opens the seal. A JSON array is not accepted as a request body.

**SEND HELP: every package keeps its own call, an old position is never sent as where you are, and the phone asking for help stays silent.** A review of the Ultra box found six serious faults in SEND HELP; all six are fixed, and a second review of the fixes found sixteen follow-ups, fixed with them.

- **One call per package.** The machine used to hold one call for help for everything: a second package pressing SEND HELP replaced the first package's live call, its holders were told it had ended and its phone said "Help window ended". Now each package has its own call (`releases` in `config/ultra-help.json`; a file holding the old single `release` still loads, and the next write moves it). SEND HELP, EXTEND HELP and STAND DOWN act on one package only. With more than one package saved, the box shows a package choice beside SEND HELP: it follows the newest call until you pick one, marks a package whose help is on (`· HELP ON`), and says when another package is also asking for help. A package removed from Your Devices ends its call; if the device list cannot be read, no call ends and each one stays in the box (`· REMOVED`), where STAND DOWN still reaches it.
- **The box acts on the package it names.** The desktop's SEND HELP and EXTEND HELP used whichever phone had reported last, so EXTEND on one package's call could end it and broadcast another package's position. Now the press names its package (or, with one saved, uses it; with one call running, renews that one), and uses that package's own phone. EXTEND from the box keeps the call's incident instead of taking whatever the FIND HELP select shows; on the phone the incident list follows the running call, so EXTEND there does not quietly turn a THREAT into OTHER.
- **No stale position.** SEND HELP could publish a fix of any age — a phone that last reported yesterday — stamped with the time of the press, and put it in the plea to your helpers. A new press is now refused when the package's last position is more than 20 minutes old (the rule Find Ultra Help already used), with a sentence naming its age. The phone page asks for a fresh fix (eight seconds at most) when its last one is over a minute old and sends the fix's age; a saved report is dated by when its fix was taken, not when it arrived; a device time in the future or a report with no time is held as now. EXTEND HELP of a running call is never refused, and after a restart it renews at the call's own position.
- **EXTEND really extends.** Receivers read an answer whose `at` is more than four hours old as over, and EXTEND without a new fix never moved `at`, so every helper's box ended an extended call about four hours after the first press and announced "stood down". A release now records `renewedAt`, and the answer's `at` is the latest of the press, the last EXTEND and the fix.
- **The phone asking for help stays silent.** The two SEND HELP taps also switched the page's voice on, so it then read out "Text your helpers" and every holder's message, THREAT included. Now the SEND HELP row never switches the voice on; from the committed second tap until STAND DOWN the page never speaks, stops anything it was saying, and for a THREAT neither vibrates nor keeps vibrating. Whether the call is on comes from the map's answers, not from comparing the phone's clock with the map's, and a poll sent before a press was answered cannot undo it. STAND DOWN tapped while the phone is being found wins over the press.
- **The SMS line tells the truth.** It said ALREADY TEXTED when nothing had been delivered: a failed text kept its ten-minute cooldown and any refusal read as already texted. Now it is built from what happened to each helper's number: SENDING, SMS SENT HH:MM, SMS SENT 2/3 · 1 NOT SENT, the failure (SMS FAILED: …) or the limit (SMS NOT SENT: DAILY LIMIT / HOURLY LIMIT). A failed text can be tried again a minute later, by EXTEND or a new press, and gives back its place in the day's and the hour's count (a timeout keeps it, since it may have gone), so pressing again during an outage never uses up the day.

Verified: `npm test` — 4,479 tests, 4,472 pass, 0 fail, 7 skipped. New tests cover two packages pressing and standing down independently, the box's package choice (following a new call, the owner's pick, a removed package, EXTEND keeping the incident), stale, untimed, future-dated and late-batch fixes, EXTEND after a restart and across the four-hour mark on a receiver, a failed text retried a minute later and an outage that does not spend the day, and the phone page's own script run against a stand-in page: silent through a THREAT press, a call started from the box, a stale poll and a skewed clock, the incident kept on EXTEND, and STAND DOWN winning over a press still finding the phone. Format and build clean.

**The group directory is location only, nobody is shown your number while you ask for help, and eight more help-network faults are fixed.**

- **Directory tokens reach nothing but the position (owner ruling).** Whatever you publish to the group directory is now location only, for good: everyone who reads the directory gets the position poll (`/network`) and nothing else — no holder page, no `/status`, no message box — even while you are asking for help, so nobody in the group can write to your phone during a call. The token PUBLISH MY TOKEN makes for you is minted that way (`locationOnly` in `config/ultra-tokens.json`, shown as LOCATION ONLY (DIRECTORY) in its row), and a token you choose to publish becomes so when you publish it. PUBLISH accepts only a token with SMS and ANYTIME off; the dropdown offers only those, and DIRECTORY TOKEN (made for you) no longer quietly republishes one you picked earlier that has either on.
- **No "Text <you> directly" link during a call (owner ruling).** While your call for help is on, no holder's `/status` carries your number, whatever the token's SMS or ANYTIME ticks, so the holder page has no link that would text the person in trouble. A holder page opened before the call asks again every 20 s and drops the link when the call starts; an ANYTIME token shows the number again after STAND DOWN.
- **Published and shared NETWORK links carry your tailnet address.** They used the listener's first address, which is often a LAN one every receiver refuses, and still said PUBLISHED. Now PUBLISH and the link of a NETWORK token use the first https `*.ts.net` name (else a `100.64.0.0/10` address); with neither, PUBLISH says to set `DEVICE_REPORT_PUBLIC_BASE`, and the token note says where NETWORK links point (or that they cannot reach anyone yet) instead of promising the LAN works.
- **A dev-server restart no longer loses what the phone was about to get.** A POWER UP save or SAVE DIRECTORY restarts the dev server, which loads the Ultra code afresh; the cards waiting for the phone (the plea for your helpers among them), the camera/SMS command, the last fixes, each package's call and the SMS ledger now live beside the process (`globalThis`) and carry over. A full `npm run dev` restart still starts them empty.
- **STAND DOWN takes back the plea card.** A card the phone had not popped yet would appear, buzz and ask to text your helpers hours after you stood down. STAND DOWN now removes it, so does the end of the call's window, and EXTEND replaces a waiting card instead of adding a second. Past twenty queued cards, messages go before an SMS card.
- **Find Ultra Help's text cannot be replaced by a camera button.** It shared the phone's one-slot command with the camera switch; it now goes in the card queue.
- **Unticked numbers stay unticked.** Find Ultra Help's list was rebuilt on every 3-second poll, ticking again every number you had unticked, so Send Ultra Help texted them all. It is now rebuilt only when the search result changes.
- **Removing an old NEEDS HELP row no longer hides that person's next call.** Removing a row that had ended long ago restarted the ten-minute quiet gap, so a brand-new SEND HELP from that person inside it raised nothing. Only removing a row that is still running does now.
- **MOVED clears, and never switches off your own links.** A directory entry flagged MOVED stayed flagged, and unpolled, even after the directory agreed with it again, and a link you had added by hand was switched off whenever the directory listed the same token elsewhere. The flag now clears when the directory agrees, and a hand-added link is never switched off: its row says DIRECTORY LISTS ANOTHER HOST, and it goes on being polled where you put it — also when a pull re-links it after the key file was lost, which used to take the directory's host.
- **Found by a second review of these fixes, and fixed.** Your number is withheld while any call on this machine is on, not only one on the token's own package (the number is one per machine). While you are asking for help, a call from someone in your home list still shows in the box and, silently, on the phone, but the relay does not text your own cell: the row says SMS HELD: YOUR CALL IS ON. A holder page fails closed: a refresh that cannot reach the map, or a number not confirmed in the last 25 s (a page the phone put to sleep), hides the direct-text link. With more than one package saved, PUBLISH MY TOKEN shows which package a new directory token follows (it used to fail with "Choose which package" and nowhere to choose), and never reuses another package's token. A link to a bare `100.64` address is published only over plain http, since no certificate can name it. A STAND DOWN whose first save was refused is saved again by a later poll, so a dev-server restart cannot bring the call back (a full `npm run dev` restart while the file still refuses the write reloads what the file holds; see the entry below). A newer Find Ultra Help Send replaces the card the phone has not popped, and the card just queued is never the one dropped. The box's notes, the SAVE MY # hint and `.env.example` now say what these rules do.

Verified: `npm test` — 4,495 tests, 4,488 pass, 0 fail, 7 skipped. New tests cover a directory token answering only `/network` during a call, the number withheld during a call and back after it, a holder page losing its link when a call starts, a token made location only by publishing, PUBLISH refusing without a tailnet address and choosing it among LAN and `100.64` ones, NETWORK and message-only token links, SMS/ANYTIME tokens refused, the plea card taken back by STAND DOWN and by expiry and replaced by EXTEND, a burst of messages not pushing it out, a fresh copy of the module keeping the phone's card and the call, Find Ultra Help's text surviving a camera switch, an untick surviving the poll, removing an ended row then a new call raising a row at once, and MOVED clearing and never switching off a hand-added link. Format and build clean.

**Twenty-nine smaller Ultra faults fixed: every saved helper gets a text, no disk error can refuse SEND HELP, and the docs match the code.** The low-severity findings from the Ultra reviews were checked again against the code and fixed in five groups, each fix with a test that fails without it. A review of those fixes then confirmed sixteen follow-up findings (some one fault found twice), fixed here the same way and folded into the bullets below: a STAND DOWN the disk refused coming back after a dev-server restart or waiting for the box to be open, a helpers file fixed by hand losing its call, friends' calls taking your share of the relay's hour, two links to one call raising a second row after a restart or freezing when the carrying link went quiet, a late street lookup moving a row back, the phone page keeping every plea card, the holder page's stale count, the box scrolling back to a clicked button, a moving call repainting every help message, a POWER UP relay row losing REMOVE, and three sentences in these notes and the current-state notes that promised more than the code does.

- **Texts, the saved call and PUBLISH.** Of the fifty texts a day, the last twenty (it was ten) are kept for your own SEND HELP, a whole PREDEFINED HELP # list, so friends' calls and TEST SMS now stop at thirty, and at forty of a provider host's sixty an hour, and a busy day or hour can no longer leave any of your saved helpers untexted. After a full `npm run dev` restart a call reloaded from the file said SENDING for the rest of the call; since what was texted is memory only, it now says SMS: NOT KNOWN SINCE RESTART, and EXTEND HELP brings the real line back. A friend's call with a relay set up but no SAVE MY # said NO SMS RELAY; it now says NO SMS: SAVE MY # FIRST. A refused write of `config/ultra-help.json` (a locked or read-only file) refused SEND HELP and STAND DOWN with a 409; now the press takes effect at once, the terminal says so once (an error code, nothing else), and the box's status poll, the phone's own poll or the home-list poller's tick writes it again at least 15 s later, so a STAND DOWN made on the phone with no GEV tab open lands too. A dev-server restart in between (a POWER UP save, SAVE DIRECTORY) keeps the STAND DOWN and never reads the file back over it; a full `npm run dev` restart while the file still refuses the write reloads the call the file holds, which nothing in the app can prevent. A helpers file that could not be parsed read as empty, and the next save wrote that empty list over your helpers and number; it is now never written over (saving helpers, your number or the phone model answers 409 with a sentence until it is fixed by hand) while SEND HELP and STAND DOWN still work; once it is fixed the call it holds loads again, except for a package pressed meanwhile, and a byte-order mark left by a Windows editor is read rather than taken for an empty file. A peer whose position changed on every poll queued a street lookup per poll; it now holds one place in the lookup queue and the row ends at the newest position, and a street that lands after the peer has moved on sets only the address, never taking the row or its pin back (a row more than 50 m on reads its coordinates until its next lookup). PUBLISH clicked twice while GitHub was answering made two tokens and two directory entries; it now makes one.
- **Receiving a call.** A directory pull adds at most eight polled links to any one machine (`ULTRA_NETWORK_HOST_ENTRY_LIMIT`, the port ignored), so rows a directory invents for someone's machine cannot spend the requests that machine allows yours; a link you add by hand is never capped. A link flagged NOT IN DIRECTORY or MOVED in the middle of a call was no longer polled, so its STAND DOWN was never heard; it is now followed at its old, already-trusted address until the call ends, never at the new host. A call outlived its real end when the other machine dropped off the tailnet; what is left of it is now measured on that machine's own clock (the HTTP Date header on its answer), so it ends here when it ends there. A REMOVE the disk refused still ended the call its row carried; the call now ends only once the file is written. Two links to one person's call (one pasted by hand and the directory's, say) raised two rows, two cards and two texts; they now raise one, matched on the same machine and the call's exact window end, while another package on that machine, which is another person, still raises its own. The match survives a restart, and when the link carrying the row stops hearing the call, the row moves to the link that still does and ends with it rather than freezing at NEEDS HELP. A street lookup that failed was kept as the address for good; it is asked again a minute later. An ADD, SET NAME or RENAME saved while UPDATE HOME LIST waited on the directory was lost when the pull finished; it is now kept, and a pull whose own write is refused rolls back to the list on disk.
- **The phone and holder pages, and the box's voice.** On a phone browser from before 2022 (no `AbortSignal.timeout`) SEND HELP failed before it was sent and said "no connection"; it now goes, with the same 15-second bound from a controller, and that timeout reads as one. The phone link opened as `/cam/` (or with a doubled slash) polled and pressed the wrong address; it now works under its key whatever the spelling. The phone page keeps ten cards as the map's queue does, so a burst of messages no longer pushes the plea card off the screen; through an EXTENDed call only the newest plea is held back, the older ones ageing out like any other card, and after STAND DOWN the last one ages out too. A holder page whose link closed while they typed (STAND DOWN, the four hours, or the link switched off; the page cannot tell which, on purpose) used to replace itself with "not valid any more" and lose the draft; it now keeps the draft, says the call has ended or the link was switched off, and works again when the owner next asks for help, showing as many messages left this hour as the map allows. Its heading reads "Message <name>", which fits a helper as well as someone asking. The box no longer reads a new call for help aloud with bare coordinates and then says nothing when the street lands: the row still shows at once, and the voice waits for the address, six seconds at most.
- **The box's buttons say what happened, and its rows hold still.** A SEND HELP, STAND DOWN or any other press that got no answer from the dev server (stopped, or restarting after a save) showed nothing at all: the line kept the phone's position and SEND HELP looked unpressed. It now says HELP NOT SENT (STAND DOWN NOT SENT, or Not sent) and asks for the press again; nothing is retried by itself. That sentence, and SAVE DIRECTORY's own (refused, no answer, or saved and restarting), now stays on the status line for fifteen seconds through the polls, failed ones included; the next poll used to paint the phone's position, or an older refusal, over it. RENAME no longer locks the link box, and lets go of the form when the rename is refused or its row goes; a rename of a row just removed used to leave the form saying RENAME, with no way to paste a link. ANYTIME is unticked after the token it made, so the next token is not always open by accident. The help messages, tokens, home list, saved helpers and phone link are compared row by row, and only a row whose text or buttons changed is replaced, so the three-second poll no longer takes the keyboard focus off a button or swallows a click pressed across it (a call's distance changing as you drive repaints that call's row alone); a row that does change gives the focus back to the same button or link (OPEN IN SMS, TEXT BACK), without scrolling the box back to it.
- **GENERATE NEW TOKEN.** Owner request: the token button under SHARE HELP TOKENS reads GENERATE NEW TOKEN (it was NEW TOKEN), says GENERATING… while the token is made — a second press then is not a second token — and GENERATED for two seconds once it is, when it can be pressed again at once. A refusal puts it back straight away, with the reason on the status line.
- **POWER UP, the dev server and the docs.** POWER UP took an SMS relay value the relay would never use (a from-number without + and the country code, a gateway on a LAN or `*.ts.net` address over plain http, a user:password in the gateway address, an account SID with a dash), counted the relay as set, and the box said NOT CONFIGURED; it now refuses such a value with a sentence naming the rule, never the value, and a hand-edited `.env` value the relay cannot use reads as not set, so POWER UP and the box agree; its row keeps REMOVE (or its configured externally badge) and marks which value is saved but not usable, so a value saved before the rule can still be replaced or removed there. Every in-process restart of the dev server (a POWER UP save, SAVE DIRECTORY) armed another launcher watch — a 2 s timer, a PowerShell process scan and more stdout and exit listeners — and the watch then closed the first server rather than the live one; it is now armed once per process and closes the live server. The POWER UP setup card and the README said a help link lets its holder message you at any time; both now say a link is dark until you press SEND HELP unless its ANYTIME tick is on, the Anytime tick explains itself on hover, and the SEND HELP confirmation names that package's token holders rather than every holder. The docs said a received NEEDS HELP pin is never recorded; a package of yours with RECORD on does capture it among its surroundings (the caveat in the September 28 entry), and they now say so. The September 28 entry and the current-state notes said the poller takes four links at a time (four a tick, rising to sixteen in flight on a long list), that the `/network` answer reads no file (admission re-reads the token and device stores, on purpose), that PUBLISH leaves the rest of the directory file untouched (it is rewritten as 2-space JSON) and that a row can read a state no poll produces (a link whose owner switched NETWORK off reads LINK DEAD (404), the same answer as a revoked one); all four are corrected, and `.env.example` gives the relay's day as fifty with the last twenty kept for your own call, and its host-hour as sixty with the same twenty kept. The current-state notes also said a failed text is retried a minute later by itself and never counts toward the day; they now say EXTEND HELP or a new press tries it again, and a timeout keeps its place in the count.

Verified: `npm test` (`node scripts/run-unit-tests.mjs`) — 4,543 tests, 4,536 pass, 0 fail, 7 skipped, and both allocation probes pass (1 and 13 tests). New tests cover a full helper list texted after friends' calls spent their share, the SMS line after a full restart, a refused save and an unparseable helpers file that no longer refuse SEND HELP or STAND DOWN (and a byte-order mark read as a file), PUBLISH clicked twice, a moving peer holding one place in the lookup queue, the eight-link cap per machine, a flagged link followed to its STAND DOWN, a call ending on the other machine's clock after it drops off, a refused REMOVE, two links to one call, a failed street lookup asked again, owner actions kept through UPDATE HOME LIST, the phone page on an old browser and under `/cam/`, the plea card through a burst of messages, the holder page after STAND DOWN, the voice waiting for the street, rows and focus through the poll, RENAME, HELP NOT SENT, SAVE DIRECTORY's sentence, ANYTIME after a mint, POWER UP agreeing with the relay, one launcher watch across re-evaluated copies, the setup card and README on dark links, what RECORD keeps, and the docs' poll and SMS figures against the code. One of them failed about one run in five: a street lookup still waiting its second in the lane when the module was pointed at another checkout went out through the new checkout's fetch; it is now dropped, with a test of its own. The follow-ups add tests for a refused STAND DOWN surviving a fresh copy of the module and reaching the file from the phone with no GEV tab open, a helpers file fixed by hand, friends' texts across midnight leaving your share of the hour, two links to one call across a restart and a link that stops hearing, a late street lookup, the phone page through an EXTENDed call, the holder page's count, the box's focus kept without a scroll and a moving call repainting one row, a POWER UP relay row keeping REMOVE, and the docs' retry, restart and hourly figures. Format clean.

## September 28, 2026

**A box you are reading no longer jumps back to the top.** Scroll down inside the Ultra box or CCTV and, a moment later, you were back at the top — every time the rail re-measured, which for Ultra is every three seconds. The cause was not the panel painters: a layout pass has to drop each box's allocated height to read the height its content actually wants, and with that height gone the box stops overflowing, so the browser sends its scroller to 0. Putting the height back does not undo that. Measured before the fix: Ultra set to 875 px read 0, 0, 0, 0, 0 over the next eight seconds; CCTV set to 163 px did the same. Both rails now record where every scroller inside a box is sitting before they take any height away, and put them back once the heights are written — Ultra holds 875 and CCTV holds 142 across five passes. The right rail had carried a one-off version of this for the Display panel since before the change, with a comment naming the cause; that special case is kept and the same care now covers every box on both rails.

**An open box uses the whole screen, over the HUD, and the boxes stack like windows.** Owner ruling, 2026-09-28. Until now a box was squeezed into the gap the tactical HUD left it — the layout measured HUD furniture as an obstacle and shortened the lane, so opening a box gave you a tall tab and a short window. Now, the moment a rail has something open, that rail's lane becomes the screen itself less a two per cent inset at each end, and the open boxes draw over the HUD at the top and the bottom. Measured at 1600×900 with the tactical HUD on, the Ultra box went from the old 295 px lane to 798 px — 226 px higher and 259 px lower than the old corridor stopped, two and a half times the working area — and where it covers the title bar and the HUD corners, a hit test at those points lands inside the box, so it is genuinely in front rather than merely larger. The one thing still allowed to bound the lane is the map attribution, which may not be covered. Open boxes also stop halving the lane with each other: each takes the height its own content wants and they overlap, cascaded so a strip of every box stays exposed, and clicking any box brings it to the front and keeps it there until you click another. A box that is merely repainted never moves. Two consequences worth knowing. A raise slides the box you clicked down one 40-pixel step for each box it passes (at most 200 px with six open) and slides the one it passed up, because the box in front has to be the one that starts lowest or the box behind loses the strip you click it by; its size never changes. And that step is 40 px rather than something tighter because the deepest collapse button in the app sits 39.7 px below its box's top edge — any less and a box behind another could be raised but not closed. On the right rail an open box starts at y=308 rather than the 302 the HUD used to allow, because its own column of collapsed tabs is taller than the HUD was; the 2026-09-27 ruling keeps those tabs visible and clickable, and that wins.

**Two tokens are never the same token, at any number of users.** A token is thirty-two bytes — 256 bits — straight from the system CSPRNG, and that is the whole of the uniqueness argument: by the birthday bound the chance that any two of n tokens collide is about n² / 2²⁵⁷, so at a hundred billion people holding ten tokens each (a thousand billion tokens) it is about 2⁻¹⁷⁷, one in 10⁵³. There is no counter, no central registry and no coordination between installs, which is exactly what lets two people who have never met hand tokens to each other and still never clash. What that argument does rest on is the generator, so the generator is now policed: a draw whose bytes are all one value — the shape a CSPRNG takes when it has failed, or when a stub has been left in by accident — is refused and redrawn rather than handed out as a secret, and a mint that somehow produced a token this machine has already issued redraws too and then says so plainly instead of issuing it. The redraw loops for the record id and the home-list entry id are bounded for the same reason: against a generator stuck on one value they used to spin for ever rather than report the fault. A test draws a hundred thousand real tokens and checks that none repeats and each is a full 32 bytes, and another replaces the system generator with one returning a run of zeros and then of 0xff and checks that nothing is minted from either. While proving that, the feed and token caches turned out to key on the file's timestamp and size, and rotating a report key rewrites a file of exactly the same length. Two writes inside one clock tick were therefore indistinguishable and a retired key could still be admitted — nanoseconds did not save it either, because Windows hands out the same mtime for about fifteen milliseconds at a time. Both caches now use the file's own contents as the stamp: the read is a few kilobytes from the page cache and only the parse is skipped when nothing changed. The retired-key test had been passing on timing luck and failed about one run in five before this; it is clean over eight consecutive runs now.

**A help token is dark until you ask for help.** Owner ruling, 2026-09-28, and the rule the rest of this entry now sits under: holding one of your tokens tells the holder nothing and reaches nobody until you press SEND HELP. The page, what it says about your package, your number and the message box all answer the same `404 Not found` the rest of the time — so a token in someone's hands is not a standing line into your phone, it is a credential that comes alive when you ask and goes quiet when you stand down. One route is deliberately exempt: the location poll keeps answering `{"released":false}` on its twenty-second cadence, because a subscriber's own server reads a 404 as a dead link and backs off for ten minutes, and would then miss the call it is waiting for. A token ticked **Anytime** (off by default, on the NEW TOKEN form and as ANYTIME ON/OFF on every row, and shown in the row as ANYTIME or ONLY WHEN ASKING) keeps the older always-open behaviour for anyone you want to be able to reach you unprompted. Nothing minted before this reads as Anytime.

**SEND HELP: the people holding your help tokens see where you are, and only while you ask.** The Ultra Security Package box gains a SEND HELP block at the top and a HELP NETWORK section at the bottom, and the phone link page gains the same press. One press releases this phone's position and one incident word (THREAT, FIRE, MEDICAL or OTHER; on the desktop it comes from the FIND HELP select, on the phone from a four-way list beside the button) to every one of your help tokens marked NETWORK, for four hours, until STAND DOWN, whichever comes first; EXTEND HELP renews the four hours and refreshes the fix. It is a subscription, not a broadcast: the holder's own GEVC polls `https://<your machine>.<tailnet>.ts.net/ultra/help/<token>/network` every twenty seconds, gets `{"released":false}` every time until you press, and then gets exactly your name, latitude, longitude, when the release last changed, when it ends and the incident word — no free text, no reply channel, no camera, no picture, no history, no other access rides that route. Tokens minted before today read NETWORK off, so no existing holder gains your location by upgrading; the tick is on for a new token, and NETWORK ON / NETWORK OFF on any token row changes it. On the receiving side each call for help becomes one HELP MESSAGES row (`JEFF · NEEDS HELP · 10 Example St, Saint John, New Brunswick (45.2744, -66.0622) · 22:14`, with the distance from your own phone when it is known, and ENDED and the time when the window closes), with the plea composed on the receiving machine underneath it, spoken aloud by the same read-aloud tick, an OPEN IN SMS link that is addressed to nobody so the helper can forward it to 911 or a neighbour, a MAP button that flies the globe to an amber pin on the Your Devices layer, and REMOVE; the same card pops on that person's own phone link page within a second, vibrating on a pattern of its own and speaking the plea. Nothing is ever addressed back to the phone of the person in trouble. The same press also keeps the original Ultra SMS detail: your phone gets a SEND SMS TO n HELPERS card whose one tap opens the composer with all of your PREDEFINED HELP # numbers and the plea in it. HELP NETWORK is where the links live: SAVE MY NAME (what your holders see), ADD TO HOME LIST (paste a help link someone gave you; only https `*.ts.net` addresses and `100.64.x` tailnet addresses are accepted), rows showing name, host, DIRECTORY or MANUAL and what the last poll said (WATCHING, NEEDS HELP, LINK DEAD (404), UNREACHABLE, BUSY (429), NOT IN DIRECTORY, MOVED; a link whose owner switched NETWORK off reads LINK DEAD (404), by design the same answer as a revoked one) with RENAME and REMOVE, CHECK NOW, and a directory for groups: SAVE DIRECTORY takes the https address of one shared JSON file of `{ name, link }` entries, UPDATE HOME LIST merges every valid entry it holds, and PUBLISH MY TOKEN writes your own entry into it through GitHub's contents API when a write token is saved, or hands you the entry to copy or email when it is not. Finally, optionally, a real text message: with Twilio or your own https gateway configured under POWER UP → SMS RELAY, a call for help you receive is texted to your own cell and your own SEND HELP texts your saved helpers without a tap. **That relay costs you money, at your provider's per-message rate, for every message it sends**; with no relay configured nothing is sent by any machine and every sms: link still only opens a messaging app, as before.

How it works. A token record gains `network`, coerced from `network === true`, so anything older or malformed reads off. `GET /ultra/help/<token>/network` sits on the report listener beside the holder page: address budget (60 a minute), miss budget (20 a minute), then the same constant-time hash admission as the rest, and a token whose NETWORK flag is off gets the same uniform `404 Not found` without spending a miss, because a valid token simply has no such route. Admission re-reads the two small stores (`config/ultra-tokens.json` and `config/device-feeds.json`, each file its own cache stamp, so a revocation or a key rotation is never missed); past that the answer is built from memory and carries the phone's latest fix when it is newer than the one recorded at the press. The phone's own press is `POST /ultra/<key>/help` under the phone key, six a minute, `415` before the body is read, `413` over 4 KiB, `400` for anything that is not JSON, `409` when no position has ever arrived; a pocket tap cannot publish anything, since the button asks for a second tap within five seconds ("TAP AGAIN TO SEND HELP"). The desktop's own presses are `POST /api/ultra-help/release` and `POST /api/ultra-help/network`, which answer this machine's own page only and refuse edits under `vite preview` like the token routes. The release itself lives in `config/ultra-help.json`, so a restart keeps it and an expired one reads as null. The home list is a new file, `config/ultra-network.json`: other people's bearer tokens, each sealed with AES-256-GCM under the same write-once `config/ultra-tokens.key` with its own associated data, beside the token's SHA-256 hash, the base and the host; it is git-ignored, written only by an owner action through the credential-store path, refused by vite's `fs.deny` and by the device-feeds store guard in every URL spelling, and the poller never writes it at all. Decrypted links live in memory and are never painted, logged or sent to the page; only hosts are shown. The poller re-parses and re-checks each link against the tailnet rule immediately before the call, sends no cookie, no Referer and no Authorization, follows no redirect, gives up after five seconds, stops reading at 4 KiB, runs four a tick, rising to sixteen in flight on a long list, oldest-due first, and backs off from twenty seconds by doubling to ten minutes (a 404 waits ten minutes, a 429 one). Every field that comes back is treated as hostile: numbers must be real, finite, in range and not 0,0, strings are cleaned and capped, the incident must be one of the four words, and what is left of the window is measured on the peer's own clock (the Date header its server puts on every answer, or their `at` when there is none), then re-based on this machine's and clamped to four hours, with a two-minute margin for theirs, so a call whose machine drops off the tailnet still ends here when it ends there. The address under the position is looked up on the receiving machine through the existing Nominatim path, one request a second at most, and the row reads coordinates alone when that fails and asks again a minute later (not on every poll); the plea is written locally by the same sentence builder Send Ultra Help uses. Each episode is one inbox row, and rows still open are resumed at start-up, so a restart neither duplicates a row nor re-notifies. Two links to one call (one handed over by hand and the directory's, say) raise one row as well: the second follows the first quietly, matched on the same machine by the call's exact window end, so another package on that machine, which is another person, still raises its own. The map pin is the same Your Devices layer: `ultraNetworkPins()` is appended to `/api/device-feeds/positions` from memory, is never written to the device store and is never followed by the camera. One caveat worth knowing: because the pin is an ordinary device on that layer, a security package of yours that has RECORD switched on can capture it among the surroundings it saves under `config/device-recordings/`, so a friend's call for help can end up in your own recording like anything else the map was showing. The directory is read only when you click: https only (a github.com blob address is rewritten to raw), ten seconds, 256 KB, at most 500 entries, each entry judged on its own, duplicates by token hash dropped; a merge adds and renames but never deletes, flags an entry whose host changed as MOVED rather than following it (a rewritten host would hand that person's token to whoever rewrote the file), and marks entries that vanished as NOT IN DIRECTORY instead of removing them, so a maintainer's mistake or a hijacked file cannot wipe your list; a call already running through a link that gets either flag is still followed at the address it was trusted at until it ends, so its STAND DOWN is heard. A pull adds at most eight links to any one machine, counting the ones already polled there, so rows a directory invents for someone's machine cannot use up the 60 requests and 20 misses a minute that machine allows yours and get the real link refused in the middle of a call; a link you add by hand is never capped. PUBLISH keeps every other element of the file (the file is rewritten as 2-space JSON, so spacing and number spelling may change), never writes over a file that is not the expected JSON, and always answers with the entry for you to copy or email even when the write failed. Two things worth knowing before you rely on it. RESET TOKENS empties the home list as well as your own tokens — every link in it was sealed under the key that RESET deletes, so it cannot be opened or polled again; UPDATE HOME LIST brings back the directory's share of it, and links people sent you by hand have to be pasted again. And the group's directory is only as trustworthy as whoever can write to it: reading it tells them nothing, but a maintainer (or anyone who takes that file over) can add entries your machine will then poll and rename the ones you have, which is why a merge never deletes, never follows a host that changed, and shows you what it did. Polling happens in your own dev server, so you receive a call for help only while `npm run dev` is running — the box says NOT POLLED when it is not. Secrets stay out of everything: `.env` holds `ULTRA_DIRECTORY_URL`, `ULTRA_DIRECTORY_WRITE_TOKEN`, and either the three Twilio values or your gateway's URL and token, all read at call time so a save from POWER UP applies at once (a hand edit of `.env` still needs `npm run dev` stopped and started); the write token is sent only to `api.github.com`; the status poll carries a provider word, a host and configured-or-not and nothing else; and no token, hash, link, sealed blob, released position, name or phone number reaches a log line — the poller prints `[Ultra help] Network: n-<id> <STATE>`, the relay prints its provider word and a failure code, and the directory prints an HTTP status or one word.

Verified: `node --test` over `src/ultraNetwork.test.mjs`, `src/ultraSmsRelay.test.mjs`, `src/ultraTokens.test.mjs`, `src/ultraHelpServer.test.mjs`, `src/ultraHelp.test.mjs`, `src/ultraHelpPanel.test.mjs`, `src/ultraSecurityPackage.test.mjs`, `src/keySetupCore.test.mjs`, `src/tooling/viteBuild.test.mjs`, `src/data/deviceFeeds.test.mjs`, `src/deviceFeedsServer.test.mjs` and `src/worldFocus.test.mjs` together: 187 tests, 0 failures. They cover the two new pure modules against hostile input (public, loopback, RFC1918, link-local and `100.63`/`100.128` hosts refused as poll targets; links with query, hash, userinfo or the wrong length refused; directory documents that are not objects, hold 600 elements, name duplicate tokens or unreadable bodies; peer answers with strings for numbers, NaN, out-of-range coordinates, 0,0, a five-hour-old timestamp or a window already closed on their clock; the backoff ladder; the 200-entry and 500-element caps), the server against a temp source root with the outside world scripted through an injected `fetch` (the two answer shapes and their exact key order, the network-off 404 spending no miss budget over twenty tries, every budget and refusal sentence, the sealed home-list file written through the hardening spy with no token in it, the merge counts, the GitHub GET/PUT with `sha` keeping a foreign element and the one retry, the relay's Twilio URL, Basic header and form body, the cooldowns and the daily and per-host caps, that no SID, auth token or from-number is anywhere in the status, that a hanging relay never holds up the phone poll, and that captured console output over a whole episode carries only `n-<id>` and a state word), and the panel and markup against the fake document (every new id and label, the collapsed panel, the status-line priority, the recipient-free OPEN IN SMS, that a release row never offers TEXT BACK, the read-aloud sentences once each, and the map events). `node scripts/format.mjs --check` is clean across 403 adopted files and `npm run build` succeeds. The whole `npm test` run is 4,437 tests with 3 failures, none of them in this work and all three (the icon glyph subset, the Realtime tool-inventory drift, the FIRMS provider) failing before it: the four `src/standalone/startupChrome.test.mjs` failures that stood beside them were a gap in that test's own sandbox and are fixed here. `node scripts/check-package-boundaries.mjs` still stops at `weather-providers` (Rollup cannot resolve `@meri-imperiumi/eccodes-wasm`) before it reaches the ultra group, as before. Then it was exercised live on this machine, in Chrome against the running dev server, with the package's own saved position: a Network token minted from the box (its row reading NET, the note changing from "Nobody receives this yet"), SEND HELP behind its confirm, the release recorded for four hours with the holder count, the box's own plea painted from a real reverse geocode — "Please HELP you are close by, to <street address>, City of Saint John, New Brunswick / Nouveau-Brunswick (<lat>, <lon>) of victim in progress, fire thank you." — the same sentence reaching the phone's poll as a SEND SMS TO HELPERS card addressed to the saved PREDEFINED HELP # number, the holder route answering `{"released":false}` while quiet and exactly `{released, name, lat, lon, at, until, incident}` while live with no message, number, id or token in it, a token without Network answering 404 there while still working as an ordinary help link, STAND DOWN clearing it from both, the home-list form refusing a public, loopback, LAN, link-local or plain-http link and refusing the owner's own link, accepting a tailnet peer link and writing it sealed with no plaintext token in `config/ultra-network.json`, and the box left clean afterwards. What is still untried, and cannot be tried on one machine: a real second GEVC over a shared Tailscale node (the guard refuses a link whose token is the owner's own, so a peer cannot be faked), a real phone pressing SEND HELP, a directory file read or written on GitHub, and an SMS actually sent through Twilio or a gateway — those claims rest on the test suites, which drive the real routes and the real modules with the network scripted. So take the money plainly: the relay is charged per message by whoever carries it, and it is off unless you configure it. No secret is printed anywhere — not the relay's SID or auth token, not a gateway token, not the GitHub write token, not a peer's help link — and none of them appears in the status the box polls. Then an adversarial review ran over the whole feature — five lenses (security and SSRF, the server state machine, the two pages and the box, robustness, and whether the tests and these paragraphs tell the truth), each finding attacked by two independent refuters — and what it turned up was fixed. The one it confirmed outright was the worst: a phone report key that had been retired with NEW KEY, or belonged to a package since deleted, was still admitted, because admission consulted a map of every key this process had ever seen a fix from rather than the saved packages; worse, the new phone SEND HELP route fell back to "whichever package is first in the file", so a retired link could publish a position as another package's and stand a real call for help down. Admission is now the saved packages alone, that route serves only its own package, the desktop's SEND HELP no longer falls back either, and everything this process remembers under a key the store has stopped naming — position, camera command, picture, notify queue, host — is dropped the moment the store changes; a test rotates a key and pins that the old one answers 404 on the poll, the camera page, a release and a stand-down, while the new one works. Beside it: an in-process Vite restart used to stop the poller for good, because Vite builds the new server before closing the old one and the departing server's close handler switched off the timer the new one had just started (the timer now has an owner, and the test fires the handlers in that order); a reverse geocode that came back after the peer had stood down, or after the owner had removed the link, could resurrect the call for the rest of its four hours; an answer already in flight when REMOVE landed could still raise a row for a link that was gone; REMOVE and RESET TOKENS left a call for help amber on the map with no link behind it; a refused write to the home list left memory and disk disagreeing, so a peer the owner was told had not been removed came back on the next restart; the SEND HELP line could read SENDING for the rest of a call when the relay's own cooldown refused the repeat, and EXTEND HELP reset it; a busy home list could spend the whole day's SMS allowance, so the owner's own helpers went untexted (peer notices now stop ten short of the cap, which only the owner's own call may spend); a long home list was walked four at a time whatever its length, so a call could sit unseen for minutes (the batch now scales to cover the due list inside one poll period, up to sixteen in flight, oldest-due first); the phone page's SEND HELP had no timeout, so a stalled connection left both it and STAND DOWN disabled for good on the one page a person in trouble is holding (fifteen seconds now, and it says to press again); and in the box, a single failed status poll repainted from nothing — putting SEND HELP back, hiding STAND DOWN and saying nobody receives it while a call was running — RENAME quietly swallowed a pasted link, every refusal sentence was wiped by the next three-second poll before it could be read (they now survive fifteen seconds), the publish picker was rebuilt under the owner's finger every three seconds, and RESET TOKENS left a "published" marker pointing at a token it had just deleted. One finding was left alone on purpose: the reverse-geocode queue is one lane, a second apart, so the owner's own plea can wait behind a queue of peers' addresses. A priority lane was written and then reverted — it cost a cached address and made the poller geocode the same spot twice — and with one refuter already refuting the finding, the honest state is that it stands unfixed rather than traded for a regression. Two things the live pass caught and fixed. The four `src/standalone/startupChrome.test.mjs` failures were a gap in that test's own sandbox, which had never been given the Ultra panel initialiser the standalone entry calls: it is stubbed now beside the two that were already there, counted on the side rather than pushed into the event list the assertions read by position, and one line pins that the box goes down with the shell so its poll and its map events cannot outlive it — the suite's seven failures are three. And the sticky title of a left-stack box was 92% opaque, so the brightest scrolled line still read through the letters of "ULTRA SECURITY PACKAGE" once the box grew long enough to scroll; the header is now fully opaque and its lower band is exactly the header's own margin, so a row sliding under it is covered to that edge and not shaved. Nothing was committed and nothing was pushed to the repository.

## September 27, 2026

**Share help tokens: a link that lets one person reach your phone.** The Ultra Security Package box gains two sections. SHARE HELP TOKENS, at the bottom, mints any number of tokens (NEW TOKEN, with a name for the holder and SMS and Voice ticks; a package choice appears only when more than one security package is saved) and lists them with SHARE, SMS ON/OFF, VOICE ON/OFF and REVOKE; a revoked token stays in the list dimmed, with its message count, until REMOVE or REMOVE ALL REVOKED. SAVE MY # stores your own number, which a holder sees only through a token marked SMS. A token whose package was since removed under POWER UP is marked PACKAGE REMOVED and offers only REVOKE and REMOVE, because its link answers 404. SHARE opens a box with the link (`<listener>/ultra/help/<token>`: the same address the phone link uses, https over Tailscale or http on the LAN) and COPY LINK / COPY TOKEN / HIDE; the box is painted only by that click, never by the status poll, so the poll can neither wipe nor re-show a link, and the plaintext is nowhere but in that box until HIDE. HELP MESSAGES, directly under the status line, lists what holders sent (time, token name, the holder's name or "someone", the text, a position when they shared one) with READ, TEXT BACK (only when the holder gave a number the server accepted as +E.164; it is an sms: link, which the desktop hands to whatever routes those, such as Windows Phone Link) and REMOVE, an unread count that also takes over the status line as "HELP · n NEW", and a "Read new help messages aloud" tick that speaks new messages through the browser's speechSynthesis (messages older than ten minutes at page load are never replayed). Nothing on the desktop sends an SMS; every sms: link only opens a messaging app. The holder opens the link and sees only "Ask <package name> for help", a 500-character message box, an optional name, an optional reply number (refused before sending unless it carries its country code, since the server would otherwise drop it silently), a "Share my location with this message" tick (one fix, 15 s), Send help message, and a footer saying the owner can switch the link off; with Voice, a Dictate button (the browser's SpeechRecognition, on the holder's own device, only on the https link; the page says "Dictation needs the https link (Tailscale)" otherwise) and Read it back; with SMS and a saved number, "Text <name> directly". A sent message reaches the phone link page on its next 1 s poll: the page vibrates, speaks it once the page has been tapped (the Sound on button, or any tap), lists it above the video with a Map (geo:) link and Text back or Open in SMS, and counts unseen messages in the tab title; the same message is in the box whether or not the phone has taken it.

How it works. A token is `uht1.` plus 43 base64url characters (256 random bits); the dot keeps it from ever passing as a phone key, and a phone key can never pass as a token. `config/ultra-tokens.json` holds each token's SHA-256 hash and the token itself sealed with AES-256-GCM (the record id as associated data) under a write-once, machine-local key in `config/ultra-tokens.key`, made on the first mint and read back before use; both files are written only through the credential-store path (owner-only permissions before the bytes land, atomic rename), are git-ignored, are refused as files by the device-feeds guard in every URL spelling and by vite's fs.deny, and hold no phone key: a token records the package's id, so NEW KEY does not break it. `config/ultra-help.json` now takes the same credential-store write and holds your shareable number beside the saved contacts, plain, since it is the datum you chose to hand to SMS holders. Losing the key file does not stop existing links (admission is by hash); it stops SHARE and NEW TOKEN until every live token is revoked (or RESET TOKENS is pressed), after which the next NEW TOKEN makes a fresh key; a key file that is present but not a key is never overwritten: fix it or RESET TOKENS. A store that cannot be parsed refuses every link and every token action (mint, reveal, edit, revoke, remove, purge) with "Not saved: …" until RESET TOKENS; your number, the contacts and the inbox are other files and still save. RESET TOKENS deletes only `config/ultra-tokens.key` and `config/ultra-tokens.json` (the inbox and your number stay) and refuses, with a plain sentence, when a folder sits at either path. The owner routes, `POST /api/ultra-help/tokens` (mint, reveal, edit, revoke, remove, purge, reset), `/number` and `/inbox`, answer only this machine's own page (loopback socket, local Origin, no forwarding headers, same-origin fetch) and `403 Editing is available under the dev server only` under `vite preview`; the owner status never carries a token, a hash or a sealed record, only an eight-character fingerprint; `GET /api/ultra-help/status` now answers like `/`, which the box had been polling and getting 404 for. On the listener, `/ultra/help/<token>` (page), `/status` and `POST /message` admit the token by shape check, one SHA-256 digest and a constant-time compare against every record with no early exit; unknown, revoked, malformed, orphaned (package removed) and unreadable-store all answer the phone routes' `404 Not found`; each address is held to 60 requests and 20 misses a minute (`429 Wait`), each token to one message per 10 s and 20 an hour, counted on accepted messages only, and the message body to 4 KiB of JSON (415/413/400 before anything is stored). The page carries no data at all (CSP `default-src 'none'`, `Referrer-Policy: no-referrer`, no-store), and `/status` gives the holder the package name, the two flags, the number when SMS is on, and how many sends remain; never a position, a camera, a contact or another token. Accepted messages live in memory and in `config/ultra-inbox.json` (no owner secret, newest 100, written within a second of a change: made through the credential-store path so it is owner-only like the other stores, then written in place), and on a per-package notify queue (20 deep) that `GET /ultra/<key>` now drains beside the one-slot camera command as `{ command, notify }`, so a queued camera switch and a help message arrive together; a page that reads only `.command` keeps working. Text is cleaned before it is kept (control characters out, whitespace runs collapsed, 500 characters), a holder's number is kept only as +E.164, and a position only when both coordinates are finite, in range and not 0,0; every render in the box and on the phone page is textContent. No SMS gateway exists. Dictation is the holder's browser's own speech recognition, and Chrome sends that audio to Google's speech service as it does for any site; the transcript is simply the message the holder chooses to send, and nothing else leaves either device. The OpenAI Realtime tools are untouched. Server logs never contain a token, a hash or a link.

Verified: `src/ultraTokens.test.mjs` (19 tests: token shape, seal/open, constant-time lookup, store and inbox normalisation, text cleaning incl. zero-width and non-string input, budgets, sms: links, address rule, and that the module loads without Buffer or crypto), `src/ultraHelpServer.test.mjs` (9 tests against a temp source root: mint with the key file and hardening spy, reveal/edit/revoke/remove/purge/number, no-key / key-invalid / unreadable semantics, owner admission and the preview 403, the ten uniform 404 spellings and the exact holder headers, messages and the inbox file, the budgets with a fixed clock, the phone poll's `{ command, notify }`), `src/ultraHelpPanel.test.mjs` (fake document: the reveal-box contract, status-line priority, textContent-only rows, TEXT BACK only for +E.164, read-aloud once per message) and `src/ultraHelp.test.mjs` (its markup pin now names every id of the two new sections and their order in the box) pass together with `src/ultraSecurityPackage.test.mjs` (50 tests, 0 failures; the server suite also pins the orphaned flag and 409, the fresh key after the last live token is revoked, and the preview 403 on `/inbox`); the never-served pins in `src/ultraSecurityPackage.test.mjs` and `src/tooling/viteBuild.test.mjs` cover the new file names; `src/deviceFeedsServer.test.mjs` gains a raw-socket test that every spelling of `/ultra/` reaches the phone routes and that a refused report's warning blanks key-sized path segments and caps the tailnet login it repeats. `node scripts/format.mjs --check` is clean and `npm run build` succeeds; `node scripts/check-package-boundaries.mjs` is still red at `weather-providers` (Rollup cannot resolve `@meri-imperiumi/eccodes-wasm`) before it reaches the ultra group, as before this change; the `ultra-help-provider` group was run on its own and passes. The box takes its sms: link builder from `src/ultraHelp.mjs`, so the browser bundle no longer carries `src/ultraTokens.mjs` or a `node:crypto` stub. Exercised live on this machine, against the running dev server, in Chrome: a token minted from the box (key file and sealed store written, the status poll never carrying the token), the holder page opened on the listener (headers as specified, "Ask Samsung for help", "20 more this hour", the "Text Samsung directly" link once a number was saved), a message typed with a name and a reply number and sent ("19 more this hour", the button held for the cooldown), the phone link page popping the card on its next poll (vibrate call, "Text back" to the holder's number, "(1) Ultra phone link" in the tab title, "Sound on" offered), the box showing "HELP · 1 NEW" with the row and TEXT BACK, SHARE painting the link and two polls leaving it alone, HIDE, NEW TOKEN, READ, REVOKE (the link answering 404 at once), then RESET TOKENS. Not tried: a real phone, `tailscale serve` end to end (the link is built from its address), and vibration or speech on a handset. A long left-stack box used to paint its scrolled rows straight through its sticky title; the header now has a backing that also covers the scroller's padding above it and the margin under it. An adversarial review then ran (five finders: security, server correctness, client and pages, robustness, tests-and-docs truth; two independent refuters per finding) and what survived was fixed: the inbox and token rows' compact-button rule lost to the panel's own full-width rule, so every READ / TEXT BACK / REMOVE and SHARE / SMS / VOICE / REVOKE stacked on its own line (the rule now carries the panel id); "revoke the existing tokens, then mint again" was a dead end with the key file missing because revoked records still blocked a fresh key (only live tokens do now, and the key-invalid refusal says "fix the file or RESET TOKENS"); `/inbox` did not honour the preview read-only rule the docs promised (it does); RESET TOKENS answered a bare 500 when a folder or a locked file sat at either path (it refuses with a plain sentence first, removes the key before the store so a half-reset leaves a state a second RESET clears, and the owner routes' generic 500 now prints the error code to the terminal); a token whose package was removed still looked live and SHARE handed out a link that only 404s (the row says PACKAGE REMOVED with REVOKE and REMOVE only, reveal answers 409); the status shipped 50 inbox rows but counted unread over 100 (every kept row ships); unticking "Read new help messages aloud" left queued speech talking (it cancels); an Enter on the empty SAVE MY # field silently cleared the saved number (it does nothing; CLEAR MY # is the way); the holder page kept saying "Listening…" after dictation ended and silently lost a reply number typed without its country code (it says so and refuses to send until fixed or emptied); the phone page hid Sound on until the first message and never armed sound on an ordinary tap (the button is there from the start and any tap arms it), queued unspoken messages without bound (last ten), restored a stale status line over a camera start (it restores only its own text), and built its card after the vibrate and voice calls (the card comes first, so a refusing voice cannot hide it); holder text made of zero-width characters or a non-string body passed as text (both are empty now). From the security lens: the listener dispatched to the phone routes only on the exact spelling `/ultra/…`, so `//ultra/help/<token>` (a base pasted with its trailing slash), `/Ultra/…` (dictation) or a percent-encoded first segment fell into the report route, whose refusal warning printed the whole path, token included (the listener now folds a doubled leading slash, decodes and case-folds the first segment before dispatching, and the refusal warning blanks every key-sized path segment); the miss-budget warning and that same refusal warning echoed a `Tailscale-User-Login` header of any length from any socket, letting a LAN device sign the owner's log as a tailnet user (both read it only on the loopback proxy socket, printable ASCII, 80 characters); the inbox file was written plain, which on Windows meant every local account could read holders' numbers and positions or plant a message the box would read aloud after a restart (it now goes through the credential-store path like the other stores); and TEXT BACK / Text back linked to a stranger's number without ever showing it (the number is in the row and the card, and in the link's title). Two more security findings were judged and left as they are, with the bound written into the README: a store or key file planted before the first mint by another local account is trusted, and the encryption cannot defend against an account that can write to this checkout at all, since such an account could change the code itself. Docs corrected in the same pass: dictation is the browser's speech recognition (Chrome sends the audio to Google), TEXT BACK on the desktop opens whatever handles sms: links, the link is https over Tailscale and http on the LAN, the inbox is written within a second, and only token actions are refused by an unreadable store. Keep in mind: the token travels in the URL like the phone key, so it lands in the holder's browser history; without `DEVICE_REPORT_PUBLIC_BASE` the link is a LAN address that works only on the same network (COPY TOKEN lets you hand the base separately); the encryption defends against a copied or committed store, not against an account that can read both files; address budgets, cooldowns and undelivered notify items live in memory and reset with the dev server (the inbox file keeps the messages); and Send Ultra Help still asks the phone to text, as before, unchanged by this.

**The LLM box is "LLM Risk & Truth", a member of the left stack; Data Layers, Sea Temperature and Scenes move to the right.** The LLM box used to be a free-standing panel pinned to the bottom-left corner with its own show/hide button (which the accordion did not know about), its rows clipped to half the screen: with several model keys the model blocks ran into each other. It is now a collapsible panel of the left stack like the others, titled LLM RISK & TRUTH (LLM when collapsed), with the shared collapse button and the same 176 px tab, ordered first; the Ultra Security Package sits under it, CCTV under that. Each model still has its own input, buttons and log; the blocks stack top to bottom and scroll inside the panel, whose height comes from the stack's corridor, so they never overlap. The panel is hidden by the modes that hide the other boxes (clean view, recording, scene playback, cockpit) and is one of the panels cleared on entering the cockpit; "llm", "ask" and "risk and truth" open it by voice. Data Layers, Sea Temperature and Scenes now live on the right rail with Context and Display: Data Layers first, above the Display panel the layout prepends at runtime; each takes the rail's allocation and scrolls inside it, collapses to the rail's tab width, and is hidden with the rail in cockpit mode. `src/tooling/panelPlacement.test.mjs` pins the placement and the LLM box's chrome. Verified in Chrome with three stubbed model rows (no model called): the rows stacked at 403, 483 and 574 px without overlap, the header button collapsed the box to 50 px and reopened it, the collapsed tab measured 176 px like Ultra and CCTV, and Data Layers opened at the top of the rail.

**The phone link puts the phone on the map with no app.** The Ultra Security Package's phone link (`https://<this machine>/ultra/<key>/cam`, the page the phone's browser opens for the camera) now also sends the phone's position: the browser's own location service, posted as a report every time the fix changes and at least every 20 s, with accuracy, altitude, heading and speed, and the page keeps the screen awake while it is open. The page says what it is doing ("Position sent 10:42:05 (±8 m)", "Location blocked: …", "Position not sent: no connection to the map"). Nothing has to be installed or configured on the phone beyond opening the link and allowing location; the tracking apps (Traccar Client, OwnTracks, GPSLogger, Overland) keep working as before. The Ultra box shows the link as soon as the package is saved (it used to wait for a first report, which the link is what produces), and the Samsung card's instructions name it first. This is what was missing while the Z Fold never appeared: no report had ever reached the app, because the tracking app on the phone was never sending.

**The tabs stay in reach while boxes are open.** With the tactical HUD on, the right rail hid every collapsed tab the moment one box opened, so a second box could not be opened at all; the left stack hid its collapsed tabs in the same way whenever the open boxes outgrew the corridor. Both rails now keep every tab visible and clickable in every mode, and open boxes scroll inside their share. The policy function that decided the hiding answers "no" for every HUD layout, and the rules that hid the tabs are gone.

**Every open box stays open, on the right rail as on the left.** The right rail used to collapse a box the moment a second one opened whenever the pair would not fit (and, with the tactical HUD on, collapsed every box after the newest); the left did the same except for the AI and Ultra boxes. Neither rail auto-collapses a box any more: boxes opened together share the corridor, the newest first, and each scrolls inside its share. The release path for a box an earlier version collapsed (`layout-auto-collapsed`) remains. The rail tests now pin the sharing rather than the collapsing.

**The HUD's bottom-right detail block sits at the very bottom, above the POWER UP chip.** Its GSD / ALT / AIS lines used to end 124 px from the bottom (tactical and operator HUDs) or 180 px (the base rule), holding the right rail's corridor short; they now sit just above the POWER UP chip (`calc(0.9rem + 2.6rem)` from the bottom), so the rail runs further down and the radio controls under the Scenes tab expand into the room that frees. The bottom-left block and the cockpit's own offsets are unchanged.

**Radio shows below the Scenes tab, only when selected; the AI box and Ultra stay open together; the LLM box is "AI Risk & Truth Assessment".** The Internet Radio controls lived inside the Context box and opened it whenever they opened. Radio is not a box of the dashboard any more: it has no tab in the rail's list and is not in the rail at all. It stays out of sight until it is selected (the radio control in the Context header, "radio" by voice, or a share link), then its controls appear at the bottom of the right rail, below the last tab (Scenes), taking the rail's allocation and scrolling inside it, with a − button that puts them away again; selecting it does not hide the rail's tabs. The radio icon in the Context header now opens those controls directly, there, and closes them when pressed again; it no longer pops the compact controls out under the Context tab; the compact radio controls in the Context header are unchanged. On the left, the AI Risk & Truth Assessment box and the Ultra Security Package are never auto-collapsed to make room for each other: each takes its share of the corridor and scrolls inside it, so both can be open at once. The LLM box is renamed AI Risk & Truth Assessment, in POWER UP's wording and in the voice aliases ("ai risk", "risk and truth assessment") too; its tab carries the full name as well, on two lines inside the same 176 px tab, with the collapse button kept at its full size.

**One expand/collapse button for every box.** The right rail's boxes (Display, CCTV, Context) showed ◀ / ▶ while every other box showed + / −, so the rail read two ways once Data Layers, Sea Temperature, Scenes and the LLM box joined it or sat beside it. Every collapsible box now uses the Data Layers button: + to expand, − to collapse, the same 22 px button (the Display box's was 20 px). The cockpit's own launcher arrows are unchanged.

**OpenRouter defaults to NVIDIA: Nemotron 3 Ultra (free), and every LLM key has a MODEL box in POWER UP.** `OPENROUTER_MODEL` now defaults to `nvidia/nemotron-3-ultra-550b-a55b:free` (OpenRouter's id for "NVIDIA: Nemotron 3 Ultra (free)", read from its model list on September 27, 2026) instead of `openai/gpt-5.2`. Under POWER UP each LLM key (NVIDIA NIM, xAI Grok, Anthropic Claude, OpenRouter) shows a MODEL box beside the key: the id that provider is asked for, saved as `NVIDIA_MODEL`, `XAI_MODEL`, `ANTHROPIC_MODEL` or `OPENROUTER_MODEL`. It is optional: an empty box means the provider's default, shown in the placeholder, and it never decides whether the key counts as set; a model in use is shown in the box's placeholder because a model id is a choice, not a credential. OpenRouter's box suggests its free Nemotron models (Ultra, Super, Nano Omni, 3.5 Lightning) and the paid Ultra and Super, and any id OpenRouter lists may be typed. A test keeps each box's default equal to the server's (`server/providers/llm/ask.js`). The Custom LLM slot keeps its required `CUSTOM_LLM_MODEL`.

**A recorded device shows its saved route on the map.** A device with a recording (the Ultra Security Package by default) now carries the route its daily files hold as a line under its live trail: `GET /api/device-feeds/track/<id>?days=N` (this machine only, like `/positions`) reads the last N daily files (30 unless asked, at most 366), takes one point per saved line from the `target` the server checked that line against, sorts them oldest first, drops a fix that did not move 3 m from the one before it, and thins anything longer than 4,000 points evenly, keeping the last. Only positions come back, never what was recorded around them. The map asks for the route once per device and again only when the recording has grown: the `/positions` poll now says, per device, how many days are saved and when the newest file was last written (`history: {days, lastAt}`), and the layer refetches when `lastAt` changes. The line is the device's own colour at half strength, 3 px, clamped to the ground; the live trail (2 px, brighter, in-memory since the page opened) draws over it. A device whose recording is removed loses the line. Verified: 3 saved lines over 2 days came back as 2 points, a day filter as 1, a recorded camera's name never appeared in the answer, and the layer test drew, kept, redrew and removed the line as the poll's `lastAt` changed.

**The report listener can speak HTTPS.** A phone's browser opens its camera only on a secure address, so the Ultra camera page cannot get a live picture over plain `http://100.x.y.z:44173`; the phone's own browser says so on the page. With `DEVICE_REPORT_TLS_CERT` and `DEVICE_REPORT_TLS_KEY` pointing at a certificate and key (with Tailscale: enable HTTPS in the tailnet's DNS settings and run `tailscale cert <machine>.<tailnet>.ts.net`), the listener serves https instead, and `DEVICE_REPORT_PUBLIC_HOST` puts that name first in the card's addresses; both files must read, or it stays on http and logs why. `.env.example` describes all three. The Ultra help's idea of "our network" now includes Tailscale's 100.64.0.0/10, so a phone that reports in over Tailscale is tried for a camera app's usual snapshot addresses too, and the camera link accepts an https base.

**Through Tailscale instead of through the firewall.** `tailscale serve --bg --https=443 http://127.0.0.1:44173`, run once on this machine, makes Tailscale's own process take the phone's connection and hand it to the listener over loopback: no firewall rule for the port, a real certificate (Tailscale issues it once HTTPS is enabled in the tailnet's DNS settings), and an address the phone's browser treats as secure, `https://<machine>.<tailnet>.ts.net`. `DEVICE_REPORT_PUBLIC_BASE` set to that address puts it first on the card, verbatim. Behind that proxy the socket is loopback, so the Ultra help reads the phone's address from the forwarded header instead.

**Found while testing:** nothing from the phone ever reached the listener because Windows Firewall had no rule for the port and its Public profile, which a Tailscale adapter falls under, blocks `node.exe` inbound by default. The rule to add is in `.env.example` and the README; the listener itself answered on the Tailscale address from this machine throughout. The last position the app holds for the package is still the one the September 23 test sent, and every recorded line since carries that position with nothing found within its 2 km.

## September 26, 2026

**Ultra Security Package box.** A collapsible panel on the left stack, next to Data Layers, CCTV, and Sea Temperature. It talks only to the phone already paired as an Ultra package. Front, rear, and inside-fold camera buttons follow the handset. The list is a generic cell, Apple iPhone 15 through 17, Google Pixel, Motorola, Oppo, Vivo, Xiaomi, Galaxy S26, S22 Ultra, Z8, Z3, and Z Fold. A fold offers the inner camera. The older S3 choice is now the Z3, and the older S6 choice is the generic cell. Find Ultra Help uses the phone's last fresh position, rejects a stale, unclassified, or repeated incident, and lists published police and fire stations plus numbers you saved. Send Ultra Help asks that phone to text only the numbers you tick: "Please HELP you are close by, to {place} of victim in progress, {type} thank you." The CCTV catalogues are unchanged. A phone forwards its camera without a picture address: open the link in the Ultra box on the phone. That page sends live video, about twelve frames a second, and the box plays it as a motion-JPEG stream. An app that already serves a still or motion-JPEG on port 8080, 4747, 8081, or 8888 is pulled from the address the phone used to report in.

**Wind, observed weather, and cyclone advisories.** Ported from upstream as their own layers, without the CCTV rewrite that shipped in the same upstream commit. Rain radar, satellite clouds, and lightning come from NOAA nowCOAST. Wind comes from GFS and ECMWF IFS. Cyclone advisories come from the National Hurricane Center. The Canadian, US, and international camera packs, private cameras, and traffic-over-CCTV compositing are unchanged. Radar's share token is `h` here because `v` is already the device-feed layer.

## September 23, 2026

**Fire perimeters, and MODIS in Active Fires.** Ported from upstream without replacing this fork's cameras, traffic, or device feeds. A new Fire Perimeters layer draws current NIFC WFIGS outlines (keyless, cached five minutes, share token `p`) and links a selected incident to InciWeb when the names match. Active Fires now also requests MODIS NRT beside the three VIIRS sources. The layer is off until you turn it on.

**The recording distance is the owner's choice: 1, 2, 3, 4, 5, 10, 15, 20, 25, 30, 40 or 50 km.** A recording device (any device with RECORD on, the Ultra Security Package by default) used to save everything the map knew within 50 km of it; the RECORD EVERYTHING WITHIN line on its card now carries that distance as a choice, 50 km unless the owner picks another, so nothing already saved changes. The choice is kept with the device (`recordKm` in `config/device-feeds.json`; a value that is not one of the twelve falls back to 50), the map's recorder gathers only what lies within it, and the server, which re-checks every record against the position it knows, keeps only what lies within it too; each saved line says which distance it was taken at. The card's RECORDING line reads "within 5 km" once something has been saved. Verified in Chrome: the twelve choices are offered, 5 km saved and came back, and the device layer was told 5.

## September 22, 2026

**A phone reports straight to the app: no Traccar server, no OwnTracks Recorder.** GPS Tracking Devices and the Ultra Security Package have a first connection method, **Reports to this app**. Nothing is asked for: the phone's own tracking app sends its positions here. Traccar Client (its OsmAnd protocol: `lat`, `lon`, `timestamp`, `speed` in knots, `bearing`, `altitude`, as a GET or a POST with an empty body), OwnTracks in HTTP mode (`{_type: "location", lat, lon, tst, vel, cog, alt}`, answered with the empty array it expects), Overland (a batch of GeoJSON features, the newest counts) and GPSLogger's custom URL (`speedMps=%SPD`, since its speed is metres a second) are all read; any other JSON with a point in it is too. Saving such a device mints its key, 32 random bytes, which is its whole login: the card shows the key and the addresses this machine answers on, in the words each app wants (Traccar Client: server URL `http://192.168.2.15:44173`, device identifier the key; OwnTracks and Overland: `http://192.168.2.15:44173/<key>`), and a NEW KEY button retires the old key at once. The address and login boxes are gone from the card for this method. Reports arrive from the phone, not from this page, so the report route is the one route not behind the loopback gate: it is admitted by the key alone (compared in constant time), answers nothing but "taken" or "not found", takes at most 64 KB, and can only put a position in. Because the dev server listens on localhost, the route is also served on its own small listener, `DEVICE_REPORT_PORT` (default 44173, the app's port with a 4 in front; `DEVICE_REPORT_HOST` default every interface), which serves that route and nothing else (`/api/device-feeds/status` on it is not found), opens when the first reporting device is saved and closes when the last is removed or the dev server stops, and says so in the card if the port is taken. A buffered batch flushed from the phone in the wrong order cannot move it backwards: the newest fix wins. The newest report is kept on disk beside the device's recordings, with their permissions, so a restart shows the phone where it last was. The map layer, follow, and the 50 km recorder are unchanged: the recorder is checked against the reported position exactly as against a polled one. The `phone-app` bridge note now points here first. Verified on the running dev server: a Traccar Client-shaped POST on port 44173 and an OwnTracks-shaped POST on the app's route both placed the device, a wrong key and any other path on 44173 answered 404, and the card read LIVE · reporting in. What to keep in mind: the listener answers on every interface so a phone on your Wi-Fi or VPN reaches it; never forward it, or the app's port, on a router. The README's security list and `.env.example` say the same.

**One dev server per checkout.** Stopping `npm run dev` on Windows ended npm and its `cmd` wrapper but not the Node process that is Vite, so every restart left a server running and the next one moved up a port: nine were found holding 4173 to 4181, and `npm run dev` printed "Port 4173 is in use, trying another one..." eight times. A new plugin, first in the server's list (`server/standalone/single-instance.js`), does two things. At start-up it reads the pid the last dev server of this checkout recorded (`node_modules/.vite/gev-dev-server.pid`), and if that process is still alive and its command line shows it is Vite, stops it and waits for it to go before the port is taken; any other process, or a dead pid, is left alone. While running, every two seconds it checks that every process in the chain that launched it is still there (cmd, npm, the shell, the terminal: recorded once at start-up from the process table, up to the session's root; a stop from a tool or a terminal can kill any one link and leave the rest) and, when its output is a pipe rather than a terminal, that the pipe's reader is still there (an empty write, which shows nothing, gets the EPIPE a closed reader answers with); on Linux and macOS an orphan is re-parented, which counts too. When any of that fails it closes the server and exits, three seconds at most. Vite would close itself when stdin ends, but a piped stdin is never read, so that never fired, which is how the servers were left behind; it is not read now either, because under some tools stdin is already at EOF when the server starts and reading it would end the server at once. `vite build` never runs it; `GEV_DEV_WATCH_DEBUG=1` prints the chain it watches. Verified: a recorded process was stopped in under a second; a server whose launcher, or the launcher's launcher, was killed exited within two seconds. What it cannot see: a launcher that stops reporting a command but keeps every process and pipe alive, which one automation tool does; that server is stopped by the next start instead, so no port drifts. Servers started before this change are not recorded, so the ones already running have to be stopped once by hand.

## [0.2.0] — 2026-09-22 — Country Ground Truth Assessments

Release of this fork's work since v0.1.1: the entries dated September 8 to September 20, 2026 below.

## September 20, 2026

**No maximum on the vehicle traffic drawn.** The street-traffic layer used to stop at 6,000 vehicle dots and 400 congestion heat-lines per view, sharing the dots out between roads when a view wanted more. Both ceilings are gone: every road in view carries the full count its length, the zoom level, the density setting and TomTom's congestion reading call for, and every slow or jammed road gets its heat-line. The fair-share allocator that divided the old ceiling went with it. Measured in headless Chrome at the highest density setting: Manhattan at 2,500 m drew 5,612 dots and Tokyo at 2,900 m drew 5,285, both at the same 36 to 38 frames a second as a few hundred dots. Unchanged: the daily TomTom tile budget (`TOMTOM_DAILY_TILE_BUDGET`, which guards the account's free quota), the 8 km altitude above which the layer is off, and the roughly 5.5 km box around the look-at point that roads are loaded for.

**Country Ground Truth Assessment reads Eurostat for the European countries.** Thirty-eight countries (the EU's 27, Iceland, Liechtenstein, Norway, Switzerland, Bosnia and Herzegovina, Montenegro, North Macedonia, Albania, Serbia, Türkiye and Kosovo) are now assessed from Eurostat's table of police-recorded offences by category (`crim_off_cat`: 25 categories of the International Classification of Crime, counts and rates, yearly since 2008), laid over what the same country reported to the United Nations and the World Health Organization's estimate. One more public, keyless request per country per day; if Eurostat does not answer, the country is still assessed from the UN as every other country is. **1. Incidents left out of totals**: a category against the parts listed under it (sexual violence is rape plus sexual assault: Sweden 2024 reports 21,207 and its two parts add to 20,617; a part that exceeds its whole is a finding too), beside the UN checks (Germany 2020: 2.2% of sexual-assault victims told the police). **2. Use of "other"**: the table has 25 named categories and no "other", and the report says so. **3. New categories and partial data**: categories that begin years after the table does (France: fraud, corruption, money laundering and computer offences from 2016, the environmental offences from 2020), categories whose figures stop (France's kidnapping figures stop in 2016), categories with no figure at all for the country, years missing inside a series, and a count that moves by two fifths or more in one year, said once per category with how many other years did the same (France's drug offences: 7,483 in 2015, 241,887 in 2016). **4. Incorrect numbers**: every category's rate implies a population, which must be the same whatever the crime; the police homicide rate against the WHO's interval; and the homicide count in Eurostat against the one in the UN series for the same country and year (Germany 2024: 694 and 779, apart in each of the four years before too). That last one is reported as a fact about two publications, once, with the caution that the two publishers may not define or count a homicide the same way; it is not counted five times and not called an error. The United Kingdom is read from the UN instead: Eurostat lists England and Wales, Scotland and Northern Ireland separately and stops in 2018. Kosovo, which the UN's table does not list, is read from Eurostat alone and the report says which checks it therefore lacks. Ukraine stays left out. The adapter is `server/providers/regional/eurostat-ground-truth.js`. The UN country-name table also lost its HTML character references ("T&#252;rkiye" now reads Türkiye).

**Country Ground Truth Assessment now runs for every country except Ukraine**, which is left out at the operator's instruction (the panel says so and asks no model, so it costs nothing). Canada and the United States keep their own adapters, reading the national agency's full table. Every other country is read from what it reported itself to the United Nations, with the same four methods and the same report layout. Three public, keyless requests per country, once a day: the UN Statistics Division's SDG database for indicator 16.1.1 (the police-recorded count and rate of intentional homicide each country sends the UN Office on Drugs and Crime, by sex and year since 1990, with the footnotes and the source of every figure) and indicator 16.3.1 (what share of victims told the police, from national victimization surveys), and the World Health Organization's own estimate of the homicide death rate with its uncertainty interval, which is the independent source method 4 had been missing. **1. Incidents left out of totals**: the homicide total against its parts by sex (Mexico 2024: 33,550 reported, 33,187 as male or female, 363 as neither); the share of victims who never told the police and so are in no police total (Mexico 2024: 4% of sexual-assault victims reported it, 11.8% of robbery victims; France 2022: 6% for sexual violence); and the notes attached to the figures that say what a count leaves out (Japan: "homicide" does not include "robbery-homicide"). **2. Use of "other"**: this source publishes one category, so the report says there is nothing to check rather than showing a zero. **3. New categories and partial data**: years with no figure inside the series (China: 1998 to 2001; Nigeria: 5 of 8 years), a series that stopped (China's latest figure is for 2020), figures the UN took from different sources over the years (a later collection round of the same source is not a change), figures that are estimates rather than the country's count, and the comparability notes ("Refers to financial year April-March"). **4. Incorrect numbers**: each year's count and rate imply a population, which cannot jump 5% in a year; and the police rate is set against the WHO estimate for the same year, a finding when it falls outside the WHO's whole interval (China 2020: police 0.5 per 100,000, WHO 0.72, between 0.54 and 0.93; Japan and South Africa sit above theirs). The report is about intentional homicide only and says so under the source line: it is the one offence every country counts in a comparable way and the one the UN collects from all of them. A country the UN database holds no figure for (North Korea) says so and asks no model; so does a place the UN's table of countries does not list (Taiwan, Kosovo). Country codes (alpha-2, alpha-3, UN M49) are a static table generated once from the UN Statistics Division's M49 standard and cross-checked against the World Bank's list: `server/providers/regional/country-codes.js`, 248 countries and areas. The adapter is `server/providers/regional/un-ground-truth.js`; which country goes where is `country-ground-truth.js`.

**Country Ground Truth Assessment now covers the United States**, with the same four methods and the same report layout as Canada. The source is the FBI's Crime Data Explorer (the Uniform Crime Reporting Program's national figures, monthly since 1985): twelve requests, one after another, once a day, answered from memory after that; no key is needed (set `DATA_GOV_API_KEY` to go through api.usa.gov instead). **1. Incidents left out of totals.** The American total is a sum of what police agencies chose to send, and the explorer publishes, month by month, what share of the population those agencies cover; where the rest live, nothing is in any total. The report gives the latest year and the least-covered years: 96.4% in 2025, eight years under 90%, and **77% in 2021**, when the FBI stopped accepting the old format and 77 million people lived where no report was made (932,565 violent crimes were reported that year; at the same rate the rest would add about 279,000, which the report labels as arithmetic on the published figures, not a count). Violent crime and property crime are checked against their parts (they agree). The explorer publishes no count of reports police struck as "unfounded", and the report says so rather than showing a zero. **2. Use of "other".** Arrests are published by offence: "All Other Offenses" held 2,358,889 arrests in 2024, 33.2% of all arrests and more than any named offence, up from 28.6% five years earlier. **3. New categories and partial data.** Neighbouring years that count different populations (2020 to 2021, 2021 to 2022, 1987 to 1989), the 2013 rape definition as the series itself shows it (83,439 in 2012, 96,316 in 2013, 136,168 in 2017), and categories the arrest table lists and holds nothing in ("Rape" holds 0 arrests while "Rape (Legacy)" holds 17,993). **4. Incorrect numbers.** Every published annual rate recomputed from the published counts over the population whose police reported, and clearances checked against offences: 20 figures, 0 disagreeing; the explorer publishes no list of corrections, which is said too. The explorer carries no footnotes, so the five notes in the US report are the Program's own documented rules (the Hierarchy Rule, unfounded reports, the 2013 definition, the 2021 transition, what "All Other Offenses" means), each marked "documented method"; everything else is a number from the explorer or arithmetic on one. The section lines now word themselves for what each country's source publishes (coverage where it exists, "no count published" where there is none), and a connected country is one entry in `server/providers/regional/country-ground-truth.js`: Canada is `statcan-ground-truth.js`, the United States `fbi-ground-truth.js`.

**4,848 more Canadian cameras.** The Canadian CCTV pack went from 4,767 cameras to **9,615** by adding everything in the Canadian webcam listing (`canada_webcams.tsv`, 7,387 rows) that the pack did not already hold; no camera it held before was lost. New: the City of Toronto (1,017 views), the City of Vancouver (852), the City of Surrey (597), the City of Ottawa (458), York Region (378), Panomax (210), 201 Ontario 511 views the pack lacked, the City of Edmonton (190), the City of Calgary (103), Burlington, Manitoba 511, Nova Scotia 511, harbours, BC Ferries terminals, the Coast Guard ice cameras, ski hills and resorts, and 37 stream-only cameras that play as video (Nova Scotia Webcams, City of Kamloops). A row listing several views becomes one camera per view, each pointing its own way. **Cameras with no coordinates are placed by address** (308 of them): the listing's location, street names or town are looked up once and remembered. Vancouver names its views by two streets run together ("Beatty Robson", "Cambie02East" for Cambie at 2nd Avenue), Newfoundland and Labrador by a place name with no spaces ("Portauxbasques"); an answer has to be in Canada, in the right province, within 60 km of the camera's own town, and a place rather than the province itself. 170 were placed from a street, junction or place name and 138 at their town's centre because the listing gives them no address at all ("Ottawa Traffic Camera 379"); cameras sharing an address step off it on a 40 m ring so none is hidden under another. Every such camera is marked `placedBy: address` with the address used, and you can move it: right-click its thumbnail, drag it, right-click to save. Already acquired and skipped: 2,815 rows with the same still (DriveBC serves one camera at two addresses; both count as one), 107 listed twice through two hosts (the city's own host kept, the 511 re-listing dropped), and 380 within 25 m of a camera from a province's own list on another host (on the same host it is another view from the same pole and stays). Left out: 754 rows with only a web page and nothing to watch (Québec 511's 678 are already in the pack from Québec's own dataset), 38 with no coordinates, no address and no town to place them by, 17 school, university and library cameras, and 2 advertising-billboard monitors: devices somebody left reachable, found by scanning address space, that no operator publishes; a marina, heliport or ski club that publishes its own camera stays. The area cap is unchanged (the nearest 1,000 within 50 km), so downtown Vancouver now has 1,822 cameras in reach and loads the nearest 1,000. Rebuild: `node tools/camera-pack/build-canada-listing.mjs --input <path>/canada_webcams.tsv` then `node tools/camera-pack/merge-pack.mjs`; the report is `tools/camera-pack/sources/cams-canada-listing.report.txt`.

**Ctrl+F searches the LLM output box.** With the pointer over the LLM panel, or the focus in it (the output box now takes a click), Ctrl+F / Cmd+F opens a search field over the box instead of the browser's page find: every match is marked, the current one is scrolled to inside the box, the count reads `3 of 17`, Enter and Shift+Enter (or the < and > buttons) step through and wrap, Escape closes. A Ground Truth report runs to a hundred lines in a box a few lines tall, which the page find could not scroll to. Matches are marked with the CSS Custom Highlight API, ranges over the box's own text with no markup added, so the log stays plain text that selects and copies cleanly; a new answer arriving under an open search is searched too. Anywhere else on the page Ctrl+F is still the browser's. Two old nuisances went with it, inside the panel only: Ctrl+F no longer toggles the layer panel, and Ctrl+C on a selected answer no longer toggles the CCTV layer (the globe's single-letter hotkeys take modified letters too; that policy is pinned by a test and is unchanged everywhere else). Country Ground Truth Assessment now lists only the **top five** details of each section 1 check (totals that don't equal their parts, categories struck as unfounded, exclusion notes), in the panel's entry and in the model's answer alike; the numbered line above them still carries the full count. Country Ground Truth and Risk Assessment also stopped mistaking **Toronto** for a US city: the country was guessed from latitude bands, and southern Ontario lies inside the band read as the United States, so Risk Assessment searched US sources for it and Ground Truth said no table was connected. The country now comes from the server's location lookup, then from the built-in Canadian city list, and from latitude only as a last resort.

The LLM panel has a third button, **COUNTRY GROUND TRUTH ASSESSMENT**, on the same row as OVERVIEW and RISK ASSESSMENT (all three a little smaller so they share it). It reads the selected country's own published crime table for the four ways a published total can say less than what happened, shows what it found, and then has the model explain it. Every finding is a number or a note from the table, or arithmetic on them; the model is given those findings and told to add nothing. **1. Incidents left out of totals**: each total against the sum of the parts listed under it, incidents reported to police and then struck from the count as unfounded, and the table's own notes saying what a category excludes or counts elsewhere (only the sentences that say so, for example "Incidents of child pornography are not included in the category of sexual violations against children. Excludes incidents of sexual assault levels 1, 2 and 3 against children and youth which are counted within those three violation categories."). **2. Use of "other"**: every catch-all category's share of its parent total, whether it outweighs every named category beside it, whether it is outgrowing its parent over five years or jumped in one, and notes that file offences under "other" ("Other sexual offences not involving assault or sexual violations against children are included with 'other violent offences'"). **3. New categories and partial data**: notes that rule out comparison across years, and series that reach a tenth of their recent level only part-way through the table (sexual violations against children: table starts 1998, reaches its recent level in 2008). **4. Incorrect numbers**: every published rate and percentage change recomputed from the published counts (each rate implies a population, which must be the same whatever the crime), and the corrections the agency has issued. **The report has one layout, for the panel's own entry and for the model's answer**: four numbered lines carrying the counts (`1. Incidents left out of totals, 2 totals that don't equal their listed parts, 15 categories with 10% or more of police reports struck as "unfounded", and 5 exclusion notes`, and so on), each followed by `List Details:` and one line per finding; section 4 lists details only when a recomputed figure disagrees with the published one. The counted lines are written by the code and the model is told to copy them, so a count is never something a model arrived at. There is no grade, indicator or verdict in the output. The panel's GROUND TRUTH CHECKS entry lists the findings (every one in sections 2 to 4, the top five of each check in section 1) and costs no model request; the model is handed the ten strongest of each check with the count of the rest, and room for a listed answer (a question may now raise its own answer budget, here to 6,000 tokens, never above 8,192 and never below `LLM_MAX_TOKENS`; a question that sets out its own layout overrides the panel's usual one-paragraph rule). The report ends with section 4 and carries no caveat line; what the checks cannot see (a number that is wrong but consistent with itself shows only against an independent source) is recorded with the evidence the route returns, not printed. The findings say what a practice does to a total, not why the agency does it; the table cannot show intent. Connected today: **Canada** (Statistics Canada table 35-10-0177-01, national row, all 314 violation categories, 1998 to the latest year; about 16 requests to the agency's data service once a day, answered from memory after that). On the 2025 table it finds 2 totals that do not equal their parts, 15 categories with a tenth or more of reports struck as unfounded, 5 exclusion notes, 11 unusual "other" categories, 65 late-starting series and 20 notes ruling out comparison, and 0 of 182 recomputed figures disagreeing. Any other country says plainly that no table is connected for it yet and asks no model, so it costs nothing. New route `GET /api/country-ground-truth?country=CA`.

Street Traffic no longer freezes the map while it loads a city's roads. A CPU profile of the running app found the main thread idle more than half the time and the app's own code a few percent of it, with one exception: every time roads loaded, the page stopped for 2 to 3.5 seconds. All but 8 ms of that was `scene.sampleHeight`, the GPU read-back that finds the ground under the start of each road, run for every road in one go. A worker thread cannot do that (it has no access to the map's GPU scene), so the roads are now parsed in slices of 100 ms with the thread handed back to the map between them: the same roads, the same probes in the same order, nothing thinned. The slice is as small as it usefully gets: the first probe after a drawn frame waits for the GPU to finish that frame (about 70 ms, against 3 ms for the probes behind it), so 8 ms slices took 44 s to the full roads and 50 ms slices 16 s. Measured in Chrome on Saint John (705 roads): the longest the map went without a frame during the road load fell from 2,166 ms to about 150 ms, and the full roads arrive about 4 s later than they did. A load overtaken by a move, or a layer switched off, stops probing at the next slice instead of finishing a parse nobody will see. A hidden tab parses in one pass as before.

The POWER UP chip on the dashboard now counts every power-up, not only the provider keys. It counted the 12 key slots and nothing else, so the seven sections that hold your own things (home cameras, business cameras, drones, robots, marine drones, GPS trackers, Ultra Security Packages) never moved the number: it read 7 KEYS WAITING whatever you added. Each section is now one power-up, ON when it holds at least one camera or device, so the chip reads `POWER UP · 13 WAITING` on this machine (19 in all: 5 keys and the home cameras are on), drops by one when a first drone is saved, and retires to POWERED UP only when everything is on. The sections report in as soon as they have loaded and again after every save.

POWER UP has a fifth device section, the **Ultra Security Package**, any number of them: a GPS tracker or a phone you are responsible for, which the map follows and records around. A phone is reached the only way a phone can be, through an app installed on it that reports to a server of yours (the card says so plainly: a phone cannot be found by its number). New direct method: **Home Assistant device tracker** (its phone companion app, and the iCloud, Life360 and every other tracker Home Assistant knows), alongside Traccar, OwnTracks, any JSON endpoint, GeoJSON, KML, NMEA and Signal K; listed with the bridge each needs: phone apps that report in (OwnTracks, Traccar Client, GPSLogger, Overland), Apple Find My / Google Find Hub / AirTag / Life360, and cellular and OBD trackers (GT06, TK103, Teltonika and the 200 other protocols Traccar speaks). The same methods were added to GPS Tracking Devices. Every login type as before. Two switches, on every device of every kind and on by default for a package. **FOLLOW ON THE MAP**: the device is handed to the same follow camera flights and satellites use, so the map stays on it wherever it goes, gliding between its reports, with its name, speed and heading as the tracked readout. One device is followed at a time (saving a second with FOLLOW on moves the follow to it). Going somewhere else lets go, exactly as for a flight: a search, a city, another tracked object, or a clean click on open map; it is not grabbed back until you save its card again or restart. The layer never flies the camera itself. **RECORD EVERYTHING WITHIN 50 KM**: while the map is open, every half minute, what each layer that is on knows within 50 km of the device is saved as it moves: aircraft, military aircraft, vessels, earthquakes, fires, cameras (name and place, never a stream address; the camera layer gained plain records for this), satellites overhead, bike share, installations, your other devices. Only what changed is written: a camera is saved once when it comes within range and again only if it leaves and returns, an aircraft every time it has moved, and the device's own track always. The traffic layer's dots are left out: they are an animation of flow, not vehicles anyone observed. Recordings are daily JSON-lines files under `config/device-recordings/<device>/`, and because they hold where someone's tracker or phone has been they are treated like the login store: git-ignored, never served as a file however the address is spelled, written only by a route that answers this machine and this page, and every record is re-checked by the server against the position IT knows for the device, not the one the page claims. The card shows how many days and how much has been saved. Removing a device leaves its recordings on disk; delete the folder to delete them. Verified in Chrome with a moving test phone (Home Assistant shape): the package followed it across Saint John, a click on open map let go, and the recording held its track and the 40 cameras within range.

POWER UP has four new sections for your own devices, any number in each: **Aerial drones (UAV)**, **Robots**, **Marine drones (USV / AUV)** and **GPS tracking devices**. Each device is a small form: a name, how it connects, the address, an optional camera picture (a snapshot or a motion-JPEG stream, of which the first frame is taken), and a login. The connection list is every standard method for that kind of device. The ones the application speaks directly: MAVLink over mavlink2rest (ArduPilot, PX4, BlueOS), Signal K, Traccar, OwnTracks Recorder, GeoJSON, KML, NMEA 0183 over HTTP, any JSON endpoint (the position is found automatically, or by two JSON paths you give), and picture-only at a fixed position. The ones that need something in between are listed too, each naming the bridge that turns it into one of the above: RTSP, RTMP, WebRTC, SRT, MAVLink over UDP/TCP, MQTT, ROS / ROS 2, DJI Cloud API, NMEA over TCP/UDP, AIS, APRS, satellite trackers (Iridium, Spot, inReach), OPC UA and vendor cloud APIs. Every kind offers every standard login: none, username + password (answered only on the device's challenge, Digest preferred, Basic only when asked for), bearer token, an API key in a header, or an API key in the address. A login is sent only over https, or over plain http to a device on your own network, and a redirect is never followed with it. Addresses and logins live in `config/device-feeds.json` (git-ignored, written through the same protected store as provider keys, never served as a file, never part of a share link); the routes answer this machine and this page only, the card is shown "saved", never the value, and the map is told a name, a kind and a position, never an address. Devices stand on the map in a new **Your Devices** layer (share-link token `v`), coloured by kind, with speed, heading and altitude or depth, a trail of where each has been, and the camera picture as a thumbnail when there is one. The layer turns itself on when you save a device. Devices are asked no more than once every 5 seconds each, and one that stops answering is asked less and less often (15 s up to 5 min). Verified in Chrome against a local test device: saved through the card with a bearer token, the layer came on, the position moved and the picture showed.

Every video camera now works the same way, in the Canadian, US and international packs alike. A stream-only camera (an HLS playlist kept as `videoUrl`, or the stream a Road511 lookup finds) is served as `feedType: 'hls'`. Current Chrome plays HLS in a plain `<video>`, MPEG-TS and fragmented MP4 both, so the server brings the stream to its own origin: the playlist is rewritten so that every address in it (segments, the init segment, keys, variant playlists) comes back through `/api/cctv/hls/<id>`, which fetches only from the stream's own public host. Same origin means the video can be textured onto the monitor plane and drawn in the side panel whatever CORS headers the operator sends. Pack streams need no Road511 lookup, so no quota is spent on them. **Video plays only when you click the camera**: nothing is requested for a thumbnail or for a camera the program activated by itself (its plane reads VIDEO · CLICK THE CAMERA TO PLAY), and once a camera has been played the last picture it showed becomes its thumbnail. A survey of every stream host, one request each: 1,668 cameras on 59 hosts play through the proxy as they are; 463 on 7 hosts (Seoul's TOPIS, Thailand's highways) serve an incomplete certificate chain, which this server refuses and never relaxes, so for those hosts only the viewer's browser plays the stream directly and the plane is textured through the canvas buffers; about 470 answer 404 or do not connect (dead at the source); and 974 kept addresses are not a plain `.m3u8` (Maryland's `GetVideo` endpoints, player pages) and are not served. A browser without HLS falls back to the stitched MP4 clips, fragmented-MP4 streams only. Verified in Chrome 153 on Wilmington DE (US, MPEG-TS), Seoul (international) and Lakewood NJ (lookup, fragmented MP4).

Video-only cameras (511NJ, for example US-9 @ Kennedy Boulevard in Lakewood) now appear on the map, not only in the side panel. The thumbnail tier was stills-only, so a camera whose stream had been looked up stayed a bare icon until clicked; it now gets a thumbnail, its picture a frame the browser takes from the camera's clip. Clicking that thumbnail opens the live video on the monitor plane. Whenever there is no current picture the previous one stays up: the next clip loads in a second video element while the finished one keeps its last frame on the plane, and the two change places only once the new one has a picture (re-pointing the one element blanked the plane every six seconds); a thumbnail keeps its last good frame the same way. Each clip address now serves one fixed set of bytes: a player fetches an address in several byte ranges, and a clip rebuilt between two of them answered 416 and stalled the video. Requests arriving within four seconds share one upstream round.

A camera's picture now shows on the map, not only in the side panel, for every still camera in the Canadian, US and international packs (about 141,000). The open monitor plane was stuck on whatever it was first given, usually the dark placeholder: Cesium re-uploads a canvas texture only when the material receives a new object, the entity plane was being handed the alternating buffers made for exactly that reason, but the primitive plane (the one actually drawn, so that traffic reads on top of it) was always handed the same working canvas, so its texture was uploaded once and never again. It is now handed the freshly swapped buffer. Seen on Québec 511, 511NY and Saint John alike. 511NJ now shows too. Its 808 cameras are video only: Road511 lists an HLS stream and no still, which the lookup used to write off as "no image". The lookup now keeps the stream, and because New Jersey's DOT streams (`nj-511.wink.co`) are fragmented MP4 the proxy cuts a clip from them with no decoding and no new dependency: the init segment plus the newest three media segments, joined, is an ordinary MP4 (about 390 KB, built in under a second, cached 8 seconds, served with byte ranges). The app's existing video path plays it on the monitor plane, the side panel shows a picture taken from that video every 4 seconds (status STREAM · OK), a thumbnail takes its frame from the clip, and when a clip ends the next one is fetched so the picture keeps moving. Cameras answered "no image" before this are asked again. Every playlist entry is re-checked and must stay on the playlist's own public host. The New Jersey Turnpike's cameras (`njtpk-wink.xcmdata.org`) go through exactly the same path, with no special handling. Their operator serves US networks only (from Canada every path on that host, and on 511nj.org, answers with a block page, even to a real browser), so whether they play depends on where the application is run, not on the code. 511NY thumbnails fill in slowly by design: that host allows 20 requests a minute and 1,000 a day, and the proxy keeps to it.

## September 19, 2026

CCTV thumbnails are upright again, standing where their picture opens, and you line them up with the map yourself. Right-click a thumbnail to start: its outline turns amber and its title reads R-CLICK TO SAVE. Drag it to move it over the map; turn the mouse wheel over it to rotate it (2 degrees a notch, 15 with Shift; the left and right arrow keys do the same). Right-click it again, or press Enter, to save; Escape cancels; Delete forgets the saved alignment and puts the thumbnail back where the program places it. What is saved is tied to the map, not the screen: the ground point under the middle of the picture and the compass bearing "up the picture" points to, so the thumbnail stays on its road as the view orbits and zooms. Alignments are written to a tracked file, `config/cctv_thumbnail_alignments.json` (one line per camera), so they come back on the next run and travel with the repository. A saved alignment outranks anything the program works out. The automatic road matching of the previous entries (position, width and turn) is now off by default; `CCTV_ROAD_MATCH_HOSTS` switches it back on for the hosts you list.

Road-matched thumbnails now turn to any angle to run along their road. The direction comes from the real road by the camera (the traffic layer's road lines, main roads preferred over side streets): a camera whose heading is known takes the road end nearest that heading, unless it plainly looks across the road, when its own heading stands; a camera whose heading nobody knows (385 of Québec 511's 678) takes the road's line and is kept the right way up, since the road says where it runs but not which way the camera faces along it. The card stands on the road's own line, is turned about the bottom-centre of its picture, and follows the view as you orbit. Clicks, the resize corners and the vehicles drawn across the picture all follow the turn. With the traffic layer off (no road lines loaded) a camera of known heading turns along its heading and the rest stay upright.

Québec 511 thumbnails are matched to the map by the widest road in their picture. In a road camera's picture the road is widest along the bottom edge: that is the road nearest the camera, where the lower edge of its view comes down (19 m ahead of a 10 m mount pitched 6 degrees down, across a strip 30 m wide). The thumbnail now stands with the bottom of its picture on that spot and is drawn as wide on screen as that strip of ground, so its road sits over the map's road at the same width; it grows as you close in and shrinks as you pull away, and the S/M/L/XL size and corner drag still multiply it. Scope is by host, `CCTV_ROAD_MATCH_HOSTS` (default `quebec511.info`; `*` for every camera; empty for none), plus any browser-loaded still. Every other camera keeps its thumbnail on the spot its picture opens at.

Stability. No setting was lowered and no data or capability removed. (1) One failed asset no longer freezes the application: Cesium stops its render loop for good the first time anything throws inside a frame, and its own sky box rethrows a failed texture load there, so a single dropped request at start-up left a dead globe behind a modal. The loop now restarts after a short, growing pause; an error that keeps returning (five times in a minute) gets the same modal as before. (2) One failing route no longer takes the dev server down: a rejected promise in an async provider route was an unhandled rejection, which ends the Node process and every layer with it. A guard installed before every provider answers that one request with a 500 and logs it, and background rejections are logged and survived. (3) The still proxy keeps two warm connections per host. Québec 511 refuses most new connections and keeps serving one it has answered (measured: 403, 200, 200, 200, 200 on a kept-alive connection against 403, 200, 403, 403, 403 on fresh ones), so a cold start now loads 24 of 25 Montréal frames at once instead of 15, and a warm still takes about 30 ms instead of 100. A refused new connection is retried twice, 150 ms apart; a camera's own 404, a timeout or a 429 no longer makes the proxy forget the host or send anything more; a budgeted 511 host never gets a second attempt, so one budget grant is one request. (4) The motion-JPEG reader is linear in the bytes read (it re-joined and re-scanned the whole stream on every chunk) and a wrong declared part length no longer strands it until the byte cap. (5) Thumbnail placement: a probe miss is no longer remembered, probe memory is per surface regime, the terrain reading covers the whole pose range, a sight line that starts under the terrain gives no opinion instead of a hit at 5 m, readings are staggered so cards do not all re-read on one frame, and the per-frame path compares three references instead of building key strings. (6) Private cameras: the vendor's site is recognised from the feed address even when the relay's picture hosts are missing, never as a bare public suffix such as `co.uk`, the local config is re-read when it changes, and a file that cannot be read is said out loud instead of silently leaving the saved-login guard knowing only the example hosts.

A CCTV thumbnail now stands where its monitor picture will actually open. When a camera is activated its picture is pulled in just short of the first thing its sight line hits, and for a road camera that is the road: a 10 m mount pitched 6 degrees down meets the ground within 50 to 100 m, far short of a 500 m pose range. Idle thumbnails were standing at the full range, which on screen put them well above the square their picture opens in (about 230 px in the reported Montréal view; now 2 to 4 px, measured from two angles). The expected spot comes from stepping the sight line against the terrain already loaded (no raycast; it matched the activation probe to within a metre), then from what the last activation found for that pose, and it follows the picture every frame instead of being captured once when the card is raised.

CCTV thumbnails sit exactly on the spot their camera looks at: the middle of the picture lands on that point of the map, where the spatial picture opens, so the vehicles crossing a thumbnail are the ones crossing that stretch of road and nothing shifts on a click. They used to float a leader's length above it. A thumbnail is never moved off that spot: the first version fell back to above or below whenever the spot was contested (by the active camera's title, by a panel), which is exactly where thumbnails were seen sitting above their picture. Now it stays put and the active camera's title reads on top of it; where two thumbnails would overlap, or the spot is under the HUD text, the lower-ranked one waits instead of drifting. Every camera gets this, cameras of unknown heading included (385 of Québec 511's 678, which is why only some Montréal thumbnails lined up): their picture opens along a placeholder bearing, and the thumbnail now stands there too. Thumbnails also fill in faster: cold fill launches up to six frame requests 150 ms apart (was four, 250 ms), the proxy spaces requests to one host 150 ms apart (was 250 ms), and Québec 511 is asked the way it answers from the very first frame instead of spending one refused request per server start.

Montréal and every other Québec 511 camera (678) show map thumbnails, cards and monitor pictures. Their stills had been handed to the viewer's browser on the belief that Québec 511 refuses every server; it refuses only Node's `fetch` client and answers node:https, so the proxy now retries a 401/403 that way (once more after a short pause), remembers the host, and asks it that way first from then on. `CCTV_BROWSER_DIRECT_HOSTS` now defaults to none; if your `.env` still lists `quebec511.info`, empty it and restart `npm run dev`. A host that is listed there no longer loses its map thumbnails: a browser-loaded still is now drawn on the thumbnail like any other (thumbnails are painted on the 2D overlay, which accepts a picture served without a CORS header). Only the 3D monitor plane, a WebGL texture, still cannot show such a still. The same retry recovers a Belgian traffic host (41 cameras). Cameras published only as a motion-JPEG stream (Taiwan's freeway and highway bureaus, about 3,500) now get a still too: the proxy reads the stream until its first picture is whole, then hangs up. A survey of every host with five or more cameras found the remaining misses are on the operators' side (hosts that no longer answer, removed cameras, and web pages catalogued as stills).

The private camera relay is vendor-neutral: it is the GEV Private_CCTV_Feed Relay (`tools/private-cctv-feed-relay`, installed with `npm run private-cctv-feed-relay:install`), and the repository names no camera site. The tracked extension carries reserved example hosts; your own feed address and picture hosts go in `config/private_cctv_feed.local.json` (never committed; see `config/private_cctv_feed.example.json`), and the installer writes them into the installed copy. Existing installs need one reinstall from the new folder and one re-pair, because the extension folder, its storage name and its request headers were renamed.

## September 18, 2026

The Ask route no longer caps the length of a question: Overview and Risk Assessment send their full instructions, and a 2,000-character limit was cutting them. Only the whole request body is bounded (2 MB) so one request cannot exhaust the dev server.

CCTV thumbnails resize from any of their four corners (the bottom-right badge still steps S/M/L/XL on a click). While detection is tagging vehicles, street traffic shows only the vehicles that carry a `VEH-0000` tag; with detection off every vehicle shows again. The corner brackets follow the same rule: a vehicle with no tag gets no bracket, so nothing frames empty road. Vehicles on a thumbnail ride the road band of the picture and never its sky. Risk Assessment states whether aljazeera.com has reported on the location in the past 90 days, lists those items in the visible search log, and distinguishes "nothing found" from "search failed". Flying to a preset never lands below the city's known ground elevation: terrain sampled from coarse far tiles read ~600 m over Calgary against a true ~1045 m and parked the camera a few metres above the street.

On CCTV camera views every vehicle dot now carries its `VEH-0000` identifier: a vehicle whose tag has no room on a thumbnail is left off rather than drawn as an anonymous dot, every marker on an open monitor picture is tagged, and the views can carry up to 1,000 tags a frame (was 4 per thumbnail and 40 per picture). Risk Assessment states each comparison with Canada as a multiple, "N times the Canada rate", both in the Statistics Canada items and in what the model is asked to write.

The LOCATION tray resizes from any of its four corners; a taller tray lays its pills out in more rows, the size is remembered, and a double-click on a grip resets it. A CCTV thumbnail is now a window onto the map: the vehicles shown on it are the ones driving behind it, as they show through the open monitor plane. Placing them through each camera's recorded pose was dropped, because most poses are estimates and the dots read as random.

CCTV thumbnails stand where their camera looks rather than where it is mounted, so they line up with the map without a click and do not jump when their spatial picture opens. The LOCATION row and the landmark row scroll sideways with a visible scrollbar (and the mouse wheel), so every option can be reached. Rapid Falls DZ has its own pill at the front of the row, followed by LAST and 2ND LAST, the two locations selected before the current one; they survive a reload.

A camera now has one view at a time: while its thumbnail is showing, its spatial monitor plane stays closed, and it opens again when the thumbnail goes. Vehicles drawn in a camera picture are limited to what that camera covers (no farther than the picture itself, clear of the frame edge, never in the sky band of a road camera), which removes the stray dots. The LLM Risk Assessment receives up to ten Statistics Canada outliers for the location, strongest first, from a wider scan of violations; a place with fewer simply returns fewer.

Vehicles now drive across CCTV thumbnails instead of vanishing under them, with nothing clicked. The thumbnail cards are painted on the 2D overlay, which sits above the WebGL scene, so no scene draw order could ever put a vehicle dot over one; the vehicles that fall behind a card's picture are now repainted on the overlay itself, after the cards, clipped to the picture. Inside a thumbnail a vehicle is placed by the CAMERA, not by the map behind the card: it is projected from street level through the camera's mount and recorded pose into the picture, so it travels along the street the picture shows as closely as that pose allows (a camera whose heading is unknown falls back to the vehicles passing behind its card). Each vehicle carries its `VEH-0000` ID tag over thumbnails (up to four per card) and over an open monitor picture, where detection's own tags were hidden beneath the cards. Street traffic now reads on top of CCTV camera views. The viewshed coverage volume was a translucent-pass primitive, so its faces blended over every traffic dot inside the cone and washed them out; it now draws in the opaque pass with its own alpha blend and no depth write, the same treatment the monitor picture already had, so sprites draw over it at full strength. Street traffic also appears on an open CCTV picture. Earlier attempts only changed draw order, which was never the obstacle: the picture stands at the far end of the camera's view, clear of terrain, so vehicles on the road in front of it almost never lined up with it. Each vehicle the camera can see (inside its field of view and its coverage range) is now projected through the camera's mount point onto the picture, sized by apparent distance, for still and video feeds alike. It follows calibration edits, is capped at 300 markers, and clears when the picture closes.

## September 16, 2026

Windows credential hardening isolates the ACL verifier from a side-by-side PowerShell 7 `PSModulePath`, so Get-Acl loads from Windows PowerShell 5.1's own module tree. CI pins `actions/checkout` and `actions/setup-node` to commit SHAs. Community PR review is documented in `docs/MAINTAINER_WORKFLOW.md` for this fork (`AiCanada/Gods-Eye-View-Canada`).

Overpass requests identify the application (`gods-eye-view/0.1` plus this repository URL) instead of a generic proxy label. Pinokio Update prints the remote and incoming commits, then fast-forwards that exact revision before reinstalling; if the revision cannot be shown, it stops. The Material Symbols font is subset to the glyphs the app renders, and the unused Material Icons Round family is no longer loaded. A closed or replaced voice session discards late tool and viewport completions so they cannot speak into the next conversation.

Launcher and preview tests resolve macOS temp directories through their physical path so a `/var` → `/private/var` symlink does not fail cwd comparisons.

The CCTV media route parses and bounds a client `Range` before forwarding it, and cancels the upstream camera request when the viewer leaves. Street traffic no longer drops a newer destination's abort controller when an older road fetch finishes, and a zoom above the traffic altitude cancels in-flight loads.

Backtick toggles a rendered-frame-rate readout. Tilt and north-up compass buttons sit in the top-center globe actions. The search box answers decimal-degree coordinates and bundled city/landmark names with no key, then Google, then Photon, then Nominatim as a last resort.

A Directions layer plots keyless A→B drive/walk/bike routes with turn-by-turn steps and FLY, using the existing OSRM proxy. Traffic sprites stay above CCTV.

CCTV area loading now returns at most 1,000 cameras within 50 km of the selected place (was 2,500). The radius is unchanged.

Street-traffic vehicles draw on top of the open camera picture. The monitor plane is a slightly see-through primitive that does not write depth, so it no longer covers the dots.

The LLM panel keeps Ask for typed questions and a separate Risk Assessment button beside Overview. Answers share one running log: each new report is added at the top and older text is kept. Overview rates on-screen activity as low, mid, or high and says how that volume changes operational risk (more cars raise accident risk, and so on). Risk Assessment searches government crime-stat pages and local headlines for the closest city to the selected location (Saint John, not a POI or Danger Zone label), shows those hits immediately, then adds the model write-up on top. In Canada it queries Statistics Canada table 35-10-0177-01 by Geography and Violations and reports rate outliers versus Canada.

## September 14, 2026

CCTV loads by area. The server stores every camera in its packs, and `/api/cctv/sources` now takes the selected place and returns at most the 2,500 nearest cameras within 50 km, nearest first and gzipped. Picking a place outside the loaded area swaps the cameras, even within one state. A request without a point returns no cameras instead of the whole catalogue. The per-state, per-province and per-country caps are gone, along with `CCTV_MAX_SOURCES` and `CCTV_REGION_CAP`.

US state DOT traffic cameras join the Canadian pack. `config/cctv_sources.us.json` is built offline from a Road511 listing by `tools/camera-pack/build-road511-us.mjs`, and `CCTV_SOURCES_FILE` takes a comma list of pack files. A US camera with no public image is looked up through Road511 only when you open it, using the new server-side POWER UP key `ROAD511_API_KEY`; answers are cached for 24 h and calls are spaced at least 1 s apart.

Public webcams from 166 other countries and territories join them. `config/cctv_sources.intl.json` is built offline, with no network requests, from an international webcam listing (Windy, WebcamGalore, WorldCam, Panomax, feratel, OpenStreetMap, SkylineWebcams and national road agencies such as DGT, Trafikverket, Digitraffic, Statens vegvesen, TfL, the Hong Kong Transport Department and MLIT), and `CCTV_SOURCES_FILE` now defaults to all three packs. Windy lists many of the same webcams twice under different image addresses, so one camera is kept per Windy webcam id. 103,573 cameras remain; the exact count is in `tools/camera-pack/cctv_sources.intl.report.txt`. Cameras marked offline stay. School, university, college and library cameras are removed by name in many languages (school, Schule, scuola, école, escuela, universidad, Hochschule, Gymnasium, škola, skola, skole, campus, academy, library, Bibliothek, biblioteca, 学校), and ski, kite, flight and driving schools named as the place are removed too; the report lists every exclusion for review. The pack has no defaults or caps of its own: it loads by area like the others, at most 2,500 cameras within 50 km of the selected place, and `CCTV_COUNTRIES=*` (the default) serves every country.

The Austin, Caltrans and TfL live packs keep every camera, with no special defaults or caps. Each list downloads only when a selected area overlaps its city and is cached for 24 h; Caltrans runs only when `CCTV_CALTRANS_DISTRICTS` names districts. `CCTV_AUSTIN_MAX_SOURCES`, `CCTV_PREFER_AUSTIN`, `CCTV_FORCE_AUSTIN`, `CCTV_CALTRANS_MAX_SOURCES`, `CCTV_TFL_MAX_SOURCES` and the launcher scripts' pack defaults are removed, and an empty area no longer shows placeholder Austin cameras.

IBI 511 camera hosts are held to 20 requests a minute and 1,000 a day per host: the open camera refreshes about once a minute, map cards about every 15 minutes, and a spent budget shows the last good still or a `511 LIMIT REACHED` placeholder. Unknown cameras and cameras without a still make no upstream request, and the Street View fallback is off unless `CCTV_STREETVIEW_FALLBACK=1`, and then only for the open camera.

Street traffic roads now come from OpenFreeMap vector tiles through the disk-cached `/api/roads/tiles/{z}/{x}/{y}.pbf` proxy. Public Overpass mirrors were refusing or timing out, which left uncached areas such as Austin with no roads; Overpass remains a fallback that skips failing mirrors.

## September 12, 2026

An LLM panel in the bottom-left corner answers typed questions and one-click overviews about the current view. One row appears per configured model (NVIDIA NIM, xAI Grok, Anthropic Claude, OpenRouter, or any OpenAI-compatible endpoint); nothing is called until Ask or Overview is pressed, and the route shares the opt-in `GEV_RATELIMIT_OPENAI_PER_MIN` throttle with the other paid LLM routes.

CCTV sources can be gated by country with `CCTV_COUNTRIES`, and a camera may declare a page plus a frame resolver instead of a fixed URL. (The catalogue ceiling this release introduced was replaced on September 14, 2026 by area loading: at most 2,500 cameras within 50 km of the selected place.) A Canadian camera pack ships in `config/cctv_sources.canada.json`, built by `tools/camera-pack/`. Failed frames back off before touching the paid Street View fallback.

Saint John, New Brunswick is a preset city, and a built-in Canadian gazetteer answers the search box without a Google key. A trackpad pinch now zooms the globe. Provider Settings repairs a hand-tightened `.env` DACL instead of failing the save with a generic error.

## [0.1.1] — 2026-09-01 — Installation and live-data fixes

### Changed

- Tightened the README opening around keyless setup, source freshness, modeled
  experiences, and the accessibility of the provider stack.

### Fixed

- Pinokio now recognizes its nested successful-install marker, so a completed
  one-click install exposes Start instead of returning to Install.
- The keyless `dev-fresh.sh` startup summary now names Esri World Imagery with
  keyless terrain and identifies OpenStreetMap as the fallback.
- All three VIIRS sources now reach the Active Fires layer. Merging a source's
  detections used argument spread, which exceeds the engine's argument limit on
  the two largest sources and dropped them entirely — leaving roughly a third of
  global detections while reporting each dropped source twice, once as
  successful with its real count and once as failed.
- `./scripts/dev-fresh.sh` no longer crashes on stock macOS bash 3.2 when no
  provider keys are exported: expanding the empty external-keys provenance
  array under `set -u` was fatal there. Launches with exported keys are
  unchanged.

### Security

- GBFS proxy body-size cap now measures the response in bytes
  (`Buffer.byteLength`) instead of JavaScript string length, so the
  `GBFS_MAX_BODY_BYTES` limit holds for multi-byte payloads and cannot be
  overrun by non-ASCII upstream responses.

## [0.1.0] — 2026-08-31 — One-click install, keyless boot, Provider Settings

### Added

- **One-click install** via Pinokio. Keyless boot lands on a live Esri World
  Imagery satellite globe with keyless terrain; OSM takes over automatically if
  Esri is unreachable, and the globe continues without terrain if its source is
  unavailable.
- **Provider Settings** (the POWER UP panel): add, replace, or remove API keys
  inside the app. Credential files are made owner-only before any secret is
  written — verified on macOS and Windows — and keys configured outside the
  panel are shown read-only, never rewritten.
- **Keyless capability responses**: the optional HUD summary and place-search
  endpoints return a deliberate "not configured" success instead of errors, and
  never consume rate-limit quota.
- `.gitattributes` normalizes line endings, so Windows clones pass the full
  test suite out of the box (#81 — thanks @ethanstoner).

### Changed

- README rewritten keyless-first around the provider ladder: zero keys → free
  Cesium ion (eligible personal, non-commercial use) → billing-enabled Google
  Maps.
- Browser-built data modules no longer import `node:fs`; a repo-wide boundary
  scan test keeps it that way (#83 — thanks @ethanstoner).
- Aircraft-identity voice answers explicitly cover operator, type, and route,
  and say so plainly when enrichment is unavailable instead of guessing.

### Security

- Provider Settings answers only local, unproxied requests and disables itself
  entirely whenever the server is shared. Public datacenter and dam datasets
  omit contact-oriented fields (see the dataset READMEs).

## Pre-release development history

The dated entries and internal milestone numbers below predate the first
tagged GitHub Release. They are retained as project history and do not
represent previously published GitHub Releases.

## [Unreleased] — 2026-08-24

### Added

- Added honest aircraft identity narration: callsign, operator, registration,
  type, and route come only from selected-contact context, and missing operator,
  route, or type enrichment is named explicitly.
- Added local, publication-compatible copies of the two README PNGs, with source
  records and third-party-license boundaries in `docs/media/README.md`.
- Added regression coverage for aircraft identity narration and optional-key
  loading feedback.

### Changed

- First-run presentation now opens with Detection `DENSE` at 75%, `ELASTIC`
  allocation, Fade 7%, Outside 1%, scope feather 11%, and aircraft 3D models in
  `PROXIMITY`. Stored state and share links still override these baselines.
- The 17 selected README GIFs remain unchanged and are documented separately
  from the two owner-published PNGs.
- Bundled datacenter and dam snapshots now omit contact-oriented fields and
  note values containing email or phone identifiers. Feature geometry, names,
  operator/capacity/river metadata, counts, and ODbL terms are unchanged.
- Public documentation and the L9 release matrix no longer reference non-public
  planning material or repository history.

### Fixed

- A missing optional FIRMS key no longer turns the complete Environmental
  mission into `LOAD FAILED`. The FIRMS row still reports `KEY REQUIRED`, while
  earthquakes continue to load. Real lifecycle and fetch failures retain
  failure priority.
- The mapped-installations layer retries after an unavailable request when it is
  enabled or the camera settles.
- Aircraft trails attach to the rendered aircraft transform and remain near the
  rear center across headings. Parked aircraft do not draw a moving head
  segment.
- Grounded aircraft keep validated floor evidence through temporary terrain
  outages and wait for measured photoreal-surface evidence before a 3D model
  takes over from its billboard.
- Cockpit altitude uses aviation MSL data rather than Cesium render height.

### Security

- Production transitive dependencies resolve to patched DOMPurify and
  protobufjs releases without changing the Cesium version or application APIs.
- Production dependency audit reports no known advisories; remaining audit
  findings are confined to development and QA tooling.

## [Unreleased] — 2026-08-23

### Added

- Added a first-run mission launcher for Contacts, Space Missions,
  Environmental, and manual exploration.
- Added terrain-validity gating and bounded last-known placement for grounded
  aircraft models.

### Changed

- Environmental consistently presents both earthquakes and NASA FIRMS fires,
  with honest optional-key degradation.
- The tracked aircraft trail acceptance bar is visual: roughly rear-center,
  stable across headings, with minor hull overlap allowed and no conspicuous
  top, bottom, or lateral projection.

## [Unreleased] — 2026-08-18 to 2026-08-22

### Added

- Added the four-source Map Source tray, share-link v2 state, cockpit/context
  voice parity, MSL altitude readouts, and close-range tracked aircraft models.
- Added the L9 release-candidate matrix, AIS feed watchdog, voice cost controls,
  satellite classes, and the shared world-overlay host.
- Added deterministic first-run, map-source, floor, overlay, tracking, and
  aircraft-model regression harnesses.

### Changed

- Consolidated world labels, cards, tracked readouts, CCTV thumbnails, cable
  labels, mission labels, and detection presentation under shared allocation and
  lifecycle rules.
- Reduced idle rendering through the render governor and explicit scope mask.
- Improved cockpit layout, context restoration, keyless feed honesty, and
  aircraft 2D/3D handoffs.

### Fixed

- Fixed degenerate depth picks, map-source restore states, route-camera motion,
  bright-ground label readability, grounded display flooring, and cross-layer
  tracking cleanup.
- Fixed stale overlay callbacks, parked-idle render leaks, cable-label sweep
  starvation, and several share-link state conflicts.

## [Unreleased] — 2026-08-02 to 2026-08-16

### Added

- Added Global Context modes, Cockpit briefing surfaces, Radio context,
  satellite mission replay, and real per-class aircraft models with adjacent
  provenance records.
- Added a shared screen-space overlay system with bounded allocation for labels,
  cards, callouts, detection brackets, and selected-object presentation.

### Changed

- Unified right-side product controls and responsive cockpit/map layouts.
- Migrated public-safe neighborhood geometry to DataSF and tightened safe local
  development defaults.
- Improved proxy resilience, annotation outline bounds, CCTV enable pacing,
  contact de-emphasis, and deterministic visual stacking.

## [Unreleased] — July 2026

### Added

- Added live NASA FIRMS fires, optional live TomTom traffic, Caltrans and TfL
  CCTV packs, CCTV viewsheds and direct-manipulation calibration, citywide CCTV
  cards, Natural Earth regions, analyst queries, and voice routing QA.
- Added the end-to-end vertical-datum system for aircraft, vessels, CCTV,
  annotations, trails, and terrain-aware rendering.
- Added aircraft class silhouettes, path-derived display heading, ADSBDB
  enrichment, cached CelesTrak TLE lookup, and next-ISS-pass prediction.

### Fixed

- Fixed elevated-airport aircraft placement, vessel sea-surface placement,
  close-zoom FIRMS anchors, antimeridian region framing, annotation resolution,
  cross-layer tracking ownership, and CCTV projection lifecycle issues.

## [Unreleased] — June 2026

### Added

- Added OpenAI Realtime voice control, scene-aware entity context, viewport image
  grounding, the AI HUD summary, live AIS vessels, infrastructure layers, map
  source switching, free-text navigation, and server-side data proxies.
- Added hybrid map annotations, 3D aircraft, panoptic detection, tracking
  harnesses, and public data attribution.
- Added MIT source licensing, security guidance, contribution guidance, data
  source notices, and third-party asset boundaries.

### Changed

- Removed the experimental AI video-edit style and retained seven deterministic
  visual styles.
- Moved Realtime text-history trimming to the server-side retention policy while
  keeping only the latest viewport image in conversation context.

## [0.7.0] — 2026-02-18

- Added the Bikeshare Pulse layer and panoptic label improvements.
- Improved tracked-item boxes, post-render alignment, and CCTV projection
  quality.
- Removed the experimental shift-drag CCTV calibration interaction.

## [0.6.0] — 2026-02-10

- Added the initial multi-layer 3D globe experience, visual styles, live
  aircraft, satellites, earthquakes, CCTV, traffic, FIRMS, infrastructure, and
  performance controls.
- Added entity inspection, tracking, scenes, keyboard controls, and shareable
  views.

## [0.1.0] — 2026-02-09

- Initial project version.
