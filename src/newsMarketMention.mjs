/**
 * Which price a headline names. A match is a word or phrase in the title.
 * It is not a claim that the story moved the price. "Europe" does not
 * count as the euro. The words are the catalog's (src/marketAssets.mjs).
 */
import { MARKET_ASSETS } from './marketAssets.mjs';

/** One headline channel per asset, in the catalog's order. */
export const NEWS_MARKET_CHANNELS = Object.freeze(
  MARKET_ASSETS.map((asset) => asset.id),
);

const ALIASES = Object.freeze(
  Object.fromEntries(MARKET_ASSETS.map((asset) => [asset.id, asset.mentions])),
);

const MATCHERS = Object.freeze(
  NEWS_MARKET_CHANNELS.map((id) => [
    id,
    new RegExp(
      ALIASES[id]
        .map((phrase) => phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .map((phrase) => `\\b${phrase}\\b`)
        .join('|'),
      'i',
    ),
  ]),
);

function plain(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[/_-]+/g, ' ');
}

/** Series ids named by a headline, in channel order. */
export function seriesMentioned(text) {
  const blob = plain(text);
  return MATCHERS.filter(([, pattern]) => pattern.test(blob)).map(([id]) => id);
}
