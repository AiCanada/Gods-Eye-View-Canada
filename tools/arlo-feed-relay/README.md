# GEV Arlo Feed Relay

A personal, unpacked Chrome extension that lets Gods Eye View (GEV) show a recent
picture from each of your Arlo cameras. Arlo offers this account no API key, no
per-camera address and no RTSP stream, and every software sign-in path would need
bot-detection bypass, which GEV does not do. The relay instead reuses the Arlo
feed page **you** already have open and signed in.

## What it does

- While your own signed-in `https://my.arlo.com/#/feed` tab is open, a content
  script reads the feed cards the page already shows: the camera name, the clip
  label (type, date and time) and the address of the newest clip thumbnail per
  camera.
- The extension's service worker downloads that thumbnail from Arlo's recording
  storage (`arlos3-prod-z1` … `arlos3-prod-z4` `.s3.amazonaws.com`) **without
  cookies or credentials**: the address is a short-lived signed link Arlo placed
  in the page.
- It sends only the picture bytes, the camera name and the short clip label to
  GEV at `http://localhost:4173`. GEV keeps the latest picture per camera in
  memory and shows it in the CCTV panel.

## What it does not do

- It never signs in to Arlo, never sees your Arlo password, and never reads or
  forwards cookies, localStorage, sessionStorage, tokens or Authorization headers.
- It never clicks, scrolls, reloads or navigates the Arlo page, never keeps the
  Arlo session alive and never runs code inside the page's own JavaScript.
- It does not bypass bot detection or disguise the browser.
- It never logs, stores or sends thumbnail addresses. Its diagnostics show host
  names and outcomes only.
- It requests no Chrome permissions (no cookies, tabs, scripting, storage,
  webRequest or debugger), only access to Arlo's four thumbnail hosts and to GEV
  on port 4173. There is no remote code.

## Install

1. In the GEV folder run:

   ```sh
   npm run arlo-relay:install
   ```

   It copies the extension to a fixed folder and prints it:
   - Windows: `%LOCALAPPDATA%\GEV\arlo-feed-relay`
   - Linux and macOS: `$XDG_DATA_HOME/gev/arlo-feed-relay`, or
     `~/.local/share/gev/arlo-feed-relay`

   A fixed folder keeps the extension ID the same after updates, so the pairing
   stays valid.
2. Open `chrome://extensions`, turn on **Developer mode**, choose **Load
   unpacked** and paste the printed folder path into the folder box. On Windows
   `AppData` is a hidden folder, so it does not show up when you browse to it.
3. **Reload your my.arlo.com feed tab** if it was already open. Chrome adds the
   extension only to pages loaded after it was installed or reloaded; an older
   tab is simply not read.
4. After updating GEV, run the install command again, press the reload button on
   the extension's card, and reload the feed tab once more.

## Pair with GEV

1. Start GEV. In **POWER UP → HOME SECURITY**, set your Arlo site's sign-in to
   **Browser feed relay (Chrome extension)** and save. Each camera's Arlo name
   defaults to its GEV name; set it when the names differ.
2. On `chrome://extensions` open the extension's **Details → Extension options**
   and press **PAIR WITH GODS EYE VIEW**. GEV gives the request a random
   6-character code, and the page shows that code and the extension ID.
3. In **POWER UP → HOME SECURITY** every waiting request shows its own code and
   extension ID. Press **APPROVE** only on the request whose code **and**
   extension ID both match the options page; if either one differs, do not
   approve it. GEV issues every code itself and never gives two waiting requests
   the same one, so another extension cannot copy yours. A request expires after
   2 minutes, each extension can have one request waiting, and approving pairs
   exactly the request you pressed.
4. The options page changes to "Paired with …". You may close it: the feed tab
   picks up the approval by itself, also when you pair again after **UNPAIR**.

Pairing creates a random 32-byte secret that stays in the extension's IndexedDB.
GEV stores only its SHA-256 hash, bound to this extension ID.

## Keep it working

- Keep `https://my.arlo.com/#/feed` open and signed in, in a normal Chrome window.
  Only a tab on the feed (or on Arlo's sign-in page) reports; other Arlo pages
  stay silent.
- Add `my.arlo.com` to **chrome://settings/performance → Always keep these sites
  active**, so Memory Saver does not discard the tab.
- The options page lists recent outcomes per camera: `sent`, `unknown camera
  name` (set that camera's Arlo name in POWER UP), `not paired`, `GEV not
  reachable`, `thumbnail refused (HTTP 403)` and so on. Chrome pauses the relay
  when it is idle and the list starts empty again; it fills with the next feed
  report, within 2 minutes.

## How often it talks to Arlo and GEV

- When the page changes, and every 2 minutes (every 15 seconds while GEV does not
  accept the relay yet), the feed tab tells GEV what the page shows, with an
  opaque tag for the tab. That goes to GEV only, never to Arlo.
- A thumbnail is downloaded from Arlo only for a camera GEV knows, when its newest
  clip changes or when GEV says it has no picture (after a GEV restart, a new
  pairing or a camera change).
- A thumbnail Arlo refuses (for example an expired link) is never requested
  again; GEV or network failures are retried with a growing delay, up to 10
  minutes, and not at all while GEV is stopped or does not recognise the pairing.

## Limits

- Pictures are the latest **motion-clip thumbnails, not live video**. A camera
  shows a picture only after it records a clip that is loaded in the feed. A
  camera without recent clips (for example a quiet back yard) shows "waiting for a
  clip".
- Arlo signs the web page out after about 30 minutes without activity. The relay
  then reports "signed out" and pauses until you sign in again; it does not keep
  the session alive. Within seconds of the feed tab reporting that Arlo signed
  it out, or once the relay has been silent for 10 minutes, GEV shows a
  placeholder with the time the last picture arrived instead of an old picture.
  An Arlo sign-in page left open in another tab does not override a tab that is
  still reading the feed.
- GEV keeps pictures in memory only; after a GEV restart it asks the relay for
  them again, so they come back within about 2 minutes.
- If Arlo changes the feed page, GEV shows "Arlo feed layout not recognised" until
  the relay is updated.
- Needs Chrome 116 or newer and GEV on exactly `http://localhost:4173`. If the
  app starts on another port (because 4173 is busy), POWER UP warns you and the
  relay cannot reach it.

## Terms of service risk

Arlo's Terms of Service (section 8) prohibit data-gathering or extraction tools
and unapproved applications, and allow Arlo to suspend or close accounts. This
relay only reads your own feed page in your own browser, but it is still such a
tool. **Use it at your own risk.**

## Uninstall

1. In GEV, **POWER UP → HOME SECURITY → UNPAIR**.
2. On the extension's options page, **FORGET PAIRING**.
3. On `chrome://extensions`, **Remove** the extension.
4. Delete the folder printed by `npm run arlo-relay:install`.
