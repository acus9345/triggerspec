/**
 * Regression tests for the Windows/macOS reviews (round 1: H1, H2, M1-M3, Lows; round 2: H-N1, M-N2, L-N3..L-N7).
 * Platform behaviour is simulated with injectable fs / platform / spawn so these run
 * (and mean the same thing) on Linux, macOS and Windows CI runners.
 */
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadCatalog } from '../src/catalog.js';
import { diffCatalogs } from '../src/diff.js';
import { discoverSkills } from '../src/discover.js';
import { trustedPathDirs, withDefaults, type ExeLookup } from '../src/exe.js';
import { nodeFsLike, resolveCase, type FsLike } from '../src/fsx.js';
import { aggregateCrlf, lintSkill, MAX_SKILL_DEPTH, referenceRules, walkSkillFiles } from '../src/lint.js';
import { run } from '../src/main.js';
import { extractLinks } from '../src/markdown.js';
import { checkScripts, findBash, findPython, type SpawnLike } from '../src/scripts.js';
import { runTriggerTests } from '../src/tester.js';
import { expandHome } from '../src/util.js';
import { byCode, caseInsensitiveFs, codes, GOOD_DESC, isWindows, load, makeSkill, skillMd, swapCase, tmp, writeTree } from './helpers.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.join(here, '..');
const ciFs = caseInsensitiveFs();

async function cli(args: string[], cwd = pkgRoot) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(args, { out: (s) => out.push(s), err: (s) => err.push(s), cwd, env: {}, color: false });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

/** Symlink a directory; junctions on Windows need no admin rights. */
function linkDir(target: string, at: string) {
  symlinkSync(target, at, process.platform === 'win32' ? 'junction' : 'dir');
}

/** A skill like anthropics/skills' pdf: SKILL.md names REFERENCE.md / FORMS.md, files are lowercase. */
function pdfLike() {
  return makeSkill('pdf', {
    'SKILL.md': skillMd({ name: 'pdf', description: GOOD_DESC }, 'For advanced features see REFERENCE.md. To fill forms follow FORMS.md.\nSee [guide](references/Guide.md).\nRun `python scripts/Fill.py`.\n'),
    'reference.md': '# Reference\n',
    'forms.md': '# Forms\n',
    'references/guide.md': '# Guide\n',
    'scripts/fill.py': 'print(1)\n',
  });
}

const summary = (fs: { code: string; severity: string; message: string; file?: string }[]) =>
  fs.map((x) => `${x.severity} ${x.code} ${x.message} @${x.file ? path.basename(x.file) : ''}`).sort();

describe('H1: case-insensitive filesystems (simulated NTFS/APFS)', () => {
  it('the simulated fs really is case-insensitive (sanity check of the test double)', () => {
    const dir = pdfLike();
    expect(ciFs.existsSync(path.join(dir, 'REFERENCE.md'))).toBe(true);
    expect(ciFs.readdirSync(dir)).toContain('reference.md');
    expect(ciFs.readdirSync(dir)).not.toContain('REFERENCE.md');
  });

  it('reports the on-disk spelling and no false orphans, identical to a case-sensitive fs', () => {
    const dir = pdfLike();
    const skill = load(dir);
    const onCi = referenceRules(skill, ciFs).findings;
    const onReal = referenceRules(skill).findings;
    expect(summary(onCi)).toEqual(summary(onReal));
    const msgs = byCode(onCi, 'path-case-mismatch').map((x) => x.message);
    expect(msgs).toContainEqual(expect.stringContaining('the file is reference.md'));
    expect(msgs).toContainEqual(expect.stringContaining('the file is forms.md'));
    expect(msgs).toContainEqual(expect.stringContaining('the file is scripts/fill.py'));
    expect(msgs.join('\n')).not.toMatch(/the file is (REFERENCE|FORMS)\.md/);
    expect(byCode(onCi, 'broken-link')[0]?.message).toMatch(/references\/guide\.md exists with different letter case/);
    expect(codes(onCi)).not.toContain('orphan-file');
  });

  it('the two tests that failed on Windows pass on the simulated case-insensitive fs', () => {
    const a = lintSkill(load(makeSkill('s', { 'SKILL.md': skillMd({ name: 's', description: GOOD_DESC }, 'See [guide](references/Guide.md).'), 'references/guide.md': '# g' })), { execChecks: false, fs: ciFs });
    expect(byCode(a, 'broken-link')[0]?.message).toMatch(/different letter case/);
    expect(codes(a)).not.toContain('orphan-file');
    const b = lintSkill(load(makeSkill('s', { 'SKILL.md': skillMd({ name: 's', description: GOOD_DESC }, 'For details see REFERENCE.md. Then run scripts/Fill.py.'), 'reference.md': '# r', 'scripts/fill.py': 'print(1)\n' })), { execChecks: false, fs: ciFs });
    expect(byCode(b, 'path-case-mismatch').map((x) => x.message).sort()).toEqual([expect.stringContaining('the file is reference.md'), expect.stringContaining('the file is scripts/fill.py')]);
    expect(codes(b)).not.toContain('orphan-file');
  });

  it('a skill path typed in the wrong case (C:\\users\\... vs C:\\Users\\...) is not a lint problem', () => {
    const good = path.join(pkgRoot, 'examples', 'good', 'pdf-form-filler');
    const real = load(good);
    // Same skill, but every path segment up to and including the skill folder spelled differently
    // (also checks that name-dir-mismatch compares with the on-disk folder name).
    const dir = swapCase(real.dir);
    const skill = { ...real, dir, file: path.join(dir, 'SKILL.md') };
    expect(ciFs.existsSync(dir)).toBe(true);
    // An autocrlf (Windows) checkout of examples/ adds the run-wide CRLF info; it has nothing to do with case.
    expect(lintSkill(skill, { execChecks: false, fs: ciFs }).filter((f) => f.code !== 'crlf-line-endings')).toEqual([]);
  });

  it('resolveCase: exact / case (with on-disk name) / missing / outside root / NFC vs NFD', () => {
    const root = writeTree(tmp(), { 'References/API.md': 'x', 'caf\u0065\u0301.md': 'nfd', 'x.md': 'x' });
    expect(resolveCase(root, path.join(root, 'References', 'API.md'))).toEqual({ status: 'exact', actual: path.join(root, 'References', 'API.md') });
    expect(resolveCase(root, path.join(root, 'references', 'api.md'), ciFs)).toEqual({ status: 'case', actual: path.join(root, 'References', 'API.md') });
    expect(resolveCase(root, path.join(root, 'nope.md'), ciFs).status).toBe('missing');
    expect(resolveCase(root, path.join(root, '..'), ciFs).status).toBe('exact'); // outside root: existence only
    expect(resolveCase(root, path.join(root, 'caf\u00e9.md')).status).toBe('exact'); // macOS NFD names
    expect(resolveCase(root, path.join(root, 'x.md', 'y')).status).toBe('missing'); // file used as dir
    expect(resolveCase(swapCase(root), path.join(swapCase(root), 'x.md'), ciFs).status).toBe('exact'); // root case ignored
  });
});

describe('H2: CRLF working trees (git core.autocrlf) are not a lint problem', () => {
  const crlf = (s: string) => s.replace(/\r?\n/g, '\r\n');

  it('one aggregated info per skill, never a warning, whatever the number of files', () => {
    const dir = makeSkill('c', {
      'SKILL.md': crlf(skillMd({ name: 'c', description: GOOD_DESC }, 'Run `scripts/a.sh` and `scripts/b.py`.\n')),
      'scripts/a.sh': { content: crlf('#!/bin/sh\necho a\n'), mode: 0o755 },
      'scripts/b.py': { content: crlf('#!/usr/bin/env python3\nprint(1)\n'), mode: 0o755 },
    });
    const f = lintSkill(load(dir), { execChecks: true });
    const c = byCode(f, 'crlf-line-endings');
    expect(c).toHaveLength(1);
    expect(c[0]!.severity).toBe('info');
    expect(c[0]!.files).toHaveLength(3);
    expect(c[0]!.message).toMatch(/^3 files use CRLF line endings \(c\/SKILL\.md, c\/scripts\/a\.sh, c\/scripts\/b\.py\)\. This is normal on Windows/);
    expect(f.filter((x) => x.severity !== 'info')).toEqual([]); // no $'\r' syntax errors from bash -n either
  });

  it('one aggregated info for a whole lint run; --fail-on warning still passes', async () => {
    const root = tmp();
    for (const n of ['one', 'two', 'three']) makeSkill(n, { 'SKILL.md': crlf(skillMd({ name: n, description: GOOD_DESC })) }, root);
    const r = await cli(['lint', root, '--fail-on', 'warning', '--json']);
    expect(r.code).toBe(0);
    const data = JSON.parse(r.out);
    expect(data.counts).toEqual({ error: 0, warning: 0, info: 1 });
    expect(data.findings[0].files).toHaveLength(3);
  });

  it('an autocrlf checkout of examples/ gives the same errors/warnings as LF, plus one info', async () => {
    const root = tmp();
    cpSync(path.join(pkgRoot, 'examples'), root, { recursive: true });
    const toCrlf = (d: string): void => {
      for (const n of readdirSync(d)) {
        const p = path.join(d, n);
        if (statSync(p).isDirectory()) toCrlf(p);
        else if (/\.(md|py|ya?ml|sh|txt)$/.test(n)) writeFileSync(p, crlf(readFileSync(p, 'utf8')));
      }
    };
    toCrlf(root);
    const lf = JSON.parse((await cli(['lint', path.join(pkgRoot, 'examples'), '--json', '--no-exec'])).out);
    const cr = JSON.parse((await cli(['lint', root, '--json', '--no-exec'])).out);
    const noCrlf = (fs: { code: string; severity: string; message: string }[]) => fs.filter((x) => x.code !== 'crlf-line-endings').map((x) => `${x.code} ${x.message}`).sort();
    expect(noCrlf(cr.findings)).toEqual(noCrlf(lf.findings));
    expect(cr.findings.filter((x: { code: string }) => x.code === 'crlf-line-endings')).toHaveLength(1);
    expect((await cli(['test', path.join(root, 'good')])).code).toBe(0);
  });

  it('aggregateCrlf merges already-aggregated findings without double counting', () => {
    const a = { code: 'crlf-line-endings', severity: 'info' as const, message: 'x', skillDir: '/s/a', files: ['/s/a/SKILL.md', '/s/a/x.sh'] };
    const b = { code: 'crlf-line-endings', severity: 'info' as const, message: 'x', skillDir: '/s/b', files: ['/s/b/SKILL.md', '/s/a/x.sh'] };
    const out = aggregateCrlf([a, { code: 'other', severity: 'warning', message: 'm' }, b]);
    expect(out.map((x) => x.code)).toEqual(['crlf-line-endings', 'other']);
    expect(out[0]!.files).toHaveLength(3);
  });
});

describe('M1: skills behind symlinks / junctions are discovered', () => {
  it('follows linked skill folders and linked parent folders; cycles and dangling links are safe', () => {
    const real = tmp();
    makeSkill('alpha', {}, real);
    makeSkill('beta', {}, path.join(real, 'nested'));
    const skills = tmp();
    linkDir(path.join(real, 'alpha'), path.join(skills, 'alpha-link'));
    linkDir(path.join(real, 'nested'), path.join(skills, 'group'));
    linkDir(skills, path.join(skills, 'loop')); // cycle
    try {
      symlinkSync(path.join(real, 'missing'), path.join(skills, 'dangling'), process.platform === 'win32' ? 'junction' : 'dir');
    } catch {
      /* some platforms refuse dangling junctions */
    }
    const found = discoverSkills(skills).map((s) => path.relative(skills, s.dir).split(path.sep).join('/'));
    expect(found).toEqual(['alpha-link', 'group/beta']);
  });

  it('the same skill reached through a link and directly is only loaded once in a catalog', () => {
    const real = tmp();
    makeSkill('alpha', {}, real);
    const links = tmp();
    linkDir(path.join(real, 'alpha'), path.join(links, 'alpha'));
    const cat = loadCatalog(real, [links]);
    expect(cat.skills).toHaveLength(1);
    expect(cat.extra).toHaveLength(0);
  });

  it('linked folders that stay inside the skill count as part of it (no false missing/orphan)', () => {
    const dir = makeSkill('s', { 'SKILL.md': skillMd({ name: 's', description: GOOD_DESC }, 'Run `python scripts/helper.py`.'), 'lib/helper.py': 'print(1)\n' });
    linkDir(path.join(dir, 'lib'), path.join(dir, 'scripts'));
    expect(lintSkill(load(dir), { execChecks: false })).toEqual([]);
  });

  it('L-N3: a linked folder that leaves the skill is not scanned, and references through it are flagged', () => {
    const shared = writeTree(tmp(), { 'helper.py': 'print(1)\n', 'secret.md': '# Secret\n' });
    const dir = makeSkill('s', { 'SKILL.md': skillMd({ name: 's', description: GOOD_DESC }, 'Run `python scripts/helper.py`. See [x](scripts/secret.md).') });
    linkDir(shared, path.join(dir, 'scripts'));
    const f = lintSkill(load(dir), { execChecks: false });
    expect(codes(f)).toEqual(['link-outside-skill', 'reference-outside-skill', 'reference-outside-skill']);
    expect(byCode(f, 'link-outside-skill')[0]!.severity).toBe('info');
    expect(byCode(f, 'reference-outside-skill').map((x) => x.message).join('\n')).toMatch(/through a symlink\/junction/);
    expect(codes(f)).not.toContain('orphan-file');
  });
});

describe('M2 / L1: diff and test honour per-file threshold', () => {
  // v2 adds "graphs": the prompt then reaches coverage ~0.28 (above 0.2, below the file's 0.9).
  const csvV1 = skillMd({ name: 'csv-charts', description: 'Turn CSV data into spreadsheets. Use for CSV files.' });
  const csvV2 = skillMd({ name: 'csv-charts', description: 'Turn CSV data into graphs and spreadsheets. Use for CSV files.' });
  const other = skillMd({ name: 'notes', description: 'Write meeting notes and summaries.' });
  const tests = 'threshold: 0.9\nshould_not_trigger:\n  - graphs for the board\n';

  it('a file threshold that keeps a case passing in `test` also keeps it passing in `diff`', async () => {
    const base = loadCatalog(writeTree(tmp(), { 'csv-charts/SKILL.md': csvV1, 'csv-charts/triggers.yaml': tests, 'notes/SKILL.md': other }));
    const head = loadCatalog(writeTree(tmp(), { 'csv-charts/SKILL.md': csvV2, 'csv-charts/triggers.yaml': tests, 'notes/SKILL.md': other }));
    const t = await runTriggerTests(head);
    expect(t.failed).toBe(0);
    expect(t.skills[0]!.cases[0]!.threshold).toBe(0.9);
    expect(t.fileThresholds).toEqual({ 'csv-charts': 0.9 });
    // Sanity: at the default threshold the case WOULD fail, so the plumbing matters.
    expect((await runTriggerTests(head, { threshold: 0.2 })).failed).toBe(1);
    const d = await diffCatalogs(base, head);
    expect(d.regressions).toEqual([]);
    expect(d.changes).toEqual([]);
    // An explicit --threshold still overrides the file, on both commands.
    expect((await diffCatalogs(base, head, { threshold: 0.2 })).regressions).toHaveLength(1);
  });

  it('the test summary shows per-file thresholds', async () => {
    const root = writeTree(tmp(), { 'csv-charts/SKILL.md': csvV2, 'csv-charts/triggers.yaml': tests, 'notes/SKILL.md': other });
    expect((await cli(['test', root])).out).toMatch(/threshold 0\.2 \(from trigger files: csv-charts 0\.9\)/);
  });
});

describe('M3: WSL bash on Windows (simulated platform + lookup + spawn)', () => {
  const sh = () => writeTree(tmp(), { 'a.sh': '#!/bin/bash\necho ok\n' });
  const mockSpawn = (onBashN: (cmd: string) => { status: number; stderr?: string }): SpawnLike & { calls: string[][] } => {
    const calls: string[][] = [];
    const fn: SpawnLike = (cmd, args) => {
      calls.push([cmd, ...args]);
      if (args[0] === '-c' || args[0] === '-I') return { status: 0 };
      if (args[0] === '-n') return onBashN(cmd);
      return { status: 1 };
    };
    return Object.assign(fn, { calls });
  };
  /** A Windows machine: PATH, cwd and the set of existing executables. */
  const win = (PATH: string, exes: string[], extra: Partial<ExeLookup> = {}): Partial<ExeLookup> => ({
    platform: 'win32',
    env: { Path: PATH, ProgramFiles: 'C:\\Program Files', LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' },
    cwd: 'C:\\work\\repo',
    isExecutable: (p) => exes.some((e) => e.toLowerCase() === p.toLowerCase()),
    realpath: (p) => p,
    ...extra,
  });
  const WSL = 'C:\\Windows\\System32\\bash.exe';
  const GIT_BASH = 'C:\\Program Files\\Git\\bin\\bash.exe';

  it('only the WSL launcher on PATH: shell checks are skipped, never reported as syntax errors', () => {
    const dir = sh();
    const spawn = mockSpawn(() => ({ status: 1, stderr: '/bin/bash: C:\\x\\a.sh: No such file or directory' }));
    const f = checkScripts([path.join(dir, 'a.sh')], dir, { exec: true, platform: 'win32', spawn, lookup: win('C:\\Windows\\System32', [WSL]) });
    expect(codes(f)).toEqual(['script-check-skipped']);
    expect(f[0]!.message).toMatch(/WSL/);
    expect(spawn.calls.some((c) => c[1] === '-n')).toBe(false);
  });

  it('Git Bash is preferred over the WSL launcher, on PATH or in its install folder', () => {
    const spawn = mockSpawn(() => ({ status: 0 }));
    const apps = 'C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps';
    expect(findBash('win32', spawn, win(`${apps};C:\\Program Files\\Git\\bin`, [`${apps}\\bash.exe`, GIT_BASH])).cmd).toBe(GIT_BASH);
    // Not on PATH at all: the well-known Git for Windows locations are tried.
    expect(findBash('win32', spawn, win('C:\\Windows\\System32', [WSL, GIT_BASH])).cmd).toBe(GIT_BASH);
    const userGit = 'C:\\Users\\me\\AppData\\Local\\Programs\\Git\\usr\\bin\\bash.exe';
    expect(findBash('win32', spawn, win('', [userGit])).cmd).toBe(userGit);
  });

  it('a bash that cannot open the file is a skipped check, not a syntax error', () => {
    const dir = sh();
    const spawn = mockSpawn(() => ({ status: 127, stderr: 'bash: /mnt/c/x/a.sh: No such file or directory' }));
    const f = checkScripts([path.join(dir, 'a.sh')], dir, { exec: true, platform: 'win32', spawn, lookup: win('D:\\tools', ['D:\\tools\\bash.exe']) });
    expect(codes(f)).toEqual(['script-check-skipped']);
  });

  it('real syntax errors are still reported through a native bash', () => {
    const dir = sh();
    const spawn = mockSpawn(() => ({ status: 2, stderr: 'a.sh: line 3: syntax error: unexpected end of file' }));
    const f = checkScripts([path.join(dir, 'a.sh')], dir, { exec: true, platform: 'win32', spawn, lookup: win('C:\\Program Files\\Git\\bin', [GIT_BASH]) });
    expect(f.map((x) => [x.code, x.line])).toEqual([['script-syntax-error', 3]]);
    expect(spawn.calls.find((c) => c[1] === '-n')?.[0]).toBe(GIT_BASH);
  });

  it('file-mode (chmod) checks follow the injected platform', () => {
    const dir = writeTree(tmp(), { 'a.py': { content: '#!/usr/bin/env python3\n', mode: 0o644 } });
    expect(checkScripts([path.join(dir, 'a.py')], dir, { exec: false, platform: 'win32' })).toEqual([]);
  });
});

describe('H-N1: executables are only taken from trusted absolute locations', () => {
  const okSpawn = (): SpawnLike & { calls: string[][] } => {
    const calls: string[][] = [];
    const fn: SpawnLike = (cmd, args) => {
      calls.push([cmd, ...args]);
      if (args[0] === '-n') return { status: 0 };
      if (args.includes(PY_PROBE)) return { status: 0, stdout: '[null]' };
      return { status: 0, stdout: '[null]' };
    };
    return Object.assign(fn, { calls });
  };
  const PY_PROBE = 'import ast';

  it('win32: bash.exe / python.exe planted in the cwd, the skill folder or a relative PATH entry are never chosen', () => {
    const planted = [
      'C:\\work\\repo\\bash.exe', 'C:\\work\\repo\\python.exe', 'C:\\work\\repo\\python3.exe',
      'C:\\work\\repo\\bin\\bash.exe', 'C:\\work\\repo\\tools\\python.exe',
      'D:\\skills\\pdf\\bash.exe', 'D:\\skills\\pdf\\scripts\\python.exe', 'D:\\skills\\bin\\bash.exe',
      '\\evil\\bash.exe',
    ];
    const trusted = ['C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Python312\\python.exe'];
    const PATH = ['', '.', 'bin', '.\\tools', 'tools', '\\evil', 'C:\\work\\repo\\bin', 'c:\\WORK\\Repo\\tools', 'D:\\skills\\bin', 'D:\\skills\\pdf\\scripts', '"C:\\Python312"', 'C:\\Windows\\System32'].join(';');
    const lookup: Partial<ExeLookup> = {
      platform: 'win32',
      env: { PATH, ProgramFiles: 'C:\\Program Files' },
      cwd: 'C:\\work\\repo',
      isExecutable: (p) => [...planted, ...trusted].some((e) => e.toLowerCase() === p.toLowerCase()),
      realpath: (p) => p,
    };
    const l = withDefaults(lookup, ['D:\\skills']);
    expect(trustedPathDirs(l)).toEqual(['C:\\Python312', 'C:\\Windows\\System32']);
    const spawn = okSpawn();
    expect(findBash('win32', spawn, lookup, ['D:\\skills']).cmd).toBe('C:\\Program Files\\Git\\bin\\bash.exe');
    expect(findPython('win32', spawn, lookup, ['D:\\skills'])).toBe('C:\\Python312\\python.exe');
    // Without any trusted install, nothing is chosen at all.
    const none = { ...lookup, isExecutable: (p: string) => planted.some((e) => e.toLowerCase() === p.toLowerCase()) };
    expect(findBash('win32', spawn, none, ['D:\\skills']).cmd).toBeNull();
    expect(findPython('win32', spawn, none, ['D:\\skills'])).toBeNull();
    // Every spawn used an absolute path, and never `where` or a planted file.
    for (const [cmd] of spawn.calls) {
      expect(path.win32.isAbsolute(cmd!) && /^[A-Z]:\\/i.test(cmd!)).toBe(true);
      expect(planted.map((x) => x.toLowerCase())).not.toContain(cmd!.toLowerCase());
      expect(cmd).not.toMatch(/where/i);
    }
  });

  it('win32: a trusted-looking PATH entry whose file resolves into the repo is not used', () => {
    const lookup: Partial<ExeLookup> = {
      platform: 'win32',
      env: { PATH: 'C:\\tools' },
      cwd: 'C:\\work\\repo',
      isExecutable: (p) => p === 'C:\\tools\\bash.exe',
      realpath: (p) => (p === 'C:\\tools\\bash.exe' ? 'C:\\work\\repo\\.hidden\\bash.exe' : p),
    };
    expect(findBash('win32', okSpawn(), lookup).cmd).toBeNull();
  });

  it('posix: relative and repo-internal PATH entries are ignored', () => {
    const l = withDefaults({ platform: 'linux', env: { PATH: ':.:bin:./node_modules/.bin:/repo/bin:/repo/skills/x:/usr/local/bin:/usr/bin' }, cwd: '/repo', realpath: (p) => p }, ['/repo/skills']);
    expect(trustedPathDirs(l)).toEqual(['/usr/local/bin', '/usr/bin']);
    // Running from / does not make every PATH entry "inside the cwd".
    expect(trustedPathDirs({ ...l, cwd: '/' , untrusted: [] })).toEqual(['/repo/bin', '/repo/skills/x', '/usr/local/bin', '/usr/bin']);
  });

  it.skipIf(isWindows)('real POSIX run: a planted `bash` / `python3` in a relative PATH entry, the cwd or the skill never runs (canary)', () => {
    const repo = tmp();
    const canary = path.join(tmp(), 'canary');
    const evil = `#!/bin/sh\necho pwned > '${canary}'\nexit 0\n`;
    writeTree(repo, {
      'bash': { content: evil, mode: 0o755 },
      'python3': { content: evil, mode: 0o755 },
      'bin/bash': { content: evil, mode: 0o755 },
      'bin/python3': { content: evil, mode: 0o755 },
      'bin/python': { content: evil, mode: 0o755 },
      'json.py': `open(${JSON.stringify(canary)}, 'w').write('pwned')\n`,
      'ast.py': `open(${JSON.stringify(canary)}, 'w').write('pwned')\n`,
      'skills/s/SKILL.md': skillMd({ name: 's', description: GOOD_DESC }, 'Run `scripts/run.sh` and `python scripts/fill.py`.'),
      'skills/s/scripts/run.sh': { content: '#!/bin/bash\necho ok\n', mode: 0o755 },
      'skills/s/scripts/fill.py': { content: '#!/usr/bin/env python3\nprint(1)\n', mode: 0o755 },
      'skills/s/scripts/bash': { content: evil, mode: 0o755 },
      'skills/s/scripts/python3': { content: evil, mode: 0o755 },
    });
    const PATH = `bin:.::skills/s/scripts:${path.join(repo, 'skills', 's', 'scripts')}:${process.env.PATH ?? ''}`;
    // 1. Library call with the poisoned PATH and the repo as cwd.
    const skillDir = path.join(repo, 'skills', 's');
    const files = ['scripts/run.sh', 'scripts/fill.py'].map((x) => path.join(skillDir, x));
    const f = checkScripts(files, skillDir, { exec: true, lookup: { env: { PATH }, cwd: repo }, untrusted: [repo] });
    expect(existsSync(canary)).toBe(false);
    expect(codes(f).filter((c) => c === 'script-syntax-error')).toEqual([]);
    // 2. The built CLI, run inside the repo with that PATH (what `npx triggerspec lint .` does).
    const r = spawnSync(process.execPath, [path.join(pkgRoot, 'dist', 'cli.js'), 'lint', '.', '--verbose'], { cwd: repo, env: { ...process.env, PATH }, encoding: 'utf8' });
    expect(r.status).toBe(0);
    expect(existsSync(canary)).toBe(false);
    // The real interpreters were still found (when installed), so the checks really ran.
    if (spawnSync('bash', ['-c', 'exit 0']).status === 0 && spawnSync('python3', ['-I', '-c', 'import ast']).status === 0) {
      expect(r.stdout).not.toMatch(/script-check-skipped/);
    }
  });
});

describe('M-N2: link loops and hostile trees inside skills and catalogs', () => {
  const realFs: FsLike = nodeFsLike;
  const note = 'See notes.txt.';

  it('a self-referencing link inside a skill: no false orphans, one loop note', () => {
    const dir = makeSkill('s', { 'SKILL.md': skillMd({ name: 's', description: GOOD_DESC }, note), 'notes.txt': 'x\n' });
    linkDir(dir, path.join(dir, 'self'));
    const f = lintSkill(load(dir), { execChecks: false });
    expect(codes(f)).toEqual(['path-skipped']);
    expect(f[0]!.message).toMatch(/self: link loop/);
    expect(walkSkillFiles(dir).files).toEqual(['SKILL.md', 'notes.txt']);
  });

  it('two self-links (the 70 s / 8,191-orphan case) and mutual links finish fast', () => {
    const dir = makeSkill('s', { 'SKILL.md': skillMd({ name: 's', description: GOOD_DESC }, note), 'notes.txt': 'x\n', 'a/x.md': '# a\n', 'b/y.md': '# b\n' });
    linkDir(dir, path.join(dir, 'self1'));
    linkDir(dir, path.join(dir, 'self2'));
    linkDir(path.join(dir, 'b'), path.join(dir, 'a', 'toB'));
    linkDir(path.join(dir, 'a'), path.join(dir, 'b', 'toA'));
    const t0 = Date.now();
    const f = lintSkill(load(dir), { execChecks: false });
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(codes(f).filter((c) => c !== 'path-skipped' && c !== 'orphan-file')).toEqual([]);
    // x.md / y.md are real orphans exactly once each; nothing reached through the loops.
    expect(byCode(f, 'orphan-file').map((x) => x.message.split(' ')[0]).sort()).toEqual(['a/x.md', 'b/y.md']);
  });

  it('simulated junction realpath quirks: unresolved or failing realpath, loops still stop via (dev, ino)', () => {
    const dir = makeSkill('s', { 'SKILL.md': skillMd({ name: 's', description: GOOD_DESC }, note), 'notes.txt': 'x\n' });
    linkDir(dir, path.join(dir, 'self1'));
    linkDir(dir, path.join(dir, 'self2'));
    const unresolved: FsLike = { ...realFs, realpathSync: (p) => p };
    const failing: FsLike = { ...realFs, realpathSync: (p) => { throw Object.assign(new Error('ELOOP ' + p), { code: 'ELOOP' }); } };
    for (const fs of [unresolved, failing]) {
      const w = walkSkillFiles(dir, fs);
      expect(w.files).toEqual(['SKILL.md', 'notes.txt']);
      expect(w.issues.map((i) => i.kind)).toEqual(['loop', 'loop']);
    }
    // Worst case: no realpath AND no inode numbers. Depth and entry caps still end the walk.
    const blind: FsLike = { ...realFs, realpathSync: (p) => p, statSync: (p) => Object.assign(statSync(p), { ino: 0 }) };
    const t0 = Date.now();
    const w = walkSkillFiles(dir, blind);
    expect(Date.now() - t0).toBeLessThan(10000);
    expect(w.issues.some((i) => i.kind === 'limit')).toBe(true);
  });

  it('deep chains are capped, and ELOOP / EACCES / ENAMETOOLONG entries are skipped with a note', () => {
    const deep = Array.from({ length: MAX_SKILL_DEPTH + 3 }, (_, i) => `d${i}`).join('/');
    const dir = makeSkill('s', { 'SKILL.md': skillMd({ name: 's', description: GOOD_DESC }, 'See d0/ for data.'), [`${deep}/f.txt`]: 'x', 'bad/x.txt': 'x', 'ok.txt': 'x' });
    expect(walkSkillFiles(dir).issues.map((i) => i.kind)).toEqual(['limit']);
    for (const code of ['ELOOP', 'EACCES', 'EPERM', 'ENAMETOOLONG']) {
      const fs: FsLike = { ...realFs, statSync: (p) => { if (path.basename(p) === 'bad') throw Object.assign(new Error(code), { code }); return statSync(p); } };
      const w = walkSkillFiles(dir, fs);
      expect(w.issues).toContainEqual({ path: 'bad', reason: `cannot read (${code})`, kind: 'error' });
      expect(w.files).toContain('ok.txt');
    }
  });

  it('discovery: self and mutual loops, realpath quirks, per-entry errors and the folder cap', () => {
    const root = writeTree(tmp(), { 'one/s1/SKILL.md': skillMd({ name: 's1', description: GOOD_DESC }), 'two/s2/SKILL.md': skillMd({ name: 's2', description: GOOD_DESC }), 'bad/x': 'x' });
    linkDir(root, path.join(root, 'one', 'up'));
    linkDir(path.join(root, 'two'), path.join(root, 'one', 'toTwo'));
    linkDir(path.join(root, 'one'), path.join(root, 'two', 'toOne'));
    const names = (xs: { dir: string }[]) => xs.map((x) => path.relative(root, x.dir).split(path.sep).join('/'));
    expect(names(discoverSkills(root))).toEqual(['one/s1', 'two/s2']);
    // Realpath that does not resolve (junction quirk): (dev, ino) still stops the loops.
    expect(names(discoverSkills(root, { fs: { statSync: (p) => statSync(p), realpathSync: (p) => p } }))).toEqual(['one/s1', 'two/s2']);
    const issues: { path: string; reason: string }[] = [];
    const eloop = (p: string) => { if (path.basename(p) === 'bad') throw Object.assign(new Error('ELOOP'), { code: 'ELOOP' }); return statSync(p); };
    expect(names(discoverSkills(root, { fs: { statSync: eloop, realpathSync: (p) => realpathSync.native(p) }, onIssue: (i) => issues.push(i) }))).toEqual(['one/s1', 'two/s2']);
    expect(issues).toEqual([{ path: path.join(root, 'bad'), reason: 'cannot follow (ELOOP)' }]);
    const capped: { path: string; reason: string }[] = [];
    discoverSkills(root, { maxDirs: 2, onIssue: (i) => capped.push(i) });
    expect(capped[0]?.reason).toMatch(/stopped after 2 folders/);
  });

  it('lint shows discovery notes as run-wide info', async () => {
    const root = writeTree(tmp(), { 's1/SKILL.md': skillMd({ name: 's1', description: GOOD_DESC }) });
    linkDir(root, path.join(root, 'loop'));
    const r = await cli(['lint', root, '--verbose']);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/1 skill checked: 0 errors, 0 warnings/);
  });
});

describe('Round-2 lows', () => {
  it('L-N4: a wrong-case link is one finding (broken-link), not also path-case-mismatch', () => {
    const dir = makeSkill('s', { 'SKILL.md': skillMd({ name: 's', description: GOOD_DESC }, 'Follow [the forms guide](FORMS.md).'), 'forms.md': '# Forms\n' });
    expect(codes(lintSkill(load(dir), { execChecks: false }))).toEqual(['broken-link']);
  });

  it('L-N5: a mention whose resource folder has the wrong case is a path-case-mismatch, not an orphan', () => {
    const dir = makeSkill('s', { 'SKILL.md': skillMd({ name: 's', description: GOOD_DESC }, 'Run `python Scripts/Run.py`.'), 'scripts/run.py': 'print(1)\n' });
    const f = lintSkill(load(dir), { execChecks: false });
    expect(codes(f)).toEqual(['path-case-mismatch']);
    expect(f[0]!.message).toMatch(/the file is scripts\/run\.py/);
  });

  it('L-N6: the CRLF info covering several skills is run-wide, not filed under the first skill', async () => {
    const crlf = (n: string) => skillMd({ name: n, description: GOOD_DESC }).replace(/\n/g, '\r\n');
    const root = writeTree(tmp(), { 'a/SKILL.md': crlf('a'), 'b/SKILL.md': crlf('b') });
    const j = JSON.parse((await cli(['lint', root, '--json', '--verbose'])).out);
    const c = j.findings.filter((x: { code: string }) => x.code === 'crlf-line-endings');
    expect(c).toHaveLength(1);
    expect(c[0].skill).toBeUndefined();
    expect((await cli(['lint', root, '--verbose'])).out).toMatch(/All paths\n\s+info\s+2 files use CRLF/);
    // Within one skill it stays with that skill.
    const one = aggregateCrlf(lintSkill(load(path.join(root, 'a')), { execChecks: false }));
    expect(one.find((x) => x.code === 'crlf-line-endings')?.skillDir).toBe(path.join(root, 'a'));
  });

  const hasGit = spawnSync('git', ['--version']).status === 0;
  it.skipIf(!hasGit)('L-N7: a script committed with CRLF warns; a CRLF working-tree copy of an LF commit does not', () => {
    const repo = tmp();
    writeTree(repo, {
      's/SKILL.md': skillMd({ name: 's', description: GOOD_DESC }, 'Run `scripts/bad.sh` and `scripts/ok.sh`.'),
      's/scripts/bad.sh': { content: '#!/bin/bash\r\necho bad\r\n', mode: 0o755 },
      's/scripts/ok.sh': { content: '#!/bin/bash\necho ok\n', mode: 0o755 },
    });
    const g = (...a: string[]) => spawnSync('git', ['-c', 'core.autocrlf=false', '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...a], { cwd: repo, encoding: 'utf8' });
    g('init', '-q');
    g('add', '-A');
    g('commit', '-q', '-m', 'x');
    // Simulate autocrlf=true: ok.sh is LF in git but CRLF on disk.
    writeFileSync(path.join(repo, 's', 'scripts', 'ok.sh'), '#!/bin/bash\r\necho ok\r\n');
    const f = lintSkill(load(path.join(repo, 's')));
    expect(byCode(f, 'script-crlf-committed').map((x) => path.basename(x.file!))).toEqual(['bad.sh']);
    expect(byCode(f, 'script-crlf-committed')[0]!.severity).toBe('warning');
    expect(byCode(f, 'crlf-line-endings')).toHaveLength(1);
    // --no-exec spawns nothing, so it cannot tell and stays silent.
    expect(codes(lintSkill(load(path.join(repo, 's')), { execChecks: false }))).not.toContain('script-crlf-committed');
  });
});

describe('Lows', () => {
  it('L2: lint on a folder without skills says 0 skills checked', async () => {
    const r = await cli(['lint', tmp()]);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/0 skills checked: 1 error/);
  });

  it('L3: check rejects options it would ignore, and --warn-at > --error-at is rejected', async () => {
    for (const extra of [['--llm'], ['--only', 'x'], ['--model', 'm'], ['--provider', 'openai']]) {
      const r = await cli(['check', 'examples/good', ...extra]);
      expect(r.code).toBe(2);
      expect(r.err).toMatch(/not supported by "check"/);
    }
    for (const cmd of ['collisions', 'check']) {
      const r = await cli([cmd, 'examples/good', '--warn-at', '0.8', '--error-at', '0.5']);
      expect(r.code).toBe(2);
      expect(r.err).toMatch(/--warn-at .* must not be greater than --error-at/);
    }
  });

  it('L4: a misspelled `expect:` skill says the skill does not exist', async () => {
    const root = writeTree(tmp(), {
      'release-notes/SKILL.md': skillMd({ name: 'release-notes', description: 'Write release notes and changelogs from git history.' }),
      'pdf/SKILL.md': skillMd({ name: 'pdf', description: 'Fill PDF forms.' }),
      'pdf/triggers.yaml': 'should_not_trigger:\n  - prompt: write release notes for v2\n    expect: release-note\n',
    });
    const t = await runTriggerTests(loadCatalog(root));
    expect(t.skills[0]!.cases[0]!.reason).toMatch(/expect: "release-note" is not a skill in the catalog \(did you mean release-notes\?\)/);
  });

  it('L5: link extraction stays linear on hostile input', () => {
    const t0 = Date.now();
    extractLinks('['.repeat(100_000) + '](x.md)\n' + '[a] '.repeat(50_000), 1);
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(extractLinks('[x [y] z](ref.md) ![i](a(b).png "t")', 1).map((l) => l.target)).toEqual(['ref.md', 'a(b).png']);
  });

  it('L10: a leading ~ is expanded (cmd/PowerShell pass it literally)', () => {
    expect(expandHome('~')).toBe(homedir());
    expect(expandHome('~/x/y')).toBe(path.join(homedir(), 'x/y'));
    expect(expandHome('~\\x')).toBe(path.join(homedir(), 'x'));
    expect(expandHome('a/~b')).toBe('a/~b');
    expect(expandHome('~user/x')).toBe('~user/x');
  });

  it.skipIf(spawnSync('git', ['--version']).status !== 0)('L11: --base-ref values that look like options are rejected before git sees them', async () => {
    const r = await cli(['diff', 'examples/good', '--base-ref', '--output=/tmp/x']);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/invalid git ref/);
  });

  it('L7: collision and finding order does not depend on locale', async () => {
    const root = tmp();
    mkdirSync(root, { recursive: true });
    for (const n of ['b-skill', 'a-skill', 'B-skill'.toLowerCase() + '2']) makeSkill(n, { 'SKILL.md': skillMd({ name: n, description: GOOD_DESC }) }, root);
    const r1 = await cli(['collisions', root, '--json']);
    const pairs = JSON.parse(r1.out).pairs.map((p: { a: string; b: string }) => `${p.a}|${p.b}`);
    expect(pairs).toEqual([...pairs].sort((x: string, y: string) => (x < y ? -1 : x > y ? 1 : 0)));
  });
});
