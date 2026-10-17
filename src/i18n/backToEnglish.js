/**
 * Reading a translated line back into English, for the hover help in the
 * locales few readers know (src/ui/englishHint.js). What the page kept as it
 * drew the line comes first: it is exact, values included. The catalog covers
 * the rest: a whole line, a line with values (matched against its pattern, a
 * translated value read back too), or a line put together from several
 * translated pieces.
 */

/** Egyptian hieroglyphs (with their format controls) and Canadian syllabics. */
const HINT_SCRIPT = /[\u{13000}-\u{1345F}\u{1400}-\u{167F}\u{18B0}-\u{18FF}]/u;
const PLACEHOLDER = /\{([A-Za-z0-9_]+)\}/g;
const PLACEHOLDER_SPLIT = /\{([A-Za-z0-9_]+)\}/;
const CONTEXT_PREFIX = /^[a-z][a-z ]*\|/;
const WORD_CHARACTER = /[\p{L}\p{N}]/u;
/** How deep a translated value inside a value is read back. */
const MAX_DEPTH = 3;
/** Marks a piece already read back while a line is put together. */
const PIECE_MARK = String.fromCharCode(0xe000);

/** True when the text holds hieroglyphs or syllabics. */
export function hasHintScript(text) {
  return typeof text === 'string' && HINT_SCRIPT.test(text);
}

const squash = (text) =>
  String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim();

/** The character before `at`, whole even when it takes two code units. */
function characterBefore(text, at) {
  if (at <= 0) return '';
  const unit = text.charCodeAt(at - 1);
  const start = unit >= 0xdc00 && unit <= 0xdfff && at >= 2 ? at - 2 : at - 1;
  return String.fromCodePoint(text.codePointAt(start));
}

function characterAt(text, at) {
  return at >= text.length ? '' : String.fromCodePoint(text.codePointAt(at));
}

const wordEdge = (character) => !character || !WORD_CHARACTER.test(character);

/**
 * The values of a pattern split as [words, name, words, name, …, words] in a
 * line, each the shortest run that lets the rest match; null when it does not.
 */
function matchPattern(parts, line) {
  if (!line.startsWith(parts[0])) return null;
  let at = parts[0].length;
  const values = [];
  for (let index = 1; index < parts.length; index += 2) {
    const words = parts[index + 1];
    let end;
    if (index + 2 >= parts.length) {
      if (!line.endsWith(words)) return null;
      end = line.length - words.length;
    } else {
      // Two values side by side cannot be told apart.
      if (!words) return null;
      end = line.indexOf(words, at + 1);
    }
    if (end <= at) return null;
    values.push(line.slice(at, end));
    at = end + words.length;
  }
  return at === line.length ? values : null;
}

function fill(pattern, values) {
  return pattern.replace(PLACEHOLDER, (literal, name) =>
    Object.hasOwn(values, name) ? values[name] : literal,
  );
}

/**
 * @param {Record<string, string|Record<string, string>>|null} catalog The
 *   active locale's catalog.
 * @param {object} [page]
 * @param {(line: string) => string|undefined} [page.recorded] The English the
 *   page kept for a line it showed.
 * @param {(plural: string) => string|undefined} [page.singular] The English
 *   singular of a count message, found by its plural.
 * @returns {{englishFor: (text: string) => string|undefined}}
 */
export function createBackTranslator(
  catalog,
  { recorded = () => undefined, singular = () => undefined } = {},
) {
  let index = null;

  function build() {
    const lines = new Map();
    const patterns = [];
    for (const [key, entry] of Object.entries(catalog ?? {})) {
      const english = key.replace(CONTEXT_PREFIX, '');
      const plural = Boolean(entry) && typeof entry === 'object';
      for (const form of plural ? Object.values(entry) : [entry]) {
        if (typeof form !== 'string') continue;
        const line = squash(form);
        if (!hasHintScript(line)) continue;
        const parts = line.split(PLACEHOLDER_SPLIT);
        if (parts.length === 1) {
          if (!lines.has(line)) lines.set(line, english);
          continue;
        }
        const words = parts.filter((_, at) => at % 2 === 0).join('');
        // Values and separators alone would match almost any line.
        if (!hasHintScript(words)) continue;
        patterns.push({ parts, english, plural, weight: words.length });
      }
    }
    // The pattern with the most words of its own is the likeliest.
    patterns.sort((a, b) => b.weight - a.weight);
    const longestFirst = [...lines.keys()].sort((a, b) => b.length - a.length);
    return { lines, patterns, longestFirst };
  }

  /** A pattern's values, each read back to English, or null when one cannot be. */
  function valuesFrom(pattern, found, depth) {
    const values = {};
    for (const [at, value] of found.entries()) {
      let english = value;
      // A value in the script that does not read back means the pattern
      // swallowed words of its own: the line is something else.
      if (hasHintScript(value)) english = englishOf(value, depth + 1);
      if (!english) return null;
      values[pattern.parts[at * 2 + 1]] = english;
    }
    return values;
  }

  function fromPattern(line, depth) {
    for (const pattern of index.patterns) {
      const found = matchPattern(pattern.parts, line);
      const values = found && valuesFrom(pattern, found, depth);
      if (!values) continue;
      const one = pattern.plural && String(values.count ?? '').trim() === '1';
      const english = one
        ? (singular(pattern.english) ?? pattern.english)
        : pattern.english;
      return fill(english, values);
    }
    return undefined;
  }

  function fromPieces(line) {
    let work = line;
    const english = [];
    for (const piece of index.longestFirst) {
      let from = 0;
      for (
        let at = work.indexOf(piece);
        at >= 0;
        at = work.indexOf(piece, from)
      ) {
        const end = at + piece.length;
        if (
          wordEdge(characterBefore(work, at)) &&
          wordEdge(characterAt(work, end))
        ) {
          const mark = `${PIECE_MARK}${english.length}${PIECE_MARK}`;
          english.push(index.lines.get(piece));
          work = work.slice(0, at) + mark + work.slice(end);
          from = at + mark.length;
        } else {
          from = at + 1;
        }
      }
    }
    if (!english.length) return undefined;
    return work
      .split(PIECE_MARK)
      .map((part, at) => (at % 2 ? english[Number(part)] : part))
      .join('');
  }

  function englishOf(text, depth) {
    const line = squash(text);
    if (!hasHintScript(line)) return undefined;
    index ??= build();
    const exact = recorded(line) ?? index.lines.get(line);
    if (exact) return exact;
    if (depth >= MAX_DEPTH) return undefined;
    return (
      fromPattern(line, depth) ?? (depth === 0 ? fromPieces(line) : undefined)
    );
  }

  return {
    /** The English of a line in hieroglyphs or syllabics, or undefined. */
    englishFor: (text) => englishOf(text, 0),
  };
}
