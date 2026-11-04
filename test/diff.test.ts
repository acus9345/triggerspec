import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadCatalog } from '../src/catalog.js';
import { checkoutRoutingFiles, diffCatalogs } from '../src/diff.js';
import { skillMd, tmp, writeTree } from './helpers.js';

const hasGit = spawnSync('git', ['--version']).status === 0;

const pdfV1 = skillMd({ name: 'pdf-forms', description: 'Fill in PDF forms and extract form fields. Use when the user asks to fill out a PDF form.' });
const pdfV2 = skillMd({ name: 'pdf-forms', description: 'Work with documents. Use for document tasks.' });
const csv = skillMd({ name: 'csv-charts', description: 'Turn CSV data into charts and spreadsheets. Use for plotting CSV files.' });
const wizard = skillMd({ name: 'form-wizard', description: 'Fill out PDF forms.' });
const tests = 'should_trigger:\n  - fill out this PDF form\nshould_not_trigger:\n  - plot my CSV file\n';

describe('diffCatalogs', () => {
  it('reports description changes, winner changes and regressions', async () => {
    const base = loadCatalog(writeTree(tmp(), { 'pdf-forms/SKILL.md': pdfV1, 'pdf-forms/triggers.yaml': tests, 'csv-charts/SKILL.md': csv }));
    const head = loadCatalog(
      writeTree(tmp(), {
        'pdf-forms/SKILL.md': pdfV2,
        'pdf-forms/triggers.yaml': tests,
        'csv-charts/SKILL.md': csv,
        'form-wizard/SKILL.md': wizard,
      }),
    );
    const d = await diffCatalogs(base, head, { prompts: ['fill a form'] });
    expect(d.added).toEqual(['form-wizard']);
    expect(d.removed).toEqual([]);
    expect(d.descriptionChanged).toEqual(['pdf-forms']);
    expect(d.changes).toContainEqual({ prompt: 'fill out this PDF form', owner: 'pdf-forms', before: 'pdf-forms', after: 'form-wizard' });
    expect(d.changes).toContainEqual({ prompt: 'fill a form', owner: null, before: 'pdf-forms', after: 'form-wizard' });
    expect(d.regressions).toEqual([{ skill: 'pdf-forms', prompt: 'fill out this PDF form', shouldTrigger: true, reason: expect.stringContaining('form-wizard') }]);
    expect(d.fixes).toEqual([]);
    expect(d.prompts).toBe(3);
  });

  it('reports fixes when a change makes a failing case pass', async () => {
    const base = loadCatalog(writeTree(tmp(), { 'pdf-forms/SKILL.md': pdfV2, 'pdf-forms/triggers.yaml': tests, 'csv-charts/SKILL.md': csv, 'form-wizard/SKILL.md': wizard }));
    const head = loadCatalog(writeTree(tmp(), { 'pdf-forms/SKILL.md': pdfV1, 'pdf-forms/triggers.yaml': tests, 'csv-charts/SKILL.md': csv }));
    const d = await diffCatalogs(base, head);
    expect(d.fixes).toEqual([{ skill: 'pdf-forms', prompt: 'fill out this PDF form', shouldTrigger: true }]);
    expect(d.regressions).toEqual([]);
  });

  it('identical catalogs produce an empty diff', async () => {
    const files = { 'pdf-forms/SKILL.md': pdfV1, 'pdf-forms/triggers.yaml': tests };
    const d = await diffCatalogs(loadCatalog(writeTree(tmp(), files)), loadCatalog(writeTree(tmp(), files)));
    expect([d.added, d.removed, d.descriptionChanged, d.changes, d.regressions, d.fixes]).toEqual([[], [], [], [], [], []]);
  });
});

describe.skipIf(!hasGit)('checkoutRoutingFiles (git)', () => {
  it('materializes SKILL.md and trigger files at a ref, for a subfolder of the repo', async () => {
    const repo = tmp();
    const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd: repo, stdio: 'pipe' });
    git('init', '-q');
    writeTree(repo, { 'skills/pdf-forms/SKILL.md': pdfV1, 'skills/pdf-forms/triggers.yaml': tests, 'skills/pdf-forms/scripts/big.py': 'x = 1\n', 'skills/csv-charts/SKILL.md': csv, 'README.md': '# repo' });
    git('add', '.');
    git('commit', '-q', '-m', 'base');
    writeFileSync(path.join(repo, 'skills/pdf-forms/SKILL.md'), pdfV2);
    writeTree(repo, { 'skills/form-wizard/SKILL.md': wizard });
    git('add', '.');
    git('commit', '-q', '-m', 'head');

    const co = checkoutRoutingFiles(path.join(repo, 'skills'), 'HEAD~1');
    try {
      expect(existsSync(path.join(co.path, 'pdf-forms', 'SKILL.md'))).toBe(true);
      expect(existsSync(path.join(co.path, 'pdf-forms', 'triggers.yaml'))).toBe(true);
      expect(existsSync(path.join(co.path, 'pdf-forms', 'scripts', 'big.py'))).toBe(false);
      const base = loadCatalog(co.path);
      expect(base.skills.find((s) => s.name === 'pdf-forms')?.description).toMatch(/Fill in PDF forms/);
      const d = await diffCatalogs(base, loadCatalog(path.join(repo, 'skills')));
      expect(d.regressions).toHaveLength(1);
    } finally {
      co.cleanup();
    }
    expect(existsSync(co.path)).toBe(false);
  });

  it('throws for an unknown ref', () => {
    const repo = tmp();
    execFileSync('git', ['init', '-q'], { cwd: repo });
    expect(() => checkoutRoutingFiles(repo, 'does-not-exist')).toThrow();
  });
});
