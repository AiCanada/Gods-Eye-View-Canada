# Security

God's Eye View is a local-first client for **public** data. It is built for exploration, demos, and learning — not as a hardened production service. This document explains the security model so you can run it safely and report issues responsibly.

Vite's development file server also denies `.gev-logs/`, `.gev-cache/`, and
the package checkout's root `dist/` directory. Dependency `dist/` directories
remain available. This filesystem deny list does not filter `public/` assets or
preview output; never put private artifacts in a public asset directory.

## Reporting a vulnerability

Please report security issues **privately** — do not open a public issue for anything exploitable.

- Use GitHub's [private vulnerability reporting](https://github.com/bilawalsidhu/gods-eye-view/security/advisories/new) (Security tab → "Report a vulnerability"), or
- Reach the maintainer directly via the contact on the GitHub profile.

Include repro steps and impact. We'll acknowledge, investigate, and credit you (if you'd like) once a fix ships.

## How secrets are handled

The golden rule: **secret-bearing API keys stay on the server side.** The dev/preview server (middleware under `server/providers/`) brokers every request that needs a private credential, so the browser never receives one.

| Key | Where it lives | How the browser uses it |
|-----|----------------|--------------------------|
| `OPENAI_API_KEY` | Server only | Browser fetches a short-lived **ephemeral** Realtime session token from `/api/realtime/token`; the real key never ships |
| `NVIDIA_API_KEY`, `XAI_API_KEY`, `ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`, `CUSTOM_LLM_API_KEY` | Server only | Ask and voice both stay on the server. Grok voice receives a short-lived secret from `/api/llm/voice/session`. Claude, NVIDIA, OpenRouter, and a custom endpoint send transcripts and audio through `/api/llm/voice/*`. The browser never receives those keys |
| ChatGPT sign-in through Codex (optional, experimental) | Codex's own `auth.json` (`CODEX_HOME`, default `~/.codex`); GEV reads it server-side and never writes or refreshes it | Only after **USE CHATGPT OAUTH** is selected in Provider Settings: the server mints the same ephemeral Realtime token with the ChatGPT access token, for loopback clients or the owner's Tailscale device only |
| `AISSTREAM_API_KEY` | Server only | Server holds the AISStream websocket; browser polls the same-origin `/api/vessels` cache |
| OpenSky OAuth (`OPENSKY_CLIENT_ID/SECRET`) | Server only | Server mints + refreshes the token behind `/api/flights` |
| `GOOGLE_MAPS_SERVER_API_KEY` (optional, #33) | Server only | Server calls Places (`/api/google/nearby-places`, `/api/google/text-search`), Geocoding (`/api/google/geocode`, `/api/google/reverse-geocode`) and the Street View fallback with this key; falls back to `GOOGLE_MAPS_API_KEY` when unset |
| `ROAD511_API_KEY` (optional) | Server only | Read from the server environment on every lookup. Road511 is called only after you open a US camera that has no public image (`POST /api/cctv/lookup/:id`); the browser gets back only the lookup state. The 24 h lookup cache on disk stores image URLs and states, never the key, and a rejected key is logged once without its value |

### Three deliberately client-side keys — restrict them

These are designed to be used directly in the browser (like a Mapbox public token). They are injected into the client bundle via Vite's `define`, so they **will** be visible in browser devtools. Scope and restrict them rather than trying to hide them:

1. **Google Maps API key** — loads Photorealistic 3D Tiles directly and powers Street View (Maps JavaScript API; add it to the key's API restrictions). **Restrict it** (HTTP referrer + API restriction to the required Google APIs) in the Google Cloud Console. An unrestricted key in a public deployment can be abused and billed to you. Restrict it to the **Map Tiles API and Maps JavaScript API only**: a referrer restriction applies to the Maps JavaScript API and the client SDKs, not to the web services, so a key carrying Geocoding under one is refused with `API keys with referer restrictions cannot be used with this API`. Search does not need it — geocoding goes through the server proxies above (#363).
2. **Cesium ion token** (`CESIUM_ION_TOKEN`, optional — for ion-hosted Google Photorealistic 3D Tiles, Bing world imagery, and world terrain) — used as `Cesium.Ion.defaultAccessToken` client-side. Use a public **`assets:read`** token with **URL restrictions** for any hosted deployment. The Community plan has eligibility and usage limits; a public token is not a secret, but it can still consume the account's quota.
3. **Mapillary client token** (`MAPILLARY_CLIENT_TOKEN`, optional, Street Level) — used by the MapillaryJS viewer and Graph API lookups in the browser, and by the server's coverage-tile proxy, which sends it only to `tiles.mapillary.com` over HTTPS (an upstream redirect is refused and answered 502, never followed) and caches tiles in memory only, and by the image-metadata search (`/api/mapillary/images`), which sends it to `graph.mapillary.com` only in an `Authorization: OAuth` header, never in a URL, a log or an answer. Mapillary client tokens are meant for browser use.

> The explicit browser `define` block in `build/vite.js` controls exactly what reaches the client: only these three keys. Everything else stays server-side.

**Places, Geocoding and the Street View Static fallback never needed to be on that list** (#33, #363): they're called from the server-side proxies in the table above, which use `GOOGLE_MAPS_SERVER_API_KEY` when it's set. Splitting it from the browser-exposed key lets each key's Google Cloud restriction actually match what it does — the browser key referrer-restricted to Map Tiles + Maps JavaScript API, the server key IP-restricted (never a referrer, since it never leaves your server) to Places + Geocoding + Street View Static — instead of one key that has to be either over-permissioned or broken for one of its jobs. A single shared `GOOGLE_MAPS_API_KEY` still works if you don't split them, but then it cannot carry a referrer restriction at all: the web services refuse one, and search would be the half that breaks.

Never commit real keys. `.env` is gitignored; only `.env.example` (placeholder names) is tracked. On macOS `dev-fresh.sh` can read keys from the Keychain; plain Vite uses env vars or a local `.env`, and Pinokio uses its ignored app `ENVIRONMENT` file.

The official Pinokio launcher stores optional values in its ignored local
`pinokio/ENVIRONMENT` file and Vite explicitly denies that filename. Add,
replace, or remove those values through the in-app **POWER UP → Provider
Settings** panel; the server restricts the file before writing and restarts the
local app after a save. Do not submit credentials through Pinokio 8.0.40's
native Configure form: that release targets the wrong file for this nested
launcher layout and logs the submitted values. The ignored file is local
plaintext, not encrypted storage. The macOS Keychain remains the stronger local
option when launching through `./scripts/dev-fresh.sh`.

### Configuring separate Google keys locally

Terminal development uses one ignored repository-root `.env` for both
`GOOGLE_MAPS_API_KEY` (browser) and `GOOGLE_MAPS_SERVER_API_KEY` (server).
The tracked `.env.example` documents both without credentials. Vite injects
only the browser key; sharing an environment file does not expose the server
key. Provider Settings presents only the browser key as Google Maps; configure
the optional server key manually in the environment file. Pinokio uses
its ignored `pinokio/ENVIRONMENT` instead, with app values and blanks taking
precedence over inherited global values. An absent server key retains the
browser-key fallback for existing single-key setups.

## Server-side proxy hardening

The data proxies under `server/providers/` are written so the browser cannot turn the server into an open relay:

- **No arbitrary-URL fetching.** The CCTV frame proxy fetches only server-registered camera/frame URLs — clients cannot pass an upstream URL to fetch (SSRF mitigation). Other proxies target fixed upstream hosts.
- **Mapillary image search is small-box, header-authorised and pinned.** `GET /api/mapillary/images?bbox=west,south,east,north` takes only four plain decimals on the globe with west < east, south < north and at most 0.05° a side (Mapillary answers bbox searches only under 0.01 square degrees); anything else is a `400`, and without `MAPILLARY_CLIENT_TOKEN` it answers `503 {"error":"no_key","keyRequired":true}`, in both cases without calling Mapillary. It asks only the fixed host `https://graph.mapillary.com/images`, for fixed fields (no thumbnail links: those are signed URLs on CDN hosts that vary per image) and at most 2,000 images, with the token only in the `Authorization: OAuth` header; it never follows a redirect (a 3xx is a `502`), times out after 30 s, caps the body at 4 MB and validates every image (finite numbers; ids and sequence ids of at most 64 safe characters; a camera type of at most 32). Each box's answer is cached in memory for 24 h (32 MB, least recently used first). Like its siblings it refuses cross-site requests; it allows 300 searches a minute per client (1,200 overall), runs at most 4 upstream searches at once with 32 waiting (more get `503` with `Retry-After`), shares identical searches in flight, and after a rejected token (5 minutes) or a Mapillary `429` (its `Retry-After`, at most 10 minutes) answers misses without asking again.
- **Camera lookups and frames are decided by the server.** `POST /api/cctv/lookup/:id` answers only a same-origin POST whose `Host` is one the server serves (Fetch Metadata, and `Origin` must match that `Host`), is rate-limited to 30 requests a minute per client and 120 overall, and resolves only catalogue cameras marked for Road511 lookup with a well-formed feature id; anything else answers without an upstream call. An image URL Road511 returns is used only when it is http(s) on a public host. `/api/cctv/frame/:id` ignores client-supplied position, label and heading parameters, makes no upstream call for an unknown id, and uses the Street View fallback only when `CCTV_STREETVIEW_FALLBACK=1` and only for the open camera. `/api/cctv/sources` needs a point and returns at most the 1,000 cameras nearest to it, never the whole catalogue.
- **Live HLS is bounded and origin-pinned.** Registered HTTP(S) HLS sources use a Node puller that rejects redirects and off-origin playlist references, bounds playlists and segment bodies while streaming, and aborts timed-out or released sessions. At most two sessions retain 12 segments/24 MiB each, plus bounded download buffers. Stores are memory-only and idle sessions expire after 15 seconds. RTMP/ffmpeg execution is not enabled. Locally configured source URLs remain an operator trust boundary.
- **Radio is not an audio relay.** `/api/radio/stations` contacts only allowlisted Radio Browser HTTPS hosts and paths, rejects redirects, rejects any hostname with a loopback/private/link-local/metadata/non-public A or AAAA result, and pins each TLS connection to a validated address. It returns normalized public HTTPS stream URLs; `/api/radio/click/:uuid` applies the same destination policy and accepts only station IDs from the current bounded catalog. The browser then connects directly to the broadcaster after an explicit playback action, so the broadcaster sees the listener's IP address. GEV never proxies, caches, records, or redistributes audio.
- **No verbatim client headers upstream.** The CCTV media route is the one route that relays a request header (`Range`, for video seeking). It is parsed and canonicalized before it is forwarded: one `bytes=` range only, with every accepted form — explicit span, open-ended and suffix — bounded to the same 64 MiB ceiling the relay applies to a declared response body. Multi-range, malformed, inverted and non-`bytes` values are dropped and the request proceeds without a `Range`, as RFC 7233 §3.1 prescribes. Bounding the request bounds what is asked for: a response that declares no length — live streamed media, or a chunked body from an upstream that ignores the `Range` — has no ceiling. An upstream request the browser has stopped waiting for is cancelled rather than left running, whether the viewer leaves before the headers arrive or during the body.
- **Transit fetches registered feeds only.** `/api/transit/vehicles/<id>` resolves the id against `src/data/transitFeeds.js`; the browser never supplies a URL, and a feed that is registered but disabled does not resolve at all. Redirects are followed manually and each hop is validated against the feed's own https origin before it is requested, so an off-origin or downgraded hop is refused rather than contacted. Bodies are capped at 8 MB, the protobuf is decoded server-side under entity-count and string-length ceilings, a differential feed is refused, and snapshots live 15 s in memory with no disk cache. A per-feed admission limiter and a failure cooldown ladder bound what this process can ask of any operator.
- **Local receiver feeds are operator-configured and local-only.** `/api/local-receivers/aircraft` reads only the `aircraft.json` URLs in the server's `LOCAL_RECEIVER_FEEDS`; the browser never supplies an address. Each host must pass the shared tap address rule (`src/data/tapAddress.js`: loopback, RFC1918, `localhost`, `*.local`; no link-local, IPv6 or other names), the scheme must be http(s), the path must end in `aircraft.json`, and credentials, queries and fragments are refused. Invalid entries are logged at startup and never fetched. Reads use a 2 s timeout, refuse redirects, cap bodies at 2 MB and share one read per second; responses name each feed by band only and never carry upstream error text.
- **Validated response formats.** Proxied bodies are relayed only in the format the route serves. CCTV frames and the Street View fallback accept JPEG, PNG, GIF, WebP and AVIF only, sent under their canonical type; any other type falls through to the next fallback. Live CCTV media must match its feed kind (`video/mp4`, `video/webm`, or `multipart/x-mixed-replace` with a boundary) before it is relayed or the camera counts as healthy, and its redirects stay on the registered origin. GBFS bodies must parse as JSON and are re-serialized as `application/json; charset=utf-8`. Camera catalog URLs are pinned by parsed URL — scheme, exact host, no credentials, default port, and a normalized path inside the agency's image directory — and a redirect on a pinned host must stay inside the same directory. Every `/api/cctv` route uses the keyless cross-site checks described below, so cameras stay reachable behind a reverse proxy; a request carrying forwarding headers never reaches the key-bearing Street View fallback and gets the placeholder frame instead, as when no key is configured.
- **Consistent API response headers.** Every `/api` response, including errors, partial content, Host refusals and unknown routes, carries `Content-Security-Policy: default-src 'none'; sandbox` and `X-Content-Type-Options: nosniff` (`apiResponseHeadersPlugin` in `build/vite.js`, installed ahead of the Host check). A route that sets its own policy adds it as a further policy; it never replaces this one.
- **Response-size caps and timeouts** on proxied responses.
- **Sanitized errors** — internal error details are not echoed back to clients.
- **Coalesced OAuth refresh** and cached successful responses only (OpenSky).
- **Redacted debug logging.** The voice debug log (`.gev-logs/`, gitignored) strips API keys, bearer tokens, client secrets, and image data URLs before writing.
- **Cross-site gate on cost/log endpoints.** The cost-bearing (`/api/realtime/token`, `/api/openai/hud-summary`, `/api/google/nearby-places`, `/api/google/text-search`), quota-bearing (`/api/mapillary/*`, with per-IP limits on tiles and image searches, and `/api/tomtom/*`, backed by its persistent daily tile budget) and log (`/api/realtime/debug-log`) endpoints refuse cross-site browser requests: a foreign or opaque `Origin`, a `Sec-Fetch-Site` other than `same-origin`/`none` (this is what blocks an `<img>`/navigation that carries no `Origin`), or any reverse-proxy/CDN forwarding header returns `403`. Non-browser loopback tools (the repo QA harnesses POST the token endpoint with no `Origin`) and the explicit `HOST=0.0.0.0` LAN opt-in keep working — the gate deliberately does not require a loopback remote address; that stricter requirement belongs only to the credential panel (`admitKeySetupRequest`). The Host check (`allowedHosts`, applied by `hostCheckPlugin` ahead of every route, since Vite's own check runs only after plugin middleware) rejects a rebinding `Host` before any handler runs, in every mode, and the gate is defense in depth behind it: the LAN opt-in keeps that check and accepts only IP addresses, `localhost` and names listed in `GEV_ALLOWED_HOSTS`. **Limit:** a name you list there is trusted like the app's own address, so list only names you control. The keyless terrain route (`/api/terrain/heights`) uses the same cross-site checks, minus the forwarding-header refusal: it guards only the per-client quota and point cache, not a key or a bill, and the map needs it to render behind a reverse proxy. The CCTV routes (`/api/cctv/*`) use the same keyless checks; their one key-bearing step, the Street View fallback, is skipped for any request with forwarding headers.
- **Full Content-Security-Policy.** The dev and preview servers send a real CSP (`script-src 'self' 'unsafe-eval' blob:` plus the YouTube, Facebook and X scripts the Nepal event's embedded media loads and the Maps JavaScript API that Street View runs on, with a matching `frame-src` for their players and posts: no inline script and no other script origin; `blob:` covers the object URLs Cesium's bundled workers bootstrap through in the built app), alongside the existing `X-Frame-Options: DENY` and `frame-ancestors 'none'`. `'unsafe-eval'` stays because Knockout, bundled inside Cesium's widgets package, resolves the global object with `eval` at load time and the globe does not initialize without it; styles permit `'unsafe-inline'` and Google Fonts because Vite's dev client injects `<style>` elements.

Allowing `maps.googleapis.com` in `script-src` also trusts its JSONP endpoints, which can bypass the script allowlist if an HTML-injection bug exists; this is an accepted limitation of loading the Maps JavaScript API, alongside the existing `'unsafe-eval'` allowance.
- **ChatGPT OAuth voice reuses the local Codex sign-in.** `/api/realtime/oauth-status`, `/api/realtime/oauth-login` and `/api/realtime/token?auth=oauth` answer only loopback connections or [the owner's Tailscale device](#your-own-phone-over-tailscale-mirror-of-pc-gevc-on-cell), behind the same cross-site gate as the token endpoint; the login route also refuses a foreign `Origin`, and from the owner's device it requires an exact one. `codex login` always runs on the PC, so its sign-in page opens in the PC's browser. None of them returns the access token. The login route runs `codex login` (or the executable named by `CODEX_BIN`) without a shell. On Windows the program is always a full path (`CODEX_BIN` must be one), so the working folder is never searched before PATH, and an npm `codex.cmd` shim is replaced by Node running the shim's own `codex.js`; the window is hidden. It runs with an allowlisted environment that leaves out GEV's provider keys, keeps one attempt pending at a time and cancels it after two minutes or when the server stops. **Limits:** any program on this machine that can reach the server can mint Realtime sessions on the signed-in ChatGPT account, as it can with the API key; a local reverse proxy that hides the client's address defeats the loopback check; and OpenAI has not documented this use of Codex credentials for Realtime, so it may stop working or fall outside the account's terms.

## Private home and business security cameras

POWER UP → **HOME SECURITY · PRIVATE_CCTV_FEED** and **BUSINESS SECURITY** add your own
cameras. They are deliberately separate from the public CCTV proxy and catalogue
(`server/providers/private-cameras.js`, `src/privateCamerasCore.mjs`):

- **At rest.** Logins, tokens and camera addresses live only in
  `config/private-cameras.json` — git-ignored and written through the same
  owner-only credential-store writer as `.env`. They are never logged, never
  sent to the browser (the panel sees only "saved" flags and masked addresses),
  and never enter share links, the area cap or `/api/cctv/sources`.
- **Browser ↔ server.** Every `/api/private-cams/*` route answers only the
  machine running the server or the owner's Tailscale device (the relay
  extension routes answer only the PC; see below): the Provider Settings gate refuses LAN peers,
  tunnels, proxied requests, foreign `Host` headers (DNS rebinding) and any
  sharing mode. Requests another website triggers are refused by Fetch Metadata
  (`Sec-Fetch-Site`), and every response is `Cross-Origin-Resource-Policy:
  same-origin`, `no-store` and `nosniff`, so a page elsewhere can neither embed
  a camera frame nor read the camera list. Saving requires the exact local
  `Origin` and a JSON body; editing exists only under the dev server. The
  owner's device may add, edit and move cameras and approve a relay pairing,
  but a save that removes a camera or site, clears a saved password or token,
  or drops the relay pairing, and `/relay/unpair`, are refused from it ("Removing
  is done on the PC") and nothing is written.
- **Server ↔ bridge or camera.** A password or token is never sent over plain
  `http://` beyond the local network (loopback, RFC 1918, link-local, Tailscale
  / CGNAT, `.local` / `.lan` / `.home.arpa` names); anything else must be
  `https://`, both when you save and again on every fetch. Passwords go out only
  in answer to the camera's challenge — Digest when offered, Basic only over
  https or the local network. Redirects are refused, so a login is never replayed
  to another host. A pinned SHA-256 certificate fingerprint (for self-signed
  Home Assistant, Scrypted or NVR certificates) is checked on the TLS handshake
  before any request byte is written. Only JPEG, PNG, WebP and GIF stills are
  relayed; an SVG or HTML answer is dropped.
- **Private_CCTV_Feed.** The app never signs in to Private_CCTV_Feed. Private_CCTV_Feed cameras come through a bridge you
  run (Home Assistant with a camera integration, or Scrypted), which holds the Private_CCTV_Feed login
  and two-factor codes, or through the optional browser feed relay described
  below. Give the bridge a dedicated, non-admin user for the long-lived access
  token you paste here, and prefer its https address.
- **The store is never a static file.** Vite serves the whole checkout, so a
  guard that runs before any static file handling answers `404` to every URL
  naming `private-cameras.json` — however it is cased, percent-encoded or
  shortened to a Windows 8.3 name.
- **Status and frames are readable by local software.**
  `GET /api/private-cams/frame/:id` and `GET /api/private-cams/status` (site and
  camera names, pairing state and any waiting relay pairing code) answer any
  program on this machine, including another local process or a browser
  extension allowed to reach `localhost`: Fetch Metadata and
  `Cross-Origin-Resource-Policy` stop other *websites*, not software you run. A
  local program can also forge the headers the POWER UP routes check, so none of
  these gates protects against software already running as you.

### Private_CCTV_Feed browser feed relay

A personal Private_CCTV_Feed account offers no API key, camera address or RTSP stream, and
GEV will not script Private_CCTV_Feed's sign-in, which would mean defeating its bot
protection. A home site set to **Browser feed relay** instead receives pictures
from **GEV Private_CCTV_Feed Relay**, a personal unpacked Chrome extension in
`tools/private-cctv-feed-relay` (`npm run private-cctv-feed-relay:install`):

- **What leaves the extension.** While your own signed-in
  `https://feed.private-cctv.example/#/feed` tab is open, the extension reads the newest clip
  thumbnail per camera from that page, fetches the image without credentials
  from Private_CCTV_Feed's image host and sends GEV only the image bytes, the camera name and
  a short clip label (such as "Motion · 2:14 PM"). It never reads or forwards
  cookies, `localStorage` / `sessionStorage`, `Authorization` headers or any Private_CCTV_Feed
  login; it never clicks, scrolls, reloads or keeps the Private_CCTV_Feed session alive; it
  has no `cookies`, `tabs`, `scripting`, `webRequest` or `debugger` permission
  and runs nothing in the page's own JavaScript world. The signed thumbnail
  addresses stay in the extension's memory: they are never logged, stored or
  sent, and its diagnostics show hostnames only.
- **No login travels.** A relay site sends its saved bridge address, token,
  username and password nowhere. Values saved earlier stay in
  `config/private-cameras.json`, unused, until the site is switched back.
- **Who can reach the relay routes.** `/api/private-cams/relay/pair-request`,
  `pair-status`, `frame` and `heartbeat` apply the same locality checks as the
  other private camera routes (loopback peer, local `Host`, no proxy headers, no
  sharing mode) and refuse the owner's Tailscale device, since only the
  extension on the PC uses them. They also require `Sec-Fetch-Site: none`, which a browser never
  attaches to a request made by a web page, and on every write
  `Origin: chrome-extension://<id>`. No route sends CORS headers and preflight
  `OPTIONS` requests are refused. A local program can forge headers, so headers
  alone authenticate nothing: the paired secret does.
- **Pairing is approved in POWER UP.** The extension creates a 32-byte random
  secret and sends GEV only its SHA-256 hash. GEV issues the request a random
  6-character code of its own — never one the request sends, and never one
  another waiting request shows — and the extension's options page shows that
  code. The request waits in server memory for two minutes and grants nothing
  until you press **APPROVE** in POWER UP — through the normal same-origin, JSON,
  dev-server-only gate — after checking that both the code and the extension ID
  match the extension's options page. Each extension may have one request
  waiting (at most four extensions at once, each rate-limited on its own), and a
  request only ever replaces its own extension's earlier one. So another
  extension that reads a waiting code from `GET /status` can neither put that
  code on a request of its own, swap in its own secret nor push the real request
  out: its request shows separately, with a different code and its own extension
  ID. **APPROVE** sends both the code and the extension ID it showed, the server
  pairs exactly the request that has both, then discards every other waiting
  request. The store then keeps the extension ID and the secret's hash, never
  the secret. **UNPAIR**, or switching the site away from the relay, forgets
  both.
- **What a frame must pass.** A frame needs the bearer secret of a paired site,
  sent from that site's extension ID, with a camera-name header and a declared
  `image/jpeg`, `image/png` or `image/webp` body of at most 8 MiB — all checked
  before any byte of the body is read. Then its magic bytes must match the
  declared type, and each camera accepts at most one frame every 2 seconds.
  Frames, heartbeats and unmatched camera names live in memory only: nothing the
  relay sends is written to disk, and a restart forgets it. A heartbeat answer
  tells the extension only which of the camera names it reported still need a
  picture and which match no camera, so it downloads a thumbnail from Private_CCTV_Feed only
  when GEV will take it.
- **No stale picture passes for a current one.** A relay picture is shown only
  while the relay keeps reporting and its feed tab shows Private_CCTV_Feed signed in. When
  that tab reports that Private_CCTV_Feed signed the page out, the pictures give way within
  seconds. Each heartbeat carries an opaque tag for its tab (a hash, not the tab
  or any Private_CCTV_Feed value), so a sign-in page left open in another tab does not
  override a tab that reported reading the feed in the last 2.5 minutes. Without
  a current picture the camera shows a placeholder saying why, with the time the
  last picture arrived. A camera whose Private_CCTV_Feed name changes on save (a new Name or
  Private_CCTV_Feed name, or two Private_CCTV_Feed names swapped) drops its picture, so it never shows
  another camera's.
- **Private_CCTV_Feed's terms.** Private_CCTV_Feed's Terms of Service prohibit data-gathering or
  extraction tools and unapproved applications, and allow Private_CCTV_Feed to terminate
  accounts that use them. The relay is a personal tool you install and run at
  your own risk; Private_CCTV_Feed neither makes nor approves it. Its pictures are the latest
  motion-clip thumbnails, not live video, and they stop when Private_CCTV_Feed signs the web
  page out after inactivity.

## Your own drones, robots, marine drones and GPS trackers

POWER UP → **YOUR DEVICES** adds any number of devices of four kinds, and the
package cards at the bottom of the ULTRA SECURITY PACKAGE tab add Ultra
Security Packages, a fifth kind, through the same routes
(`server/providers/device-feeds.js`, `src/deviceFeedsCore.mjs`). The rules are
the private cameras' rules:

- **At rest.** Addresses and logins live only in `config/device-feeds.json` —
  git-ignored, written through the same owner-only credential-store writer as
  `.env`, and answered `404` by a guard that runs before any static file
  handling, however the name is cased, percent-encoded or shortened. A store
  that cannot be read is never overwritten by a save.
- **Browser ↔ server.** Every `/api/device-feeds/*` route answers only the
  machine running the server or the owner's Tailscale device (the Provider
  Settings gate; the owner's device may add and edit devices but not remove
  one) and only this page
  (Fetch Metadata). The card is told "saved" flags and masked addresses, never a
  value; the map layer is told a name, a kind and a position, never an address
  or a login. Devices can be saved only under the dev server.
- **Server ↔ device.** Only http(s) addresses with no login inside them. A login
  is sent only over https, or over plain http to a device on your own network.
  A username and password answer the device's challenge and nothing else
  (Digest preferred, Basic only when that is what it asks for); bearer tokens
  and API keys go on the request. A redirect is never followed, so a login is
  never carried to wherever a device points. Answers are size-capped, a picture
  must be an image, and a device is asked at most once every 5 seconds, less
  often while it is not answering.
- **Follow and record (Ultra Security Package, or any device).** A device's
  recording (what the map knew within 50 km of it, and its own track) is a
  folder of daily JSON-lines files under `config/device-recordings/`. It holds
  where someone's tracker or phone has been, so it is treated like the login
  store: git-ignored, answered `404` by the same guard, restricted to your
  account (with SYSTEM and Administrators on Windows, 0700 elsewhere) the
  first time a process writes to it, inherited by every file in it, the
  phone's `last-report.json` included, and written only by
  `POST /api/device-feeds/record/<id>`, which answers this machine (or the
  owner's Tailscale device) and this page only, refuses a device whose RECORD switch is off, saves no more often
  than every 10 seconds, and re-checks every record against the position the
  SERVER knows for the device. A camera is saved by name and place, never by
  stream address. Removing a device leaves its recordings; delete the folder to
  delete them. A phone is only ever reached through an app installed on it
  that reports to a server of its owner's: there is no lookup by number. Use it
  for devices and people you are responsible for, who know.
- **Local devices are reachable on purpose.** Drones, robots and boats live on
  your own network, so these addresses may be private ones. Only the machine
  running the server can set them.

## Artificial Intelligence World Training Sim

The tab's routes, `/api/ai-world/*` (`server/providers/aiWorld.js`,
docs/AI-WORLD-TAB.md), start heavy local work and delete local data, so they
follow the device feeds' rules:

- **Who may ask.** Only the machine running the server (loopback socket and
  a local `Host`) or the owner's Tailscale device, with an exact `Origin` and
  a JSON body on writes and same-origin Fetch Metadata; proxied requests and
  sharing modes are refused (the Provider Settings gate). Writes are limited
  to 30 a minute per client and 60 overall; the status and catalog routes
  answer before the limiter.
- **Delete.** `GET /delete-preview` lists what would go, by group, with a
  sha256 token over every listed path, size and modification time.
  `DELETE /delete` lists again and refuses (409) unless the token matches,
  deletes only those files, only inside `.gev-data/` (resolved paths;
  links are removed as links, never followed), only while the job is
  stopped, and never touches `.gev-cache`, `config/` or the repository. The
  owner's phone is refused every removal with `X-GEV-Removal: pc-only` and
  `{"removal":"pc-only"}` (owner ruling 2026-10-11), by the mirror and by the
  route.
- **Areas.** `POST /areas` adds a point (finite latitude and longitude, a
  name of at most 80 characters, at most 32 areas) to
  `.gev-data/ai-world/areas.json`; the feeds that record around places
  (cameras, traffic, news, imagery, street level, the mapped static layers)
  use only those points. `DELETE /areas` takes one off the list (recording
  stops there; what was recorded stays) and is refused to the owner's phone
  like every removal.
- **Upstreams.** The recorder reads almost every feed through the app's own
  `/api/` routes, so every proxy's fixed hosts, budgets and keys still
  apply; camera stills go through `/api/cctv/frame/<id>` and its 511
  host budget, never school, university, college or library cameras.
  Street level reads Mapillary only through `/api/mapillary/tiles/coverage`
  and `/api/mapillary/images` (at most 32 image searches an area a day) and
  never fetches image pixels. Two layers have no app route and their sources fetch fixed hosts from the
  server, as the browser does: RECENT SATELLITE IMAGERY (NASA CMR
  `cmr.earthdata.nasa.gov` and Worldview snapshots `wvs.earthdata.nasa.gov`,
  one catalog query and at most one image per area a day) and PLATE-READER
  CAMERAS (the OpenStreetMap extract at `tiles.dontgetflocked.com`, once a
  day per area). Both are asked only for the selected areas' boxes, never a
  URL a request names. YOUR DEVICES reads the owner's own recordings under
  `config/device-recordings/` without writing there. POPULATION
  DEMOGRAPHICS fetches the World Bank API the rail volumes already use. The
  child processes are the repository's own `ml/` modules, started with a
  fixed argument list (no shell); `GEV_PYTHON` only chooses the interpreter.
  OWID, OxCGRT, the USGS catalogue, the FIRMS archive, the GFS archive,
  HURDAT2 and past VIIRS images are fetched only by the command-line tools,
  never by the server. `world-tape:backfill` asks only fixed hosts:
  `earthquake.usgs.gov`, `firms.modaps.eosdis.nasa.gov`,
  `noaa-gfs-bdp-pds.s3.amazonaws.com` (the `.idx` inventories and byte ranges
  of the object keys the Wind proxy builds; one cycle at a time, at most four
  ranges in flight, 60 s per request, bodies capped as the proxy caps them),
  `www.nhc.noaa.gov` (the `/data/hurdat/` listing, then only file names a
  strict pattern accepts, resolved in that folder; 1 MB and 32 MB caps) and
  `wvs.earthdata.nasa.gov` (through the Recent Imagery source, for the AI
  World areas' boxes or `--area` points only). Its GFS, HURDAT2 and Worldview
  requests refuse redirects. It writes only under its `--tape` directory
  (default `.gev-data/tape/`) and reads `.gev-data/ai-world/areas.json`.
- **Typed addresses.** A news URL (the NEWS EVENTS list) is fetched only
  if it is public https: no userinfo, the host checked as written and again
  after DNS (every address it resolves to must be public), and redirects
  followed by hand, at most three, each new address checked the same way
  (`server/shared/publicFetch.mjs`). Fetch's own redirect-following would
  let a public page send the request into the owner's network.
- **Market quotes.** Yahoo Finance's chart and spark endpoints
  (`query1.finance.yahoo.com`, fixed symbols from `src/marketAssets.mjs`, 20
  a request), Twelve Data (`api.twelvedata.com`; its key rides in the
  `Authorization` header, never the address) and OilPriceAPI
  (`api.oilpriceapi.com`, key in the `Authorization` header). Not advice.
- **POST-TRAIN.** `POST /posttrain` names an adapter as `module:Class` and
  an existing model's checkpoint. The adapter must be a file in the
  repository's `ml/adapters/` or `.gev-data/ai-world/adapters/` (the
  pattern `^[a-z_][a-z0-9_]*:[A-Za-z_][A-Za-z0-9_]*$`; nothing else is
  imported), the checkpoint a path that resolves inside `.gev-data/`; both are
  checked on the server before anything runs, and `ml.gevtape.posttrain`
  loads the adapter from those folders only. Writing an adapter file is
  writing code that runs on this PC: only the owner puts one there.
- **At rest.** Everything recorded lives in the gitignored `.gev-data/`,
  each record tagged with its licence class; the job state in
  `.gev-data/ai-world/state.json` holds no credential. The dev server never
  serves `.gev-data/` as static files (`fs.deny` in `build/vite.js`; dev-mode
  sirv does not skip dotfiles, so before this a GET of
  `/.gev-data/<path>` returned the file) and never watches it; only the
  `/api/ai-world` routes read it.

## Custom LLM training

The POWER UP section's routes, `/api/llm-training/*`
(`server/providers/llmTraining.js`, `server/shared/llmTraining.mjs`), start
heavy local work and read the owner's files, so they follow the same rules as
the AI World tab's:

- **Who may ask.** This machine's own page (loopback socket, local `Host`)
  or the owner's Tailscale device, exact `Origin`, JSON bodies on writes,
  same-origin Fetch Metadata; writes limited to 30 a minute per client, 60
  overall. The owner's phone may add URLs and local sources and start, pause
  and stop a run; every DELETE (a URL or a local source off the list) is
  refused to it with `X-GEV-Removal: pc-only`, as every removal is.
- **Custom URLs.** At most 100, public https only (`cleanNewsUrl`), fetched
  only when INITIALIZE TRAINING runs, through `server/shared/publicFetch.mjs`
  (DNS checked, redirects followed by hand and checked again, 15 s, text
  types only, at most 2 MB of text each). Their text is kept under
  `.gev-data/llm/sources/urls/`; a URL taken off the list takes its text
  with it.
- **Local sources.** At most 50 absolute paths to files or folders that
  exist. The app's own keys and output are refused: the repository's
  `config/`, `.gev-cache/`, any `.env…`, `.gev-data/llm/`, and any folder
  that holds them (the repository itself). The dataset builder reads only
  text-like files (text, Markdown, CSV, JSON lines, HTML, code; at most 2 MB a
  file, 200 MB and 20,000 files in all), skips hidden folders and files
  (`.git`, `.ssh`, `.env`), and copies their text into the training set under
  `.gev-data/llm/<name>/data/`, which stays on this machine.
- **Models.** The base model is loaded with `local_files_only`: nothing is
  downloaded. It is found in `.gev-data/llm/base/<name>` (the default
  Qwen3.5-0.8B and the large option Qwen3.6-35B-A3B are downloaded there once
  by the owner), the Hugging Face cache, or a folder the owner names; only native transformers model classes
  load it, never code from the model folder (`trust_remote_code` is off). The trained adapters (`adapter.safetensors`, `adapter.json`)
  stay under `.gev-data/llm/<name>/model/`. The child processes are the
  repository's own `ml.gevtape.llm_data` and `ml.gevtape.llm_train`, started
  with a fixed argument list (no shell).
- **What a model can repeat.** A model trained on a file can say what was in
  it. Local sources are the owner's choice; the refusals above keep this
  app's own keys out, not every secret a chosen folder may hold.

## Network exposure — the operator threat model

The dev server is a **key broker**: every server-side key above is spendable by anyone who can send HTTP requests to it. That shapes the defaults:

- **Local-only by default.** `./scripts/dev-fresh.sh` (and the Vite config itself) bind to `localhost`, so only your machine can reach the server — and only local names are accepted (`allowedHosts` stays restricted, which also blunts DNS-rebinding tricks). Binding to all interfaces keeps that restriction: IP addresses and `localhost` work, and LAN hostnames must be listed in `GEV_ALLOWED_HOSTS` (for example `GEV_ALLOWED_HOSTS=globe.lan`); suffix and wildcard entries are ignored. `POST /api/cctv/lookup/:id`, `POST /api/location-switch/release`, the model routes (`/api/llm/ask`, `/api/llm/voice/*`), the bot swarms (`/api/social/swarm`) and the public news lookup (`/api/social/public-news`) also check the `Host` against the served hosts themselves (`server/providers/common/allowed-hosts.js`), on top of the Host check that runs ahead of every route. `/api/llm/ask` also takes at most 20 questions a minute from one address without any setting.
- **Opening Grok Bot starts a program here, so only this machine's own page (or the owner's Tailscale device) may ask.** `POST /api/social/grok-bot/open` (OPEN GROK BOT, and GROK BOT SWARM when it has no API key and no computer) uses POWER UP's gate: a loopback socket, a local Host, an exact local Origin, JSON, no proxy headers, never while sharing (or the owner's device stamped by the mirror, with its exact Origin; the program still opens on the PC). It opens only `GROK_BOT_LINK` from `.env` (a `.lnk` or `.exe` on a local drive, never a share or device path) or Grok Bot's own `grokbot://app/v1/open`, never anything the request names (a `target`, window, or agent in the body is ignored), through Explorer under `SystemRoot` (never a program found on `PATH`), at most once every 3 seconds. A swarm or skill-check body `{ paste: true, text }` (text capped at 16 KB; never argv) also pastes that task into the focused Grok Bot composer on Windows (`scripts/paste-grok-bot.ps1`, PowerShell 5.1 under `SystemRoot`, process name `Grok Bot` only) and sends it. The script keeps that window topmost until Ctrl+V so another app in front does not receive the keys, and it refuses to send if the click pixel is not Grok Bot. OPEN GROK BOT still posts `{}` and does not paste. Missing or oversized text is not pasted (never the current clipboard).
- **Opening ChatGPT starts a program here, so only this machine's own page (or the owner's Tailscale device) may ask.** `POST /api/social/openai-dots/open` (OPEN CHATGPT, and OPENAI BOT SWARM / OPENAI DOT SWARM when it has no API key) uses the same POWER UP gate as Grok Bot. It opens only `OPENAI_DOTS_LINK` from `.env` (a `.lnk` or `.exe` on a local drive, never a share or device path) or ChatGPT's own `chatgpt://` link, never anything the request names, through Explorer under `SystemRoot`, at most once every 3 seconds. A swarm or skill-check body `{ paste: true, text }` (text capped at 16 KB; never argv) also pastes that task into the focused ChatGPT composer on Windows (`scripts/paste-openai-dots.ps1`, PowerShell 5.1 under `SystemRoot`, process names `ChatGPT Classic` and `ChatGPT`) and sends it. The script keeps that window topmost until Ctrl+V so another app in front does not receive the keys, and it refuses to send if the click pixel is not ChatGPT. OPEN CHATGPT still posts `{}` and does not paste. Missing or oversized text is not pasted (never the current clipboard).
- **The Grok Bot computer token goes only to that computer.** `GROK_BOT_GATEWAY_URL` must be loopback (`127.0.0.1`, `localhost` or `::1`, any port; Grok Bot's own is `http://127.0.0.1:1340`), http to a `100.64.x.x` Tailscale address, or https on a `.ts.net` name, with no user:password, query or path; POWER UP refuses any other address, `POST /api/social/swarm/grok-bot` checks it again before every send, and a hand edit after a POWER UP save fails its integrity check (and `/status` then stops offering the computer). That route sends the saved token, so only this machine's own page or the owner's Tailscale device may ask: POWER UP's gate (a loopback socket or the owner's stamped device, an exact Origin, JSON, no proxy headers). It is rate-limited before any lookup, shares the nearest-city cache and limit, runs one sweep per bot at a time, and the token rides only in the `Authorization` header. A refusal is reported without the token: the token is redacted before the text is cut.
- **The Chief of Staff webhook key goes only to Grok Bot.** `GROK_BOT_WEBHOOK_URL` must be https on a `cursor.sh` or `cursor.com` host with the path `/automations/webhook/<id>` and nothing else; POWER UP refuses any other address, the route checks it again before every send, and a hand edit after a POWER UP save fails its integrity check. A refusal from the webhook is reported without the key, and its answer is never passed on. Swarm buttons do not call this route.
- **LAN exposure is an explicit opt-in**: `HOST=0.0.0.0 ./scripts/dev-fresh.sh`. The launcher prints a prominent warning plus your LAN URL. Understand what opting in means: **every device on that network can drive the proxies and spend your OpenAI / Google / OpenSky / AISStream / TomTom / FIRMS / Road511 quota** for as long as the server runs. Do this only on networks you trust.
- **App-level throttles (on by default):** `GEV_RATELIMIT_OPENAI_PER_MIN` (default `30`) and `GEV_RATELIMIT_GOOGLE_PER_MIN` (default `120`) — the values the Pinokio build already ships — cap the cost-bearing endpoints per client IP per minute (over-limit requests receive a sanitized `429`). Both defaults sit well above what the app itself generates; set either to exactly `0` to run unthrottled. They are **per-IP, process-local, in-memory guards** — they reset on restart, a caller with several addresses gets a bucket per address, and they are **not billing caps**.
- **Docker trusts one address, and only because the port is on loopback.**
  Docker delivers the host's own browser to the container from the container
  network's gateway, never from `127.0.0.1`, so a loopback-only Provider
  Settings refuses the machine running it. `scripts/docker-start.mjs` therefore
  sets `GEV_KEY_SETUP_TRUSTED_PEERS` to exactly that gateway address. The list
  takes exact addresses only (no wildcards, prefixes or hostnames), is unset
  under every other launcher, and relaxes none of the sharing, Host, Origin,
  Content-Type or proxy-header checks. It is safe precisely because
  `compose.yaml` publishes on `127.0.0.1`: **widen that mapping and every LAN
  client arrives from the same gateway address, which hands them Provider
  Settings too.** Treat publishing beyond loopback as the LAN opt-in above.
  Compose forwards `GEV_KEY_SETUP_TRUSTED_PEERS` and `GEV_ALLOWED_HOSTS` from
  the shell or project `.env` before the launcher runs. Set trusted peers to
  `none` when widening the publish: it becomes an explicit empty list before
  Vite loads configuration, so the gateway cannot regain Provider Settings
  access. Unset or blank values preserve automatic gateway discovery.
- **Provider-side budgets are the real backstop.** For hard spend protection, configure limits where the money is: OpenAI platform usage limits, Google Cloud budget alerts + per-API quotas, and equivalent controls for any other keyed provider.
- **Pinokio LAN and Cloudflare sharing are refused.** The current supported
  Pinokio release re-reads sharing state when an app registers its Open URL and
  logs a successful tunnel-login passcode in its own notification and terminal
  stream. Before preflight, the launcher rewrites its app-scoped sharing controls
  to disabled values, clears any Pinokio-global passcode from the child, and
  pins the platform share trigger to a disabled sentinel. A stale or requested
  sharing value is therefore discarded rather than honored, and GEV starts on
  loopback only. Use a separately reviewed authentication proxy for remote
  access and keep provider-side quotas as the spend backstop.

## Your own phone over Tailscale (Mirror of PC GEVC on Cell)

`GEV_TAILNET_DASHBOARD=1` serves the dashboard on this machine's Tailscale
address for the owner's own phone or tablet
([Mirror of PC GEVC on Cell](Mirror%20of%20PC%20GEVC%20on%20Cell/README.md)).
By owner ruling (2026-10-11) that device gets every PC function, writes
included, except removing or deleting anything stored on the PC.

- **Tailnet IPv4 only.** The second listener binds to the machine's
  100.64.0.0/10 address alone, never a LAN or public one.
- **Only the owner's devices.** Each caller's address is checked with
  `tailscale whois` against the account this machine is signed in to. Answers
  are cached for 5 minutes, and a lookup that fails counts as no. Anyone
  else's device is refused every request, and its websockets are closed. A
  tagged PC has no owner, and a tagged node, subnet router or exit node is
  never taken for the owner's device, because every node or LAN client behind
  it would share the owner's identity.
- **A stamp only the mirror can set.** Every caller-sent
  `x-gev-owner-device*` header is removed on entry. An owner request is then
  stamped with a 32-byte random token held only in memory (cleared when the
  server stops) and the listener's own `http://<tailnet IP>:<port>`, never
  taken from the request. The gates (`ownerDeviceAuthority` in
  `src/keySetupCore.mjs`) accept the stamp only from a tailnet socket, with
  a constant-time token match, over http, and with a Host equal to that
  authority, so a DNS-rebinding page or a forged header on the loopback
  listener does not pass.
- **Writes keep the browser rules.** Every request from the owner's device
  other than GET and HEAD needs the exact mirror Origin, and POST, PUT, PATCH
  and any other request with a body need JSON.
- **Proxies and sharing are refused first.** `x-forwarded-*` and other proxy
  headers (`tailscale serve`, Funnel) and any sharing mode are refused before
  the stamp is looked at, and the mirror does not stamp a proxied request.
- **Removing stays on the PC.** From the owner's device, every DELETE and
  each of these removals sent as a save is refused silently (owner ruling): it
  answers 403 with `X-GEV-Removal: pc-only` and the body `{"removal":"pc-only"}`,
  no error text, the phone shows nothing and keeps the item, and nothing is
  written: clearing a POWER UP key, road CCTV key and social
  login removal, Ultra media delete, token reset, revoke and remove, contact,
  home-list and inbox removal, clearing the owner number or the HELP DELIVERY
  default, private camera, site, password or token removal and relay unpair,
  device removal, and forgetting a CCTV alignment. MCP calls from the owner's
  device are refused the same way. The PC itself may still remove. Releasing
  a road camera's live-stream lease (`DELETE /api/cctv/media/<id>?lease=...`)
  frees only an in-memory session and is allowed.
- **Paths that stay apart.** The private camera relay extension routes answer
  only the PC, device `/report` stays admitted by device key alone, and the
  Ultra holder and phone routes stay token-only.
- **Accepted consequence.** An unlocked phone signed in to your Tailscale
  account can save POWER UP keys and social logins, press SEND HELP and start
  programs on the PC (ChatGPT sign-in, OPEN GROK BOT). Keep it locked. A
  plain TCP forwarder (`tailscale serve --tcp`, socat) on one of your own
  devices that points at the mirror port still counts as you, so anything
  that can reach that forwarder gets the same access; do not run one.

## MCP server and panel

God's Eye View's tools are also served to MCP clients: over stdio (`npm run mcp`) and at `/mcp` on the development and preview servers.

- **`/mcp` answers only direct local requests**: a loopback connection naming a loopback host on the port it reached, a browser `Origin` (when sent) from that same host, no proxy forwarding headers, and launcher sharing off. The owner's Tailscale device is also admitted when its Host is the mirror's own address and port and every non-GET request carries that exact Origin; its calls get a server of their own whose tools reach the API over loopback without the stamp and are refused every DELETE, PUT and PATCH and every POST to a route family that can remove stored data. It accepts only JSON, so a web page cannot post to it cross-site. This is transport safety, not authentication: any program on your machine can use the tools, and some of them spend the same provider quotas as the app.
- **What the panel's requests can reach.** In clients that display MCP Apps, the panel loads the app through the `panel_request` tool, which requests paths on the app's server. It is marked for the panel only and requires a key that each MCP server puts in its panel page, which keeps it from clients that list tools to the model without loading the panel. That key is not access control: any MCP client can read the panel page, key included, and then reach the app's files and data routes through `panel_request`, much as its other tools reach the data. Provider Settings, credential and model endpoints, `/mcp` and the development server's internal routes are refused to every caller.
- **The panel carries the two browser keys.** The panel build (`npm run build:panel`) includes the same Google Maps key and Cesium ion token as the app, and they run inside the client's panel page, on the client's site. A key restricted by HTTP referrer must also allow that page, or the panel cannot load tiles. To keep the app's own keys narrower, build the panel with separately restricted keys in the environment of `npm run build:panel`.
- **Embed mode is not framable by default.** `?embed=1` documents keep `X-Frame-Options: DENY` and `frame-ancestors 'none'` unless `GEV_EMBED_FRAME_ANCESTORS` names the pages that may frame them; a framing page can change what the app shows. Other documents can never be framed.

## Scope & expectations

- The Vite server is a **development/preview** server. If you expose it beyond localhost, put it behind your own auth/proxy and review the bindings (see the threat model above).
- All data shown is from **public** sources. See [DATA_SOURCES.md](DATA_SOURCES.md). Respect each provider's terms and rate limits.
- The voice agent receives feed-sourced text (place names, callsigns) as scene context. It is instructed to act only via a fixed set of app-control tools and not to execute arbitrary instructions found in data, but treat model output as untrusted and keep the tool surface limited.

## Responsible use

This is an interface for signals that are **already public**. Use it accordingly: respect privacy, follow data providers' terms, and don't represent public-data inference as authoritative intelligence.
