import { writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { classifyTarget } from '../src/lint.js';
import { extractLinks } from '../src/markdown.js';
import { byCode, codes, GOOD_DESC, lintDir, makeSkill, skillMd } from './helpers.js';

const withBody = (name: string, body: string, files: Record<string, string> = {}) =>
  lintDir(makeSkill(name, { 'SKILL.md': skillMd({ name, description: GOOD_DESC }, body), ...files }));

describe('links', () => {
  it('accepts existing relative links, anchors and ./ prefixes', () => {
    const f = withBody('s', 'See [api](references/api.md#auth-flow), [img](./assets/logo.png) and [top](#usage).\n\n## Usage\n', {
      'references/api.md': '# API\n\n## Auth flow\n',
      'assets/logo.png': 'png',
    });
    expect(f).toEqual([]);
  });

  it('broken links are errors with a line number', () => {
    const f = withBody('s', 'one\n\nSee [guide](references/guide.md).\n');
    const b = byCode(f, 'broken-link')[0];
    expect(b?.severity).toBe('error');
    expect(b?.line).toBe(8);
  });

  it('mentions the case mismatch for links that only differ in case', () => {
    const f = withBody('s', 'See [guide](references/Guide.md).', { 'references/guide.md': '# g' });
    expect(byCode(f, 'broken-link')[0]?.message).toMatch(/different letter case/);
    expect(codes(f)).not.toContain('orphan-file');
  });

  it('broken anchors warn, in the same file and in other files', () => {
    const f = withBody('s', '[a](#nope) [b](references/api.md#missing)\n\n## Real heading\n', { 'references/api.md': '# API\n' });
    expect(byCode(f, 'broken-anchor')).toHaveLength(2);
  });

  it('decodes percent-encoded anchors and unicode headings', () => {
    const f = withBody('s', '[a](#%C3%BCber-uns) [b](#日本語の見出し)\n\n## Über uns\n\n## 日本語の見出し\n');
    expect(f).toEqual([]);
  });

  it('ignores URLs, mailto, placeholders and links inside code', () => {
    const f = withBody('s', '[x](https://example.com/a.md) [m](mailto:a@b.c) [Title](URL) [p](path/to/file.md)\n\n```md\n[x](references/missing.md)\n```\n\n`[y](references/missing2.md)`\n');
    expect(f).toEqual([]);
  });

  it('absolute paths warn', () => {
    expect(codes(withBody('s', '[cfg](/etc/app/config.md) [w](C:/Users/me/a.md)'))).toEqual(['absolute-path', 'absolute-path']);
  });

  it('Windows backslash links warn but still resolve', () => {
    const f = withBody('s', 'Read [api](references\\api.md).', { 'references/api.md': '# API' });
    expect(codes(f)).toEqual(['windows-path-separator']);
  });

  it('links outside the skill folder warn', () => {
    expect(codes(withBody('s', '[shared](../shared.md)', {}))).toContain('broken-link');
    const dir = makeSkill('s', { 'SKILL.md': skillMd({ name: 's', description: GOOD_DESC }, '[shared](../shared.md)') });
    writeFileSync(path.join(dir, '..', 'shared.md'), 'x');
    expect(codes(lintDir(dir))).toEqual(['reference-outside-skill']);
  });

  it('reference-style link definitions are checked', () => {
    expect(codes(withBody('s', 'See [the guide][g].\n\n[g]: references/gone.md\n'))).toEqual(['broken-link']);
  });
});

describe('path mentions', () => {
  it('missing scripts mentioned in commands warn', () => {
    const f = withBody('s', 'Run `python3 scripts/run.py input.csv`.', { 'scripts/other.py': 'print(1)\n' });
    expect(byCode(f, 'missing-file')[0]?.message).toContain('scripts/run.py');
  });

  it('does not report mentions when the folder is not part of the skill', () => {
    expect(withBody('s', 'Create `scripts/deploy.sh` in the user project.')).toEqual([]);
  });

  it('suggests the file when the extension was left off', () => {
    const f = withBody('s', 'Run `python scripts/check_fields <file.pdf>`.', { 'scripts/check_fields.py': 'print(1)\n' });
    expect(byCode(f, 'missing-file')[0]?.message).toContain('did you mean scripts/check_fields.py');
  });

  it('ignores optional files ("if it exists"), tree drawings and extensionless prose', () => {
    const f = withBody('s', 'Use `scripts/full.mjs` if it exists, else `scripts/lite.mjs`.\n\n```\n├── scripts/\n│   └── smoke.ts\n```\n\nPick curl/httpx or scripts/tools.\n', {
      'scripts/lite.mjs': 'console.log(1)\n',
    });
    expect(f).toEqual([]);
  });

  it('path-case-mismatch for bare file names and resource paths', () => {
    const f = withBody('s', 'For details see REFERENCE.md. Then run scripts/Fill.py.', { 'reference.md': '# r', 'scripts/fill.py': 'print(1)\n' });
    expect(byCode(f, 'path-case-mismatch').map((x) => x.message)).toEqual([expect.stringContaining('scripts/fill.py'), expect.stringContaining('reference.md')].sort(() => 0));
    expect(codes(f)).not.toContain('orphan-file');
  });

  it('Windows-style backslash mentions warn and count as references', () => {
    const f = withBody('s', 'Run `scripts\\build.py`.', { 'scripts/build.py': 'print(1)\n' });
    expect(codes(f)).toEqual(['windows-path-separator']);
  });

  it('code samples in reference files do not produce missing-file', () => {
    const f = withBody('s', 'See [guide](references/guide.md).', {
      'references/guide.md': '# Guide\n\n```json\n{"smoke": "tsx scripts/smoke.ts"}\n```\n',
      'scripts/real.py': 'print(1)\n',
    });
    expect(codes(f)).toEqual(['orphan-file']);
  });
});

describe('orphans and reachability', () => {
  it('flags files nothing refers to; exempts LICENSE, manifests, evals and trigger files', () => {
    const f = withBody('s', 'Body.', {
      'references/unused.md': '# unused',
      'LICENSE.txt': 'MIT',
      'requirements.txt': 'pypdf',
      'evals/evals.json': '[]',
      'triggers.yaml': 'should_trigger: [convert csv files to excel spreadsheets]\n',
    });
    expect(byCode(f, 'orphan-file').map((x) => x.message)).toEqual([expect.stringContaining('references/unused.md')]);
  });

  it('follows references transitively and reports nesting depth as info', () => {
    const f = withBody('s', 'See [a](references/a.md).', {
      'references/a.md': 'Then [b](b.md).',
      'references/b.md': 'Finally run scripts/deep.py',
      'scripts/deep.py': 'print(1)\n',
    });
    expect(codes(f)).toEqual(['nested-reference']);
    expect(f[0]!.severity).toBe('info');
  });

  it('a mentioned directory covers its files', () => {
    expect(withBody('s', 'Fonts live in the `./canvas-fonts` directory. Themes are in `themes/`.', { 'canvas-fonts/a.ttf': 'x', 'canvas-fonts/b.ttf': 'x', 'themes/dark.md': '# d' })).toEqual([]);
  });

  it('a generic folder name in prose does not cover its files, but "scripts/" does', () => {
    expect(codes(withBody('s', 'This skill has some helper scripts.', { 'scripts/a.py': 'print(1)\n' }))).toEqual(['orphan-file']);
    expect(withBody('s', 'Helpers are in `scripts/`.', { 'scripts/a.py': 'print(1)\n' })).toEqual([]);
  });

  it('python modules imported by dotted path or from referenced scripts are referenced', () => {
    expect(withBody('s', '```python\nfrom core.gif_builder import GIFBuilder\n```', { 'core/gif_builder.py': 'x = 1\n', 'core/__init__.py': '' })).toEqual([]);
    expect(withBody('s', 'Run `python scripts/main.py`.', { 'scripts/main.py': 'from helpers import util\nimport lib_tools\n', 'scripts/helpers.py': '', 'scripts/lib_tools.py': '' })).toEqual([]);
  });

  it('JS relative imports count as references', () => {
    expect(withBody('s', 'Run `node scripts/run.mjs`.', { 'scripts/run.mjs': "import { x } from './lib/shared.mjs';\n", 'scripts/lib/shared.mjs': 'export const x = 1;\n' })).toEqual([]);
  });

  it('a used package folder covers its implementation files', () => {
    expect(withBody('s', 'Run `python scripts/office/pack.py`.', { 'scripts/office/pack.py': 'print(1)\n', 'scripts/office/schemas/a.xsd': '<x/>', 'scripts/office/helpers/h.py': '' })).toEqual([]);
  });

  it('works with nested skill folders and unicode file names', () => {
    const f = withBody('s', 'Siehe [Übersicht](references/übersicht.md) und [日本](references/日本.md).', { 'references/übersicht.md': '# Ü', 'references/日本.md': '# 日本' });
    expect(f).toEqual([]);
  });
});

describe('extractLinks', () => {
  it('handles <angle> targets, titles, images and nested brackets', () => {
    const links = extractLinks('[a](<references/a b.md>) ![i](assets/x.png "Logo") [[1]](references/c.md)\n\n    [d]: references/d.md\n', 1);
    expect(links.map((l) => [l.target, l.kind])).toEqual([
      ['references/a b.md', 'inline'],
      ['assets/x.png', 'image'],
      ['references/c.md', 'inline'],
    ]);
  });
});

describe('classifyTarget', () => {
  it('classifies link targets', () => {
    expect(classifyTarget('https://x.y').kind).toBe('skip');
    expect(classifyTarget('#a')).toEqual({ kind: 'fragment', fragment: 'a' });
    expect(classifyTarget('/abs/p.md').kind).toBe('absolute');
    expect(classifyTarget('C:\\x\\y.md').kind).toBe('absolute');
    expect(classifyTarget('references/a b.md')).toMatchObject({ kind: 'path', rel: 'references/a b.md' });
    expect(classifyTarget('references\\a.md')).toMatchObject({ kind: 'path', rel: 'references/a.md', backslash: true });
    expect(classifyTarget('templates/{name}.md').kind).toBe('skip');
    expect(classifyTarget('a%20b.md#x')).toMatchObject({ kind: 'path', rel: 'a b.md', fragment: 'x' });
  });
});
