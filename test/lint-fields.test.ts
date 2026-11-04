import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { lintCatalog, lintSkill } from '../src/lint.js';
import { loadSkill } from '../src/parse.js';
import { byCode, codes, GOOD_DESC, lintDir, load, makeSkill, skillMd, tmp, writeTree } from './helpers.js';

/** Lint a single skill whose folder is `dir` and frontmatter is `fm`. */
function lintFm(fm: string, dir = 'my-skill', body?: string, extra: Record<string, string> = {}) {
  const root = tmp();
  writeTree(root, { [`${dir}/SKILL.md`]: skillMd(fm, body), ...Object.fromEntries(Object.entries(extra).map(([k, v]) => [`${dir}/${k}`, v])) });
  return lintDir(path.join(root, dir));
}
const desc = `description: ${GOOD_DESC}`;

describe('a valid skill', () => {
  it('has no findings', () => {
    expect(lintDir(makeSkill('csv-to-excel'))).toEqual([]);
  });
});

describe('frontmatter structure', () => {
  it('missing frontmatter is an error and stops field checks', () => {
    const root = tmp();
    writeTree(root, { 'my-skill/SKILL.md': '# No frontmatter\n' });
    expect(codes(lintDir(path.join(root, 'my-skill')))).toEqual(['frontmatter-missing']);
  });

  it('invalid YAML reports the line', () => {
    const f = lintFm(`name: my-skill\ndescription: Use this: when x: y`);
    const yamlErr = byCode(f, 'frontmatter-invalid-yaml')[0];
    expect(yamlErr?.severity).toBe('error');
    expect(yamlErr?.line).toBe(3);
  });
});

describe('name rules', () => {
  const cases: [string, string, string][] = [
    ['missing', `${desc}`, 'name-missing'],
    ['empty', `name: ""\n${desc}`, 'name-missing'],
    ['not a string', `name: 42\n${desc}`, 'name-type'],
    ['uppercase', `name: My-Skill\n${desc}`, 'name-format'],
    ['underscore', `name: my_skill\n${desc}`, 'name-format'],
    ['leading hyphen', `name: -my-skill\n${desc}`, 'name-hyphen-edge'],
    ['trailing hyphen', `name: my-skill-\n${desc}`, 'name-hyphen-edge'],
    ['consecutive hyphens', `name: my--skill\n${desc}`, 'name-consecutive-hyphens'],
    ['too long', `name: ${'a'.repeat(65)}\n${desc}`, 'name-too-long'],
    ['folder mismatch', `name: other-name\n${desc}`, 'name-dir-mismatch'],
    ['whitespace', `name: " my-skill"\n${desc}`, 'name-whitespace'],
  ];
  for (const [label, fm, code] of cases) {
    it(`${label} -> ${code}`, () => {
      expect(codes(lintFm(fm))).toContain(code);
    });
  }

  it('accepts exactly 64 characters', () => {
    const n = 'a'.repeat(64);
    expect(lintFm(`name: ${n}\n${desc}`, n)).toEqual([]);
  });

  it('non-ASCII lowercase letters are a warning, not an error', () => {
    const f = lintFm(`name: résumé-helper\n${desc}`, 'résumé-helper');
    expect(codes(f)).toEqual(['name-non-ascii']);
    expect(f[0]!.severity).toBe('warning');
  });

  it('matches NFC/NFD-normalised folder names', () => {
    const nfd = 'cafe\u0301-tools'; // e + combining accent
    const nfc = 'caf\u00e9-tools';
    expect(codes(lintFm(`name: ${nfc}\n${desc}`, nfd))).not.toContain('name-dir-mismatch');
  });

  it('reserved words are info', () => {
    const f = lintFm(`name: claude-helper\n${desc}`, 'claude-helper');
    expect(byCode(f, 'name-reserved-word')[0]?.severity).toBe('info');
  });
});

describe('description rules', () => {
  it('missing / empty / wrong type are errors', () => {
    expect(codes(lintFm('name: my-skill'))).toContain('description-missing');
    expect(codes(lintFm('name: my-skill\ndescription: "  "'))).toContain('description-missing');
    expect(codes(lintFm('name: my-skill\ndescription: [a, b]'))).toContain('description-type');
  });

  it('1024 characters is fine, 1025 is an error (unicode counted by code point)', () => {
    const ok = 'Use when ' + 'é'.repeat(1015);
    expect([...ok].length).toBe(1024);
    expect(codes(lintFm(`name: my-skill\ndescription: ${ok}`))).not.toContain('description-too-long');
    expect(codes(lintFm(`name: my-skill\ndescription: ${ok}x`))).toContain('description-too-long');
  });

  it('short descriptions warn; angle brackets warn; missing "when" is info', () => {
    const f = lintFm('name: my-skill\ndescription: Formats <b>tables</b>.');
    expect(byCode(f, 'description-too-short')[0]?.severity).toBe('warning');
    expect(byCode(f, 'description-angle-brackets')[0]?.severity).toBe('warning');
    expect(byCode(f, 'description-no-trigger-context')[0]?.severity).toBe('info');
  });

  it('flags hidden unicode in the description', () => {
    const f = lintFm(`name: my-skill\ndescription: "${GOOD_DESC}\u200b"`);
    expect(codes(f)).toContain('hidden-unicode');
  });

  it('block scalars are supported', () => {
    expect(lintFm(`name: my-skill\ndescription: >-\n  ${GOOD_DESC}`)).toEqual([]);
  });
});

describe('other fields', () => {
  it('unknown fields warn; Claude Code fields are info unless --spec-only', () => {
    const f = lintFm(`name: my-skill\n${desc}\ncolour: blue\nwhen_to_use: when x`);
    expect(byCode(f, 'unknown-field').map((x) => x.message)).toEqual([expect.stringContaining('"colour"')]);
    expect(byCode(f, 'client-extension-field')[0]?.severity).toBe('info');
    const root = tmp();
    writeTree(root, { 'my-skill/SKILL.md': skillMd(`name: my-skill\n${desc}\nwhen_to_use: when x`) });
    const strict = lintSkill(load(path.join(root, 'my-skill')), { specOnly: true, execChecks: false });
    expect(codes(strict)).toEqual(['unknown-field']);
  });

  it('compatibility must be a 1-500 character string', () => {
    expect(codes(lintFm(`name: my-skill\n${desc}\ncompatibility: 3`))).toContain('compatibility-type');
    expect(codes(lintFm(`name: my-skill\n${desc}\ncompatibility: "${'x'.repeat(501)}"`))).toContain('compatibility-length');
    expect(lintFm(`name: my-skill\n${desc}\ncompatibility: Requires python3 and network access`)).toEqual([]);
  });

  it('license must be a string; a referenced license file must exist', () => {
    expect(codes(lintFm(`name: my-skill\n${desc}\nlicense: [MIT]`))).toContain('license-type');
    expect(codes(lintFm(`name: my-skill\n${desc}\nlicense: Proprietary. LICENSE.txt has complete terms`))).toContain('license-file-missing');
    expect(lintFm(`name: my-skill\n${desc}\nlicense: Proprietary. LICENSE.txt has complete terms`, 'my-skill', undefined, { 'LICENSE.txt': 'terms' })).toEqual([]);
    expect(lintFm(`name: my-skill\n${desc}\nlicense: Apache-2.0`)).toEqual([]);
  });

  it('metadata must be a string map', () => {
    expect(codes(lintFm(`name: my-skill\n${desc}\nmetadata: nope`))).toContain('metadata-type');
    const f = lintFm(`name: my-skill\n${desc}\nmetadata:\n  version: 1.0\n  author: me`);
    expect(byCode(f, 'metadata-value-type')[0]?.message).toContain('version');
  });

  it('allowed-tools: string ok, list is info, other types error', () => {
    expect(lintFm(`name: my-skill\n${desc}\nallowed-tools: Bash(git:*) Read`)).toEqual([]);
    expect(byCode(lintFm(`name: my-skill\n${desc}\nallowed-tools: [Bash, Read]`), 'allowed-tools-list')[0]?.severity).toBe('info');
    expect(codes(lintFm(`name: my-skill\n${desc}\nallowed-tools: 5`))).toContain('allowed-tools-type');
    expect(codes(lintFm(`name: my-skill\n${desc}\nallowed-tools: [Bash, 3]`))).toContain('allowed-tools-type');
  });
});

describe('file-level rules', () => {
  it('CRLF is only an info, BOM warns, and the skill is otherwise parsed', () => {
    const dir = makeSkill('crlf-skill', { 'SKILL.md': '\uFEFF' + skillMd({ name: 'crlf-skill', description: GOOD_DESC }).replace(/\n/g, '\r\n') });
    const f = lintDir(dir);
    expect(codes(f)).toEqual(['crlf-line-endings', 'utf8-bom']);
    expect(f.find((x) => x.code === 'crlf-line-endings')!.severity).toBe('info');
    expect(f.find((x) => x.code === 'utf8-bom')!.severity).toBe('warning');
  });

  it('wrong-case skill.md is an error', () => {
    const root = tmp();
    writeTree(root, { 'my-skill/skill.md': skillMd({ name: 'my-skill', description: GOOD_DESC }) });
    expect(codes(lintDir(path.join(root, 'my-skill')))).toContain('skill-file-case');
  });

  it('empty body warns', () => {
    expect(codes(lintFm(`name: my-skill\n${desc}`, 'my-skill', ''))).toEqual(['body-empty']);
  });

  it('line and token budgets', () => {
    const long = Array.from({ length: 501 }, (_, i) => `line ${i}`).join('\n');
    expect(codes(lintFm(`name: my-skill\n${desc}`, 'my-skill', long))).toContain('body-too-long');
    const dir = makeSkill('big', { 'SKILL.md': skillMd({ name: 'big', description: GOOD_DESC }, 'word '.repeat(30)) });
    expect(codes(lintSkill(load(dir), { maxBodyTokens: 10, execChecks: false }))).toEqual(['body-too-many-tokens']);
    expect(codes(lintSkill(load(dir), { maxBodyLines: 5, maxBodyTokens: 1e6, execChecks: false }))).toEqual([]);
  });

  it('counts CJK text conservatively for the token budget', () => {
    const dir = makeSkill('cjk', { 'SKILL.md': skillMd({ name: 'cjk', description: GOOD_DESC }, '漢字'.repeat(3000)) });
    expect(codes(lintDir(dir))).toContain('body-too-many-tokens');
  });

  it('hidden bidi characters in the body warn with a line number', () => {
    const f = lintFm(`name: my-skill\n${desc}`, 'my-skill', 'ok\nevil \u202e text\n');
    const h = byCode(f, 'hidden-unicode')[0];
    expect(h?.line).toBe(7);
    expect(h?.message).toContain('U+202E');
  });

  it('--disable drops rule codes', () => {
    const dir = makeSkill('x-skill', { 'SKILL.md': skillMd({ name: 'other', description: GOOD_DESC }) });
    expect(codes(lintSkill(load(dir), { disable: new Set(['name-dir-mismatch']), execChecks: false }))).toEqual([]);
  });
});

describe('catalog rules', () => {
  it('duplicate names across folders are errors on both', () => {
    const root = tmp();
    writeTree(root, {
      'a/dup/SKILL.md': skillMd({ name: 'dup', description: GOOD_DESC }),
      'b/dup/SKILL.md': skillMd({ name: 'dup', description: GOOD_DESC }),
    });
    const skills = [path.join(root, 'a', 'dup'), path.join(root, 'b', 'dup')].map((d) => load(d));
    const f = lintCatalog(skills);
    expect(f.map((x) => x.code)).toEqual(['duplicate-name', 'duplicate-name']);
    expect(f[0]!.message).toContain('b/dup');
  });

  it('reports invalid trigger test files', () => {
    const dir = makeSkill('t-skill', { 'triggers.yaml': 'should_trigger: [ok]\nshuld_not_trigger: [x]\n' });
    const f = byCode(lintDir(dir), 'trigger-file-invalid');
    expect(f[0]?.message).toContain('shuld_not_trigger');
  });

  it('loads skills through loadSkill for single files', () => {
    const dir = makeSkill('single');
    const s = loadSkill({ dir, file: path.join(dir, 'SKILL.md'), fileName: 'SKILL.md' });
    expect(s.name).toBe('single');
  });
});
