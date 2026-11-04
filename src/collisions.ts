import { routableSkills, type Catalog } from './catalog.js';
import { Bm25Index, DEFAULT_THRESHOLD, type RoutableSkill } from './scorer.js';
import { findTestFile, parseTestFile } from './testfile.js';
import { surfaceForms, tokenize } from './tokenize.js';

export interface CollisionPair {
  a: string;
  b: string;
  /** Cosine similarity (0..1) of TF-IDF vectors of the two skills' routing text. */
  similarity: number;
  severity: 'error' | 'warning';
  /** Highest-weight terms both descriptions share. */
  shared: string[];
  /** Terms that distinguish each side (useful to sharpen the descriptions). */
  onlyA: string[];
  onlyB: string[];
  /** Trigger-test prompts written for one skill that the scorer routes to the other. */
  stolen: { prompt: string; owner: string; winner: string }[];
}

export interface CollisionReport {
  skills: number;
  warnAt: number;
  errorAt: number;
  pairs: CollisionPair[];
}

export interface CollisionOptions {
  warnAt?: number;
  errorAt?: number;
}

function vectors(skills: RoutableSkill[]): Map<string, number>[] {
  const docs = skills.map((s) => {
    const tf = new Map<string, number>();
    for (const t of [...tokenize(s.name.replace(/[-_]/g, ' ')), ...tokenize(s.description), ...tokenize(s.extra ?? '')]) tf.set(t, (tf.get(t) ?? 0) + 1);
    return tf;
  });
  const df = new Map<string, number>();
  for (const d of docs) for (const t of d.keys()) df.set(t, (df.get(t) ?? 0) + 1);
  const N = docs.length;
  return docs.map((d) => {
    const v = new Map<string, number>();
    let norm = 0;
    for (const [t, tf] of d) {
      const w = (1 + Math.log(tf)) * (Math.log((N + 1) / ((df.get(t) ?? 0) + 1)) + 1);
      v.set(t, w);
      norm += w * w;
    }
    norm = Math.sqrt(norm) || 1;
    for (const [t, w] of v) v.set(t, w / norm);
    return v;
  });
}

/** Cosine similarity of two sparse vectors (0 when either is empty). */
export function cosine(a: Map<string, number>, b: Map<string, number>): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (const w of a.values()) na += w * w;
  for (const w of b.values()) nb += w * w;
  if (na === 0 || nb === 0) return 0;
  const [small, big] = a.size < b.size ? [a, b] : [b, a];
  for (const [t, w] of small) {
    const o = big.get(t);
    if (o) dot += w * o;
  }
  return dot / Math.sqrt(na * nb);
}

export function findCollisions(catalog: Catalog, opts: CollisionOptions = {}): CollisionReport {
  const warnAt = opts.warnAt ?? 0.4;
  const errorAt = opts.errorAt ?? 0.7;
  const pool = routableSkills([...catalog.skills, ...catalog.extra]);
  const vecs = vectors(pool);
  const index = new Bm25Index(pool);
  const primary = new Set(routableSkills(catalog.skills).map((s) => s.name));

  // Cross-routing evidence from trigger tests of the skills under test.
  const stolen: CollisionPair['stolen'] = [];
  for (const s of catalog.skills) {
    const file = findTestFile(s.dir);
    if (!file || !s.name) continue;
    let spec;
    try {
      spec = parseTestFile(file);
    } catch {
      continue;
    }
    for (const c of spec.cases) {
      if (!c.shouldTrigger) continue;
      const r = index.route(c.prompt, spec.threshold ?? DEFAULT_THRESHOLD);
      const winner = r.ranking[0];
      if (winner && winner.score > 0 && winner.skill !== s.name) stolen.push({ prompt: c.prompt, owner: s.name, winner: winner.skill });
    }
  }

  const pairs: CollisionPair[] = [];
  for (let i = 0; i < pool.length; i++) {
    for (let j = i + 1; j < pool.length; j++) {
      const A = pool[i]!;
      const B = pool[j]!;
      if (A.name === B.name) continue; // duplicate names are a lint error, not a collision
      if (!primary.has(A.name) && !primary.has(B.name)) continue; // both from --catalog: not ours to report
      const va = vecs[i]!;
      const vb = vecs[j]!;
      const sim = cosine(va, vb);
      const evidence = stolen.filter((s) => (s.owner === A.name && s.winner === B.name) || (s.owner === B.name && s.winner === A.name));
      if (sim < warnAt && evidence.length === 0) continue;
      const surf = new Map<string, string>();
      for (const x of [A, B]) surfaceForms(`${x.name.replace(/[-_]/g, ' ')} ${x.description} ${x.extra ?? ''}`, surf);
      const word = (t: string) => surf.get(t) ?? t;
      const shared = [...va.keys()].filter((t) => vb.has(t)).sort((x, y) => va.get(y)! * vb.get(y)! - va.get(x)! * vb.get(x)!).slice(0, 8).map(word);
      const only = (v: Map<string, number>, o: Map<string, number>) => [...v.entries()].filter(([t]) => !o.has(t)).sort((x, y) => y[1] - x[1]).slice(0, 6).map(([t]) => word(t));
      pairs.push({
        a: A.name,
        b: B.name,
        similarity: Math.round(sim * 1000) / 1000,
        severity: sim >= errorAt ? 'error' : 'warning',
        shared,
        onlyA: only(va, vb),
        onlyB: only(vb, va),
        stolen: evidence,
      });
    }
  }
  pairs.sort((x, y) => y.similarity - x.similarity || cmp(x.a, y.a) || cmp(x.b, y.b));
  return { skills: pool.length, warnAt, errorAt, pairs };
}

/** Locale-independent string order (stable output across machines). */
function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
