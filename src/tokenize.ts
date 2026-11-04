/**
 * Deterministic tokenizer used by the offline trigger scorer and collision report.
 * Lowercases (NFKC), splits on non-letter/digit, drops stopwords and skill-description
 * boilerplate, applies a light English stemmer, and emits character bigrams for CJK text.
 */

const STOPWORDS = new Set(
  (
    'a about above after again against all also am an and any are as at be because been before being below between both but by can could did do does doing done down during each either else etc even ever every few for from further get gets getting go going got had has have having he her here hers him his how however i if in into is it its itself just let like make makes me more most much must my need needs no nor not now of off often on once one only or other our ours out over own per please rather really same see she should so some such than that the their theirs them then there these they this those through thus to too under until up upon us very via was we were what whatever when whenever where whether which while who whom whose why will with within without would yet you your yours ' +
    // Boilerplate that appears in nearly every skill description and carries no routing signal.
    'use uses used using skill skills user users claude agent ask asks asked asking want wants wanted request requests requested mention mentions mentioned trigger triggers triggered triggering invoke invoked help helps helping task tasks something anything thing things way ways e.g eg i.e ie including include includes related relevant whatever able new well'
  ).split(/\s+/),
);

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const WORD = /[\p{L}\p{N}\p{M}]+/gu;

/** Light, deterministic English stemmer (not Porter; consistent is what matters). */
export function stem(w: string): string {
  if (w.length <= 3 || /\d/.test(w)) return w;
  let s = w;
  if (s.endsWith('ies') && s.length > 4) s = s.slice(0, -3) + 'y';
  else if (s.endsWith('sses')) s = s.slice(0, -2);
  else if (s.endsWith('ss') || s.endsWith('us') || s.endsWith('is')) {
    /* keep */
  } else if (s.endsWith('s') && s.length > 3) s = s.slice(0, -1);
  if (s.endsWith('ing') && s.length > 5) s = s.slice(0, -3);
  else if (s.endsWith('ed') && s.length > 4) s = s.slice(0, -2);
  else if (s.endsWith('ly') && s.length > 5) s = s.slice(0, -2);
  if (/([b-df-hj-np-tv-z])\1$/.test(s) && !/(ll|ss|zz)$/.test(s)) s = s.slice(0, -1);
  if (s.endsWith('e') && s.length > 3) s = s.slice(0, -1);
  if (s.endsWith('y') && s.length > 3) s = s.slice(0, -1) + 'i';
  return s;
}

export function tokenize(text: string): string[] {
  return tokenizeDetailed(text).map((t) => t.term);
}

/** Map each term (stem) to the first word it came from, for readable reports. */
export function surfaceForms(text: string, into: Map<string, string> = new Map()): Map<string, string> {
  for (const t of tokenizeDetailed(text)) if (!into.has(t.term)) into.set(t.term, t.surface);
  return into;
}

export function tokenizeDetailed(text: string): { term: string; surface: string }[] {
  const out: { term: string; surface: string }[] = [];
  const norm = text.normalize('NFKC').toLowerCase();
  for (const m of norm.matchAll(WORD)) {
    const word = m[0];
    if (CJK.test(word)) {
      // Split mixed runs into CJK and non-CJK parts; CJK -> character bigrams.
      for (const part of word.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+|[^\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu) ?? []) {
        if (CJK.test(part)) {
          const chars = [...part];
          if (chars.length === 1) out.push({ term: chars[0]!, surface: chars[0]! });
          for (let i = 0; i + 1 < chars.length; i++) out.push({ term: chars[i]! + chars[i + 1]!, surface: chars[i]! + chars[i + 1]! });
        } else pushWord(part, out);
      }
      continue;
    }
    pushWord(word, out);
  }
  return out;
}

function pushWord(word: string, out: { term: string; surface: string }[]): void {
  if (word.length < 2 && !/\d/.test(word)) return;
  if (STOPWORDS.has(word)) return;
  const s = stem(word);
  if (STOPWORDS.has(s)) return;
  out.push({ term: s, surface: word });
}
