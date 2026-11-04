import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { loadCatalog } from './catalog.js';
import { findCollisions } from './collisions.js';
import { checkoutRoutingFiles, diffCatalogs } from './diff.js';
import { discoverSkills } from './discover.js';
import { createJudge } from './judge.js';
import { aggregateCrlf, lintCatalog, lintSkill, type LintOptions } from './lint.js';
import { loadSkill } from './parse.js';
import { countBySeverity, findingToJson, formatCollisions, formatDiff, formatLint, formatRoute, formatTest, makeStyle, type Style } from './report.js';
import { Bm25Index, DEFAULT_THRESHOLD } from './scorer.js';
import { routableSkills } from './catalog.js';
import { runTriggerTests } from './tester.js';
import type { Finding } from './types.js';
import { displayPath, expandHome } from './util.js';

export interface Io {
  out(s: string): void;
  err(s: string): void;
  cwd: string;
  env: Record<string, string | undefined>;
  color: boolean;
}

export class UsageError extends Error {}

export function version(): string {
  try {
    return (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version;
  } catch {
    return '0.0.0';
  }
}

export const HELP = `triggerspec — offline trigger tests, routing diffs, collision reports and deep lint for Agent Skills (SKILL.md)

Usage:
  triggerspec lint <path...>          Validate SKILL.md frontmatter, links, referenced files, scripts, budgets
  triggerspec test <path>             Run trigger tests (triggers.yaml) with the offline BM25 scorer
  triggerspec collisions <path>       Report skills whose descriptions compete for the same prompts
  triggerspec route <path> <prompt>   Show how the offline scorer ranks skills for one prompt
  triggerspec diff <path> --base-ref <git-ref> | --base <dir>
                                      Show which test prompts change winner between two catalog versions
  triggerspec check <path>            lint + collisions + test in one go

<path> is a SKILL.md, a skill folder, or any folder containing skill folders (searched recursively).

Common options:
  --json                 Machine-readable output on stdout
  --fail-on <level>      Exit 1 on "error" (default) or "warning" findings
  --verbose              Show info findings / passing test cases
  --no-color             Disable ANSI colors (also NO_COLOR=1)
  -h, --help / -v, --version

lint:
  --disable <codes>      Comma-separated rule codes to ignore
  --max-body-lines <n>   Body line budget (default 500)
  --max-body-tokens <n>  Body token budget (default 5000, estimated)
  --no-exec              Do not spawn python3/bash/node to syntax-check scripts (scripts are never run)
  --spec-only            Treat client-extension fields (Claude Code) as unknown fields

test / route / collisions / diff:
  --catalog <dir>        Add competitor skills (e.g. ~/.claude/skills); repeatable
  --threshold <0..1>     Min. prompt coverage for the top skill to count as triggered (default ${DEFAULT_THRESHOLD})
  --only <name>          (test) Only run one skill's tests; repeatable
  --llm                  (test) Also ask an LLM judge; needs ANTHROPIC_API_KEY or OPENAI_API_KEY
                         (+ OPENAI_BASE_URL for compatible servers); skipped when no key is set
  --provider <p>         (test) anthropic | openai     --model <id>  (test) judge model
  --warn-at <0..1>       (collisions) similarity that warns (default 0.4)
  --error-at <0..1>      (collisions) similarity that errors (default 0.7)
  --top <n>              (route) rows to show (default 5)
  --prompts <file>       (diff) extra prompts to compare, one per line

Exit codes: 0 ok, 1 errors/failed tests/regressions, 2 usage or I/O error.`;

interface Parsed {
  positionals: string[];
  flags: Map<string, string[]>;
}

const BOOL = new Set(['json', 'verbose', 'no-color', 'no-exec', 'spec-only', 'llm', 'help', 'version']);
const VALUE = new Set(['fail-on', 'disable', 'max-body-lines', 'max-body-tokens', 'catalog', 'threshold', 'only', 'provider', 'model', 'warn-at', 'error-at', 'top', 'prompts', 'base', 'base-ref']);

export function parseArgs(argv: string[]): Parsed {
  const positionals: string[] = [];
  const flags = new Map<string, string[]>();
  const add = (k: string, v: string) => flags.set(k, [...(flags.get(k) ?? []), v]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--') {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (a === '-h') { add('help', 'true'); continue; }
    if (a === '-v') { add('version', 'true'); continue; }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const name = eq > 0 ? a.slice(2, eq) : a.slice(2);
      if (BOOL.has(name)) {
        if (eq > 0) throw new UsageError(`--${name} does not take a value`);
        add(name, 'true');
      } else if (VALUE.has(name)) {
        const v = eq > 0 ? a.slice(eq + 1) : argv[++i];
        if (v === undefined) throw new UsageError(`--${name} needs a value`);
        add(name, v);
      } else throw new UsageError(`unknown option ${a}`);
      continue;
    }
    positionals.push(a);
  }
  return { positionals, flags };
}

const one = (p: Parsed, k: string) => p.flags.get(k)?.at(-1);
const has = (p: Parsed, k: string) => p.flags.has(k);
const num = (p: Parsed, k: string, min: number, max: number): number | undefined => {
  const v = one(p, k);
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) throw new UsageError(`--${k} must be a number between ${min} and ${max}`);
  return n;
};
const failOn = (p: Parsed): 'error' | 'warning' => {
  const v = one(p, 'fail-on') ?? 'error';
  if (v !== 'error' && v !== 'warning') throw new UsageError('--fail-on must be "error" or "warning"');
  return v;
};

function lintPaths(paths: string[], p: Parsed): { findings: Finding[]; dirs: string[]; skillDirs: string[] } {
  const opts: Partial<LintOptions> = {
    execChecks: !has(p, 'no-exec'),
    specOnly: has(p, 'spec-only'),
    disable: new Set((p.flags.get('disable') ?? []).flatMap((s) => s.split(',')).map((s) => s.trim()).filter(Boolean)),
  };
  const mbl = num(p, 'max-body-lines', 1, 1e9);
  const mbt = num(p, 'max-body-tokens', 1, 1e9);
  if (mbl !== undefined) opts.maxBodyLines = mbl;
  if (mbt !== undefined) opts.maxBodyTokens = mbt;
  const findings: Finding[] = [];
  const skills = [];
  // Interpreters for syntax checks are never taken from inside the linted folders (see exe.ts).
  opts.untrustedDirs = paths.map((x) => path.resolve(expandHome(x)));
  for (const input of paths) {
    const found = discoverSkills(input, {
      onIssue: (is) => findings.push({ code: 'path-skipped', severity: 'info', message: `${is.path}: ${is.reason}; not searched for skills.`, skillDir: path.resolve(expandHome(input)) }),
    });
    if (found.length === 0) {
      findings.push({ code: 'no-skills-found', severity: 'error', message: `No SKILL.md found under ${input}.`, skillDir: path.resolve(input) });
      continue;
    }
    for (const sf of found) {
      const s = loadSkill(sf);
      skills.push(s);
      findings.push(...lintSkill(s, opts));
    }
  }
  findings.push(...lintCatalog(skills, opts));
  const dirs = skills.map((s) => s.dir);
  for (const f of findings) if (f.code === 'no-skills-found' && f.skillDir) dirs.push(f.skillDir);
  // One CRLF note for the whole run, never one per file.
  return { findings: aggregateCrlf(findings), dirs, skillDirs: skills.map((s) => s.dir) };
}

function collisionOpts(p: Parsed): { warnAt?: number; errorAt?: number } {
  const warnAt = num(p, 'warn-at', 0, 1);
  const errorAt = num(p, 'error-at', 0, 1);
  if ((warnAt ?? 0.4) > (errorAt ?? 0.7)) throw new UsageError(`--warn-at (${warnAt ?? 0.4}) must not be greater than --error-at (${errorAt ?? 0.7})`);
  return { warnAt, errorAt };
}

function requirePath(p: Parsed, cmd: string): string {
  const target = p.positionals[0];
  if (!target) throw new UsageError(`${cmd} needs a <path>`);
  return target;
}

export async function run(argv: string[], io: Io): Promise<number> {
  let p: Parsed;
  try {
    p = parseArgs(argv);
  } catch (e) {
    io.err(`triggerspec: ${(e as Error).message}\nRun "triggerspec --help" for usage.`);
    return 2;
  }
  if (has(p, 'version')) {
    io.out(version());
    return 0;
  }
  const cmd = p.positionals.shift();
  if (has(p, 'help') || !cmd || cmd === 'help') {
    io.out(HELP);
    return cmd || has(p, 'help') ? 0 : 2;
  }
  const st: Style = makeStyle(io.color && !has(p, 'no-color') && !io.env.NO_COLOR);
  const json = has(p, 'json');
  const verbose = has(p, 'verbose');
  const emit = (obj: unknown) => io.out(JSON.stringify(obj, null, 2));
  const catalogs = p.flags.get('catalog') ?? [];
  try {
    switch (cmd) {
      case 'lint': {
        if (p.positionals.length === 0) throw new UsageError('lint needs at least one <path>');
        const fo = failOn(p);
        const { findings, dirs, skillDirs } = lintPaths(p.positionals, p);
        const c = countBySeverity(findings);
        const code = c.error > 0 || (fo === 'warning' && c.warning > 0) ? 1 : 0;
        if (json) emit({ ok: code === 0, skills: skillDirs.map((d) => displayPath(d, io.cwd)), counts: c, findings: findings.map((f) => findingToJson(f, io.cwd)) });
        else io.out(formatLint(findings, dirs, st, io.cwd, verbose));
        return code;
      }
      case 'test': {
        const target = requirePath(p, 'test');
        const threshold = num(p, 'threshold', 0, 1);
        const catalog = loadCatalog(target, catalogs);
        if (catalog.skills.length === 0) throw new UsageError(`no SKILL.md found under ${target}`);
        let judge = null;
        let judgeSkippedReason: string | undefined;
        if (has(p, 'llm')) {
          const prov = one(p, 'provider');
          if (prov !== undefined && prov !== 'anthropic' && prov !== 'openai') throw new UsageError('--provider must be anthropic or openai');
          const r = createJudge({ provider: prov as 'anthropic' | 'openai' | undefined, model: one(p, 'model'), env: io.env });
          judge = r.judge;
          judgeSkippedReason = r.reason;
        }
        const runRes = await runTriggerTests(catalog, { threshold, judge, judgeSkippedReason, only: p.flags.get('only') });
        const judgeFailed = runRes.judge && !runRes.judge.skippedReason ? runRes.judge.failed + runRes.judge.errors : 0;
        const noTests = runRes.skills.length === 0;
        const code = runRes.failed > 0 || judgeFailed > 0 || noTests ? 1 : 0;
        if (json) {
          emit({
            ok: code === 0,
            ...runRes,
            skills: runRes.skills.map((s) => ({ ...s, skillDir: displayPath(s.skillDir, io.cwd), file: s.file ? displayPath(s.file, io.cwd) : null, cases: s.cases.map(({ skillDir: _d, file: _f, ...c }) => c) })),
          });
        } else io.out(formatTest(runRes, st, io.cwd, verbose));
        return code;
      }
      case 'collisions': {
        const target = requirePath(p, 'collisions');
        const fo = failOn(p);
        const catalog = loadCatalog(target, catalogs);
        if (catalog.skills.length === 0) throw new UsageError(`no SKILL.md found under ${target}`);
        const rep = findCollisions(catalog, collisionOpts(p));
        const errors = rep.pairs.filter((x) => x.severity === 'error').length;
        const code = errors > 0 || (fo === 'warning' && rep.pairs.length > 0) ? 1 : 0;
        if (json) emit({ ok: code === 0, ...rep });
        else io.out(formatCollisions(rep, st));
        return code;
      }
      case 'route': {
        const target = requirePath(p, 'route');
        const prompt = p.positionals.slice(1).join(' ');
        if (!prompt.trim()) throw new UsageError('route needs a <prompt>');
        const catalog = loadCatalog(target, catalogs);
        const idx = new Bm25Index(routableSkills([...catalog.skills, ...catalog.extra]));
        const r = idx.route(prompt, num(p, 'threshold', 0, 1) ?? DEFAULT_THRESHOLD);
        const top = num(p, 'top', 1, 1000) ?? 5;
        if (json) emit({ ...r, ranking: r.ranking.filter((x) => x.score > 0).slice(0, top) });
        else io.out(formatRoute(r, st, top));
        return 0;
      }
      case 'diff': {
        const target = requirePath(p, 'diff');
        const baseDir = one(p, 'base');
        const baseRef = one(p, 'base-ref');
        if (!baseDir === !baseRef) throw new UsageError('diff needs exactly one of --base <dir> or --base-ref <git-ref>');
        let cleanup = () => {};
        let basePath = expandHome(baseDir ?? '');
        if (baseRef) {
          try {
            const co = checkoutRoutingFiles(target, baseRef);
            basePath = co.path;
            cleanup = co.cleanup;
          } catch (e) {
            const msg = (e as { stderr?: Buffer | string }).stderr?.toString().trim() || (e as Error).message;
            throw new UsageError(`cannot read ${baseRef} from git: ${msg.split('\n')[0]}`);
          }
        }
        try {
          const head = loadCatalog(target, catalogs);
          const base = loadCatalog(basePath, catalogs);
          const promptsFile = one(p, 'prompts');
          const prompts = promptsFile ? readFileSync(expandHome(promptsFile), 'utf8').split(/\r?\n/).filter((l) => l.trim() && !l.startsWith('#')) : [];
          const d = await diffCatalogs(base, head, { threshold: num(p, 'threshold', 0, 1), prompts });
          const code = d.regressions.length > 0 ? 1 : 0;
          if (json) emit({ ok: code === 0, ...d });
          else io.out(formatDiff(d, st));
          return code;
        } finally {
          cleanup();
        }
      }
      case 'check': {
        const target = requirePath(p, 'check');
        const fo = failOn(p);
        for (const k of ['only', 'llm', 'provider', 'model', 'top', 'base', 'base-ref', 'prompts']) {
          if (has(p, k)) throw new UsageError(`--${k} is not supported by "check" (use "test", "route" or "diff" for it)`);
        }
        const { findings, dirs } = lintPaths([target], p);
        const catalog = loadCatalog(target, catalogs);
        const rep = findCollisions(catalog, collisionOpts(p));
        const runRes = await runTriggerTests(catalog, { threshold: num(p, 'threshold', 0, 1) });
        const c = countBySeverity(findings);
        const lintFail = c.error > 0 || (fo === 'warning' && c.warning > 0);
        const colFail = rep.pairs.some((x) => x.severity === 'error') || (fo === 'warning' && rep.pairs.length > 0);
        const testFail = runRes.failed > 0;
        const code = lintFail || colFail || testFail ? 1 : 0;
        if (json) {
          emit({ ok: code === 0, lint: { counts: c, findings: findings.map((f) => findingToJson(f, io.cwd)) }, collisions: rep, test: { passed: runRes.passed, failed: runRes.failed, skills: runRes.skills.map((s) => ({ skill: s.skill, error: s.error, failed: s.cases.filter((x) => !x.pass).map((x) => ({ prompt: x.prompt, shouldTrigger: x.shouldTrigger, reason: x.reason })) })) } });
        } else {
          io.out(st.bold('== lint'));
          io.out(formatLint(findings, dirs, st, io.cwd, verbose));
          io.out('\n' + st.bold('== collisions'));
          io.out(formatCollisions(rep, st));
          io.out('\n' + st.bold('== trigger tests'));
          io.out(runRes.skills.length ? formatTest(runRes, st, io.cwd, verbose) : st.dim('no trigger test files (triggers.yaml) found; skipped'));
        }
        return code;
      }
      default:
        throw new UsageError(`unknown command "${cmd}"`);
    }
  } catch (e) {
    if (e instanceof UsageError) {
      io.err(`triggerspec: ${e.message}\nRun "triggerspec --help" for usage.`);
      return 2;
    }
    const err = e as NodeJS.ErrnoException;
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR' || err.code === 'EACCES') {
      io.err(`triggerspec: ${err.message}`);
      return 2;
    }
    io.err(`triggerspec: ${err.message ?? String(e)}`);
    return 2;
  }
}
