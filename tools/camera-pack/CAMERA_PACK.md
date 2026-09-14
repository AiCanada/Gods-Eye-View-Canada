# Camera packs for God's Eye View

Two CCTV source packs ship with the app:

- **Canada** (`config/cctv_sources.canada.json`), built from public Canadian
  web-camera directories and the provinces' own camera lists.
- **United States** (`config/cctv_sources.us.json`), built from Road511's
  listing of the state DOT and city traffic cameras.

The built-in live packs (Austin open data, Caltrans, Transport for London) sit
beside them and load only for an area that needs them.

## How the app consumes them

`server/providers/local.js` assembles the CCTV catalogue from three origins:
the pack files named in `CCTV_SOURCES_FILE` (a comma-separated list), an inline
`CCTV_SOURCES_JSON`, and the live packs. A pack file is either a plain JSON
array of cameras or the compact envelope described under
[US pack](#us-pack-road511-listing).

The file list defaults to both packs. A typical `.env`:

```
CCTV_SOURCES_FILE=config/cctv_sources.canada.json,config/cctv_sources.us.json
CCTV_COUNTRIES=CA,US
CCTV_BROWSER_DIRECT_HOSTS=quebec511.info
```

The server reads the files once into an in-memory index and rebuilds it only
when a file changes (size or modification time) or the country list does. It
stores every camera; what one request loads is limited by the
[area cap](#area-cap).

## Activating cameras by country

`CCTV_COUNTRIES` is a comma-separated list of ISO country codes and is the one
switch that decides which cameras exist at all. A country that is off is never
loaded, so none of its frames, lookups or live-pack downloads are ever
requested.

| Value | Effect |
|---|---|
| `CA` | Canada only. |
| `CA,US` | Adds the US pack. The Austin open-data pack loads when an Austin area is selected; Caltrans only when `CCTV_CALTRANS_DISTRICTS` is set. |
| `CA,GB` | Adds the Transport for London pack when a London area is selected (unless `CCTV_TFL_ENABLED=0`). |
| `PM` | Saint-Pierre-et-Miquelon, French territory. Its two streams are HLS-only, so nothing loads until an HLS player ships. |
| `*` or `ALL` | Every country. |
| empty | No cameras at all. |

Every entry carries a `country` field, and the field is also exposed on
`/api/cctv/sources` so a client can group or filter by it. An entry that
declares no country cannot be classified and is therefore never filtered out.

### Area cap

No request loads more than **2,500 cameras**: the nearest to the selected place
within **50 km**. The catalogue itself keeps every camera, so a busy state is
never cut short; it is the loaded area that is capped. The cap has no off
switch and no environment variable, and no request can lift it.

`/api/cctv/sources?lat=<lat>&lon=<lon>[&radiusKm=<km>]` answers with the
cameras nearest first, each with its `distKm`, and an `area` block:
`{ lat, lon, radiusKm, limit, inArea, loaded, dropped, reachKm, capped, total, generation, pending }`.
`radiusKm` is clamped to 0.5–50 km. Without a valid point the list is empty
and `area.pointRequired` is `true`; the whole catalogue is never sent. The
response is gzipped when the client accepts it.

Picking a place outside the loaded area, whether in another state or far across
the same one, replaces the loaded cameras with the new area's. The CCTV
panel's chip reads `AREA 50 KM · 2,500 CAP · N MORE NEARBY` when an area is
over the cap, `AREA 50 KM · N CAMERAS` otherwise, `AREA LOADING` while a load
is in flight, and `AREA --` before any place is selected. Metro Atlanta is the
busiest area in the packs: 2,982 cameras within 50 km, so 2,500 load and 482
wait until a place nearer them is picked.

### Live packs

The Austin, Caltrans and Transport for London packs have no special defaults
and no caps. Each loads only when its country is enabled **and** a selected
area overlaps its coverage:

- **Austin** (City of Austin open data): the list is downloaded only when a
  50 km area overlaps Austin (latitude 29.9–30.75, longitude −98.15 to
  −97.35), then kept in memory and in `.gev-cache/cctv-austin.json` for 24
  hours. While it downloads, `/api/cctv/sources` lists it in `area.pending`
  and the client asks again once, about five seconds later. Every camera in
  the list is kept, switched off or not. A Road511 Texas camera within 30 m of
  an Austin camera is dropped, because the Austin one has a still.
- **Caltrans**: only when `CCTV_CALTRANS_DISTRICTS` names districts; there are
  no default districts.
- **Transport for London**: when `GB` is enabled and `CCTV_TFL_ENABLED` is not
  `0`.

`CCTV_AUSTIN_ROWS_URL` overrides the Austin dataset address.

## US pack (Road511 listing)

Road511 indexes the public traffic cameras of the US state DOTs and city traffic
centres. Its export, `us_public_webcams.tsv`, is a raw download and is never
committed (`tools/camera-pack/sources/*.tsv` is ignored). The pack is built from
it with no network access at all:

```bash
node tools/camera-pack/build-road511-us.mjs --input <path>/us_public_webcams.tsv
```

`build-road511-us.mjs` writes `config/cctv_sources.us.json` and
`tools/camera-pack/cctv_sources.us.report.txt`, which records every decision
below. The pure helpers live in `road511-tsv.mjs` and the host-to-operator
table in `us-providers.mjs`.

- **Columns are read by header name**, so a re-ordered export still builds.
- **Duplicates.** Byte-identical rows drop silently. A camera id reused by a
  different row keeps the first row and reports the rest.
- **Coordinates.** A positive longitude is a lost minus sign when its negation
  lands within reach of the median point of that state's cameras, so it is
  restored (Alaska is exempt). A point outside the US box (latitude 17.5–71.5,
  longitude −179.5 to −64) or beyond its state's reach is rejected: 800 km, or
  1,200 km for California and Texas, whose cameras run to Crescent City and El
  Paso; Alaska is held by the box alone.
- **Feed type.** A row with a still `primary_url` is `feedType: 'image'`, its
  address percent-encoded (`new URL(u).href`). A row with no link, a stream
  only (an `.m3u8` or anything in the video column), or a link that is not a
  still is `feedType: 'none'` with `lookup: 'road511'`: see
  [On-demand Road511 lookup](#on-demand-road511-lookup). Its stream address is
  kept as `videoUrl` but never served.
- **Multi-view sites** (Nebraska) with two or more distinct view stills become
  one camera per view, `us511-<camera_id>-<DIR>`, pointed along that view.
- **Heading.** A compass `direction` (`N`, `SW`) is an estimated heading;
  anything else is unknown and the app uses its own prior.
- **Names and places.** A name that is empty, a bare number, a code, just the
  road, or TxDOT's `MRM 0` placeholder is replaced by the location or details
  text, or by the road with the code beside it (`I-66 (NO0092)`). The city is a
  town named in brackets at the end of the name (`(BARROW)` → Barrow), New
  Jersey's township column, or else the state. Ground elevation is left to the
  app's terrain priors.
- **Operator.** The provider and license come from the host of the camera's
  still, stream or view link, or else the state's DOT. Each license names the
  operator and credits the listing: `Florida Department of Transportation
  (listing: Road511)`.

Every camera id is `us511-` plus Road511's own camera id, unchanged.

The file is a compact envelope with one camera per line, about 11 MB (1.4 MB
gzipped). Shared fields sit in `defaults` and each operator in `providers`; the
loader expands every camera as `{...defaults, ...providers[p], ...camera}`:

```json
{"format":"gev-cctv-pack/1",
"defaults":{"country":"US","sourceKind":"configured","pitchDeg":-6,"fovDeg":70,"rangeM":500,"mountHeightM":10,"headingConfidence":"unknown"},
"providers":{
"ctroads":{"provider":"CTroads","license":"Connecticut Department of Transportation (listing: Road511)"},
"massdot":{"provider":"Mass511","license":"Massachusetts Department of Transportation (listing: Road511)"}
},
"cameras":[
{"id":"us511-CT-cam-308","name":"Camera 308","city":"Connecticut","region":"CT","lat":41.823175,"lon":-72.501513,"p":"ctroads","feedType":"none","lookup":"road511"},
{"id":"us511-MA-cam-10843","name":"RampXXE-EB-MM0.1-Boston-93N to HOV-E","city":"Massachusetts","region":"MA","lat":42.344126,"lon":-71.061151,"p":"massdot","feedType":"image","url":"https://public.carsprogram.org/cameras/MA/1501-fullJpeg.jpg"}
]}
```

The September 2026 listing (48,508 rows) built to **48,697 cameras**:

- 38,143 with a public still.
- 10,554 lookup cameras: 9,088 with no link, 1,465 with a stream only, and 1
  whose link is a private address.
- 14,683 with an estimated heading, credited to 59 operators.
- Dropped along the way: 111 identical duplicate rows, 6 rejected coordinates
  (test rows in Ontario and the Atlantic, one Nebraska row placed in
  California) and 35 school cameras. Five longitudes were repaired. No two
  rows share an id: camera ids are kept exactly as listed, so Vermont's
  `VT-cam-HARTFORD RWIS CCTV` and `VT-cam-HARTFORD  RWIS CCTV` (two spaces)
  are two cameras.

## On-demand Road511 lookup

A camera with no public still (`feedType: 'none'`, `lookup: 'road511'`) costs
nothing while nobody opens it: its map card and monitor plane paint a local
placeholder and no request leaves the browser for it.

Only an explicit open looks it up: clicking the camera on the map or its card,
choosing it from the camera list, cycling to it, or NEAREST. That sends one
`POST /api/cctv/lookup/:id`. AUTO HOP, arriving at a place, the default camera
picked when the layer is enabled, and a restored selection never look anything
up.

The server needs `ROAD511_API_KEY` (POWER UP → ROAD511). The key stays on the
server and is read from the environment on every call, so a key saved in POWER
UP works at once. A lookup asks
`https://api.road511.com/api/v1/features/<feature id>/details` for the camera's
still, where the feature id is the pack id without `us511-` (and without a
`-<DIR>` view suffix). Requests are spaced at least a second apart, and a
result, found or not, is cached for 24 hours in
`.gev-cache/road511-lookups.json`, so reopening a camera, even after a restart,
makes no call. A rejected key pauses lookups and a failing Road511 backs off.
The frame route never calls Road511.

The lookup answers `resolved`, `no-image`, `no-key`, `key-rejected`, `backoff`,
`busy`, `not-lookup` or `unknown`. With no key, the panel says
"Needs ROAD511_API_KEY".

Road511's ids for most Maine, New Hampshire and Vermont cameras contain spaces,
brackets and commas (`ME-cam-I-95 Mile 108 NB (Augusta)`), and seven hold two
spaces in a row. The builder writes every id exactly as listed, trimming only
its ends, and the lookup percent-encodes it in the Road511 URL. The build
report checks every lookup camera with the server's own `road511FeatureId`
(`server/providers/cctv/road511-lookup.js`) and lists any id the lookup route
would refuse; the September 2026 build has none.

## Sources

### Canada

| Pack file | Origin | Coordinates |
|---|---|---|
| `cams-saintjohn.json` | City of Saint John cameras, via ipcamlive snapshot endpoints | estimated |
| `nbcams.json` | nbcams.ca directory | exact, from each entry's map pin |
| `cams-windy.json` | Windy cameras that meteoblue lists around Saint John | estimated |
| `cams-ns.json` | Nova Scotia Webcams and NS Public Works highway cameras | mixed |
| `cams-pei.json` | PEI 511 map layer and Government of PEI streams | exact for traffic cams |
| `cams-quebec511.json` | Québec's open traffic-camera dataset (MTMD, the Québec 511 map), 678 cameras | exact |
| `cams-aggregators.json` | SkylineWebcams and WebcamTaxi | estimated |
| `cams-drivebc.json` | DriveBC's own camera list, every camera | exact |
| `cams-alberta511.json` | Alberta 511's own camera list, every view | exact |
| `cams-transcanada.json` | Provincial systems linked from transcanadahighway.com | mixed |
| `cams-transcanada-links.json` | Individual city, news and tourism webcams listed on the same page | estimated, geocoded from the listing |
| `cams-on.json` | Ontario 511's own camera list, every view | exact |

### United States

| Source | Origin | Coordinates |
|---|---|---|
| `us_public_webcams.tsv` (not committed) | Road511's listing of state DOT and city traffic cameras, 47 states | exact, repaired or rejected as above |

### Notes on individual sources

**nbcams.ca** publishes a Google Street View link beside most cameras whose URL
encodes the view direction and field of view (`@lat,lon,3a,<fov>y,<heading>h,<tilt>t`).
That gives a real heading prior for 61 of the 98 cameras. The tilt values are
hand-set and a good number point above the horizon, which would aim the
projected frustum at the sky, so only downward tilts are kept.

**Ontario 511** exposes `https://511on.ca/api/v2/get/cameras` with no key: 944
camera sites, every one with exact coordinates. The same path on the New Brunswick
and Nova Scotia 511 hosts returns `Invalid Key`, which is why those provinces
had to be scraped instead. That API was read for the first view of each site
only; the pack now comes from the list behind `https://511on.ca/cctv` (the same
feed as Alberta 511, see below), which gives all 1,672 views of the 944 sites.
A heading is taken from "Looking North"-style labels; "Toronto Bound" names a
destination and stays unknown.

**PEI** blocks plain HTTP clients on its provincial webcam page behind a bot
check. The camera list was recovered from the 511 PEI map layer, and every feed
URL was then verified against the live origin.

**Québec 511** comes from the ministry's open dataset
([Données Québec](https://www.donneesquebec.ca/recherche/fr/dataset/d2f1dce5-35c5-4bb5-a54c-3b8ec9ac9de9),
CC-BY 4.0), whose GeoJSON export gives every camera an exact point. The dataset
only links each camera's viewer page, so `build-quebec511.mjs` derives the still
from the camera code: its letter picks the regional folder (Q Quebec, M
Montreal, G Gatineau, T TroisRivieres) and the rest is the image number, so
`Q19901` is `…/Images/Cameras/Quebec/cam/19901.jpg`. Every Québec 511 still the
directories had already listed follows this rule. The pack ranks above those
directories, so their 119 copies drop out as duplicate feed URLs. A heading is
taken from descriptions that name a direction ("westward", "direction ouest").

**DriveBC** publishes its whole camera list at `https://www.drivebc.ca/api/webcams/`
(the data behind `https://www.drivebc.ca/cameras`). `build-drivebc.mjs` keeps
every camera, switched off or not, with its exact point and the compass
direction DriveBC gives it; the still is `https://www.drivebc.ca/images/<id>.jpg`.
The pack ranks above the Trans-Canada directory, whose DriveBC copies drop out.

**Alberta 511** has no keyless `/api/v2` endpoint (it answers `400`), but the
list behind `https://511.alberta.ca/cctv` is a DataTables feed,
`https://511.alberta.ca/List/GetData/Cameras?query=<json>&lang=en-US`, that
serves 100 camera sites a page with exact points. A site can hold several
views, each its own still at `https://511.alberta.ca/map/Cctv/<id>`, so
`build-alberta511.mjs` writes one entry per view, including views the operator
has switched off. A heading is taken
only from a view label that is nothing but a direction ("North", "Road W").

**transcanadahighway.com webcams** are the individual cameras that page lists by
name under regional headings, with no coordinates. `build-transcanada-links.mjs`
fetches each page with an honest identity, one at a time, looks for a recent
still, and geocodes the listed name. `curate-link-cameras.mjs` then drops share
images, video posters, banners and article photos, and any single image the
page attached to cameras in different places. Of 136 links, 12 survive and 8
are not already in the pack.

**Road511** lists each camera once with its state's still or stream link.
Texas, Minnesota, Oklahoma, New Jersey, Mississippi, Connecticut, Maine, New
Hampshire, West Virginia, Vermont and most of Michigan publish no link in the
listing, and Maryland, Delaware and most of Missouri only a video stream, so
those cameras are lookup cameras.

**Offline cameras stay.** Cameras drop out for minutes, days or a season and
come back, so no builder removes a camera for being down. The 511 and DriveBC
builders keep views their operator has switched off, and the US builder keeps
every row whatever its `active` flag says. The Trans-Canada crawler
still asks a newly found link to show a fresh frame once, because a static
banner or share image is indistinguishable from a frozen webcam, but every
camera an earlier build kept is carried over whether or not the current run
reaches it or finds its frame fresh.

**No school cameras.** Cameras on a school, university, college or library are
never requested or stored (`school-cams.mjs`): the crawler skips such links
before fetching anything, `parse-nbcams.mjs` leaves them out, the merge refuses
one arriving in any pack, and the US builder removes any row whose link, name,
location or details put it on a school. Roads named after a school are traffic
cameras and stay: "University Avenue", "boul. Université", "Indian School Rd",
"College Hwy", and a bare cross street such as "SR 9 at College" or
"I-17 S of Indian School". A school named as the place ("DE 24 @ Beacon Middle
School", "Pueblo Community College", "Main St at University of Toronto",
"Campus / Main Gate") is a school camera, and so is one named by an
abbreviation after its own name ("Spalding Dr at Norcross HS", "E DOVER ELEM",
"Meadowcreek High Sch", "Lincoln Jr High", "US69/287 @ Lumberton Middle").
Abbreviations that name a road stay ("Prmy Sch Rd"), and so does a trailing
"Middle" that marks a spot on a road ("Needles Ferry Bend Middle", "POTTERS
MILLS MIDDLE"). A 511 traffic system camera (a `/map/Cctv/` address) labelled
by two crossing roads with no junction word is an intersection camera and
stays: Boise's "Broadway University", "Capitol University" and "University
Joyce-LL". The same two words anywhere else name the institution. The US
report lists every camera removed and every school word kept as a road name.

While a camera is down the proxy
backs off from it and shows the placeholder card, so an offline camera costs
one failed request per backoff window, not one per refresh.

**Direct media only.** Every Canadian entry's `url` must return an image. HLS
playlists are excluded until the app ships an HLS player: a plain `<video>`
element cannot decode them, so such a camera rendered a blank plane while
reporting itself live. In the US pack a stream-only camera is kept as a lookup
camera instead, its stream in `videoUrl`, which the server never serves.
Cameras that exist only as a YouTube live embed are excluded too: a
YouTube live manifest is a short-lived signed URL and would rot in a stored
catalogue. The Confederation Bridge camera falls in this category.

## Rebuilding

```bash
node parse-nbcams.mjs      # nbcams.ca directory  (sources/nbcams.html -> sources/nbcams.json)
node build-extra.mjs       # Saint John + Windy   (sources/meteoblue.html -> sources/cams-*.json)
node build-511on.mjs       # Ontario 511          (sources/511on-cameras.json -> sources/cams-on.json)
node build-skaping.mjs     # resolver-backed Banff/Jasper/Golden cameras
node build-quebec511.mjs   # Québec 511 open data (sources/quebec511-cameras.geojson -> sources/cams-quebec511.json)
node build-drivebc.mjs     # DriveBC              (sources/drivebc-webcams.json -> sources/cams-drivebc.json)
node build-alberta511.mjs  # Alberta 511          (sources/alberta511-cameras.json -> sources/cams-alberta511.json)
node build-transcanada-links.mjs  # listed webcams (sources/transcanada-webcams.html -> sources/cams-transcanada-links.json)
node merge-pack.mjs        # validate, dedupe, order -> ../../config/cctv_sources.canada.json
node build-road511-us.mjs --input <path>/us_public_webcams.tsv  # -> ../../config/cctv_sources.us.json + cctv_sources.us.report.txt
```

Every script reads and writes inside `sources/` beside itself, so the rebuild
works from any directory. The raw inputs (`nbcams.html`, `meteoblue.html`,
`511on-cameras.json`, `alberta511-cameras.json`, `drivebc-webcams.json`, `quebec511-cameras.geojson`, `quebec511-cameras.csv`,
`transcanada-webcams.html`, `us_public_webcams.tsv`) are not committed; only the parsed `cams-*.json` are.
The Québec GeoJSON is the dataset's WFS export
(`ms:infos_cameras`, `srsname=EPSG:4326`, `outputformat=geojson`). The
Trans-Canada crawl writes `cams-transcanada-links.report.txt` with the reason
every listed webcam was kept or left out.

`merge-pack.mjs` is the gate for the Canadian pack. It drops entries whose feed URL points at an HTML
page, whose `feedType` the app cannot play, whose coordinates fall outside
Canada, or that duplicate an existing id, feed URL, or a camera within 25 m in
a higher-priority pack (the NB 511 cameras are listed by two directories). It
clamps pitch to the downward hemisphere and field of view to a sane range, and
it writes `headingDeg: null` for a camera whose bearing nobody knows, so the app
uses its own prior instead of pointing every such camera north. It never thins:
every accepted camera is written, since the server caps only what one area
loads.

## Upstream hosts that throttle

**IBI 511 sites: 20 requests a minute and 1,000 a day per host.** The
traveller-information sites built on the IBI platform serve stills at
`/map/Cctv/<id>`: in the US pack fl511.com, 511ga.org, 511ny.org,
udottraffic.utah.gov, 511pa.com, drivenc.gov, 511.idaho.gov, nvroads.com,
az511.com, 511wi.gov, 511la.org and 511.alaska.gov, and in the Canadian pack
511on.ca and 511.alberta.ca. The server holds each of those hosts to 20
requests a minute and 1,000 a day, keeps the daily counts in
`.gev-cache/cctv-host-budget.json`, and serves the active camera first. A still
is reused for up to 60 seconds for the active camera and 15 minutes for map
cards; `/api/cctv/sources` gives these cameras `activeFrameRefreshMs: 60000`
and `frameRefreshMs: 900000` so the browser asks no more often than that. When
a host's budget is spent, the last good still is served for up to an hour, and
after that a `511 LIMIT REACHED` placeholder.

**Every other host goes through a gate.** At most two requests per host run
at once, 250 ms apart, with up to 32 more waiting no longer than four seconds;
a request that finds the queue full gets a throttled placeholder. A host that
answers `429` or `503` is left alone for its `Retry-After`, from 60 seconds up
to 10 minutes.

**Street View is off by default.** With a Google key and
`CCTV_STREETVIEW_FALLBACK=1`, a camera whose frame fails can fall back to a
billed Street View still, and only for the active camera, never for map cards.

**Québec 511 refuses every server.** Its stills sit behind a Cloudflare bot
filter that answers `403` to the proxy whatever identity or headers it sends:
Cloudflare recognises the server's connection itself, not just its headers, and
only a real browser (or Windows' own `curl.exe`) gets a picture. So the proxy does
not try. `CCTV_BROWSER_DIRECT_HOSTS=quebec511.info` makes `/api/cctv/sources`
hand each Québec camera's still address to the viewer's browser as
`browserImageUrl`, and the CCTV panel loads it directly, the way quebec511.info's
own map does, refreshing at most once a minute. Québec 511 sends no CORS header,
so the still can never become a WebGL texture: those cameras' monitor planes and
map cards keep their placeholder, and their `/api/cctv/frame` route answers with
the synthetic card at once without contacting Québec 511 or Street View.

**SkylineWebcams HLS is a decoy.** Its `hd-auth.skylinewebcams.com` playlists
return HTTP 200 with a valid content type but serve segments named
`copyright_violation-<ts>.ts`. A URL check alone would score those green. The
pack uses the operator's own per-camera snapshot JPEG instead, which refreshes
roughly every 18 minutes.

**Nova Scotia Webcams stills go stale overnight.** The 52 non-HLS cameras there
refresh on an automated cycle that pauses in darkness.

## Cameras with no stable URL

Some operators publish each frame at a path containing the capture date and
minute, so no single URL stays valid. Storing one is worse than leaving the
camera out: it returns the same frozen frame forever while the console presents
it as live.

These are carried as **resolver-backed entries**. Such an entry stores no feed
URL at all. It names the operator's own page and the strategy for reading the
current frame out of it, and the proxy resolves the real URL on each request:

```json
{
  "id": "skaping-banff-gondola-summit",
  "url": "",
  "pageUrl": "https://www.skaping.com/banffgondola",
  "frameResolver": "og-image",
  "framePreferLarge": true
}
```

`frameResolver: "og-image"` reads the page's `og:image` metadata, which is where
these operators advertise the current frame. `framePreferLarge` swaps the
advertised thumbnail for its full-size sibling. The proxy only follows an
advertised frame to the page's own host or to a host the entry lists in
`frameHosts` (Skaping serves frames from its CDN), over https, and never to an
address literal, so a compromised page cannot steer it elsewhere. Resolved URLs are cached per
camera for 90 seconds, well under the roughly ten-minute frame cadence, so the
operator's page is read at most once per camera per minute and a half. A page
that fails transiently falls back to the last good URL rather than dropping
straight to the synthetic frame.

Only `pageUrl` values from the server-registered catalogue reach the resolver,
never a client-supplied one, so the existing protection against a caller
steering the proxy at an arbitrary host is preserved.

The merge still rejects any entry that stores a timestamped URL, and rejects a
resolver-backed entry that also carries a feed URL. This covers the five Banff,
Jasper and Golden cameras hosted by Skaping.

**Saint-Pierre-et-Miquelon is excluded for now.** Two streams reachable from a
Canadian webcam directory are hosted on `stream.cheznoo.net`, but both are HLS
playlists, which the merge rejects until the app can play them. They are French
territory, so once carried they would be tagged `PM` and load only when
`CCTV_COUNTRIES` names `PM` or `*`.

## Known costs

The browser builds geometry, ground-height priors and map cards only for the
loaded area, never more than 2,500 cameras, and it requests frames only for the
cards in view and the active camera. A camera with no still costs nothing until
someone opens it. The server keeps a frame for eight seconds so viewers share
it, and a camera that fails puts one request on its host per backoff window
(15 seconds doubling to five minutes) before the synthetic card is served for
free. The US pack is about 11 MB on disk and 1.4 MB gzipped; the server reads
it once and rereads it only when the file changes.

## Attribution

Each entry carries a `license` string naming the operator; US entries also
credit the Road511 listing. These are public cameras published by their
operators; the packs only record where they are and where to fetch a frame.
