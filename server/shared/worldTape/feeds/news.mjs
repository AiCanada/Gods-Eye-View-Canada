/**
 * World tape feed: regional news headlines around each area, through
 * services.regional (/api/regional-brief, the cockpit's Local Info briefing:
 * Google News RSS first, GDELT when that fails or is empty; cached five
 * minutes per 0.1° cell). Every 30 minutes; each article once. The class is
 * set per record: GDELT items are open (citation and link required), Google
 * News items non-commercial.
 */
import {
  DAY,
  MINUTE,
  forget,
  noteChange,
  requireAreas,
  round,
  text,
} from './_util.mjs';

const SOURCES = {
  google: {
    source: 'Google News',
    class: 'nc',
    licence:
      "Google News RSS (personal, non-commercial use only); the article is its publisher's",
  },
  gdelt: {
    source: 'GDELT',
    class: 'open',
    licence:
      "GDELT Project (citation and link required); the article is its publisher's",
  },
};

export default {
  id: 'news',
  label: 'News headlines (regional)',
  layers: [],
  kind: 'feed',
  class: 'nc',
  licence:
    "GDELT Project (open with citation) and Google News RSS (personal, non-commercial); articles are their publishers'",
  cadenceMs: 30 * MINUTE,
  phase: 2,
  bytesPerDay: 0.3e6,
  async poll({ services, areas, state, now, signal }) {
    const list = requireAreas(areas, { max: 8 });
    state.seen ??= new Map(); // article url → first recorded
    const t = now();
    const records = [];
    let answered = 0;
    let failure = null;
    for (const area of list) {
      let brief;
      try {
        brief = await services.regional.getBrief(area.lat, area.lon, {
          signal,
        });
        answered += 1;
      } catch (error) {
        failure ??= error;
        continue;
      }
      const from = /gdelt/i.test(String(brief?.newsSource || ''))
        ? SOURCES.gdelt
        : /google/i.test(String(brief?.newsSource || ''))
          ? SOURCES.google
          : null;
      if (!from) continue;
      const place = text(brief?.place?.label, 120) || area.name;
      for (const article of brief?.articles || []) {
        const url = text(article?.url, 600);
        const title = text(article?.title, 240);
        if (!url || !title || !/^https?:\/\//.test(url)) continue;
        if (!noteChange(state.seen, url, url, t)) continue;
        records.push({
          source: from.source,
          title,
          url,
          publisher: text(article.domain, 120),
          place,
          area: area.name,
          lat: round(area.lat, 4),
          lon: round(area.lon, 4),
          published: article.publishedAt
            ? Date.parse(article.publishedAt) || null
            : null,
          class: from.class,
          licence: from.licence,
        });
      }
    }
    forget(state.seen, t, 14 * DAY, 50_000);
    if (!answered && failure) throw failure;
    return { records };
  },
};
