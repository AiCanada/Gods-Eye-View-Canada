// GEV Private_CCTV_Feed Relay: the site the relay reads and the hosts it may
// fetch clip pictures from. This tracked copy carries reserved example hosts,
// so it relays nothing as-is. The installer
// (npm run private-cctv-feed-relay:install) writes your real ones here and into
// manifest.json from config/private_cctv_feed.local.json, which is never
// committed. Classic script: it only defines globalThis.GevPrivateCctvFeedConfig.
globalThis.GevPrivateCctvFeedConfig = Object.freeze({
  feedOrigin: 'https://feed.private-cctv.example',
  imageHosts: Object.freeze([
    'clips-z1.private-cctv.example',
    'clips-z2.private-cctv.example',
    'clips-z3.private-cctv.example',
    'clips-z4.private-cctv.example',
  ]),
});
