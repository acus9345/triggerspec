import { surfaceForms, tokenize } from './tokenize.js';

/** A routable skill: what an agent sees at startup (name + description). */
export interface RoutableSkill {
  name: string;
  description: string;
  /** Optional extra routing text (e.g. Claude Code's `when_to_use`). */
  extra?: string;
  /** Free-form identifier (e.g. directory) for reporting. */
  id?: string;
}

export interface Ranked {
  skill: string;
  /** Okapi BM25 score of the prompt against the skill's routing text. */
  score: number;
  /**
   * Share (0..1) of the prompt's IDF-weighted terms that appear in the skill's routing text.
   * Unlike BM25 it is comparable across catalogs, so it is used for the trigger threshold.
   */
  coverage: number;
  matched: string[];
}

export interface RouteResult {
  prompt: string;
  terms: string[];
  ranking: Ranked[];
  /** Winning skill if it clears the threshold, else null ("no skill would trigger"). */
  selected: string | null;
  /** (top - second) / top BM25 score; 1 when only one skill matched. */
  margin: number;
}

export interface ScorerOptions {
  k1?: number;
  b?: number;
  /** Name tokens are repeated this many times (names are strong routing signals). */
  nameWeight?: number;
}

export class Bm25Index {
  readonly k1: number;
  readonly b: number;
  private readonly docs: { name: string; tf: Map<string, number>; len: number }[] = [];
  private readonly df = new Map<string, number>();
  private avgLen = 0;

  constructor(skills: RoutableSkill[], opts: ScorerOptions = {}) {
    this.k1 = opts.k1 ?? 1.2;
    this.b = opts.b ?? 0.75;
    const nameWeight = opts.nameWeight ?? 2;
    for (const s of skills) {
      const nameTokens = tokenize(s.name.replace(/[-_]/g, ' '));
      const tokens = [...tokenize(s.description), ...tokenize(s.extra ?? '')];
      for (let i = 0; i < nameWeight; i++) tokens.push(...nameTokens);
      const tf = new Map<string, number>();
      for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
      for (const t of tf.keys()) this.df.set(t, (this.df.get(t) ?? 0) + 1);
      this.docs.push({ name: s.name, tf, len: tokens.length });
    }
    this.avgLen = this.docs.length ? this.docs.reduce((a, d) => a + d.len, 0) / this.docs.length : 0;
  }

  get size(): number {
    return this.docs.length;
  }

  idf(term: string): number {
    const n = this.df.get(term) ?? 0;
    const N = this.docs.length;
    return Math.log(1 + (N - n + 0.5) / (n + 0.5));
  }

  rank(prompt: string): { terms: string[]; ranking: Ranked[] } {
    const terms = [...new Set(tokenize(prompt))];
    const surf = surfaceForms(prompt);
    const totalIdf = terms.reduce((a, t) => a + this.idf(t), 0);
    const ranking: Ranked[] = this.docs.map((d) => {
      let score = 0;
      let matchedIdf = 0;
      const matched: string[] = [];
      for (const t of terms) {
        const tf = d.tf.get(t);
        if (!tf) continue;
        const idf = this.idf(t);
        matched.push(surf.get(t) ?? t);
        matchedIdf += idf;
        const norm = tf + this.k1 * (1 - this.b + (this.b * d.len) / (this.avgLen || 1));
        score += (idf * (tf * (this.k1 + 1))) / norm;
      }
      return { skill: d.name, score, coverage: totalIdf > 0 ? matchedIdf / totalIdf : 0, matched };
    });
    ranking.sort((a, b) => b.score - a.score || (a.skill < b.skill ? -1 : a.skill > b.skill ? 1 : 0));
    return { terms: terms.map((t) => surf.get(t) ?? t), ranking };
  }

  route(prompt: string, threshold: number): RouteResult {
    const { terms, ranking } = this.rank(prompt);
    const top = ranking[0];
    const second = ranking[1];
    const selected = top && top.score > 0 && top.coverage >= threshold ? top.skill : null;
    const margin = top && top.score > 0 ? (second ? (top.score - second.score) / top.score : 1) : 0;
    return { prompt, terms, ranking, selected, margin };
  }
}

export const DEFAULT_THRESHOLD = 0.2;
