import { execFileSync, spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseArgs, run } from '../src/main.js';
import { skillMd, tmp, writeTree } from './helpers.js';

const here = path.dirname(fileURLToPath(import.meta.url));

async function cli(args: string[], env: Record<string, string | undefined> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(args, { out: (s) => out.push(s), err: (s) => err.push(s), cwd: path.join(here, '..'), env, color: false });
  return { code, out: out.join('\n'), err: err.join('\n') };
}
const json = async (args: string[], env = {}) => {
  const r = await cli([...args, '--json'], env);
  return { ...r, data: JSON.parse(r.out) };
};

describe('argument parsing', () => {
  it('supports --flag value, --flag=value, repeats and --', () => {
    const p = parseArgs(['lint', '--catalog', 'a', '--catalog=b', '--json', '--', '--weird-dir']);
    expect(p.positionals).toEqual(['lint', '--weird-dir']);
    expect(p.flags.get('catalog')).toEqual(['a', 'b']);
  });
  it('rejects unknown options and missing values', () => {
    expect(() => parseArgs(['--nope'])).toThrow(/unknown option/);
    expect(() => parseArgs(['--threshold'])).toThrow(/needs a value/);
    expect(() => parseArgs(['--json=1'])).toThrow(/does not take a value/);
  });
});

describe('cli: general', () => {
  it('help, version, usage errors', async () => {
    expect((await cli(['--help'])).out).toMatch(/Usage:/);
    expect((await cli([])).code).toBe(2);
    expect((await cli(['-v'])).out).toMatch(/^\d+\.\d+\.\d+/);
    const bad = await cli(['frobnicate']);
    expect(bad.code).toBe(2);
    expect(bad.err).toMatch(/unknown command/);
    expect((await cli(['lint'])).code).toBe(2);
    expect((await cli(['test', 'examples/good', '--threshold', '7'])).code).toBe(2);
    expect((await cli(['lint', 'examples/good', '--fail-on', 'info'])).code).toBe(2);
  });

  it('missing path is an I/O error (exit 2)', async () => {
    const r = await cli(['lint', 'does/not/exist']);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/ENOENT|no such file/i);
  });
});

describe('cli: lint', () => {
  it('good examples pass, broken example fails with errors and warnings', async () => {
    const good = await cli(['lint', 'examples/good']);
    expect(good.code).toBe(0);
    expect(good.out).toMatch(/2 skills checked: 0 errors, 0 warnings/);
    const broken = await json(['lint', 'examples/broken']);
    expect(broken.code).toBe(1);
    expect(broken.data.ok).toBe(false);
    const codes = new Set(broken.data.findings.map((f: { code: string }) => f.code));
    for (const c of ['name-dir-mismatch', 'broken-link', 'missing-file', 'crlf-line-endings', 'description-angle-brackets', 'trigger-file-invalid', 'windows-path-separator', 'orphan-file', 'absolute-path']) expect(codes).toContain(c);
    expect(broken.data.findings.find((f: { file?: string }) => f.file).file).not.toMatch(/^\//); // paths are relative to cwd
  });

  it('--fail-on warning, --disable and multiple paths', async () => {
    const root = writeTree(tmp(), { 'w-skill/SKILL.md': skillMd({ name: 'w-skill', description: 'Too short. Use it.' }) });
    expect((await cli(['lint', root])).code).toBe(0);
    expect((await cli(['lint', root, '--fail-on', 'warning'])).code).toBe(1);
    expect((await cli(['lint', root, '--fail-on', 'warning', '--disable', 'description-too-short'])).code).toBe(0);
    const both = await json(['lint', root, 'examples/good']);
    expect(both.data.skills).toHaveLength(3);
  });

  it('reports an empty folder as an error', async () => {
    const r = await json(['lint', tmp()]);
    expect(r.code).toBe(1);
    expect(r.data.findings[0].code).toBe('no-skills-found');
  });

  it('--verbose shows info findings', async () => {
    expect((await cli(['lint', 'examples/broken', '--verbose'])).out).toMatch(/client-extension-field/);
    expect((await cli(['lint', 'examples/broken'])).out).not.toMatch(/client-extension-field/);
  });
});

describe('cli: test', () => {
  it('passes on the good examples (offline, default)', async () => {
    const r = await json(['test', 'examples/good']);
    expect(r.code).toBe(0);
    expect(r.data.failed).toBe(0);
    expect(r.data.passed).toBe(9);
    expect(r.data.judge).toBeUndefined();
  });

  it('fails on the colliding example and explains why', async () => {
    const r = await cli(['test', 'examples/colliding']);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/FAIL should trigger.*PostgreSQL/);
    expect(r.out).toMatch(/"database-assistant" ranks first/);
  });

  it('--llm without a key is skipped, not failed', async () => {
    const r = await json(['test', 'examples/good', '--llm'], {});
    expect(r.code).toBe(0);
    expect(r.data.judge.skippedReason).toMatch(/no ANTHROPIC_API_KEY or OPENAI_API_KEY set/);
    const t = await cli(['test', 'examples/good', '--llm'], {});
    expect(t.out).toMatch(/LLM judge: skipped/i);
  });

  it('exit 1 when no test files exist; --only filters', async () => {
    const root = writeTree(tmp(), { 'a-skill/SKILL.md': skillMd({ name: 'a-skill', description: 'Does a. Use when a.' }) });
    expect((await cli(['test', root])).code).toBe(1);
    const only = await json(['test', 'examples/good', '--only', 'release-notes']);
    expect(only.data.skills.map((s: { skill: string }) => s.skill)).toEqual(['release-notes']);
  });

  it('--catalog adds competitors that can steal prompts', async () => {
    const comp = writeTree(tmp(), { 'pdf-super/SKILL.md': skillMd({ name: 'pdf-super', description: 'Fill out PDF forms. Fill PDF form fields. Complete tax form PDF and application PDF forms.' }) });
    const r = await json(['test', 'examples/good', '--catalog', comp]);
    expect(r.data.catalogSize).toBe(3);
    expect(r.code).toBe(1);
  });

  it('rejects an invalid --provider', async () => {
    expect((await cli(['test', 'examples/good', '--llm', '--provider', 'x'])).code).toBe(2);
  });
});

describe('cli: collisions / route / check', () => {
  it('collisions: error pair on the colliding example; none on good', async () => {
    const r = await json(['collisions', 'examples/colliding']);
    expect(r.code).toBe(1);
    expect(r.data.pairs[0].severity).toBe('error');
    expect((await cli(['collisions', 'examples/good'])).code).toBe(0);
    expect((await cli(['collisions', 'examples/colliding', '--error-at', '0.99'])).code).toBe(0);
    expect((await cli(['collisions', 'examples/colliding', '--error-at', '0.99', '--fail-on', 'warning'])).code).toBe(1);
  });

  it('route prints the ranking', async () => {
    const r = await cli(['route', 'examples/good', 'please', 'fill', 'my', 'tax', 'form', 'PDF']);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/pdf-form-filler.*selected/);
    const j = await json(['route', 'examples/good', 'release notes for v2', '--top', '1']);
    expect(j.data.selected).toBe('release-notes');
    expect(j.data.ranking).toHaveLength(1);
    expect((await cli(['route', 'examples/good'])).code).toBe(2);
  });

  it('check combines everything', async () => {
    expect((await cli(['check', 'examples/good'])).code).toBe(0);
    const bad = await json(['check', 'examples/colliding']);
    expect(bad.code).toBe(1);
    expect(bad.data.collisions.pairs).toHaveLength(1);
    expect(bad.data.test.failed).toBe(1);
  });
});

const hasGit = spawnSync('git', ['--version']).status === 0;

describe('cli: diff', () => {
  it('--base <dir> reports regressions with exit 1', async () => {
    const base = writeTree(tmp(), {
      'pdf/SKILL.md': skillMd({ name: 'pdf', description: 'Fill PDF forms. Use when filling a PDF form.' }),
      'pdf/triggers.yaml': 'should_trigger: [fill this PDF form]\n',
    });
    const head = writeTree(tmp(), {
      'pdf/SKILL.md': skillMd({ name: 'pdf', description: 'Merge documents. Use when merging documents.' }),
      'pdf/triggers.yaml': 'should_trigger: [fill this PDF form]\n',
      'pdf-form-filler/SKILL.md': skillMd({ name: 'pdf-form-filler', description: 'Fill PDF forms. Use when filling a PDF form.' }),
    });
    const r = await cli(['diff', head, '--base', base]);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/added skills: pdf-form-filler/);
    expect(r.out).toMatch(/regression/i);
    expect((await cli(['diff', head, '--base', head])).code).toBe(0);
    expect((await cli(['diff', head])).code).toBe(2);
  });

  it.skipIf(!hasGit)('--base-ref compares with a git revision; bad refs are usage errors', async () => {
    const repo = tmp();
    const git = (...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...a], { cwd: repo, stdio: 'pipe' });
    git('init', '-q');
    writeTree(repo, { 'pdf/SKILL.md': skillMd({ name: 'pdf', description: 'Fill PDF forms. Use when filling a PDF form.' }), 'pdf/triggers.yaml': 'should_trigger: [fill this PDF form]\n' });
    git('add', '.');
    git('commit', '-q', '-m', 'one');
    writeFileSync(path.join(repo, 'pdf', 'SKILL.md'), skillMd({ name: 'pdf', description: 'Fill PDF forms and merge PDF files. Use when filling a PDF form.' }));
    const prompts = path.join(tmp(), 'prompts.txt');
    writeFileSync(prompts, '# comment\nmerge two PDF files\n');
    const r = await json(['diff', repo, '--base-ref', 'HEAD', '--prompts', prompts]);
    expect(r.code).toBe(0);
    expect(r.data.descriptionChanged).toEqual(['pdf']);
    expect(r.data.changes).toEqual([{ prompt: 'merge two PDF files', owner: null, before: null, after: 'pdf' }]);
    const bad = await cli(['diff', repo, '--base-ref', 'nope-ref']);
    expect(bad.code).toBe(2);
    expect(bad.err).toMatch(/cannot read nope-ref/);
  });
});
