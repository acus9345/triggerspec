import * as path from 'node:path';
import { routableSkills, type Catalog } from './catalog.js';
import type { Judge } from './judge.js';
import { Bm25Index, DEFAULT_THRESHOLD, type RouteResult } from './scorer.js';
import { findTestFile, parseTestFile, TestFileError, type TriggerCase } from './testfile.js';
import type { ParsedSkill } from './types.js';

export interface CaseResult {
  skill: string;
  skillDir: string;
  file: string;
  prompt: string;
  shouldTrigger: boolean;
  top: number;
  expect?: string;
  pass: boolean;
  /** Coverage threshold this case was scored with (--threshold, else the file's, else default). */
  threshold: number;
  /** Skill the offline scorer selected (null = none cleared the threshold). */
  selected: string | null;
  /** 1-based rank of the skill under test (0 if it scored nothing). */
  rank: number;
  coverage: number;
  margin: number;
  runnerUp?: string;
  reason: string;
  ranking: { skill: string; score: number; coverage: number }[];
  judge?: { name: string; selected: string | null; pass: boolean; error?: string };
}

export interface SkillTestResult {
  skill: string;
  skillDir: string;
  file: string | null;
  error?: string;
  cases: CaseResult[];
}

export interface TestRun {
  /** Threshold from --threshold, or the default. */
  threshold: number;
  /** Skills whose trigger file set a different threshold (only when --threshold was not given). */
  fileThresholds: Record<string, number>;
  catalogSize: number;
  skills: SkillTestResult[];
  passed: number;
  failed: number;
  judge?: { name: string; passed: number; failed: number; errors: number; skippedReason?: string };
}

export interface TestOptions {
  threshold?: number;
  judge?: Judge | null;
  judgeSkippedReason?: string;
  /** Only run tests for these skill names. */
  only?: string[];
}

function evaluate(c: TriggerCase, skill: string, r: RouteResult, known: Set<string>): { pass: boolean; rank: number; reason: string } {
  const idx = r.ranking.findIndex((x) => x.skill === skill && x.score > 0);
  const rank = idx + 1;
  const me = idx >= 0 ? r.ranking[idx]! : undefined;
  const top = r.ranking[0];
  if (c.shouldTrigger) {
    if (rank === 0) return { pass: false, rank, reason: 'no overlap between the prompt and this skill\'s name/description' };
    if (rank > c.top) return { pass: false, rank, reason: `ranked #${rank}; "${top?.skill}" ranks first` };
    if (rank === 1 && r.selected !== skill) return { pass: false, rank, reason: `ranked first but coverage ${fmt(me!.coverage)} is below the threshold` };
    return { pass: true, rank, reason: rank === 1 ? 'selected' : `ranked #${rank} (within top ${c.top})` };
  }
  if (c.expect) {
    const want = c.expect === 'none' ? null : c.expect;
    if (want !== null && !known.has(want)) {
      const close = [...known].filter((n) => n.includes(want) || want.includes(n)).slice(0, 3);
      return { pass: false, rank, reason: `expect: "${want}" is not a skill in the catalog${close.length ? ` (did you mean ${close.join(', ')}?)` : ''}` };
    }
    if (r.selected === skill) return { pass: false, rank, reason: `selected this skill; expected ${want ?? 'no skill'}` };
    if (r.selected !== want) return { pass: false, rank, reason: `expected ${want ?? 'no skill'} to win, got ${r.selected ?? 'no skill'}` };
    return { pass: true, rank, reason: `${want ?? 'no skill'} selected as expected` };
  }
  if (r.selected === skill) return { pass: false, rank, reason: `would trigger (rank #1, coverage ${fmt(me!.coverage)})` };
  return { pass: true, rank, reason: r.selected ? `"${r.selected}" selected instead` : 'no skill selected' };
}

function fmt(n: number): string {
  return n.toFixed(2);
}

export function skillLabel(s: ParsedSkill): string {
  return s.name || path.basename(s.dir);
}

export async function runTriggerTests(catalog: Catalog, opts: TestOptions = {}): Promise<TestRun> {
  const pool = routableSkills([...catalog.skills, ...catalog.extra]);
  const index = new Bm25Index(pool);
  const known = new Set(pool.map((s) => s.name));
  const fileThresholds: Record<string, number> = {};
  const results: SkillTestResult[] = [];
  let passed = 0;
  let failed = 0;
  const judgeStats = opts.judge ? { name: opts.judge.name, passed: 0, failed: 0, errors: 0 } : undefined;

  for (const skill of catalog.skills) {
    const label = skillLabel(skill);
    if (opts.only && !opts.only.includes(label)) continue;
    const file = findTestFile(skill.dir);
    if (!file) continue;
    let spec;
    try {
      spec = parseTestFile(file);
    } catch (e) {
      results.push({ skill: label, skillDir: skill.dir, file, error: e instanceof TestFileError ? e.message : String(e), cases: [] });
      failed++;
      continue;
    }
    const threshold = opts.threshold ?? spec.threshold ?? DEFAULT_THRESHOLD;
    if (opts.threshold === undefined && spec.threshold !== undefined && spec.threshold !== DEFAULT_THRESHOLD) fileThresholds[label] = spec.threshold;
    const cases: CaseResult[] = [];
    for (const c of spec.cases) {
      const r = index.route(c.prompt, threshold);
      const ev = evaluate(c, label, r, known);
      const runnerUp = r.ranking.find((x) => x.skill !== label && x.score > 0)?.skill;
      const cr: CaseResult = {
        skill: label,
        skillDir: skill.dir,
        file,
        prompt: c.prompt,
        shouldTrigger: c.shouldTrigger,
        top: c.top,
        expect: c.expect,
        pass: ev.pass,
        threshold,
        selected: r.selected,
        rank: ev.rank,
        coverage: r.ranking.find((x) => x.skill === label)?.coverage ?? 0,
        margin: r.margin,
        runnerUp,
        reason: ev.reason,
        ranking: r.ranking.slice(0, 5).map((x) => ({ skill: x.skill, score: round(x.score), coverage: round(x.coverage) })),
      };
      if (opts.judge) {
        try {
          const sel = await opts.judge.select(c.prompt, pool);
          const jp = c.shouldTrigger ? sel === label : c.expect ? sel === (c.expect === 'none' ? null : c.expect) : sel !== label;
          cr.judge = { name: opts.judge.name, selected: sel, pass: jp };
          if (jp) judgeStats!.passed++;
          else judgeStats!.failed++;
        } catch (e) {
          cr.judge = { name: opts.judge.name, selected: null, pass: false, error: (e as Error).message };
          judgeStats!.errors++;
        }
      }
      if (cr.pass) passed++;
      else failed++;
      cases.push(cr);
    }
    results.push({ skill: label, skillDir: skill.dir, file, cases });
  }
  return {
    threshold: opts.threshold ?? DEFAULT_THRESHOLD,
    fileThresholds,
    catalogSize: pool.length,
    skills: results,
    passed,
    failed,
    judge: judgeStats ?? (opts.judgeSkippedReason ? { name: 'llm', passed: 0, failed: 0, errors: 0, skippedReason: opts.judgeSkippedReason } : undefined),
  };
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}
