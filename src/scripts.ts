import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { findExecutable, findGit, gitForWindowsDirs, neutralCwd, withDefaults, type ExeLookup } from './exe.js';
import type { Finding } from './types.js';

/**
 * Static checks for helper scripts. Scripts are NEVER executed: Python is parsed with
 * `ast.parse`, shell with `bash -n`, JavaScript with `node --check`.
 */

export const SCRIPT_EXTENSIONS = new Set(['.py', '.sh', '.bash', '.js', '.mjs', '.cjs']);

/** Minimal spawnSync surface (injectable so Windows behaviour can be tested anywhere). */
export type SpawnLike = (cmd: string, args: string[], opts: { encoding?: 'utf8'; stdio?: 'ignore'; timeout?: number; maxBuffer?: number; cwd?: string }) => { status: number | null; stdout?: string | Buffer | null; stderr?: string | Buffer | null };

// Always an absolute command (see exe.ts), never a shell, and run from a neutral folder.
const realSpawn: SpawnLike = (cmd, args, opts) => spawnSync(cmd, args, { cwd: neutralCwd(), ...opts, shell: false, windowsHide: true });
const availability = new WeakMap<SpawnLike, Map<string, boolean>>();
function hasCommand(spawn: SpawnLike, cmd: string, args: string[]): boolean {
  let cache = availability.get(spawn);
  if (!cache) availability.set(spawn, (cache = new Map()));
  const key = `${cmd}\u0000${args.join('\u0000')}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  const r = spawn(cmd, args, { stdio: 'ignore', timeout: 10000, cwd: neutralCwd() });
  const ok = r.status === 0;
  cache.set(key, ok);
  return ok;
}

/** WSL launchers that receive Windows paths they cannot open (System32\bash.exe, WindowsApps). */
const WSL_BASH = /\\(?:system32|sysnative|windowsapps)\\bash\.exe$/i;

/**
 * The bash to use for `bash -n` (an absolute path), or null with a reason.
 *
 * Only trusted locations are searched (absolute PATH entries outside the cwd and the
 * linted folders, then the Git for Windows install folders), never the current directory:
 * a repo being linted must not be able to plant a `bash`/`bash.exe` that gets run.
 * On Windows the WSL launcher is skipped: it would get a C:\ path it cannot open and
 * report every script as broken; only a native bash (Git Bash, MSYS2, Cygwin) is used.
 */
export function findBash(platform: NodeJS.Platform, spawn: SpawnLike, lookup?: Partial<ExeLookup>, untrusted: string[] = []): { cmd: string | null; reason?: string } {
  const l = withDefaults({ ...lookup, platform }, untrusted);
  if (platform !== 'win32') {
    const cmd = findExecutable('bash', l);
    return cmd && hasCommand(spawn, cmd, ['-c', 'exit 0']) ? { cmd } : { cmd: null, reason: 'bash not available' };
  }
  let sawWsl = false;
  const cmd = findExecutable('bash', l, {
    extraDirs: gitForWindowsDirs(l),
    accept: (p) => {
      if (WSL_BASH.test(p)) {
        sawWsl = true;
        return false;
      }
      return hasCommand(spawn, p, ['-c', 'exit 0']);
    },
  });
  if (cmd) return { cmd };
  return { cmd: null, reason: sawWsl ? 'only the WSL bash launcher was found (install Git Bash to check shell scripts on Windows)' : 'bash not available' };
}

/** python3 / python (absolute path) that can run the checker in isolated mode, or null. */
export function findPython(platform: NodeJS.Platform, spawn: SpawnLike, lookup?: Partial<ExeLookup>, untrusted: string[] = []): string | null {
  const l = withDefaults({ ...lookup, platform }, untrusted);
  for (const name of ['python3', 'python']) {
    // The WindowsApps python.exe "app execution alias" only opens the Store; its probe fails.
    const cmd = findExecutable(name, l, { accept: (p) => hasCommand(spawn, p, ['-I', '-c', 'import ast']) });
    if (cmd) return cmd;
  }
  return null;
}

export interface ScriptCheckOptions {
  /** Spawn parsers (python3, bash, node). When false only file-mode checks run. */
  exec: boolean;
  platform?: NodeJS.Platform;
  spawn?: SpawnLike;
  /** Executable lookup (PATH, cwd, ...); injectable for tests. */
  lookup?: Partial<ExeLookup>;
  /** Folders that must never provide an executable (the linted paths). The skill folder always counts. */
  untrusted?: string[];
}

const PY_CHECKER = String.raw`
import ast, json, sys
out = []
for p in sys.argv[1:]:
    try:
        with open(p, 'rb') as fh:
            src = fh.read()
        ast.parse(src, p)
        out.append(None)
    except SyntaxError as e:
        out.append({"line": e.lineno or 1, "msg": e.msg})
    except Exception as e:
        out.append({"line": 1, "msg": str(e)})
print(json.dumps(out))
`;

export function checkScripts(files: string[], skillDir: string, opts: ScriptCheckOptions): Finding[] {
  const findings: Finding[] = [];
  const skipped = new Map<string, string>();
  const py: string[] = [];
  const platform = opts.platform ?? process.platform;
  const spawn = opts.spawn ?? realSpawn;
  let bash: { cmd: string | null; reason?: string } | undefined;
  const untrusted = [skillDir, ...(opts.untrusted ?? [])];
  const crlfScripts: string[] = [];
  for (const file of files) {
    const ext = path.extname(file).toLowerCase();
    let content: string;
    try {
      content = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const hasShebang = content.startsWith('#!');
    if (hasShebang && platform !== 'win32') {
      const mode = statSync(file).mode;
      if ((mode & 0o111) === 0) {
        findings.push({
          code: 'script-not-executable',
          severity: 'info',
          message: `Script has a shebang but is not executable (chmod +x ${path.basename(file)}).`,
          file,
          line: 1,
          skillDir,
        });
      }
    }
    if ((ext === '.sh' || ext === '.bash') && !hasShebang) {
      findings.push({ code: 'script-missing-shebang', severity: 'info', message: 'Shell script has no shebang line (e.g. #!/usr/bin/env bash).', file, line: 1, skillDir });
    }
    if (/\r\n/.test(content) && (ext === '.sh' || ext === '.bash' || hasShebang)) {
      findings.push({ code: 'crlf-line-endings', severity: 'info', message: 'CRLF line endings.', file, line: 1, skillDir });
      crlfScripts.push(file);
    }
    if (!opts.exec) continue;
    if (ext === '.py') {
      py.push(file);
    } else if (ext === '.sh' || ext === '.bash') {
      bash ??= findBash(platform, spawn, opts.lookup, untrusted);
      if (!bash.cmd) {
        skipped.set('bash', bash.reason ?? 'bash not available');
        continue;
      }
      // With CRLF (normal on Windows checkouts) bash -n reports $'\r' errors that are not real.
      const target = /\r\n/.test(content) ? lfCopy(content) : null;
      let r;
      try {
        r = spawn(bash.cmd, ['-n', target?.file ?? file], { encoding: 'utf8', timeout: 20000 });
      } finally {
        target?.cleanup();
      }
      const stderr = String(r.stderr ?? '');
      if (r.status !== 0 && /No such file or directory|cannot open|cannot execute/i.test(stderr)) {
        skipped.set('bash', `${bash.cmd} could not open the script (${stderr.trim().split('\n')[0]})`);
      } else if (r.status !== 0) {
        const msg = stderr.trim().split('\n')[0] ?? 'syntax error';
        const lm = /line (\d+)/.exec(msg);
        findings.push({ code: 'script-syntax-error', severity: 'error', message: `bash -n: ${msg.replace(/^.*?: line \d+: /, '')}`, file, line: lm ? Number(lm[1]) : 1, skillDir });
      }
    } else if (ext === '.js' || ext === '.mjs' || ext === '.cjs') {
      const err = nodeCheck(file, ext);
      if (err) findings.push({ code: 'script-syntax-error', severity: 'error', message: `node --check: ${err.msg}`, file, line: err.line, skillDir });
    }
  }
  if (py.length > 0) {
    const pyCmd = findPython(platform, spawn, opts.lookup, untrusted);
    if (!pyCmd) {
      skipped.set('python3', 'python3 not available');
    } else {
      // -I: isolated mode, so modules planted next to the scripts or in the cwd
      // (ast.py, json.py) and PYTHON* variables are never picked up.
      const r = spawn(pyCmd, ['-I', '-c', PY_CHECKER, ...py], { encoding: 'utf8', timeout: 60000, maxBuffer: 16 * 1024 * 1024 });
      try {
        const res = JSON.parse(String(r.stdout ?? '')) as ({ line: number; msg: string } | null)[];
        res.forEach((e, i) => {
          if (e) findings.push({ code: 'script-syntax-error', severity: 'error', message: `Python syntax error: ${e.msg}`, file: py[i], line: e.line, skillDir });
        });
      } catch {
        skipped.set('python3', 'python3 output could not be read');
      }
    }
  }
  if (opts.exec && crlfScripts.length > 0) findings.push(...committedCrlf(crlfScripts, skillDir, spawn, opts.lookup, untrusted));
  for (const [, reason] of skipped) {
    findings.push({ code: 'script-check-skipped', severity: 'info', message: `${reason}; syntax of some scripts was not checked.`, skillDir });
  }
  return findings;
}

/**
 * A CRLF working-tree file is normal on Windows (core.autocrlf). What breaks Linux/macOS
 * is a script *committed* with CRLF; git's index tells (`git ls-files --eol`: i/crlf).
 * Outside a git work tree, or without a trusted git, nothing is reported.
 */
function committedCrlf(files: string[], skillDir: string, spawn: SpawnLike, lookup: Partial<ExeLookup> | undefined, untrusted: string[]): Finding[] {
  const git = findGit(lookup, untrusted);
  if (!git) return [];
  const r = spawn(git, ['-c', 'core.fsmonitor=false', '-C', skillDir, 'ls-files', '--eol', '-z', '--', ...files], { encoding: 'utf8', timeout: 20000, maxBuffer: 16 * 1024 * 1024 });
  if (r.status !== 0) return [];
  const out: Finding[] = [];
  for (const rec of String(r.stdout ?? '').split('\0')) {
    const m = /^i\/(\S*)\s+w\/\S*\s+attr\/.*?\t(.+)$/s.exec(rec);
    if (!m || (m[1] !== 'crlf' && m[1] !== 'mixed')) continue;
    const file = path.resolve(skillDir, m[2]!);
    out.push({
      code: 'script-crlf-committed',
      severity: 'warning',
      message: `Script is committed to git with ${m[1] === 'mixed' ? 'mixed' : 'CRLF'} line endings; it fails on Linux/macOS ("/usr/bin/env: 'bash\\r'"). Convert it to LF (and add "*.sh text eol=lf" to .gitattributes).`,
      file,
      line: 1,
      skillDir,
    });
  }
  return out;
}

function lfCopy(content: string): { file: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), 'triggerspec-'));
  const file = path.join(dir, 'check.sh');
  writeFileSync(file, content.replace(/\r\n/g, '\n'));
  return { file, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function parseNodeErr(stderr: string): { line: number; msg: string } {
  const lines = stderr.split('\n');
  const loc = /:(\d+)\s*$/.exec(lines[0] ?? '');
  const msg = lines.find((l) => /Error:/.test(l))?.trim() ?? 'syntax error';
  return { line: loc ? Number(loc[1]) : 1, msg };
}

function nodeCheck(file: string, ext: string): { line: number; msg: string } | null {
  // process.execPath is the running node itself, so no lookup is involved.
  const run = (f: string) => spawnSync(process.execPath, ['--check', f], { encoding: 'utf8', timeout: 20000, cwd: neutralCwd(), shell: false, windowsHide: true });
  const r = run(file);
  if (r.status === 0) return null;
  if (ext === '.js') {
    // A .js file may be an ES module (package "type": "module" elsewhere). Retry as .mjs.
    const dir = mkdtempSync(path.join(tmpdir(), 'triggerspec-'));
    try {
      const copy = path.join(dir, 'check.mjs');
      copyFileSync(file, copy);
      if (run(copy).status === 0) return null;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  return parseNodeErr(r.stderr || '');
}
