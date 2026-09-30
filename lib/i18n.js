// Japanese -> English for drawing text. Pure: dictionary in, strings out (Node and browser).
// Keys match after NFKC normalisation with all whitespace removed, so half-width katakana,
// full-width digits and the drawings' padding spaces all hit the same entry.

const JP = /[぀-ヿ㐀-鿿ｦ-ﾟ]/;
export const hasJapanese = (s) => JP.test(String(s ?? '').normalize('NFKC'));
export const i18nKey = (s) => String(s ?? '').normalize('NFKC').replace(/\s+/g, '');

// punctuation that has an obvious English form
const CHARS = [[/※/g, '*'], [/・/g, ' / '], [/、/g, ', '], [/。/g, '.'], [/　/g, ' '], [/[「」]/g, '"']];
const tidy = (s) => CHARS.reduce((a, [re, r]) => a.replace(re, r), s.normalize('NFKC')).replace(/ {2,}/g, ' ');

/** raw dictionaries (later ones win) -> Map(key -> English) */
export function buildDict(...dicts) {
  const m = new Map();
  for (const d of dicts) for (const [k, v] of Object.entries(d || {})) m.set(i18nKey(k), String(v));
  return m;
}

/** English for `s`: dictionary hit, else punctuation/width tidy-up if that removes all Japanese,
 *  else null (untranslated - the caller shows the original and counts it). Master names with a
 *  Visio instance suffix ("B接点.8") translate by their stem. */
export function translate(s, dict) {
  if (!hasJapanese(s)) {
    const t = tidy(String(s ?? ''));
    return t !== String(s ?? '') ? t : null;           // e.g. "２" -> "2", "AUTO・IND" -> "AUTO / IND"
  }
  const k = i18nKey(s);
  if (dict.has(k)) return dict.get(k);
  const m = /^(.*?)(\.\d+)$/.exec(k);
  if (m && dict.has(m[1])) return dict.get(m[1]) + m[2];
  const t = tidy(String(s));
  return hasJapanese(t) ? null : t;
}
