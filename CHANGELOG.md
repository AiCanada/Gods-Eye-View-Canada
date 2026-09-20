# Changelog

## September 20, 2026

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

## September 8, 2026

Earthquake refreshes validate the complete feed and construct replacement entities before clearing the previous snapshot. Malformed rows and duplicate rendered IDs retain the last good entities, overlays, count and timestamp and report a malformed response; unknown magnitude is excluded from M2.5+ rendering.

Non-object or array-valued properties reject the response instead of being treated as an unknown magnitude.

Launch payloads with missing records now say PAYLOAD DATA UNAVAILABLE. Missing names use Unnamed payload; absent or invalid mass stays unknown instead of appearing as 0 KG.

This changelog records public product changes. For the authoritative description
of current runtime behavior, see [`docs/CURRENT-STATE.md`](docs/CURRENT-STATE.md).

## [Unreleased]

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

### Security

- Validate configured Google Places coordinates and text queries before rate
  limiting or upstream requests; preserve the keyless capability response.
- Bound CCTV media response headers to 15 seconds and cancel error bodies.
  Cap buffered snapshot downloads at 16 MiB while streaming.


- Cancel the active location lookup when its controls are disposed.


### Fixed

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


### Changed
- Separate explicit browser build settings from standalone environment loading
  and local provider middleware. Preserve provider behavior and root named exports.
- Rename standalone browser startup to `src/standalone/` and add a Node-only
  `gods-eye-view/build/vite` export with checked package ownership.


### Development

- Extract application lifecycle and viewer exports. Split standalone startup into
  scene setup, controls, layer registration, tools and loading UI. Startup failure
  and terminal shutdown release acquired resources and cancel delayed work.

- Adopt Prettier tooling contributed by RohanDaCoder (#227), with an explicit
  file scope, pinned formatter and Linux/Windows CI checks. Format the reusable
  infrastructure modules and their consumer tests. Package boundary checks keep
  those exports separate from app startup and local Node services.

### Fixed

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

### Fixed

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

### Added

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
