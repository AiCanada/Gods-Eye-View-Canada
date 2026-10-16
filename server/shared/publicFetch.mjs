/**
 * Fetching an address someone typed (a news URL for the AI World tab, a custom
 * URL for LLM training) without letting it reach this machine's own network:
 * https only, no userinfo, the host checked as written and again after DNS
 * (every address it resolves to must be public), and redirects followed by
 * hand, each new address checked the same way. Fetch's own redirect-following
 * would let a public page send the request to a private address.
 */
import dns from 'node:dns/promises';
import { cleanNewsUrl, isPrivateHost } from './newsUrls.mjs';

export const PUBLIC_FETCH_REDIRECTS = 3;
const TIMEOUT_MS = 15_000;

/** Whether a host is public as written and after DNS. */
export async function publicHost(hostname, lookup = dns.lookup) {
  if (isPrivateHost(hostname)) return false;
  try {
    const addresses = await lookup(hostname, { all: true });
    return (
      addresses.length > 0 && addresses.every((a) => !isPrivateHost(a.address))
    );
  } catch {
    return false;
  }
}

/**
 * The final response for a public https address, or `{ error }`: 'REFUSED
 * ADDRESS' (not https, userinfo, a private literal), 'PRIVATE ADDRESS' (it
 * resolves inside), 'UNREACHABLE', 'TOO MANY REDIRECTS'.
 * @returns {Promise<{url: string, response: Response}|{error: string}>}
 */
export async function fetchPublic(
  raw,
  {
    fetchImpl = globalThis.fetch,
    lookup = dns.lookup,
    signal,
    headers = {},
    timeoutMs = TIMEOUT_MS,
  } = {},
) {
  let url = cleanNewsUrl(raw);
  for (let hop = 0; url && hop <= PUBLIC_FETCH_REDIRECTS; hop += 1) {
    if (!(await publicHost(new URL(url).hostname, lookup)))
      return { error: 'PRIVATE ADDRESS' };
    let response;
    try {
      const timeout = AbortSignal.timeout(timeoutMs);
      response = await fetchImpl(url, {
        redirect: 'manual',
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        headers,
      });
    } catch {
      return { error: 'UNREACHABLE' };
    }
    if (response.status >= 300 && response.status < 400) {
      const next = response.headers?.get?.('location');
      try {
        await response.body?.cancel?.();
      } catch {
        /* already closed */
      }
      url = next ? cleanNewsUrl(new URL(next, url).href) : null;
      continue;
    }
    return { url, response };
  }
  return { error: url === null ? 'REFUSED ADDRESS' : 'TOO MANY REDIRECTS' };
}
