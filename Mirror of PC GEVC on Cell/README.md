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

- Everything on the map and in the panels, as on the PC.
- POWER UP, Social Media (Power Ups line), the Ultra box and private cameras
  can be **read** from your phone. Every **change** (keys, logins, settings)
  must still be made on the PC.

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
