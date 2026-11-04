import { execFileSync } from 'node:child_process';
import { findGit } from './exe.js';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { routableSkills, type Catalog } from './catalog.js';
import { Bm25Index, DEFAULT_THRESHOLD } from './scorer.js';
import { runTriggerTests, type CaseResult } from './tester.js';
import { TEST_FILE_NAMES } from './testfile.js';

export interface RouteChange {
  prompt: string;
  /** Skill whose trigger file contains the prompt (or null for --prompts input). */
  owner: string | null;
  before: string | null;
  after: string | null;
}

export interface DiffReport {
  /** --threshold, or the default; trigger files with their own `threshold:` keep it. */
  threshold: number;
  added: string[];
  removed: string[];
  descriptionChanged: string[];
  /** Prompts whose selected skill changed between base and head. */
  changes: RouteChange[];
  /** Trigger cases that passed on base and fail on head. */
  regressions: { skill: string; prompt: string; shouldTrigger: boolean; reason: string }[];
  /** Trigger cases that failed on base and pass on head. */
  fixes: { skill: string; prompt: string; shouldTrigger: boolean }[];
  prompts: number;
}

const key = (c: CaseResult) => `${c.skill}\u0000${c.shouldTrigger}\u0000${c.prompt}`;

/** Compare routing of every known test prompt between two versions of a catalog. */
export async function diffCatalogs(base: Catalog, head: Catalog, opts: { threshold?: number; prompts?: string[] } = {}): Promise<DiffReport> {
  // Pass --threshold through unchanged (undefined = let each trigger file's own `threshold:`
  // apply, exactly as `triggerspec test` does).
  const threshold = opts.threshold ?? DEFAULT_THRESHOLD;
  const bPool = routableSkills([...base.skills, ...base.extra]);
  const hPool = routableSkills([...head.skills, ...head.extra]);
  const bDesc = new Map(bPool.map((s) => [s.name, `${s.description}\n${s.extra ?? ''}`]));
  const hDesc = new Map(hPool.map((s) => [s.name, `${s.description}\n${s.extra ?? ''}`]));
  const added = [...hDesc.keys()].filter((n) => !bDesc.has(n)).sort();
  const removed = [...bDesc.keys()].filter((n) => !hDesc.has(n)).sort();
  const descriptionChanged = [...hDesc.keys()].filter((n) => bDesc.has(n) && bDesc.get(n) !== hDesc.get(n)).sort();

  const [bRun, hRun] = await Promise.all([runTriggerTests(base, { threshold: opts.threshold }), runTriggerTests(head, { threshold: opts.threshold })]);
  const bCases = new Map(bRun.skills.flatMap((s) => s.cases).map((c) => [key(c), c]));
  const hCases = new Map(hRun.skills.flatMap((s) => s.cases).map((c) => [key(c), c]));

  const regressions: DiffReport['regressions'] = [];
  const fixes: DiffReport['fixes'] = [];
  for (const [k, h] of hCases) {
    const b = bCases.get(k);
    if (!b) continue;
    if (b.pass && !h.pass) regressions.push({ skill: h.skill, prompt: h.prompt, shouldTrigger: h.shouldTrigger, reason: h.reason });
    if (!b.pass && h.pass) fixes.push({ skill: h.skill, prompt: h.prompt, shouldTrigger: h.shouldTrigger });
  }

  // Route every prompt (union of both sides + extra prompts) through both catalogs.
  const prompts = new Map<string, string | null>();
  // Each test prompt is routed with the threshold its own trigger file uses on that side.
  const bThr = new Map<string, number>();
  const hThr = new Map<string, number>();
  for (const c of bCases.values()) if (!bThr.has(c.prompt)) bThr.set(c.prompt, c.threshold);
  for (const c of hCases.values()) if (!hThr.has(c.prompt)) hThr.set(c.prompt, c.threshold);
  for (const c of [...bCases.values(), ...hCases.values()]) if (!prompts.has(c.prompt)) prompts.set(c.prompt, c.skill);
  for (const p of opts.prompts ?? []) if (p.trim() && !prompts.has(p)) prompts.set(p, null);
  const bIdx = new Bm25Index(bPool);
  const hIdx = new Bm25Index(hPool);
  const changes: RouteChange[] = [];
  for (const [prompt, owner] of prompts) {
    const before = bIdx.route(prompt, bThr.get(prompt) ?? hThr.get(prompt) ?? threshold).selected;
    const after = hIdx.route(prompt, hThr.get(prompt) ?? bThr.get(prompt) ?? threshold).selected;
    if (before !== after) changes.push({ prompt, owner, before, after });
  }
  return { threshold, added, removed, descriptionChanged, changes, regressions, fixes, prompts: prompts.size };
}

/**
 * Materialize the SKILL.md and trigger files below `dir` as they were at git `ref`
 * into a temp directory (routing only needs those files). Returns the temp path
 * corresponding to `dir`, and a cleanup function.
 */
export function checkoutRoutingFiles(dir: string, ref: string): { path: string; cleanup: () => void } {
  if (ref.startsWith('-') || /[\0\s]/.test(ref)) throw new Error(`invalid git ref "${ref}"`);
  const abs = realpathSync(path.resolve(dir));
  // Never let the OS resolve a bare "git": on Windows that searches the (untrusted) repo first.
  const gitExe = findGit(undefined, [abs]);
  if (!gitExe) throw new Error('git was not found on PATH (relative PATH entries and the repository itself are not searched)');
  const base = ['-c', 'core.fsmonitor=false'];
  const git = (args: string[], cwd = abs) => execFileSync(gitExe, [...base, ...args], { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'], shell: false, windowsHide: true });
  const top = git(['rev-parse', '--show-toplevel']).trim();
  // Ask git for the subfolder rather than path.relative(top, abs): `top` is git's spelling, which can
  // differ from `abs` (Windows 8.3 names like RUNNER~1, letter case), giving a ../.. "outside repository" path.
  const prefix = git(['rev-parse', '--show-prefix']).trim().replace(/\/$/, '');
  git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  const listing = git(['ls-tree', '-r', '-z', '--name-only', ref, '--', prefix || '.'], top);
  const wanted = listing.split('\0').filter((p) => {
    if (!p) return false;
    const base = p.split('/').pop()!;
    if (base.toLowerCase() === 'skill.md') return true;
    return TEST_FILE_NAMES.some((n) => p === n || p.endsWith('/' + n));
  });
  const tmp = mkdtempSync(path.join(tmpdir(), 'triggerspec-base-'));
  for (const p of wanted) {
    const content = execFileSync(gitExe, [...base, 'show', `${ref}:${p}`], { cwd: top, maxBuffer: 64 * 1024 * 1024, shell: false, windowsHide: true });
    const out = path.join(tmp, ...p.split('/'));
    mkdirSync(path.dirname(out), { recursive: true });
    writeFileSync(out, content);
  }
  const target = path.join(tmp, ...(prefix ? prefix.split('/') : []));
  mkdirSync(target, { recursive: true });
  return { path: target, cleanup: () => rmSync(tmp, { recursive: true, force: true }) };
}
