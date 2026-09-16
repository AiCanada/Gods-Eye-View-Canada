import {
  readResponseJsonCapped,
  readResponseTextCapped,
} from '../common/http.js';

const REGIONAL_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

/**
 * One bounded upstream read for the regional providers.
 *
 * The deadline covers the BODY, not just the headers. Awaiting inside the try
 * keeps the abort timer alive until the body is in hand.
 *
 * `redirect` is stated rather than inherited: feeds that legitimately redirect
 * (news RSS) follow, and a fixed API endpoint can be given 'error' so a
 * redirect cannot steer the proxy at a destination this code never named.
 */
async function fetchRegional(url, read, options = {}) {
  const {
    headers = {},
    timeoutMs = 9000,
    maxBytes = REGIONAL_MAX_RESPONSE_BYTES,
    redirect = 'follow',
  } = options;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers,
      redirect,
    });
    if (!response.ok) throw new Error(`Upstream returned ${response.status}`);
    return await read(response, maxBytes);
  } finally {
    clearTimeout(timeout);
  }
}

function fetchRegionalJson(url, options = {}) {
  return fetchRegional(url, readResponseJsonCapped, options);
}

function fetchRegionalText(url, options = {}) {
  return fetchRegional(url, readResponseTextCapped, options);
}

export { fetchRegionalJson, fetchRegionalText };
