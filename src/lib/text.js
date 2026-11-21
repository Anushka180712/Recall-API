/*
 * Text normalisation and tokenisation.
 *
 * Everything here is deliberately dependency-free and deterministic so that the
 * same prompt always produces the same tokens in the content script, the popup
 * and the unit tests.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RecallDefine('text', [], factory);
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // Words that carry almost no topical meaning in a chat prompt. Removing them
  // lets "can you please explain how closures work in JS" and
  // "explain JS closures" collapse to the same core tokens.
  const STOPWORDS = new Set(
    (
      'a an the and or but if then else of to in on at by for with from into onto about over ' +
      'under between through during before after above below up down out off again further ' +
      'is are was were be been being am do does did doing done have has had having ' +
      'i me my mine myself we us our ours you your yours yourself he him his she her hers ' +
      'it its itself they them their theirs this that these those there here ' +
      'what which who whom whose when where why how ' +
      'can could would should will shall may might must ' +
      'please pls plz kindly thanks thank hey hi hello ' +
      'tell explain give show help want need know like just also very really some any ' +
      'something anything me let lets let\'s get got make sure ok okay so such ' +
      'not no yes as than too only own same other each few more most both all ' +
      'way ways best using via quick quickly simple simply step steps'
    ).split(/\s+/)
  );

  // Collapse common synonyms/abbreviations so paraphrases share tokens.
  // Keys are *stemmed* forms.
  const CANONICAL = new Map(
    Object.entries({
      summarize: 'summary', summarise: 'summary', summariz: 'summary', summar: 'summary', tldr: 'summary', recap: 'summary',
      differ: 'compare', difference: 'compare', different: 'compare', vs: 'compare', versu: 'compare',
      comparison: 'compare', compar: 'compare', contrast: 'compare',
      solve: 'fix', resolve: 'fix', debug: 'fix', repair: 'fix',
      draft: 'write', compose: 'write', writ: 'write',
      js: 'javascript', ts: 'typescript', py: 'python', k8: 'kubernetes', k8s: 'kubernetes',
      db: 'database', repo: 'repository', func: 'function', fn: 'function',
      centre: 'center', colour: 'color', optimise: 'optimize',
    })
  );

  const URL_RE = /\bhttps?:\/\/\S+/gi;
  const DIACRITICS_RE = /[̀-ͯ]/g;

  /** Lower-case, strip accents and URLs, and collapse everything that isn't a letter/number. */
  function normalize(input) {
    if (typeof input !== 'string') return '';
    return input
      .normalize('NFKD')
      .replace(DIACRITICS_RE, '')
      .toLowerCase()
      .replace(URL_RE, ' url ')
      .replace(/['’]/g, '')
      .replace(/[^\p{L}\p{N}+#]+/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /**
   * A light, predictable suffix stripper (not a full Porter stemmer). Good
   * enough to merge "sorting/sorted/sorts" and "libraries/library".
   */
  function stem(word) {
    if (word.length <= 3 || /\d/.test(word)) return word;
    if (word.endsWith('ies') && word.length > 4) return word.slice(0, -3) + 'y';
    if (word.endsWith('sses')) return word.slice(0, -2);
    if (word.endsWith('ing') && word.length > 5) return undouble(word.slice(0, -3));
    if (word.endsWith('ed') && word.length > 4) return undouble(word.slice(0, -2));
    if (word.endsWith('ly') && word.length > 5) return word.slice(0, -2);
    if (word.endsWith('es') && /(ch|sh|x|z)es$/.test(word)) return word.slice(0, -2);
    if (word.endsWith('s') && !/(ss|us|is)$/.test(word)) return word.slice(0, -1);
    return word;
  }

  function undouble(word) {
    // "running" -> "runn" -> "run"; keep "ll"/"ss" endings ("spelling" -> "spell").
    if (word.length > 3 && word[word.length - 1] === word[word.length - 2] && !/[lsz]/.test(word[word.length - 1])) {
      return word.slice(0, -1);
    }
    return word;
  }

  /** Meaningful, stemmed tokens of a prompt. */
  function tokenize(input) {
    const norm = normalize(input);
    if (!norm) return [];
    const out = [];
    for (const raw of norm.split(' ')) {
      if (!raw || STOPWORDS.has(raw)) continue;
      if (raw.length < 2 && !/\d/.test(raw)) continue;
      const stemmed = stem(raw);
      out.push(CANONICAL.get(stemmed) || CANONICAL.get(raw) || stemmed);
    }
    return out;
  }

  /** Character trigrams of the normalised text; robust against typos and word order. */
  function charTrigrams(input) {
    const norm = normalize(input);
    const grams = new Set();
    if (!norm) return grams;
    const padded = ` ${norm} `;
    for (let i = 0; i < padded.length - 2; i++) grams.add(padded.slice(i, i + 3));
    return grams;
  }

  /** Stable 32-bit FNV-1a hash, hex encoded. Used for ids, never for security. */
  function hash(input) {
    let h = 0x811c9dc5;
    const str = String(input);
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16).padStart(8, '0');
  }

  function truncate(input, max) {
    const s = String(input || '').replace(/\s+/g, ' ').trim();
    return s.length > max ? s.slice(0, max - 1).trimEnd() + '…' : s;
  }

  return { STOPWORDS, CANONICAL, normalize, stem, tokenize, charTrigrams, hash, truncate };
});
