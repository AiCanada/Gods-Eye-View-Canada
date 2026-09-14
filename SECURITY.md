# Security

God's Eye View is a local-first client for **public** data. It is built for exploration, demos, and learning — not as a hardened production service. This document explains the security model so you can run it safely and report issues responsibly.

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
| `AISSTREAM_API_KEY` | Server only | Server holds the AISStream websocket; browser polls the same-origin `/api/ais-live` cache |
| OpenSky OAuth (`OPENSKY_CLIENT_ID/SECRET`) | Server only | Server mints + refreshes the token behind `/api/opensky` |
| `GOOGLE_MAPS_SERVER_API_KEY` (optional, #33) | Server only | Server calls Places (`/api/google/nearby-places`, `/api/google/text-search`) and the Street View fallback with this key; falls back to `GOOGLE_MAPS_API_KEY` when unset |

### Two deliberately client-side keys — restrict them

These are designed to be used directly in the browser (like a Mapbox public token). They are injected into the client bundle via Vite's `define`, so they **will** be visible in browser devtools. Scope and restrict them rather than trying to hide them:

1. **Google Maps API key** — loads Photorealistic 3D Tiles directly and powers GEV place search. **Restrict it** (HTTP referrer + API restriction to the required Google APIs) in the Google Cloud Console. An unrestricted key in a public deployment can be abused and billed to you.
2. **Cesium ion token** (`CESIUM_ION_TOKEN`, optional — for ion-hosted Google Photorealistic 3D Tiles, Bing world imagery, and world terrain) — used as `Cesium.Ion.defaultAccessToken` client-side. Use a public **`assets:read`** token with **URL restrictions** for any hosted deployment. The Community plan has eligibility and usage limits; a public token is not a secret, but it can still consume the account's quota.

> The explicit browser `define` block in `build/vite.js` controls exactly what reaches the client: only these two keys. Everything else stays server-side.

**Places and Street View never needed to be on that list** (#33): they're called from the server-side proxies in the table above, which use `GOOGLE_MAPS_SERVER_API_KEY` when it's set. Splitting it from the browser-exposed key lets each key's Google Cloud restriction actually match what it does — the browser key referrer-restricted to the APIs the client loads, the server key IP-restricted (never a referrer, since it never leaves your server) to Places + Street View Static — instead of one key that has to be either over-permissioned or broken for one of its two jobs. A single shared `GOOGLE_MAPS_API_KEY` still works if you don't split them; it just has to cover every API both sides use.

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
- **Radio is not an audio relay.** `/api/radio/stations` contacts only allowlisted Radio Browser HTTPS hosts and paths, rejects redirects, rejects any hostname with a loopback/private/link-local/metadata/non-public A or AAAA result, and pins each TLS connection to a validated address. It returns normalized public HTTPS stream URLs; `/api/radio/click/:uuid` applies the same destination policy and accepts only station IDs from the current bounded catalog. The browser then connects directly to the broadcaster after an explicit playback action, so the broadcaster sees the listener's IP address. GEV never proxies, caches, records, or redistributes audio.
- **Response-size caps and timeouts** on proxied responses.
- **Sanitized errors** — internal error details are not echoed back to clients.
- **Coalesced OAuth refresh** and cached successful responses only (OpenSky).
- **Redacted debug logging.** The voice debug log (`.gev-logs/`, gitignored) strips API keys, bearer tokens, client secrets, and image data URLs before writing.

## Private home and business security cameras

POWER UP → **HOME SECURITY · ARLO** and **BUSINESS SECURITY** add your own
cameras. They are deliberately separate from the public CCTV proxy and catalogue
(`server/providers/private-cameras.js`, `src/privateCamerasCore.mjs`):

- **At rest.** Logins, tokens and camera addresses live only in
  `config/private-cameras.json` — git-ignored and written through the same
  owner-only credential-store writer as `.env`. They are never logged, never
  sent to the browser (the panel sees only "saved" flags and masked addresses),
  and never enter share links, the region cap or `/api/cctv/sources`.
- **Browser ↔ server.** Every `/api/private-cams/*` route answers only the
  machine running the server: the Provider Settings gate refuses LAN peers,
  tunnels, proxied requests, foreign `Host` headers (DNS rebinding) and any
  sharing mode. Requests another website triggers are refused by Fetch Metadata
  (`Sec-Fetch-Site`), and every response is `Cross-Origin-Resource-Policy:
  same-origin`, `no-store` and `nosniff`, so a page elsewhere can neither embed
  a camera frame nor read the camera list. Saving requires the exact local
  `Origin` and a JSON body; editing exists only under the dev server.
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
- **Arlo.** The app never signs in to Arlo. Arlo cameras come through a bridge you
  run (Home Assistant with hass-aarlo, or Scrypted), which holds the Arlo login
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

### Arlo browser feed relay

A personal Arlo account offers no API key, camera address or RTSP stream, and
GEV will not script Arlo's sign-in, which would mean defeating its bot
protection. A home site set to **Browser feed relay** instead receives pictures
from **GEV Arlo Feed Relay**, a personal unpacked Chrome extension in
`tools/arlo-feed-relay` (`npm run arlo-relay:install`):

- **What leaves the extension.** While your own signed-in
  `https://my.arlo.com/#/feed` tab is open, the extension reads the newest clip
  thumbnail per camera from that page, fetches the image without credentials
  from Arlo's image host and sends GEV only the image bytes, the camera name and
  a short clip label (such as "Motion · 2:14 PM"). It never reads or forwards
  cookies, `localStorage` / `sessionStorage`, `Authorization` headers or any Arlo
  login; it never clicks, scrolls, reloads or keeps the Arlo session alive; it
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
  sharing mode). They also require `Sec-Fetch-Site: none`, which a browser never
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
  picture and which match no camera, so it downloads a thumbnail from Arlo only
  when GEV will take it.
- **No stale picture passes for a current one.** A relay picture is shown only
  while the relay keeps reporting and its feed tab shows Arlo signed in. When
  that tab reports that Arlo signed the page out, the pictures give way within
  seconds. Each heartbeat carries an opaque tag for its tab (a hash, not the tab
  or any Arlo value), so a sign-in page left open in another tab does not
  override a tab that reported reading the feed in the last 2.5 minutes. Without
  a current picture the camera shows a placeholder saying why, with the time the
  last picture arrived. A camera whose Arlo name changes on save (a new Name or
  Arlo name, or two Arlo names swapped) drops its picture, so it never shows
  another camera's.
- **Arlo's terms.** Arlo's Terms of Service prohibit data-gathering or
  extraction tools and unapproved applications, and allow Arlo to terminate
  accounts that use them. The relay is a personal tool you install and run at
  your own risk; Arlo neither makes nor approves it. Its pictures are the latest
  motion-clip thumbnails, not live video, and they stop when Arlo signs the web
  page out after inactivity.

## Network exposure — the operator threat model

The dev server is a **key broker**: every server-side key above is spendable by anyone who can send HTTP requests to it. That shapes the defaults:

- **Local-only by default.** `./scripts/dev-fresh.sh` (and the Vite config itself) bind to `localhost`, so only your machine can reach the server — and only local names are accepted (`allowedHosts` stays restricted, which also blunts DNS-rebinding tricks).
- **LAN exposure is an explicit opt-in**: `HOST=0.0.0.0 ./scripts/dev-fresh.sh`. The launcher prints a prominent warning plus your LAN URL. Understand what opting in means: **every device on that network can drive the proxies and spend your OpenAI / Google / OpenSky / AISStream / TomTom / FIRMS quota** for as long as the server runs. Do this only on networks you trust.
- **App-level throttles (opt-in):** `GEV_RATELIMIT_OPENAI_PER_MIN` and `GEV_RATELIMIT_GOOGLE_PER_MIN` cap the cost-bearing endpoints per client IP per minute (over-limit requests receive a sanitized `429`). They are **per-IP, process-local, in-memory guards** — they reset on restart and are **not billing caps**.
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

## Scope & expectations

- The Vite server is a **development/preview** server. If you expose it beyond localhost, put it behind your own auth/proxy and review the bindings (see the threat model above).
- All data shown is from **public** sources. See [DATA_SOURCES.md](DATA_SOURCES.md). Respect each provider's terms and rate limits.
- The voice agent receives feed-sourced text (place names, callsigns) as scene context. It is instructed to act only via a fixed set of app-control tools and not to execute arbitrary instructions found in data, but treat model output as untrusted and keep the tool surface limited.

## Responsible use

This is an interface for signals that are **already public**. Use it accordingly: respect privacy, follow data providers' terms, and don't represent public-data inference as authoritative intelligence.
