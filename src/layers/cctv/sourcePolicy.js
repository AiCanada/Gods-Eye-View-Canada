export const FRAME_ENDPOINT = '/api/cctv/frame';

export const SOURCE_ENDPOINT = '/api/cctv/sources';

export const HEALTH_ENDPOINT = '/api/cctv/health';

export const MEDIA_ENDPOINT = '/api/cctv/media';

/** Road511 image lookup for one camera; POST, sent only on explicit activation. */
export const LOOKUP_ENDPOINT = '/api/cctv/lookup';

/** Home and business security cameras: a separate, loopback-only service
 * (server/providers/private-cameras.js), never the public CCTV proxy. */
export const PRIVATE_SOURCE_ENDPOINT = '/api/private-cams/sources';

/** Saves the spot a private camera icon was dragged to. */
export const PRIVATE_POSITION_ENDPOINT = '/api/private-cams/position';

export const PRIVATE_FRAME_PATH = /^\/api\/private-cams\/frame\/[^/?#]+$/;

export const ACTIVE_FRAME_REFRESH_MS = 10000;
