import { accessSync, constants, realpathSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

/**
 * Trusted executable lookup.
 *
 * triggerspec is run inside repositories it has not vetted (`triggerspec lint .` on a
 * freshly cloned skills repo). Letting the OS resolve a bare command name is unsafe there:
 * Windows (`where`, CreateProcess, libuv) searches the current directory, and empty, `.`
 * or relative PATH entries point into the repo on every OS. A planted `bash.exe`,
 * `python.exe` or `git.exe` would then be executed.
 *
 * So every executable triggerspec spawns is resolved here, to an absolute path, from:
 * - absolute PATH entries only (empty, `.`, relative and `~` entries are ignored);
 * - minus any entry, or candidate whose real path is, inside the current directory or
 *   inside a folder being linted (`untrusted`);
 * - plus a few well-known install locations (Git for Windows).
 * Callers must spawn the returned absolute path, without a shell.
 */
export interface ExeLookup {
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
  cwd: string;
  /** Folders whose contents must never provide an executable (the linted skills/repo). */
  untrusted: string[];
  /** True when `p` is an existing regular file the current user may execute. */
  isExecutable(p: string): boolean;
  /** Real path of `p` (symlinks resolved); return `p` when it cannot be resolved. */
  realpath(p: string): string;
}

function defaultIsExecutable(p: string): boolean {
  try {
    if (!statSync(p).isFile()) return false;
    if (process.platform !== 'win32') accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function defaultRealpath(p: string): string {
  try {
    return realpathSync.native(p);
  } catch {
    return p;
  }
}

export function defaultLookup(untrusted: string[] = []): ExeLookup {
  return { platform: process.platform, env: process.env, cwd: process.cwd(), untrusted, isExecutable: defaultIsExecutable, realpath: defaultRealpath };
}

export function withDefaults(l: Partial<ExeLookup> | undefined, untrusted: string[] = []): ExeLookup {
  const base = defaultLookup();
  return { ...base, ...l, untrusted: [...untrusted, ...(l?.untrusted ?? [])] };
}

const pathFor = (platform: NodeJS.Platform) => (platform === 'win32' ? path.win32 : path.posix);
/** NTFS and APFS are case-insensitive by default; compare paths accordingly there. */
const foldFor = (platform: NodeJS.Platform) => (platform === 'win32' || platform === 'darwin' ? (s: string) => s.toLowerCase() : (s: string) => s);

function envVar(env: Record<string, string | undefined>, name: string, platform: NodeJS.Platform): string | undefined {
  if (platform !== 'win32') return env[name];
  const key = Object.keys(env).find((k) => k.toUpperCase() === name.toUpperCase());
  return key === undefined ? undefined : env[key];
}

/** True when `p` is `dir` or inside it (lexically, on `platform`'s path rules). */
function within(dir: string, p: string, platform: NodeJS.Platform): boolean {
  const P = pathFor(platform);
  const fold = foldFor(platform);
  const rel = P.relative(fold(P.resolve(dir)), fold(P.resolve(p)));
  return rel === '' || (!rel.startsWith('..') && !P.isAbsolute(rel));
}

/** Untrusted roots; a filesystem root as cwd (e.g. running from C:\ or /) is not treated as "inside the repo". */
function untrustedRoots(l: ExeLookup): string[] {
  const P = pathFor(l.platform);
  const roots = [l.cwd, ...l.untrusted].filter((d) => d && P.isAbsolute(d) && P.parse(P.resolve(d)).root !== P.resolve(d));
  return [...new Set(roots.flatMap((d) => [d, l.realpath(d)]))];
}

/** The absolute PATH directories that may provide executables. */
export function trustedPathDirs(l: ExeLookup): string[] {
  const P = pathFor(l.platform);
  const raw = envVar(l.env, 'PATH', l.platform) ?? '';
  const bad = untrustedRoots(l);
  const out: string[] = [];
  for (let entry of raw.split(l.platform === 'win32' ? ';' : ':')) {
    entry = entry.trim();
    if (l.platform === 'win32') entry = entry.replace(/^"(.*)"$/, '$1');
    if (!entry || entry === '.' || !P.isAbsolute(entry)) continue;
    // `\foo` is "absolute" for path.win32 but relative to the current drive: not trusted.
    if (l.platform === 'win32' && !/^[a-zA-Z]:[\\/]|^\\\\[^\\]/.test(entry)) continue;
    if (bad.some((b) => within(b, entry, l.platform) || within(b, l.realpath(entry), l.platform))) continue;
    if (!out.includes(entry)) out.push(entry);
  }
  return out;
}

/** Well-known Git for Windows locations (bash.exe, git.exe), tried after PATH. */
export function gitForWindowsDirs(l: ExeLookup): string[] {
  const P = path.win32;
  const pf = [envVar(l.env, 'ProgramFiles', 'win32'), envVar(l.env, 'ProgramW6432', 'win32'), envVar(l.env, 'ProgramFiles(x86)', 'win32'), 'C:\\Program Files'];
  const local = envVar(l.env, 'LOCALAPPDATA', 'win32');
  const roots = [...pf.filter((x): x is string => !!x).map((x) => P.join(x, 'Git')), ...(local ? [P.join(local, 'Programs', 'Git')] : [])];
  return [...new Set(roots.flatMap((r) => [P.join(r, 'bin'), P.join(r, 'usr', 'bin'), P.join(r, 'cmd')]))];
}

/**
 * Absolute path of the first trusted `name` (without extension; `.exe` is added on
 * Windows), or null. `accept` can reject a candidate (e.g. the WSL bash launcher).
 */
export function findExecutable(name: string, l: ExeLookup, opts: { extraDirs?: string[]; accept?: (p: string) => boolean } = {}): string | null {
  const P = pathFor(l.platform);
  const file = l.platform === 'win32' && !/\.exe$/i.test(name) ? `${name}.exe` : name;
  const bad = untrustedRoots(l);
  const dirs = [...trustedPathDirs(l), ...(opts.extraDirs ?? []).filter((d) => P.isAbsolute(d))];
  for (const dir of dirs) {
    const cand = P.join(dir, file);
    if (!l.isExecutable(cand)) continue;
    const real = l.realpath(cand);
    // A trusted-looking PATH entry may hold a symlink into the repo; never follow it there.
    if (bad.some((b) => within(b, cand, l.platform) || within(b, real, l.platform))) continue;
    if (opts.accept && !opts.accept(cand)) continue;
    return cand;
  }
  return null;
}

/**
 * Working directory for helper processes: never the (possibly untrusted) cwd, so nothing
 * there is picked up as a module (`python -c` puts the cwd on sys.path) or as a DLL.
 */
export function neutralCwd(): string {
  return tmpdir();
}

/** Absolute path of a trusted `git`, or null. */
export function findGit(lookup?: Partial<ExeLookup>, untrusted: string[] = []): string | null {
  const l = withDefaults(lookup, untrusted);
  return findExecutable('git', l, { extraDirs: l.platform === 'win32' ? gitForWindowsDirs(l) : [] });
}
