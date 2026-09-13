# Canadian camera pack for God's Eye View

A replacement CCTV source pack for the cloned app, built from public Canadian
web-camera directories. It substitutes for the app's built-in Austin, Caltrans
and Transport for London packs.

## How the app consumes it

`server/providers/local.js` assembles the CCTV catalogue from three origins:
a JSON file, an inline env variable, and the built-in live packs. Supplying a
file pack switches the live Austin/Caltrans/TfL fetches off unless
`CCTV_COUNTRIES` names `US` or `GB`, which switches them back on beside it.

**Nothing to configure.** The pack is the app's built-in default: a fresh
download with no `.env` loads all 4,767 cameras, with the per-country limit
already at its 5,000 ceiling, the region cap at 2,500 per province, territory
or state, and Québec 511 stills loaded by the browser. These are the defaults,
which a repo-root `.env` can override:

```
CCTV_SOURCES_FILE=config/cctv_sources.canada.json
CCTV_MAX_SOURCES=5000
CCTV_REGION_CAP=2500
CCTV_BROWSER_DIRECT_HOSTS=quebec511.info
```

Add `CCTV_COUNTRIES=CA` to serve Canada only (the default serves every
country, which for this pack is the same thing unless `US` or `GB` packs are
switched on).

## Activating cameras by country

`CCTV_COUNTRIES` is a comma-separated list of ISO country codes and is the one
switch that decides which cameras exist at all. A country that is off is never
fetched, so none of its frames are requested and none are cached. That is the
point: the startup preload asks for one frame per camera in the catalogue, so
the cheapest way to keep it small is to stop a country loading in the first
place rather than filter it afterwards.

| Value | Effect |
|---|---|
| `CA` | Canada only. The project default. |
| `CA,US` | Adds the built-in Austin and Caltrans packs. |
| `CA,GB` | Adds the built-in Transport for London pack. |
| `PM` | Saint-Pierre-et-Miquelon, French territory. Its two streams are HLS-only, so nothing loads until an HLS player ships. |
| `*` or `ALL` | Every country. |
| empty | No cameras at all. |

Naming `US` or `GB` is enough on its own; the older `CCTV_FORCE_AUSTIN`,
`CCTV_TFL_ENABLED` and `CCTV_CALTRANS_DISTRICTS` switches still work but are
left at their stock values here so they cannot veto a country the gate enabled.

The code default is every country. Because the Canadian pack is the default
catalogue, an install that sets nothing serves exactly that pack; the stock
Austin, Caltrans and TfL packs come back beside it with `CCTV_COUNTRIES=CA,US`
or `CA,GB`, or on their own with `CCTV_SOURCES_FILE=config/cctv_sources.austin.json`.

Every entry in the pack carries a `country` field, and the field is also exposed
on `/api/cctv/sources` so a client can group or filter by it. An entry that
declares no country cannot be classified and is therefore never filtered out.

`CCTV_MAX_SOURCES` caps cameras **per country**; the default and the hard
ceiling in the code are both 5000, so this pack loads whole. When
a country exceeds the cap the loader keeps that country's **first** N entries,
configured packs ahead of live ones, and the merge step orders every pack
nearest-to-Saint-John first. The merge itself never thins cameras: it writes
every accepted entry and warns if a country would pass the ceiling. One large
country never crowds out another.

### Region cap

On top of the per-country ceiling, the server limits how many cameras a viewer
loads **per region**: each Canadian province or territory, each US state, and
each other country as a whole. The default is 2,500 (`CCTV_REGION_CAP`). The
region comes from an entry's optional `region` code or, failing that, its
`cityId` (`on` → `CA-ON`, `saint-john` → `CA-NB`, Austin → `US-TX`, Caltrans
districts → `US-CA`). A Canadian or US camera whose province or state cannot be
told counts against its country.

The **REGION CAP** button in the CCTV panel turns the limit on and off for that
viewer (remembered in the browser; `CCTV_REGION_CAP_DEFAULT` sets the starting
state). Toggling reloads the camera list at once. Its tooltip names any region
over the cap and how many cameras it held back. With the cap off, only the
per-country ceiling applies. The client asks `/api/cctv/sources?regionCap=1`
or `=0`, and the response carries `regionCap: { enabled, limit, dropped }`.

## Sources

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

**Offline cameras stay.** Cameras drop out for minutes, days or a season and
come back, so no builder removes a camera for being down. The 511 and DriveBC
builders keep views their operator has switched off. The Trans-Canada crawler
still asks a newly found link to show a fresh frame once, because a static
banner or share image is indistinguishable from a frozen webcam, but every
camera an earlier build kept is carried over whether or not the current run
reaches it or finds its frame fresh.

**No school cameras.** Cameras on a school, university, college or library are
never requested or stored (`school-cams.mjs`): the crawler skips such links
before fetching anything, `parse-nbcams.mjs` leaves them out, and the merge
refuses one arriving in any pack. Roads named after a school ("University
Avenue", "boul. Université") are traffic cameras and stay. While a camera is down the proxy
backs off from it and shows the placeholder card, so an offline camera costs
one failed request per backoff window, not one per refresh.

**Direct media only.** Every entry's `url` must return an image. HLS playlists
are excluded until the app ships an HLS player: a plain `<video>` element cannot
decode them, so such a camera rendered a blank plane while reporting itself
live. Cameras that exist only as a YouTube live embed are excluded too: a
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
node merge-pack.mjs        # validate, dedupe, order, cap -> ../../config/cctv_sources.canada.json
```

Every script reads and writes inside `sources/` beside itself, so the rebuild
works from any directory. The raw inputs (`nbcams.html`, `meteoblue.html`,
`511on-cameras.json`, `alberta511-cameras.json`, `drivebc-webcams.json`, `quebec511-cameras.geojson`, `quebec511-cameras.csv`,
`transcanada-webcams.html`) are not committed; only the parsed `cams-*.json` are.
The Québec GeoJSON is the dataset's WFS export
(`ms:infos_cameras`, `srsname=EPSG:4326`, `outputformat=geojson`). The
Trans-Canada crawl writes `cams-transcanada-links.report.txt` with the reason
every listed webcam was kept or left out.

`merge-pack.mjs` is the gate. It drops entries whose feed URL points at an HTML
page, whose `feedType` the app cannot play, whose coordinates fall outside
Canada, or that duplicate an existing id, feed URL, or a camera within 25 m in
a higher-priority pack (the NB 511 cameras are listed by two directories). It
clamps pitch to the downward hemisphere and field of view to a sane range, and
it writes `headingDeg: null` for a camera whose bearing nobody knows, so the app
uses its own prior instead of pointing every such camera north.

## Upstream hosts that throttle

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

Enabling the CCTV layer makes the app build geometry for every camera in the
catalogue and batch ground-height priors for all of them, then fetch frames
for the cameras the view selects. With about 3,500 cameras the cold start is
noticeably longer than with the stock packs, and every camera that fails puts
a frame request on its host until the proxy's backoff (15 s doubling to five
minutes) engages, after which the synthetic card is served for free. With a
Google key set, a failed frame falls back to a billed Street View still until
that backoff engages. Trim by region with `CCTV_MAX_SOURCES` or by building a
pack from a subset of the source files.

## Attribution

Each entry carries a `license` string naming the operator. These are public
cameras published by their operators; the pack only records where they are and
where to fetch a frame.
