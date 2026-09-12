# Canadian camera pack for God's Eye View

A replacement CCTV source pack for the cloned app, built from public Canadian
web-camera directories. It substitutes for the app's built-in Austin, Caltrans
and Transport for London packs.

## How the app consumes it

`server/providers/local.js` assembles the CCTV catalogue from three origins:
a JSON file, an inline env variable, and the built-in live packs. Supplying a
file pack switches the live Austin/Caltrans/TfL fetches off unless
`CCTV_COUNTRIES` names `US` or `GB`, which switches them back on beside it.

Configuration lives in the repo-root `.env`:

```
CCTV_SOURCES_FILE=config/cctv_sources.canada.json
CCTV_MAX_SOURCES=2000
CCTV_COUNTRIES=CA
```

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

The code default is every country, so an install that sets nothing behaves
exactly as the upstream app always did.

Every entry in the pack carries a `country` field, and the field is also exposed
on `/api/cctv/sources` so a client can group or filter by it. An entry that
declares no country cannot be classified and is therefore never filtered out.

`CCTV_MAX_SOURCES` matters: the default is 900 and the hard ceiling in the code
is 2000, so set it to 2000 for this pack. When the catalogue exceeds the cap the
loader keeps the **first** N entries, configured packs ahead of live ones, and
the merge step orders every pack nearest-to-Saint-John first. If the cap ever
bites it drops a live pack or the far side of the country, never the cameras
this was built for.

## Sources

| Pack file | Origin | Coordinates |
|---|---|---|
| `cams-saintjohn.json` | City of Saint John cameras, via ipcamlive snapshot endpoints | estimated |
| `nbcams.json` | nbcams.ca directory | exact, from each entry's map pin |
| `cams-windy.json` | Windy cameras that meteoblue lists around Saint John | estimated |
| `cams-ns.json` | Nova Scotia Webcams and NS Public Works highway cameras | mixed |
| `cams-pei.json` | PEI 511 map layer and Government of PEI streams | exact for traffic cams |
| `cams-aggregators.json` | SkylineWebcams and WebcamTaxi | estimated |
| `cams-transcanada.json` | Provincial systems linked from transcanadahighway.com | mixed |
| `cams-on.json` | Ontario 511 public API | exact |

### Notes on individual sources

**nbcams.ca** publishes a Google Street View link beside most cameras whose URL
encodes the view direction and field of view (`@lat,lon,3a,<fov>y,<heading>h,<tilt>t`).
That gives a real heading prior for 61 of the 98 cameras. The tilt values are
hand-set and a good number point above the horizon, which would aim the
projected frustum at the sky, so only downward tilts are kept.

**Ontario 511** exposes `https://511on.ca/api/v2/get/cameras` with no key: 944
cameras, every one with exact coordinates. The same path on the New Brunswick
and Nova Scotia 511 hosts returns `Invalid Key`, which is why those provinces
had to be scraped instead.

**PEI** blocks plain HTTP clients on its provincial webcam page behind a bot
check. The camera list was recovered from the 511 PEI map layer, and every feed
URL was then verified against the live origin.

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
node build-511on.mjs       # Ontario 511          (sources/511on.json -> sources/cams-on.json)
node build-skaping.mjs     # resolver-backed Banff/Jasper/Golden cameras
node merge-pack.mjs        # validate, dedupe, order, cap -> ../../config/cctv_sources.canada.json
```

Every script reads and writes inside `sources/` beside itself, so the rebuild
works from any directory. The raw scrapes (`nbcams.html`, `meteoblue.html`,
`511on.json`) are not committed; only the parsed `cams-*.json` are.

`merge-pack.mjs` is the gate. It drops entries whose feed URL points at an HTML
page, whose `feedType` the app cannot play, whose coordinates fall outside
Canada, or that duplicate an existing id, feed URL, or a camera within 25 m in
a higher-priority pack (the NB 511 cameras are listed by two directories). It
clamps pitch to the downward hemisphere and field of view to a sane range, and
it writes `headingDeg: null` for a camera whose bearing nobody knows, so the app
uses its own prior instead of pointing every such camera north.

## Upstream hosts that throttle

**Quebec 511 rate-limits by IP.** Its 75 cameras return `403` in bursts and
recover after a pause. A same-origin `Referer` was tested against it head to
head and made no difference, so nothing in the app was changed for it; those
cameras will intermittently show the synthetic fallback frame rather than a
picture. Enabling the CCTV layer fires one request per camera, which is what
provokes the throttle in the first place.

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
for the cameras the view selects. With 2000 cameras the cold start is
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
