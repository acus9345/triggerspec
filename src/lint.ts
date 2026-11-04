import * as path from 'node:path';
import { errCode, isWithin, nodeFsLike, resolveCase, VisitedDirs, type FsLike } from './fsx.js';
import { extractLinks, extractPathMentions, headingSlugs, RESOURCE_DIRS } from './markdown.js';
import type { ExeLookup } from './exe.js';
import { checkScripts, SCRIPT_EXTENSIONS, type SpawnLike } from './scripts.js';
import { findTestFile, parseTestFile, TEST_FILE_NAMES, TestFileError } from './testfile.js';
import type { Finding, ParsedSkill, Severity } from './types.js';
import { estimateTokens, isPlainObject, toPosix } from './util.js';

export interface LintOptions {
  maxBodyLines: number;
  maxBodyTokens: number;
  /** Spawn python3/bash/node to syntax-check scripts (never executes them). */
  execChecks: boolean;
  /** Treat known client-extension fields (Claude Code etc.) as unknown fields. */
  specOnly: boolean;
  /** Rule codes to drop from the output. */
  disable: Set<string>;
  /** Filesystem used for reference checks (injectable for tests). */
  fs: FsLike;
  /** Platform used for script checks (injectable for tests). */
  platform: NodeJS.Platform;
  /** Folders that must never provide an executable (the linted paths; the skill folder always counts). */
  untrustedDirs?: string[];
  /** Executable lookup override (tests). */
  lookup?: Partial<ExeLookup>;
  /** Process spawner override (tests). */
  spawn?: SpawnLike;
}

export const DEFAULT_LINT_OPTIONS: LintOptions = {
  maxBodyLines: 500,
  maxBodyTokens: 5000,
  execChecks: true,
  specOnly: false,
  disable: new Set(),
  fs: nodeFsLike,
  platform: process.platform,
};

/** Fields defined by the Agent Skills specification (agentskills.io). */
export const SPEC_FIELDS = new Set(['name', 'description', 'license', 'compatibility', 'metadata', 'allowed-tools']);

/** Fields some clients (mainly Claude Code) read, which are not in the open spec. */
export const CLIENT_EXTENSION_FIELDS = new Set([
  'when_to_use',
  'argument-hint',
  'disable-model-invocation',
  'user-invocable',
  'model',
  'effort',
  'context',
  'agent',
  'hooks',
  'paths',
  'shell',
  'version',
]);

const TEXT_EXTENSIONS = new Set(['.md', '.markdown', '.txt', '.rst', '.mdx']);
const CODE_EXTENSIONS = new Set([...SCRIPT_EXTENSIONS, '.ts', '.tsx', '.jsx', '.rb', '.go', '.rs', '.java', '.ps1', '.json', '.yaml', '.yml', '.toml', '.html', '.xml', '.xsd', '.css']);
const EXEMPT_ORPHAN = /^(license|licence|copying|notice|readme|changelog|contributing|authors)(\..*)?$/i;
const HIDDEN_UNICODE = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/u;

/** Make a finding (helper). */
function f(code: string, severity: Severity, message: string, file: string | undefined, line: number | undefined, skillDir: string): Finding {
  return { code, severity, message, file, line, skillDir };
}

/** The last path segment of `dir` spelled as the parent directory lists it. */
function onDiskName(dir: string, fs: FsLike): string {
  const base = path.basename(dir);
  try {
    const names = fs.readdirSync(path.dirname(dir));
    if (names.includes(base)) return base;
    return names.find((x) => x.toLowerCase() === base.toLowerCase()) ?? base;
  } catch {
    return base;
  }
}

export function nameRules(skill: ParsedSkill, fs: FsLike = nodeFsLike): Finding[] {
  const out: Finding[] = [];
  const fm = skill.frontmatter;
  if (!fm) return out;
  const line = skill.fieldLines.name ?? 1;
  const raw = fm.name;
  if (raw === undefined || raw === null) {
    out.push(f('name-missing', 'error', 'Frontmatter is missing the required "name" field.', skill.file, 1, skill.dir));
    return out;
  }
  if (typeof raw !== 'string') {
    out.push(f('name-type', 'error', `"name" must be a string (got ${typeof raw}).`, skill.file, line, skill.dir));
    return out;
  }
  const name = raw.normalize('NFKC');
  if (name.trim() === '') {
    out.push(f('name-missing', 'error', '"name" is empty.', skill.file, line, skill.dir));
    return out;
  }
  if (name !== name.trim()) out.push(f('name-whitespace', 'warning', '"name" has leading or trailing whitespace.', skill.file, line, skill.dir));
  const n = name.trim();
  if ([...n].length > 64) out.push(f('name-too-long', 'error', `"name" is ${[...n].length} characters; the maximum is 64.`, skill.file, line, skill.dir));
  if (!/^[\p{Ll}\p{Lo}\p{Lm}\p{N}-]+$/u.test(n)) {
    out.push(f('name-format', 'error', `"name" "${n}" may only contain lowercase letters, digits and hyphens.`, skill.file, line, skill.dir));
  } else if (!/^[a-z0-9-]+$/.test(n)) {
    out.push(f('name-non-ascii', 'warning', `"name" "${n}" uses non-ASCII letters; allowed by the spec, but some clients (e.g. Claude's skill upload validator) require [a-z0-9-].`, skill.file, line, skill.dir));
  }
  if (n.startsWith('-') || n.endsWith('-')) out.push(f('name-hyphen-edge', 'error', `"name" "${n}" must not start or end with a hyphen.`, skill.file, line, skill.dir));
  if (n.includes('--')) out.push(f('name-consecutive-hyphens', 'error', `"name" "${n}" must not contain consecutive hyphens.`, skill.file, line, skill.dir));
  // Compare with the folder name as stored on disk: on Windows/macOS the user may have typed
  // the path in another case, which must not turn into a false mismatch.
  const base = onDiskName(skill.dir, fs);
  if (n !== base.normalize('NFKC')) out.push(f('name-dir-mismatch', 'error', `"name" "${n}" must match the folder name "${base}".`, skill.file, line, skill.dir));
  if (/anthropic|claude/i.test(n)) out.push(f('name-reserved-word', 'info', `"name" contains a reserved word ("anthropic"/"claude"); the Claude API rejects such names for custom skills.`, skill.file, line, skill.dir));
  return out;
}

export function descriptionRules(skill: ParsedSkill): Finding[] {
  const out: Finding[] = [];
  const fm = skill.frontmatter;
  if (!fm) return out;
  const line = skill.fieldLines.description ?? 1;
  const raw = fm.description;
  if (raw === undefined || raw === null) {
    out.push(f('description-missing', 'error', 'Frontmatter is missing the required "description" field.', skill.file, 1, skill.dir));
    return out;
  }
  if (typeof raw !== 'string') {
    out.push(f('description-type', 'error', `"description" must be a string (got ${Array.isArray(raw) ? 'list' : typeof raw}).`, skill.file, line, skill.dir));
    return out;
  }
  const d = raw.trim();
  if (d === '') {
    out.push(f('description-missing', 'error', '"description" is empty.', skill.file, line, skill.dir));
    return out;
  }
  const len = [...d].length;
  if (len > 1024) out.push(f('description-too-long', 'error', `"description" is ${len} characters; the maximum is 1024.`, skill.file, line, skill.dir));
  if (len < 40) out.push(f('description-too-short', 'warning', `"description" is only ${len} characters; describe what the skill does and when to use it.`, skill.file, line, skill.dir));
  if (/[<>]/.test(d)) out.push(f('description-angle-brackets', 'warning', '"description" contains "<" or ">"; Claude\'s skill validator rejects angle brackets (XML tags) in descriptions.', skill.file, line, skill.dir));
  if (!/\b(use|used|when|whenever|if|trigger|triggers|for)\b/i.test(d)) {
    out.push(f('description-no-trigger-context', 'info', '"description" does not say when to use the skill (e.g. "Use when ..."); agents select skills from this text.', skill.file, line, skill.dir));
  }
  if (HIDDEN_UNICODE.test(d)) out.push(f('hidden-unicode', 'warning', '"description" contains invisible/bidirectional Unicode control characters.', skill.file, line, skill.dir));
  return out;
}

export function otherFieldRules(skill: ParsedSkill, opts: LintOptions): Finding[] {
  const out: Finding[] = [];
  const fm = skill.frontmatter;
  if (!fm) return out;
  const L = (k: string) => skill.fieldLines[k] ?? 1;
  for (const key of Object.keys(fm)) {
    if (SPEC_FIELDS.has(key)) continue;
    if (!opts.specOnly && CLIENT_EXTENSION_FIELDS.has(key)) {
      out.push(f('client-extension-field', 'info', `"${key}" is a client extension (Claude Code), not part of the Agent Skills spec; other clients ignore it.`, skill.file, L(key), skill.dir));
    } else {
      out.push(f('unknown-field', 'warning', `Unknown frontmatter field "${key}"; the spec allows ${[...SPEC_FIELDS].join(', ')}. Strict validators (skills-ref) reject it — move it under "metadata".`, skill.file, L(key), skill.dir));
    }
  }
  if ('compatibility' in fm) {
    const c = fm.compatibility;
    if (typeof c !== 'string') out.push(f('compatibility-type', 'error', '"compatibility" must be a string.', skill.file, L('compatibility'), skill.dir));
    else if (c.trim() === '' || [...c].length > 500) out.push(f('compatibility-length', 'error', `"compatibility" must be 1-500 characters (got ${[...c.trim()].length}).`, skill.file, L('compatibility'), skill.dir));
  }
  if ('license' in fm && typeof fm.license !== 'string') out.push(f('license-type', 'warning', '"license" should be a string (a license name or bundled file).', skill.file, L('license'), skill.dir));
  if (typeof fm.license === 'string') {
    const m = /\b([\w.-]+\.(?:txt|md))\b/i.exec(fm.license);
    if (m && /[/\\]|^[A-Z]+[\w-]*\.(txt|md)$/i.test(m[1]!) && resolveCase(skill.dir, path.join(skill.dir, m[1]!), opts.fs).status !== 'exact') {
      out.push(f('license-file-missing', 'warning', `"license" refers to ${m[1]} which does not exist in the skill folder.`, skill.file, L('license'), skill.dir));
    }
  }
  if ('metadata' in fm) {
    const m = fm.metadata;
    if (!isPlainObject(m)) out.push(f('metadata-type', 'error', '"metadata" must be a mapping of string keys to string values.', skill.file, L('metadata'), skill.dir));
    else {
      const bad = Object.entries(m).filter(([, v]) => typeof v !== 'string').map(([k]) => k);
      if (bad.length) out.push(f('metadata-value-type', 'warning', `"metadata" values should be strings (quote them): ${bad.join(', ')}.`, skill.file, L('metadata'), skill.dir));
    }
  }
  if ('allowed-tools' in fm) {
    const t = fm['allowed-tools'];
    if (Array.isArray(t)) {
      if (!t.every((x) => typeof x === 'string')) out.push(f('allowed-tools-type', 'error', '"allowed-tools" entries must be strings.', skill.file, L('allowed-tools'), skill.dir));
      else out.push(f('allowed-tools-list', 'info', '"allowed-tools" is a YAML list; the spec defines a space-separated string (Claude Code accepts both).', skill.file, L('allowed-tools'), skill.dir));
    } else if (typeof t !== 'string') {
      out.push(f('allowed-tools-type', 'error', '"allowed-tools" must be a space-separated string.', skill.file, L('allowed-tools'), skill.dir));
    }
  }
  return out;
}

export function fileLevelRules(skill: ParsedSkill, opts: LintOptions): Finding[] {
  const out: Finding[] = [];
  if (skill.fileName !== 'SKILL.md') {
    out.push(f('skill-file-case', 'error', `Skill file is named "${skill.fileName}"; it must be exactly "SKILL.md" (case-sensitive filesystems and loaders will not find it).`, skill.file, undefined, skill.dir));
  }
  if (skill.hadBom) out.push(f('utf8-bom', 'warning', 'SKILL.md starts with a UTF-8 byte-order mark; strict loaders then do not see the "---" frontmatter fence.', skill.file, 1, skill.dir));
  if (skill.hadCrlf) out.push(f('crlf-line-endings', 'info', 'CRLF line endings.', skill.file, 1, skill.dir));
  const body = skill.body;
  if (skill.frontmatter && body.trim() === '') out.push(f('body-empty', 'warning', 'SKILL.md has no instructions after the frontmatter.', skill.file, skill.bodyStartLine, skill.dir));
  const lines = body.replace(/\n+$/, '').split('\n').length;
  if (lines > opts.maxBodyLines) out.push(f('body-too-long', 'warning', `SKILL.md body is ${lines} lines (budget ${opts.maxBodyLines}); move detail into references/ files.`, skill.file, skill.bodyStartLine, skill.dir));
  const tokens = estimateTokens(body);
  if (tokens > opts.maxBodyTokens) out.push(f('body-too-many-tokens', 'warning', `SKILL.md body is ~${tokens} tokens (budget ${opts.maxBodyTokens}); it is loaded in full whenever the skill triggers.`, skill.file, skill.bodyStartLine, skill.dir));
  const hidden = HIDDEN_UNICODE.exec(body);
  if (hidden) {
    const idx = body.indexOf(hidden[0]);
    const line = skill.bodyStartLine + body.slice(0, idx).split('\n').length - 1;
    out.push(f('hidden-unicode', 'warning', `Body contains invisible/bidirectional Unicode control character U+${hidden[0].codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}.`, skill.file, line, skill.dir));
  }
  return out;
}

// ---------------------------------------------------------------------------
// References, links, orphans
// ---------------------------------------------------------------------------

type Target =
  | { kind: 'skip' }
  | { kind: 'fragment'; fragment: string }
  | { kind: 'absolute'; raw: string }
  | { kind: 'path'; rel: string; fragment?: string; backslash: boolean };

export function classifyTarget(raw: string): Target {
  let t = raw.trim();
  if (t === '') return { kind: 'skip' };
  if (t.startsWith('#')) return { kind: 'fragment', fragment: t.slice(1) };
  if (/^[a-zA-Z]:[\\/]/.test(t) || t.startsWith('\\\\')) return { kind: 'absolute', raw: t };
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(t) || t.startsWith('//')) return { kind: 'skip' };
  if (t.startsWith('/') || t.startsWith('~')) return { kind: 'absolute', raw: t };
  try {
    t = decodeURI(t);
  } catch {
    /* keep raw */
  }
  if (/[{}<>*$|]/.test(t) || /\.\.\.|…/.test(t)) return { kind: 'skip' }; // placeholders, globs, elisions
  let fragment: string | undefined;
  const hash = t.indexOf('#');
  if (hash >= 0) {
    fragment = t.slice(hash + 1);
    t = t.slice(0, hash);
  }
  const q = t.indexOf('?');
  if (q >= 0) t = t.slice(0, q);
  if (t === '') return fragment !== undefined ? { kind: 'fragment', fragment } : { kind: 'skip' };
  const backslash = t.includes('\\');
  return { kind: 'path', rel: toPosix(t), fragment, backslash };
}

/** Limits for the file walk inside one skill. */
export const MAX_SKILL_DEPTH = 12;
export const MAX_SKILL_ENTRIES = 20000;

export interface SkillFileWalk {
  /** Files relative to the skill root, POSIX separators, sorted. */
  files: string[];
  /** Entries that were not walked (errors, loops, limits, links leaving the skill). */
  issues: { path: string; reason: string; kind: 'error' | 'loop' | 'limit' | 'outside' }[];
}

/**
 * Walk the files bundled with a skill: relative POSIX paths, without VCS dirs,
 * node_modules, caches and dotfiles. Symlinked files and folders (and Windows junctions)
 * are followed, but:
 * - a folder already walked (same real path or same dev/ino) is not walked again, so
 *   self-referencing and mutually-referencing link loops end immediately;
 * - linked folders whose real path is outside the skill are not walked (they will be
 *   missing when the skill is copied or installed on its own);
 * - depth and the total number of entries are capped;
 * - unreadable entries (ELOOP, EACCES, EPERM, ENAMETOOLONG, ...) are skipped.
 */
export function walkSkillFiles(dir: string, fs: FsLike = nodeFsLike): SkillFileWalk {
  const files: string[] = [];
  const issues: SkillFileWalk['issues'] = [];
  const visited = new VisitedDirs(fs);
  const realRoot = visited.real(dir);
  let entries = 0;
  let capped = false;
  type Ident = { real: string | null; id: string | null };
  type Job = { d: string; rel: string; depth: number; st?: { dev?: number | bigint; ino?: number | bigint }; chain: Ident[] };
  const ident = (d: string, st?: Job['st']): Ident => ({ real: visited.real(d), id: VisitedDirs.idOf(st) });
  const same = (a: Ident, b: Ident) => (a.real !== null && a.real === b.real) || (a.id !== null && a.id === b.id);
  // Linked folders are walked after all real folders, so files get their real (canonical)
  // path whenever they are reachable without a link.
  const deferred: Job[] = [];
  const walk = ({ d, rel, depth, st, chain }: Job): void => {
    const me = ident(d, st);
    if (!visited.enter(d, st)) {
      // A link to one of its own ancestors is a loop; a second name for a folder already
      // walked elsewhere is just an alias, and its files are already listed.
      if (chain.some((c) => same(c, me))) issues.push({ path: rel, reason: 'link loop (points to a folder that contains it)', kind: 'loop' });
      return;
    }
    if (depth > MAX_SKILL_DEPTH) {
      issues.push({ path: rel, reason: `deeper than ${MAX_SKILL_DEPTH} levels`, kind: 'limit' });
      return;
    }
    let names: string[];
    try {
      names = fs.readdirSync(d);
    } catch (e) {
      if (rel) issues.push({ path: rel, reason: `cannot read folder (${errCode(e)})`, kind: 'error' });
      return;
    }
    const nextChain = [...chain, me];
    for (const name of names) {
      if (name.startsWith('.') || name === 'node_modules' || name === '__pycache__') continue;
      if (++entries > MAX_SKILL_ENTRIES) {
        if (!capped) issues.push({ path: rel || '.', reason: `stopped after ${MAX_SKILL_ENTRIES} entries`, kind: 'limit' });
        capped = true;
        return;
      }
      const r = rel ? `${rel}/${name}` : name;
      const abs = path.join(d, name);
      let cst;
      try {
        cst = fs.statSync(abs);
      } catch (e) {
        const code = errCode(e);
        if (code !== 'ENOENT') issues.push({ path: r, reason: `cannot read (${code})`, kind: 'error' });
        continue; // ENOENT: dangling symlink
      }
      if (cst.isDirectory()) {
        const real = visited.real(abs);
        if (realRoot !== null && real !== null && !isWithin(realRoot, real)) {
          issues.push({ path: r, reason: 'linked folder points outside the skill', kind: 'outside' });
          continue;
        }
        const job: Job = { d: abs, rel: r, depth: depth + 1, st: cst, chain: nextChain };
        // A folder whose real path differs from its lexical path is reached through a link.
        if (real !== null && real !== path.join(visited.real(d) ?? d, name)) deferred.push(job);
        else walk(job);
      } else if (cst.isFile()) files.push(r);
    }
  };
  let rootSt;
  try {
    rootSt = fs.statSync(dir);
  } catch {
    rootSt = undefined;
  }
  walk({ d: dir, rel: '', depth: 0, st: rootSt, chain: [] });
  while (deferred.length > 0 && !capped) walk(deferred.shift()!);
  return { files: [...new Set(files)].sort(), issues };
}

/** Files bundled with a skill (see walkSkillFiles). */
export function listSkillFiles(dir: string, fs: FsLike = nodeFsLike): string[] {
  return walkSkillFiles(dir, fs).files;
}

function readText(file: string, fs: FsLike = nodeFsLike): string | null {
  try {
    const st = fs.statSync(file);
    if (st.size > 2 * 1024 * 1024) return null;
    const buf = fs.readFileSync(file);
    if (buf.includes(0)) return null; // binary
    return buf.toString('utf8').replace(/\r\n?/g, '\n');
  } catch {
    return null;
  }
}

export interface ReferenceResult {
  findings: Finding[];
  /** Relative POSIX paths of files considered referenced (directly or transitively). */
  referenced: Set<string>;
  /** Relative POSIX paths of all scripts reachable/present (for script checks). */
  scripts: string[];
}

const GENERIC_DIRS = new Set(RESOURCE_DIRS);
const MANIFEST_FILES = new Set(['requirements.txt', 'package.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'pyproject.toml', 'setup.py', 'setup.cfg', 'uv.lock', 'poetry.lock', 'cargo.toml', 'cargo.lock', 'go.mod', 'go.sum', 'tsconfig.json', 'makefile', 'gemfile', 'gemfile.lock']);
const PLACEHOLDER_TARGET = /^(?:[A-Z][A-Z0-9_ -]*|url|link|href|path|target|file|filename|todo|tbd)$/i;
/** "Run X when it is on disk, else Y" - optional files should not be reported missing. */
const CONDITIONAL = /\b(?:if|when|whether)\b(?:[^.\n]|\.(?=\S)){0,100}?\b(?:exists?|present|on disk|available|installed)\b|\bif (?:it|this|the file) (?:is )?there\b/i;
const TREE_LINE = /[│├└]|^\s*[|`+]--/;
const BARE_FILE = /(?<![\p{L}\p{N}_/.\\-])([\p{L}\p{N}_][\p{L}\p{N}_.-]*\.(?:md|markdown|txt|py|sh|js|mjs|cjs|ts|json|ya?ml|html|xml|xsd|csv))(?![\p{L}\p{N}_/\\-])/gu;
const GUESS_EXTS = ['.py', '.sh', '.js', '.mjs', '.ts', '.md'];

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function referenceRules(skill: ParsedSkill, fs: FsLike = nodeFsLike): ReferenceResult {
  const findings: Finding[] = [];
  const root = skill.dir;
  const walked = walkSkillFiles(root, fs);
  const all = walked.files;
  const topDirs = new Set(all.filter((p) => p.includes('/')).map((p) => p.split('/')[0]!));
  const mentionSegs = new Set([...RESOURCE_DIRS, ...topDirs]);
  const referenced = new Set<string>();
  const referencedDirs = new Set<string>();
  const reported = new Set<string>();
  const slugCache = new Map<string, Set<string>>();
  const corpus: string[] = [skill.text];
  for (const is of walked.issues) {
    if (is.kind === 'outside') findings.push(f('link-outside-skill', 'info', `${is.path} is a symlink/junction to a folder outside the skill; it is not scanned and will be missing when the skill is copied or installed on its own.`, path.join(root, is.path), undefined, root));
    else findings.push(f('path-skipped', 'info', `${is.path}: ${is.reason}; not scanned.`, path.join(root, is.path), undefined, root));
  }
  // Links can leave the skill through a symlink/junction while the path stays lexically inside.
  const guard = new VisitedDirs(fs);
  const realRoot = guard.real(root);
  const escapes = (abs: string): boolean => {
    if (!isWithin(root, abs)) return true;
    if (realRoot === null) return false;
    const real = guard.real(abs);
    return real !== null && !isWithin(realRoot, real);
  };

  const report = (key: string, fd: Finding) => {
    if (reported.has(key)) return;
    reported.add(key);
    findings.push(fd);
  };
  const slugsOf = (abs: string): Set<string> => {
    let s = slugCache.get(abs);
    if (!s) {
      s = headingSlugs(readText(abs, fs) ?? '');
      slugCache.set(abs, s);
    }
    return s;
  };
  const relOf = (abs: string) => toPosix(path.relative(root, abs));

  interface Doc { abs: string; text: string; firstLine: number; depth: number }
  const queue: Doc[] = [{ abs: skill.file, text: skill.body, firstLine: skill.bodyStartLine, depth: 0 }];
  const visited = new Set<string>([skill.file]);

  const markRef = (abs: string, depth: number) => {
    if (escapes(abs)) return; // never read files outside the skill
    const rel = relOf(abs);
    let isDir = false;
    try {
      isDir = fs.statSync(abs).isDirectory();
    } catch {
      return;
    }
    if (isDir) {
      referencedDirs.add(rel.replace(/\/$/, ''));
      return;
    }
    referenced.add(rel);
    // Reached through an in-skill alias link: also mark the file under its real path.
    const real = realRoot !== null ? guard.real(abs) : null;
    if (real !== null && realRoot !== null && isWithin(realRoot, real)) referenced.add(toPosix(path.relative(realRoot, real)));
    if (visited.has(abs)) return;
    visited.add(abs);
    if (TEXT_EXTENSIONS.has(path.extname(abs).toLowerCase())) {
      const text = readText(abs, fs);
      if (text !== null) {
        corpus.push(text);
        queue.push({ abs, text, firstLine: 1, depth: depth + 1 });
        if (depth + 1 >= 2) {
          findings.push(f('nested-reference', 'info', `${rel} is only reachable through another reference file (depth ${depth + 1}); the spec recommends keeping references one level deep from SKILL.md.`, abs, undefined, root));
        }
      }
    }
  };
  /**
   * Resolve a relative path against the document dir, then the skill root. `exact` and
   * `caseHit` are always the on-disk spelling (see resolveCase).
   */
  const resolve = (docDir: string, rel: string, docFirst = true): { exact?: string; caseHit?: string } => {
    const c = docFirst ? [path.resolve(docDir, rel), path.resolve(root, rel)] : [path.resolve(root, rel), path.resolve(docDir, rel)];
    const res = [...new Set(c)].map((x) => resolveCase(root, x, fs));
    const exact = res.find((r) => r.status === 'exact')?.actual;
    if (exact) return { exact };
    return { caseHit: res.find((r) => r.status === 'case')?.actual };
  };

  // Wrong-case link targets already reported as broken-link (one finding per mistake).
  const caseLinked = new Set<string>();
  while (queue.length > 0) {
    const doc = queue.shift()!;
    const docDir = path.dirname(doc.abs);
    const docRel = relOf(doc.abs);
    const isRoot = doc.abs === skill.file;
    const lines = doc.text.split('\n');
    const lineText = (n: number) => lines[n - doc.firstLine] ?? '';

    for (const link of extractLinks(doc.text, doc.firstLine)) {
      const t = classifyTarget(link.target);
      if (t.kind === 'skip') continue;
      if (t.kind === 'absolute') {
        report(`abs:${doc.abs}:${link.line}:${t.raw}`, f('absolute-path', 'warning', `Link uses an absolute path "${t.raw}"; use a path relative to the skill folder so it works on other machines.`, doc.abs, link.line, root));
        continue;
      }
      if (t.kind === 'fragment') {
        if (t.fragment && /\.(md|markdown)$/i.test(doc.abs) && !slugsOf(doc.abs).has(decodeFragment(t.fragment))) {
          report(`anchor:${doc.abs}:${link.line}:${t.fragment}`, f('broken-anchor', 'warning', `Link "#${t.fragment}" does not match any heading in ${docRel}.`, doc.abs, link.line, root));
        }
        continue;
      }
      if (PLACEHOLDER_TARGET.test(t.rel) || /(^|\/)path\/to\//i.test(t.rel)) continue;
      if (t.backslash) {
        report(`bs:${doc.abs}:${link.line}:${t.rel}`, f('windows-path-separator', 'warning', `Link "${link.target}" uses backslashes; use forward slashes ("${t.rel}") so it resolves on every OS.`, doc.abs, link.line, root));
      }
      const { exact, caseHit } = resolve(docDir, t.rel);
      if (!exact) {
        const hint = caseHit ? ` (${relOf(caseHit)} exists with different letter case; paths are case-sensitive on Linux)` : '';
        report(`link:${doc.abs}:${link.line}:${t.rel}`, f('broken-link', 'error', `Link target "${t.rel}" does not exist${hint}.`, doc.abs, link.line, root));
        if (caseHit) {
          caseLinked.add(`${doc.abs}\0${caseHit}`);
          markRef(caseHit, doc.depth);
        }
        continue;
      }
      if (escapes(exact)) {
        const via = isWithin(root, exact) ? ' through a symlink/junction' : '';
        report(`out:${doc.abs}:${exact}`, f('reference-outside-skill', 'warning', `Link "${t.rel}" points outside the skill folder${via}; it will be missing when the skill is installed on its own.`, doc.abs, link.line, root));
        continue;
      }
      markRef(exact, doc.depth);
      if (t.fragment && /\.(md|markdown)$/i.test(exact) && !slugsOf(exact).has(decodeFragment(t.fragment))) {
        report(`anchor:${doc.abs}:${link.line}:${t.fragment}`, f('broken-anchor', 'warning', `Link "${t.rel}#${t.fragment}" - no heading "${t.fragment}" in ${relOf(exact)}.`, doc.abs, link.line, root));
      }
    }

    // Bare mentions of resource paths: `python scripts/fill.py`, references\api.md, ...
    for (const m of extractPathMentions(doc.text, mentionSegs, doc.firstLine, { caseInsensitive: true })) {
      const rel = toPosix(m.path).replace(/\/$/, '');
      const { exact, caseHit } = resolve(docDir, rel, false);
      if (exact && escapes(exact)) {
        report(`out:${doc.abs}:${exact}`, f('reference-outside-skill', 'warning', `"${m.path}" resolves outside the skill folder through a symlink/junction; it will be missing when the skill is installed on its own.`, doc.abs, m.line, root));
        continue;
      }
      if (exact) {
        if (m.path.includes('\\')) {
          report(`bs:${doc.abs}:${m.line}:${rel}`, f('windows-path-separator', 'warning', `Path "${m.path}" uses backslashes; use "${rel}" so it works on Linux/macOS.`, doc.abs, m.line, root));
        }
        markRef(exact, doc.depth);
        continue;
      }
      const line = lineText(m.line);
      if (caseHit) {
        if (caseLinked.has(`${doc.abs}\0${caseHit}`)) continue;
        report(`case:${doc.abs}:${rel}`, f('path-case-mismatch', 'warning', `"${m.path}" is mentioned but the file is ${relOf(caseHit)} (letter case differs; fails on case-sensitive filesystems).`, doc.abs, m.line, root));
        markRef(caseHit, doc.depth);
        continue;
      }
      // Only complain when the folder is part of this skill; otherwise the mention is
      // usually illustrative ("create scripts/foo.py in your project").
      if (!topDirs.has(rel.split('/')[0]!)) continue;
      if (m.inCode && !isRoot) continue; // code samples in reference files often show the user's project
      if (TREE_LINE.test(line) || CONDITIONAL.test(line)) continue;
      const hasExt = /\.[A-Za-z0-9]{1,8}$/.test(rel);
      if (!hasExt) {
        const guess = GUESS_EXTS.map((e) => resolve(docDir, rel + e, false).exact).find(Boolean);
        if (guess) {
          report(`mention:${doc.abs}:${rel}`, f('missing-file', 'warning', `"${m.path}" is mentioned but does not exist; did you mean ${relOf(guess)}?`, doc.abs, m.line, root));
          markRef(guess, doc.depth);
        }
        continue;
      }
      report(`mention:${doc.abs}:${rel}`, f('missing-file', 'warning', `"${m.path}" is mentioned but does not exist in the skill folder.`, doc.abs, m.line, root));
    }

    // Bare file names next to the document ("see REFERENCE.md"): only matched case-insensitively
    // against real files, so mentions of the user's own files are never reported.
    for (const l of doc.text.split('\n').map((t, i) => ({ t, n: doc.firstLine + i }))) {
      for (const m of l.t.matchAll(BARE_FILE)) {
        const name = m[1]!;
        const { exact, caseHit } = resolve(docDir, name);
        if (exact) markRef(exact, doc.depth);
        else if (caseHit && isWithin(root, caseHit) && !caseLinked.has(`${doc.abs}\0${caseHit}`)) {
          report(`case:${doc.abs}:${name}`, f('path-case-mismatch', 'warning', `"${name}" is mentioned but the file is ${relOf(caseHit)} (letter case differs; fails on case-sensitive filesystems).`, doc.abs, l.n, root));
          markRef(caseHit, doc.depth);
        }
      }
    }
  }

  // ---- Orphans: fixpoint over the text of everything reachable (code included,
  // so helpers imported by referenced scripts count as referenced).
  const isExempt = (rel: string): boolean => {
    const base = rel.split('/').pop()!;
    return (
      rel === skill.fileName ||
      EXEMPT_ORPHAN.test(base) ||
      MANIFEST_FILES.has(base.toLowerCase()) ||
      TEST_FILE_NAMES.includes(rel) ||
      rel.startsWith('evals/') ||
      base === '__init__.py' ||
      base.endsWith('.pyc')
    );
  };
  for (const rel of referenced) {
    const ext = path.extname(rel).toLowerCase();
    if (CODE_EXTENSIONS.has(ext)) {
      const text = readText(path.join(root, rel), fs);
      if (text) corpus.push(text);
    }
  }
  const dirMentioned = (d: string, blob: string): boolean => {
    if (referencedDirs.has(d)) return true;
    const e = escapeRe(d);
    // Explicit directory reference: "scripts/" or "./scripts" not followed by more path.
    if (new RegExp(`(?:^|[^\\w/.-])(?:\\./)?${e}(?:/(?![\\w.-])|(?![\\w/.-]))`, 'm').test(blob) && (!GENERIC_DIRS.has(d) || new RegExp(`(?:\\./)?${e}/(?![\\w.-])|\\./${e}(?![\\w/.-])`).test(blob))) return true;
    return false;
  };
  const codeMentioned = (rel: string, blob: string): boolean => {
    const ext = path.extname(rel).toLowerCase();
    if (!CODE_EXTENSIONS.has(ext)) return false;
    const noExt = rel.slice(0, rel.length - ext.length);
    const segs = noExt.split('/');
    const stem = segs[segs.length - 1]!;
    if (stem.length < 3) return false;
    // Python dotted import paths (core.gif_builder) and `from x import stem`.
    for (let i = 0; i < segs.length - 1; i++) {
      if (new RegExp(`(?<![\\w.])${escapeRe(segs.slice(i).join('.'))}(?![\\w])`).test(blob)) return true;
    }
    if (new RegExp(`\\b(?:import|from)\\s+(?:\\.+)?(?:[\\w.]+\\.)?${escapeRe(stem)}\\b|\\bimport\\s+[^\\n]*\\b${escapeRe(stem)}\\b`).test(blob)) return true;
    // JS/TS relative imports: './stem', '../dir/stem.js'
    if (new RegExp(`['"][./\\w-]*/${escapeRe(stem)}(?:\\.\\w+)?['"]`).test(blob)) return true;
    return false;
  };
  // Package rule: once a code file inside a nested folder (scripts/office/...) is used,
  // the rest of that folder is its implementation (helpers, schemas, data).
  const packageDirs = (): string[] =>
    [...referenced]
      .filter((r) => CODE_EXTENSIONS.has(path.extname(r).toLowerCase()) && r.split('/').length >= 3)
      .map((r) => r.split('/').slice(0, -1).join('/'));
  let changed = true;
  while (changed) {
    changed = false;
    const blob = corpus.join('\n');
    for (const rel of all) {
      if (referenced.has(rel) || isExempt(rel)) continue;
      const base = rel.split('/').pop()!;
      const parts = rel.split('/');
      const ancestors = parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join('/'));
      const pkgs = packageDirs();
      const mentioned = pkgs.some((d) => rel.startsWith(d + '/')) || blob.includes(rel) || containsWord(blob, base) || ancestors.some((d) => dirMentioned(d, blob)) || codeMentioned(rel, blob);
      if (mentioned) {
        referenced.add(rel);
        const text = readText(path.join(root, rel), fs);
        if (text) corpus.push(text);
        changed = true;
      }
    }
  }
  for (const rel of all) {
    if (referenced.has(rel) || isExempt(rel)) continue;
    findings.push(f('orphan-file', 'warning', `${rel} is not referenced from SKILL.md (or any file it references); agents will not know it exists.`, path.join(root, rel), undefined, root));
  }

  const scripts = all.filter((rel) => SCRIPT_EXTENSIONS.has(path.extname(rel).toLowerCase()) && (rel.startsWith('scripts/') || referenced.has(rel)));
  return { findings, referenced, scripts };
}

function decodeFragment(fr: string): string {
  try {
    return decodeURIComponent(fr).toLowerCase();
  } catch {
    return fr.toLowerCase();
  }
}

function containsWord(blob: string, word: string): boolean {
  if (word.length < 3) return false;
  let idx = blob.indexOf(word);
  while (idx >= 0) {
    const before = blob[idx - 1] ?? ' ';
    const after = blob[idx + word.length] ?? ' ';
    if (!/[\p{L}\p{N}_]/u.test(before) && !/[\p{L}\p{N}_]/u.test(after)) return true;
    idx = blob.indexOf(word, idx + 1);
  }
  return false;
}

export function testFileRules(skill: ParsedSkill): Finding[] {
  const file = findTestFile(skill.dir);
  if (!file) return [];
  try {
    parseTestFile(file);
    return [];
  } catch (e) {
    const msg = e instanceof TestFileError ? e.message : (e as Error).message;
    return [f('trigger-file-invalid', 'error', `Trigger test file is invalid: ${msg}`, file, undefined, skill.dir)];
  }
}

/** Lint one parsed skill. */
export function lintSkill(skill: ParsedSkill, options: Partial<LintOptions> = {}): Finding[] {
  const opts: LintOptions = { ...DEFAULT_LINT_OPTIONS, ...options };
  const out: Finding[] = [...skill.parseFindings];
  out.push(...fileLevelRules(skill, opts));
  out.push(...nameRules(skill, opts.fs));
  out.push(...descriptionRules(skill));
  out.push(...otherFieldRules(skill, opts));
  const refs = referenceRules(skill, opts.fs);
  out.push(...refs.findings);
  out.push(...checkScripts(refs.scripts.map((r) => path.join(skill.dir, r)), skill.dir, { exec: opts.execChecks, platform: opts.platform, untrusted: opts.untrustedDirs, lookup: opts.lookup, spawn: opts.spawn }));
  out.push(...testFileRules(skill));
  return aggregateCrlf(out.filter((x) => !opts.disable.has(x.code)));
}

/** Checks that need the whole catalog (e.g. duplicate names). */
export function lintCatalog(skills: ParsedSkill[], options: Partial<LintOptions> = {}): Finding[] {
  const disable = options.disable ?? new Set<string>();
  const out: Finding[] = [];
  const byName = new Map<string, ParsedSkill[]>();
  for (const s of skills) {
    if (!s.name) continue;
    const list = byName.get(s.name) ?? [];
    list.push(s);
    byName.set(s.name, list);
  }
  for (const [name, list] of byName) {
    if (list.length < 2) continue;
    for (const s of list) {
      const others = list.filter((o) => o !== s).map((o) => toPosix(path.relative(path.dirname(s.dir), o.dir)));
      out.push(f('duplicate-name', 'error', `Skill name "${name}" is also used by ${others.join(', ')}; clients will load only one of them.`, s.file, s.fieldLines.name, s.dir));
    }
  }
  return out.filter((x) => !disable.has(x.code));
}

/**
 * Collapse every per-file `crlf-line-endings` finding into ONE info finding.
 *
 * CRLF in a working tree is normal on Windows (git's default core.autocrlf=true converts
 * LF files on checkout), so it is never a warning: loaders and Python handle it, and what
 * matters on Linux/macOS is how the file is stored in git, which the working tree cannot tell.
 */
export function aggregateCrlf(findings: Finding[]): Finding[] {
  const crlf = findings.filter((x) => x.code === 'crlf-line-endings');
  if (crlf.length === 0) return findings;
  const files = [...new Set(crlf.flatMap((x) => x.files ?? (x.file ? [x.file] : [])))];
  const first = crlf[0]!;
  const label = (file: string) => {
    const owner = crlf.find((x) => x.skillDir && isWithin(x.skillDir, file))?.skillDir;
    return toPosix(owner ? path.relative(path.dirname(owner), file) : path.basename(file));
  };
  const shown = files.slice(0, 3).map(label);
  const n = files.length;
  const merged: Finding = {
    code: 'crlf-line-endings',
    severity: 'info',
    message: `${n} ${n === 1 ? 'file uses' : 'files use'} CRLF line endings (${shown.join(', ')}${n > shown.length ? ', ...' : ''}). This is normal on Windows with git core.autocrlf; scripts only break on Linux/macOS if they are committed with CRLF (check with: git ls-files --eol).`,
    // Attached to a skill only when every file belongs to it; otherwise it is a run-wide note.
    skillDir: crlf.every((x) => x.skillDir === first.skillDir) ? first.skillDir : undefined,
    files,
  };
  const out: Finding[] = [];
  for (const x of findings) {
    if (x.code !== 'crlf-line-endings') out.push(x);
    else if (x === first) out.push(merged);
  }
  return out;
}
