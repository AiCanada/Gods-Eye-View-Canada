# Data Sources & Attribution

God's Eye View's **code** is [MIT](LICENSE)-licensed. **The MIT grant covers the source code only — it does NOT extend to third-party data or visual assets.** Every third-party source keeps its own license and terms. This file documents the live and bundled data sources; bundled 3D-model provenance is recorded in [`public/models/README.md`](public/models/README.md).

How to read this:

- **The non-permissive datasets are carved out, not omitted.** Some bundled data (e.g. TeleGeography, CC BY-NC-SA) isn't MIT-compatible. Rather than hide it, we **bundle it with a clear license carve-out** so the app works out of the box — but it stays under the provider's terms.
- **If your use doesn't fit a dataset's license, remove that dataset.** Most importantly: TeleGeography is **NonCommercial** — commercial users must delete it (or license it from TeleGeography). It's one self-contained folder.
- **Attribution is shown in-app** and listed here. Keep it intact. The required Google/Cesium credit renders on the on-globe credit line (bottom-left, `#cesium-credits`), and every per-layer credit below is registered into the expandable **"Data attribution"** lightbox on that line (`src/data/dataCredits.js` → `viewer.creditDisplay.addStaticCredit`). Both stay visible in clean-view and recording modes.
- **Bundled model attribution lives beside the model files.** [`public/models/README.md`](public/models/README.md) records each shipped model's creator, source, license, and modification status.

---

## Live sources (fetched at runtime — not stored in this repo)

| Source | Used for | License / terms | Attribution |
|--------|----------|-----------------|-------------|
| **Google Map Tiles API** (Photorealistic 3D Tiles) + Places/Geocoding | The 3D globe, voice scene context, and on-demand nearby installation search | Google Maps Platform ToS (proprietary, your own key + billing) | "Google" / "Google Maps" logo — **shown in-app**, required |
| **OpenSky Network** | Primary worldwide live-flight snapshot | Non-commercial research/education license | Schäfer et al., *"Bringing Up OpenSky"*, IPSN 2014 + opensky-network.org |
| **adsb.lol point API** | Bounded live-flight fallback when OpenSky has no usable snapshot | ODbL 1.0 | adsb.lol contributors; `api.adsb.lol/v2/lat/{lat}/lon/{lon}/dist/{radius}` |
| **adsb.lol** | Military flights + aircraft traces | ODbL 1.0 | "adsb.lol" (ODbL) |
| **AISStream.io** | Live vessels (AIS) | Free, beta, no formal ToS; AIS is a public broadcast | "AISStream.io" (courtesy) |
| **CelesTrak** | Satellite TLEs (SGP4) | US-government-origin data, no license; citation requested | "CelesTrak (celestrak.org), Dr. T.S. Kelso" |
| **The Space Devs — Launch Library 2 v2.3** | Recent launch, payload, stage, and recovery metadata for Space Missions (30d) | [The Space Devs terms of use](https://github.com/TheSpaceDevs/Tutorials/blob/main/faqs/faq_TSD.md#terms-of-use): data may be used and shared in any form; avoid forwarding it without added value; attribution is encouraged (not mandatory). [Official API limits](https://ll.thespacedevs.com/docs/): 15 unauthenticated calls/hour; optional token | "Launch Library 2 — The Space Devs" (courtesy attribution) |
| **Esri World Imagery** (ArcGIS Online tile service) | The keyless satellite basemap — the default landing when no Google/ion credential is configured, and the "Esri Satellite" map stack | [Esri Master Agreement](https://www.esri.com/en-us/legal/terms/full-master-agreement): the public World Imagery service is usable in public-facing apps with attribution; no key is required for this classic endpoint, but Esri governs and can change access — an app at scale should review current ArcGIS Location Platform terms | "Powered by Esri — Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community" (provider carries the service's own credit line) |
| **USGS** | Earthquakes | U.S. public domain | "Data courtesy of the U.S. Geological Survey" |
| **OpenFreeMap vector tiles** (OpenMapTiles schema, OpenStreetMap data) | Road geometry for traffic: the `transportation` layer, fetched through the disk-cached `/api/roads/tiles/{z}/{x}/{y}.pbf` proxy (z 0–14) | Free and keyless with no request limits ([openfreemap.org](https://openfreemap.org)); OpenMapTiles schema CC-BY 4.0; map data ODbL 1.0 | "OpenFreeMap © OpenMapTiles Data from OpenStreetMap" |
| **OpenStreetMap (Overpass API)** | Fallback road geometry for traffic when vector tiles are unavailable | ODbL 1.0 | "© OpenStreetMap contributors" |
| **TomTom Traffic API** (flow vector tiles) | Live congestion coloring for the traffic layer (optional, BYOK) | [TomTom for Developers terms](https://developer.tomtom.com) (proprietary, your own key; free tier currently 200K tile requests/month — see [current pricing](https://docs.tomtom.com/pricing/)) | "Traffic flow data © TomTom" — registered when live mode activates |
| **OpenStreetMap (Overpass API)** | Viewport-bounded mapped installation context for Global Context | ODbL 1.0 | "© OpenStreetMap contributors" (incomplete mapped context) |
| **Photon** (komoot) | Keyless place search after coordinates, bundled presets, and Google (when configured) | Service: free public instance, [fair use](https://photon.komoot.io) (no bulk/heavy use); underlying data: **ODbL 1.0** | "Photon (komoot)" + "© OpenStreetMap contributors" |
| **OpenStreetMap (Nominatim)** | Reverse-geocoded place label in the cockpit Local Info page, and last-resort forward geocode through `/api/geocode` after Photon | ODbL 1.0 + Nominatim usage policy (one request per second, identifying User-Agent) | "© OpenStreetMap contributors" |
| **FOSSGIS OSRM** | Keyless A→B directions (drive/walk/bike) through `/api/route?steps=1` | ODbL 1.0; FOSSGIS routing usage (about one request per second) | "© OpenStreetMap contributors" |
| **Open-Meteo** | Current weather in the cockpit Local Info page and cockpit-local dynamic atmospheric effects | [CC BY 4.0 data licence and adjacent-link attribution requirement](https://open-meteo.com/en/licence) | Linked "Weather data by Open-Meteo.com" beside the displayed local data |
| **Google News RSS** | Primary locality-matched headlines in the cockpit Regional News page | [Google News Terms of Service](https://www.google.com/intl/en_us/terms_google_news.html) restrict use to personal, noncommercial use; linked articles remain third-party publisher content and retain publisher terms | "Google News RSS" plus each article's linked publisher/domain |
| **GDELT Project DOC 2.0** | Fail-soft fallback for location-matched cockpit headlines | [GDELT Terms of Use](https://www.gdeltproject.org/about.html#termsofuse): unrestricted academic/commercial/governmental dataset use, with citation and link required; linked articles retain publisher terms | "GDELT Project" plus each article's linked publisher/domain |
| **City of Austin Open Data** | CCTV camera catalog + frames. The list downloads only when a selected area overlaps Austin (with US enabled), then is cached for 24 h | City of Austin Open Data Terms of Use | "City of Austin, TX — data.austintexas.gov" |
| **Caltrans (cwwp2.dot.ca.gov)** | CCTV camera catalogs + frames, California districts. Only districts named in `CCTV_CALTRANS_DISTRICTS`, downloaded when a selected area overlaps them and cached for 24 h | Public Caltrans traffic camera data | "Caltrans — cwwp2.dot.ca.gov" (courtesy) |
| **TfL Open Data (JamCams)** | CCTV camera catalog + frames, London. Downloaded when a selected area overlaps London (with GB enabled) and cached for 24 h | [TfL Open Data terms](https://tfl.gov.uk/info-for/open-data-users/) — attribution REQUIRED | "Powered by TfL Open Data. Contains OS data © Crown copyright and database rights" |
| **Canadian public web cameras** (`config/cctv_sources.canada.json`, built by `tools/camera-pack/`) | CCTV camera catalog + frames across Canada, optional pack | Per operator: Ontario 511, NB 511 / nbcams.ca, NS Public Works and Nova Scotia Webcams, PEI 511, Quebec 511, NL Government, NAV CANADA, City of Saint John, Windy, SkylineWebcams, WebcamTaxi, Skaping (Pursuit). Public cameras published by their operators; each entry carries a `license` string naming the operator. Where an operator's terms cannot be established, drop the row. | Operator name per camera (the `license` field) plus the pooled "CCTV cameras & frames (Canada)" credit in the Data attribution popover |
| **US state DOT 511 traffic cameras** (`config/cctv_sources.us.json`, listed via Road511, built offline by `tools/camera-pack/build-road511-us.mjs`) | CCTV camera catalog + frames across the US; only the nearest 1,000 within 50 km of the selected place load | Per operator: each state DOT or 511 system publishes its own cameras, and each entry's `license` names that operator plus "(listing: Road511)". Road511's own attribution and caching terms are still to be confirmed. IBI 511 hosts are held to 20 requests/min and 1,000/day per host. School, university, college and library cameras are excluded | Operator name per camera (the `license` field) |
| **International public webcams** (`config/cctv_sources.intl.json`, built offline with no network requests by `tools/camera-pack/build-intl.mjs`) | CCTV camera catalog + frames in 166 other countries and territories: 103,573 cameras after dedupe (the exact count is in `tools/camera-pack/cctv_sources.intl.report.txt`). Only the nearest 1,000 within 50 km of the selected place load | Per operator: public webcams and road-agency traffic cameras gathered from the listings in [International camera pack sources](#international-camera-pack-sources). Each entry's `license` names its operator. Most listings' attribution and caching terms are still to be confirmed. School, university, college and library cameras are excluded | Operator name per camera (the `license` field); OpenStreetMap-listed cameras also "© OpenStreetMap contributors", TfL cameras "Powered by TfL Open Data" |
| **Road511 API** (`api.road511.com`) | On-demand still-image lookup for US cameras that publish no image: one call, only when you open such a camera (optional, BYOK) | Road511 terms (your own `ROAD511_API_KEY`; the free trial allows 60 requests/min and 1,000/day). Attribution and caching terms are still to be confirmed | "Road511" (courtesy) |
| **GBFS (Lyft / BCycle)** | Bikeshare availability | Per-feed (attribution-only) | Credit the operator (e.g. Austin BCycle) + its `license_url` |
| **Radio Browser** | Geolocated internet-radio station directory and station-level tags | Public-domain directory data under PDDL 1.0; individual broadcaster stream terms apply | "Radio Browser" plus a link to the selected broadcaster |
| **Re:Earth Terrain** (Mapterhorn) | Terrain (keyless globe stacks — OSM etc. — + `/api/terrain/heights` ellipsoidal-height lookups) | Terrain mesh: CC BY 4.0; geoid: EGM2008 (NGA, public domain) | "Terrain (keyless globe stacks): Re:Earth Terrain / Mapterhorn (CC BY 4.0) / EGM2008 (NGA)" |

### Notes on the live sources

- **Google Maps Platform.** You supply your own API key and are bound by [Google's ToS](https://cloud.google.com/maps-platform/terms). Google Maps Content (tiles, geocodes, places) **may not be cached, stored, rehosted, or committed** — this app only ever uses it live, which is the compliant pattern. The "Google" attribution is displayed on the globe and must stay visible. Restrict your key (see [SECURITY.md](SECURITY.md)).
- **OpenSky Network.** Its license is **non-commercial**, and operational use of the REST API in a live product can require a prior written agreement with OpenSky — even for non-profit/government use. If you deploy this commercially, contact OpenSky for your own terms. The flights layer is a toggle and runs anonymously by default.
- **adsb.lol flight fallback.** When OpenSky is unavailable and no last-good OpenSky response exists, the server requests a cached, capped 250 nm adsb.lol point snapshot around the current camera subpoint. This is regional observed context, not worldwide completeness; provenance is exposed in the Flights stats/context row. Military ICAOs remain reconciled through the existing dedicated military registry rather than duplicated.
- **Launch Library 2.** `/api/launches` makes a server-side rolling-30-day query against the supported v2.3 detailed launch endpoint, caches successful responses for 15 minutes in memory and on disk, and serves the last successful response during a throttle or transient outage. Anonymous access is limited to 15 calls/hour; deployments can provide `LL2_API_TOKEN` for authenticated access. The Space Devs' published terms permit using and sharing the API data in any form, ask users not to forward it without adding value, disclaim complete accuracy, and encourage—but do not require—attribution. This app keeps a courtesy credit. Payload and stage/recovery records are shown only when supplied. Failed launches expose their source status and never receive fallback orbit geometry or a live/estimated marker. LL2 supplies launch context and event timing, not continuous ascent telemetry or live orbital state.
- **CCTV area loading and live packs.** The server keeps every camera in its packs but `/api/cctv/sources` serves at most the 1,000 nearest within 50 km of the selected place. The Austin, Caltrans and TfL lists are keyless downloads made only when a selected area overlaps their coverage; each is cached in memory and on disk for 24 h, with no per-pack cap.
- **US cameras and Road511.** The US pack is built offline from a Road511 listing and holds camera positions, names, operators and URLs. A camera with a still image is fetched from its operator through the CCTV frame proxy. A camera with no still (no link, or video-only) costs nothing until you open it; then the server asks Road511 once (`GET /api/v1/features/{id}/details`, at least 1 s apart) and caches the answer, an image URL or "no image", for 24 h in `.gev-cache/road511-lookups.json`. Map cards, auto-hop and startup never call Road511, the key is never stored in that cache, and video URLs are kept in the pack but never served.
- **International cameras.** The international pack is built offline, with no network requests, from a September 2026 listing of 142,690 rows from 172 sources, and holds camera positions, names, operators and URLs. Windy's own list and its public webcam list carry many of the same webcams under different image addresses (with or without `?v=2`), so one camera is kept per Windy webcam id (31,827 copies dropped). Cameras the listing marks inactive are kept. School, university, college and library cameras are removed by name in many languages (school, Schule, scuola, école, escuela, universidad, Hochschule, Gymnasium, škola, skola, skole, campus, academy, library, Bibliothek, biblioteca, 学校); ski, kite, flight and driving schools named as the place are removed too, and the build report lists every exclusion. The pack writes 103,573 cameras. Like the other packs, it has no defaults or caps of its own and loads by area.
- **OpenFreeMap roads.** The traffic layer reads the `transportation` layer of OpenFreeMap's planet vector tiles. The server learns the current planet version from `https://tiles.openfreemap.org/planet`, proxies tiles through `/api/roads/tiles/{z}/{x}/{y}.pbf` and keeps them on disk, since versioned tiles never change. The public Overpass API is used only as a fallback, with a per-mirror circuit breaker that skips refusing or unreachable mirrors. "OpenFreeMap © OpenMapTiles Data from OpenStreetMap" must appear with the roads.
- **TfL JamCams.** The camera list comes from the keyless `api.tfl.gov.uk` endpoint (an optional `TFL_APP_KEY` raises its rate limit); frames come from TfL's public S3 bucket. The "Powered by TfL Open Data" attribution is required by TfL's terms and is registered in the Data attribution popover.
- **Radio Browser.** `/api/radio/stations` discovers official API mirrors, makes bounded and coalesced healthy/geolocated HTTPS-station queries, caches the normalized public-domain directory for 45 minutes, and may serve the last good catalog for up to seven days during an outage. Refreshes must meet minimum accepted-query and station coverage before replacing a warm catalog; schema-valid responses whose rows all fail the product's health policy do not count as successful queries. A usable partial cold catalog is explicitly `DEGRADED`, and malformed or empty successful payloads are rejected atomically. Every directory and click-count request rejects redirects, validates all resolved addresses as globally routable (including reserved/documentation IPv4 and special/non-global IPv6 exclusions), and pins the TLS connection to a validated address. Only MP3/AAC non-HLS directory rows with public HTTPS stream targets are returned; favicons are intentionally omitted. Pressing play connects one browser audio element directly to the selected broadcaster and calls the directory's click counter through known-ID-only `POST /api/radio/click/:uuid`. GEV never proxies, caches, records, bundles, or redistributes audio. Radio Browser supplies station-level tags, not dependable current-song or upcoming-program metadata, so Radio filtering never claims either. Direct playback exposes the listener's IP address to the broadcaster, whose own stream terms apply.
- **TomTom Traffic.** Optional and BYOK: without `TOMTOM_API_KEY` the traffic layer runs its built-in simulation and no TomTom data (or attribution) appears. With a key, flow vector tiles are fetched through the server-side `/api/tomtom` proxy (120 s cache + a daily tile-budget governor — `TOMTOM_DAILY_TILE_BUDGET`, default 40,000, a configurable application safety ceiling, not a guarantee of staying within TomTom's monthly free allowance; TomTom's [current pricing](https://docs.tomtom.com/pricing/) lists 200K free tile requests per month) and the "Traffic flow data © TomTom" credit is registered in the Data attribution popover the moment live mode activates. TomTom data is served live and cached only transiently (≤120 s TTL under `.gev-cache/`, gitignored) — it is not bundled or redistributed. One 23 KB point-in-time tile snapshot is committed as a decode-test fixture (`src/data/fixtures/`, © TomTom, never served to the app).
- **Re:Earth Terrain.** Keyless (no API key). Used two ways: (1) `src/mapStackController.js` swaps in a `Cesium.CesiumTerrainProvider` pointed at Re:Earth's `cesium-mesh/ellipsoid` quantized-mesh endpoint for globe stacks without a Cesium ion token (e.g. OSM), replacing a flat `EllipsoidTerrainProvider`; falls back to the flat provider if the endpoint can't be reached. (2) The server-side `/api/terrain/heights` proxy (disk-cached, serve-stale) resolves per-point ellipsoidal ground height for entity placement. Both are best-effort with a keyless-safe fallback (bundled EGM96 geoid math) if Re:Earth is unreachable.
- **Global Context installation context.** `/api/military-installations` queries only an allow-listed subset of OSM `military=*` and `landuse=military` features inside a maximum 10° non-dateline viewport. It caches and may serve stale mapped context, but it is neither a global installation database nor evidence of capability, activity, or absence. User-requested Google Places results remain separately sourced candidates unless their returned types explicitly establish military classification; generic offices, museums, and similarly ambiguous matches are excluded from military proximity counts.
- **Cockpit regional briefing.** `/api/regional-brief` rounds aircraft coordinates into 0.1° cache cells, caches results for five minutes, and serializes Nominatim calls at no more than one request per second. Google News RSS is queried with the resolved locality/region first; GDELT is used only when that RSS query fails or is empty. Google's published Google News terms restrict that source to personal, noncommercial use, so commercial deployments must disable/replace it or obtain separate permission; GDELT permits commercial dataset use with citation. The Data attribution popover identifies the active headline sources; article links retain publisher attribution. Headlines are location-query matches, not verified incidents, risk rankings, or evidence that a location is safe. Empty, partial, stale, and unavailable source states remain distinct. Open-Meteo supplies current conditions independently of the news source. `WX OFF` disables cockpit weather rendering only; the Local Info briefing still fetches its source-backed weather values and displays the required linked Open-Meteo credit.
- **Dynamic weather presentation.** While cockpit mode is active, `/api/weather-effects` requests current Open-Meteo observations for the aircraft/camera location, rounds coordinates into 0.1° cache cells, caches results for five minutes, and may retain a stale observation for up to 30 minutes during a transient outage. WMO condition code selects the visual family; observed cloud cover, precipitation, visibility, wind speed, and wind direction bound its strength and motion. Missing or expired weather renders no synthetic atmospheric effect, and normal globe view never renders the weather overlay.

### International camera pack sources

The international pack's listing (142,690 rows from 172 sources) gathers public cameras from the directories, archives and road agencies below. Row counts are listing rows before dedupe and filtering, so together they exceed the cameras written. A listing only records where a camera is and where its picture lives; the pictures belong to the camera's operator. **Each camera carries its operator in its `license` field**, and that is the credit to show with it. Terms not established here are still to be confirmed.

| Source | Listing rows | Terms | Attribution |
|--------|--------------|-------|-------------|
| **Windy webcams** (windy.com: its webcam list, public webcam list, and weather, ski and harbour sets) | 64,769 (18,248 + 32,206 public list + 8,237 weather + 3,733 ski + 2,345 harbour). Many are the same webcam listed twice, so one camera is kept per Windy webcam id | To be confirmed | "Windy.com" plus the operator per camera |
| **WebcamGalore** | 19,602 | To be confirmed | "WebcamGalore" plus the operator per camera |
| **WorldCam** | 14,363 | To be confirmed | "WorldCam" plus the operator per camera |
| **Panomax** | 3,782 | To be confirmed | "Panomax" plus the operator per camera |
| **feratel**, listed by the Open Data Hub (OpenDataHub) | 2,429 (1,382 WebcamInfo + 1,047 feratel), plus 535 listed as Feratel | To be confirmed | "feratel" and "Open Data Hub" plus the operator per camera |
| **OpenStreetMap** `contact:webcam` | 5,458, plus 457 more listed as OpenStreetMap | Listing data (positions and webcam links): ODbL 1.0. Pictures: their operators' terms | "© OpenStreetMap contributors" plus the operator per camera |
| **AMOS archive** (Archive of Many Outdoor Scenes) | 2,116, plus 390 credited to AMOS with the camera's own host | To be confirmed | "AMOS" plus the operator per camera |
| **SkylineWebcams** | 3,146 (1,572 + 1,574 from a second listing), plus 166 live stills and 132 YouTube entries | To be confirmed | "SkylineWebcams" |
| **Whatsupcams** | 790 | To be confirmed | "Whatsupcams" |
| **DGT** (Dirección General de Tráfico, Spain) | 1,913 | To be confirmed | "DGT" |
| **Trafikverket** (Sweden) | 1,586 | To be confirmed | "Trafikverket" |
| **Digitraffic** (Fintraffic, Finland) | 811 | To be confirmed | "Digitraffic / Fintraffic" |
| **Statens vegvesen** (Norway) | 747 (725 + 22 from a second listing) | To be confirmed | "Statens vegvesen" |
| **Vegagerðin** (Iceland) | 500 (298 + 165 + 37 across three listings) | To be confirmed | "Vegagerðin" |
| **TfL JamCams** (London) | 890 | [TfL Open Data terms](https://tfl.gov.uk/info-for/open-data-users/): attribution REQUIRED | "Powered by TfL Open Data. Contains OS data © Crown copyright and database rights" |
| **Hong Kong Transport Department** | 1,013 | To be confirmed | "Transport Department, HKSAR" |
| **THB Taiwan** (provincial and freeway CCTV, thbapp.thb.gov.tw) | 3,984 (2,182 provincial + 1,802 freeway), plus 18 from a second listing | To be confirmed | "THB" |
| **MLIT Japan** (Road Information Provision System, road-info-prvs.mlit.go.jp) | 1,927 | To be confirmed | "MLIT" |
| **SANRAL i-traffic** (South Africa, i-traffic.co.za) | 1,243 (843 via OpenEagleEye + 400 SANRAL i-TRAFFIC) | To be confirmed | "SANRAL i-traffic" |
| 111 smaller sources, for example WebCamera.pl (658), BalticLiveCam (643), Skaping (525), Malaysia LLM highway CCTV (482), Roundshot (412), foto-webcam.eu (373), Madrid Informo (357), NZTA TrafficNZ (313) and ViewSurf (307) | 9,923 | To be confirmed | The operator per camera |

---

## Bundled snapshots (committed under `src/data/local_data/`)

Static datasets shipped in the repo for an out-of-the-box experience. **None are MIT** — each keeps its own license (see the carve-out in [LICENSE](LICENSE)). Each folder also has its own provenance README.

| Dataset | Folder | License | Commercial use? | Attribution |
|---------|--------|---------|-----------------|-------------|
| **Datacenters** (~4.3K) | `datacenters/` | **ODbL 1.0** (OpenStreetMap extract) | ✅ (attribution + share-alike on data) | "© OpenStreetMap contributors" |
| **Dams** (704) | `dams/` | **ODbL 1.0** (OpenInfraMap / OSM extract) | ✅ (attribution + share-alike on data) | "© OpenStreetMap contributors" (+ Open Infrastructure Map) |
| **TeleGeography Submarine Cable Map** (712 cables + 1,917 landing points) | `telegeography_submarine_cables/` | **CC BY-NC-SA 3.0** | ❌ **NonCommercial — remove for commercial use** | "© TeleGeography — submarinecablemap.com" |
| **Natural Earth physical regions** (1,046 land + 292 marine named polygons) | `natural_earth/` | **Public domain** | ✅ (no restrictions) | "Made with Natural Earth" (courtesy credit — not legally required) |
| **DataSF Analysis Neighborhoods** (41 SF neighborhood polygons) | `neighborhoods/` | **PDDL 1.0** (public domain) | ✅ (no restrictions) | "City & County of San Francisco — DataSF" (courtesy — not legally required) |

### ⚠️ TeleGeography is bundled but NonCommercial

The submarine-cable GeoJSON is **CC BY-NC-SA 3.0** (Attribution-**NonCommercial**-**ShareAlike**). It is bundled so the cables layer works out of the box, but it is **not covered by this project's MIT license**. CC BY-NC-SA permits redistribution with attribution and share-alike — which is exactly how it ships here — but the **NonCommercial** clause means:

> If you use God's Eye View commercially, delete `src/data/local_data/telegeography_submarine_cables/` (or obtain a commercial license from TeleGeography). It is one self-contained folder; the rest of the app runs without it.

The richer structured dataset is licensed separately/commercially by TeleGeography.

### ODbL share-alike (datacenters, dams)

The OSM-derived datasets are under the **Open Database License**. ODbL's share-alike applies to the **data / derived database, not this MIT-licensed code** — the two coexist (exactly how Open Infrastructure Map ships: MIT software + ODbL data). If you publicly distribute a *modified* version of these databases, you must offer it under ODbL. Keep the "© OpenStreetMap contributors" notice (link: https://www.openstreetmap.org/copyright).

### NASA FIRMS acknowledgement

> We acknowledge the use of data and/or imagery from NASA's Fire Information for Resource Management System (FIRMS) (https://earthdata.nasa.gov/firms), part of NASA's Earth Observing System Data and Information System (EOSDIS).

FIRMS active fires are **fetched live at runtime** (CC0 / U.S. public domain data): the
`/api/firms` server-side proxy merges the three VIIRS NRT sources (NOAA-20, NOAA-21,
Suomi-NPP) clamped to the trailing 24 h, cached 30 min to respect the shared MAP_KEY
transaction quota. Requires a free `FIRMS_MAP_KEY`
(https://firms.modaps.eosdis.nasa.gov/api/map_key/); the layer is empty without it.
The former bundled 2026-05-25 snapshot was removed 2026-07-16.

### Natural Earth physical regions (`natural_earth/`)

Curated from the **Natural Earth 10m physical vectors** (https://www.naturalearthdata.com/ —
fetched from the canonical `nvkelso/natural-earth-vector` GitHub repo, commit
`ca96624a56bd078437bca8184e78163e5039ad19`, 2026-07-28): `ne_10m_geography_regions_polys`
(mountain ranges, deserts, plateaus, peninsulas, islands, …) → `regions.json` and
`ne_10m_geography_marine_polys` (seas, gulfs, straits, bays) → `marine.json`. They back the
voice-annotation resolver's named-natural-region lookup (`src/data/naturalEarthRegions.js`),
so "outline the Alps" draws the real range polygon offline.

Curation (provenance in each file's `meta` header): named features only, outer rings only,
Douglas-Peucker simplified at ~0.01° with coordinates rounded to 3 decimals, sub-20 km²
MultiPolygon crumbs and zero-area sliver artifacts dropped (7.3 MB source → 2.5 MB pack).

Natural Earth is **public domain** (no permission needed, no attribution legally required —
https://www.naturalearthdata.com/about/terms-of-use/). We credit anyway: "Made with Natural
Earth". Registration in the in-app `dataCredits.js` attribution list ships with the resolver
wiring (see below).

### DataSF Analysis Neighborhoods (`neighborhoods/`)

`neighborhoods/san-francisco.json` bundles the City & County of San Francisco's official
**"Analysis Neighborhoods"** dataset (41 neighborhood polygons; DataSF dataset `j2bu-swwd`,
catalog map view
[`p5b7-5n3h`](https://data.sfgov.org/Geographic-Locations-and-Boundaries/Analysis-Neighborhoods-Map/p5b7-5n3h)).
It backs the voice-annotation resolver's offline neighborhood-boundary lookup
(`src/data/neighborhoodPolygons.js`), so "outline Chinatown" draws the city's real
boundary polygon with no network dependency.

The dataset is licensed **PDDL 1.0** (Open Data Commons Public Domain Dedication and
License — public domain; the DataSF metadata declares `licenseId: "PDDL"`). No attribution
is legally required; we note the source here and in the folder's `SOURCE.md`, which records
the retrieval date (2026-07-30), exact download URL, license evidence, and the
deterministic transform (`scripts/build-sf-neighborhoods.mjs`: `nhood` → `name`, ~2 m
Douglas-Peucker simplification, 6-decimal rounding).

---

## In-app attribution

The required Google Maps / Cesium credit renders on the on-globe credit line (`#cesium-credits`, bottom-left) and must stay visible — including in clean-view and recording modes (the whole line, logo + "Google Maps" + the "Data attribution" link, stays on screen; only the GEV panels/HUD fade). The layer-specific credits (adsb.lol, TeleGeography, OSM datacenters/dams/roads, NASA FIRMS, CelesTrak, USGS, City of Austin, GBFS, Radio Browser, OpenSky, AISStream) are registered into the expandable **"Data attribution"** popover on that credit line via `viewer.creditDisplay.addStaticCredit(new Cesium.Credit(html, /* showOnScreen */ false))` — see `src/data/dataCredits.js`. When you add a new data source, add its license and attribution to this file **and** append an entry to `DATA_CREDITS` in `src/data/dataCredits.js` so it surfaces in the app.
