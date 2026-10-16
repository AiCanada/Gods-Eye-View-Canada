/**
 * The operator's own news URLs (at most 100). An RSS item is title and
 * link. An HTML page is its title and final URL. The body is not stored.
 */
import { itemsFromFeed, titleFromHtml } from '../../newsUrls.mjs';
import { fetchPublic } from '../../publicFetch.mjs';
import { mapLimit } from './_util.mjs';

const PERIOD_MS = 30 * 60 * 1000;
const MAX_BYTES = 256 * 1024;
const AT_ONCE = 8;

async function readCapped(response) {
  const reader = response.body?.getReader?.();
  if (!reader) {
    const text = await response.text();
    return text.slice(0, MAX_BYTES);
  }
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    chunks.push(value);
    if (size > MAX_BYTES) {
      await reader.cancel();
      break;
    }
  }
  const bytes = new Uint8Array(Math.min(size, MAX_BYTES));
  let offset = 0;
  for (const chunk of chunks) {
    const take = Math.min(chunk.byteLength, bytes.length - offset);
    bytes.set(chunk.subarray(0, take), offset);
    offset += take;
    if (offset >= bytes.length) break;
  }
  return new TextDecoder().decode(bytes);
}

export default {
  id: 'news-urls',
  label: 'News URLs',
  layers: [],
  kind: 'feed',
  class: 'unclear',
  licence: "Each item is its publisher's. Only the title and link are stored.",
  cadenceMs: PERIOD_MS,
  phase: 2,
  bytesPerDay: 0.2e6,
  async poll({ fetch, newsUrls, state, signal, lookup }) {
    const urls = Array.isArray(newsUrls) ? newsUrls : [];
    state.seen ??= new Set();
    const records = [];
    let answered = 0;
    let fresh = 0;
    await mapLimit(urls, AT_ONCE, async (pageUrl) => {
      // A public address only, each redirect checked again (publicFetch.mjs):
      // a page must not send this request into the owner's own network.
      const got = await fetchPublic(pageUrl, {
        fetchImpl: fetch,
        lookup,
        signal,
        headers: {
          Accept: 'application/rss+xml, application/atom+xml, text/html',
        },
      });
      if (got.error) return;
      const { response } = got;
      if (!response.ok) return;
      answered += 1;
      const body = await readCapped(response);
      const type = String(response.headers?.get?.('content-type') || '');
      const items =
        /xml|rss|atom/i.test(type) || /<(rss|feed)\b/i.test(body)
          ? itemsFromFeed(body, pageUrl)
          : [{ title: titleFromHtml(body), url: pageUrl }].filter(
              (item) => item.title,
            );
      for (const item of items) {
        if (state.seen.has(item.url)) continue;
        state.seen.add(item.url);
        fresh += 1;
        records.push({
          source: pageUrl,
          title: item.title,
          url: item.url,
        });
      }
    });
    return { records, stats: { answered, fresh, urls: urls.length } };
  },
};
