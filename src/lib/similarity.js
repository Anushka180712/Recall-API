/*
 * Similarity scoring between two prompts.
 *
 * The final score blends two complementary signals:
 *   - TF-IDF weighted cosine over stemmed content tokens (topic overlap; rare
 *     words such as "kubernetes" count far more than common ones such as "code"),
 *   - Jaccard over character trigrams (catches typos, plurals and re-ordering).
 *
 * Both are in [0, 1]; so is the blend. An exact normalised match is always 1.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./text.js'));
  else root.RecallDefine('similarity', ['text'], factory);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (text) {
  'use strict';

  const TOKEN_WEIGHT = 0.7;
  const TRIGRAM_WEIGHT = 0.3;

  function termFrequencies(tokens) {
    const tf = new Map();
    for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1);
    return tf;
  }

  /**
   * Cosine similarity of TF-IDF vectors.
   * @param {string[]} a tokens
   * @param {string[]} b tokens
   * @param {(token: string) => number} idf inverse document frequency lookup
   */
  function tfidfCosine(a, b, idf = () => 1) {
    if (!a.length || !b.length) return 0;
    const ta = termFrequencies(a);
    const tb = termFrequencies(b);
    let dot = 0;
    let na = 0;
    let nb = 0;
    for (const [t, f] of ta) {
      const w = f * idf(t);
      na += w * w;
      if (tb.has(t)) dot += w * tb.get(t) * idf(t);
    }
    for (const [t, f] of tb) {
      const w = f * idf(t);
      nb += w * w;
    }
    if (!na || !nb) return 0;
    return Math.min(1, dot / Math.sqrt(na * nb));
  }

  function jaccard(setA, setB) {
    if (!setA.size || !setB.size) return 0;
    let inter = 0;
    const [small, large] = setA.size < setB.size ? [setA, setB] : [setB, setA];
    for (const x of small) if (large.has(x)) inter++;
    return inter / (setA.size + setB.size - inter);
  }

  /**
   * Score two prompts. Accepts pre-computed features so the index doesn't
   * re-tokenise thousands of stored prompts on every keystroke.
   *
   * @param {{norm: string, tokens: string[], grams: Set<string>}} a
   * @param {{norm: string, tokens: string[], grams: Set<string>}} b
   * @param {(token: string) => number} [idf]
   */
  function scoreFeatures(a, b, idf) {
    if (a.norm && a.norm === b.norm) return 1;
    const cos = tfidfCosine(a.tokens, b.tokens, idf);
    const jac = jaccard(a.grams, b.grams);
    return round(TOKEN_WEIGHT * cos + TRIGRAM_WEIGHT * jac);
  }

  function features(prompt) {
    return {
      norm: text.normalize(prompt),
      tokens: text.tokenize(prompt),
      grams: text.charTrigrams(prompt),
    };
  }

  /** Convenience: score two raw strings with uniform IDF. */
  function score(a, b, idf) {
    return scoreFeatures(features(a), features(b), idf);
  }

  function round(n) {
    return Math.round(n * 1000) / 1000;
  }

  return { TOKEN_WEIGHT, TRIGRAM_WEIGHT, tfidfCosine, jaccard, scoreFeatures, features, score };
});
