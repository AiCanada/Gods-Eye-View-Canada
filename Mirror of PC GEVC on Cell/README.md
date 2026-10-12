# Mirror of PC GEVC on Cell

The PC's GEVC dashboard on your own phone or tablet, over Tailscale. The PC
does the work; the phone shows the same dashboard in the same PC layout.

## What is in this folder

| File | What it does |
| --- | --- |
| `tailnet-dashboard.js` | A second listener for the dev server on this PC's Tailscale address only (100.64.0.0/10), never on Wi-Fi or a public address. Only devices signed in to **your** Tailscale account get in (checked with `tailscale whois`); anyone else's device is refused everything. |
| `viewport-mode.js` | Runs first in the page. On a touch screen it lays the dashboard out at 1024 px (the PC layout) and scales it to fit. Upright, it shows a hint to turn the phone sideways. The PC view is the only view on every screen, folded or open. |
| `phone-profiles.mjs` | The screens of the phones listed on the Ultra tab, for testing. |
| `phone-audit.mjs` | Opens the dashboard as each listed phone (sideways and upright) and reports layout, text size, tap targets, refused requests and errors, with screenshots. |

## Turning it on

1. In the PC's `.env` (never committed): `GEV_TAILNET_DASHBOARD=1`, then `npm run dev`.
2. Tailscale on, on the PC and on the phone, signed in to the same account.
3. On the phone, open `http://<PC's Tailscale IP>:4173`.

If Tailscale is off when the dev server starts, the listener starts by itself
once Tailscale connects.

## What works from the phone

Everything works from your phone as it does on the PC: every panel, saving
POWER UP keys and logins, Social Media, the Ultra box (tokens, SEND HELP,
STAND DOWN), private cameras and your devices (adding, editing, positions,
pairing approval), CCTV alignment, voice, location, camera and downloads.
Only devices Tailscale says are signed in as you get in.

**Removing is done on the PC** (owner ruling). From the phone, these removals
of what is stored on the PC are refused: any delete request, clearing a POWER UP
key, a road CCTV key or a social login removal, Ultra media delete, token reset, revoke or remove,
contact, home-list, inbox, owner-number or HELP DELIVERY clearing, relay
unpair, removing a private camera, site, saved password or token, removing a
device, and forgetting a CCTV alignment. Each is refused with no message
(owner ruling: "no message"): the server answers 403 with the header
`X-GEV-Removal: pc-only` and the body `{"removal":"pc-only"}`, and the phone
shows nothing and keeps the item as it was, since the PC still has it.
Adding, editing, overwriting a value, minting a token, SEND HELP and STAND
DOWN all work.

Some actions run on the PC itself, so their result appears there: ChatGPT
sign-in opens in the PC's browser and OPEN GROK BOT opens Grok Bot on the PC.
Both the PC and the phone record your devices; the server keeps one line per
device every 10 seconds.

An unlocked phone signed in to your Tailscale account can do all of this, so
keep it locked.

## Voice, location and camera without HTTPS (Chrome on Android)

A phone browser treats a plain `http://` page as insecure and blocks voice,
location and camera on it. The link is still private: Tailscale encrypts it.

1. In Chrome on the phone, open `chrome://flags`.
2. Search for **Insecure origins treated as secure** and set it to **Enabled**.
3. Enter `http://<PC's Tailscale IP>:4173,http://<PC's Tailscale IP>:44173`
   (the dashboard, and the Ultra phone page).
4. Tap **Relaunch**.

If a Chrome update ever removes that setting: in Termux run
`socat TCP-LISTEN:4173,fork,reuseaddr TCP:<PC's Tailscale IP>:4173` and open
`http://localhost:4173` on the phone instead (a browser always trusts
localhost).

## Testing every listed phone

```
node "Mirror of PC GEVC on Cell/phone-audit.mjs" http://<PC's Tailscale IP>:4173/ phone-audit
```

Add phone ids (from `phone-profiles.mjs`) after the folder to test only those.

## Live check on the real phone

The debugging link runs over Tailscale, not a cable. USB is only for
troubleshooting.

1. On the phone: Developer options, then turn on **USB debugging** (and
   **Wireless debugging** on Android 11 or later).
2. Put adb on the network: `adb tcpip 5555`. Send it over Wireless debugging
   (`adb pair <phone's Tailscale IP>:<pairing port>` with the code the phone
   shows), or once over the cable and then unplug it.
3. `adb connect <phone's Tailscale IP>:5555`. `adb devices` lists the phone
   by that address.
4. Open the dashboard on the phone, then on the PC either open
   `chrome://inspect` or run
   `adb forward tcp:9222 localabstract:chrome_devtools_remote` to reach the
   phone's Chrome. Every request still goes phone, Tailscale, PC.
5. When finished: `adb forward --remove tcp:9222` and `adb disconnect`. To go
   back to the cable, plug it in and run `adb usb`.

Write only placeholders such as `<phone's Tailscale IP>` in notes, issues and
commits, never the real address or the machine's tailnet name.
