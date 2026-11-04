import { describe, expect, it } from 'vitest';
import { parseFrontmatterYaml, parseSkillText, splitFrontmatter } from '../src/parse.js';

const sf = { dir: '/x/my-skill', file: '/x/my-skill/SKILL.md', fileName: 'SKILL.md' };

describe('splitFrontmatter', () => {
  it('splits a normal file and reports line numbers', () => {
    const r = splitFrontmatter('---\nname: a\n---\n# Body\n');
    expect(r.problem).toBeUndefined();
    expect(r.yaml).toBe('name: a');
    expect(r.body).toBe('# Body\n');
    expect(r.yamlStartLine).toBe(2);
    expect(r.bodyStartLine).toBe(4);
  });

  it('reports missing frontmatter', () => {
    const r = splitFrontmatter('# Just markdown\n');
    expect(r.yaml).toBeNull();
    expect(r.problem?.code).toBe('frontmatter-missing');
  });

  it('reports frontmatter that does not start on line 1', () => {
    const r = splitFrontmatter('\n\n---\nname: a\n---\nbody');
    expect(r.problem?.code).toBe('frontmatter-not-at-start');
  });

  it('reports an unterminated block', () => {
    const r = splitFrontmatter('---\nname: a\ndescription: b\n# no closing fence\n');
    expect(r.problem?.code).toBe('frontmatter-unterminated');
  });

  it('accepts a closing "..." fence and trailing spaces after ---', () => {
    expect(splitFrontmatter('---  \nname: a\n...\nbody').yaml).toBe('name: a');
  });

  it('handles an empty file', () => {
    expect(splitFrontmatter('').problem?.code).toBe('frontmatter-missing');
  });
});

describe('parseFrontmatterYaml', () => {
  it('records the line of each top-level key', () => {
    const r = parseFrontmatterYaml('name: a\n\ndescription: >\n  folded\n  text\nlicense: MIT', 2);
    expect(r.value).toEqual({ name: 'a', description: 'folded text\n', license: 'MIT' });
    expect(r.fieldLines).toEqual({ name: 2, description: 4, license: 7 });
  });

  it('flags invalid YAML with a hint about unquoted colons', () => {
    const r = parseFrontmatterYaml('name: a\ndescription: Use this: for things: here', 2);
    expect(r.value).toBeNull();
    expect(r.findings[0]?.code).toBe('frontmatter-invalid-yaml');
    expect(r.findings[0]?.message).toMatch(/quote/i);
  });

  it('flags duplicate keys', () => {
    const r = parseFrontmatterYaml('name: a\nname: b', 2);
    expect(r.findings.map((f) => f.code)).toContain('frontmatter-invalid-yaml');
  });

  it('flags a non-mapping and an empty block', () => {
    expect(parseFrontmatterYaml('- a\n- b', 2).findings[0]?.code).toBe('frontmatter-not-mapping');
    expect(parseFrontmatterYaml('just a string', 2).findings[0]?.code).toBe('frontmatter-not-mapping');
    expect(parseFrontmatterYaml('   \n', 2).findings[0]?.code).toBe('frontmatter-empty');
  });
});

describe('parseSkillText', () => {
  it('normalises CRLF and records it', () => {
    const s = parseSkillText(sf, '---\r\nname: my-skill\r\ndescription: Does things. Use when needed.\r\n---\r\n\r\n# Body\r\n');
    expect(s.hadCrlf).toBe(true);
    expect(s.name).toBe('my-skill');
    expect(s.description).toBe('Does things. Use when needed.');
    expect(s.body).not.toContain('\r');
    expect(s.parseFindings).toEqual([]);
  });

  it('strips a UTF-8 BOM and records it', () => {
    const s = parseSkillText(sf, '\uFEFF---\nname: my-skill\ndescription: x\n---\nbody');
    expect(s.hadBom).toBe(true);
    expect(s.name).toBe('my-skill');
  });

  it('keeps unicode text intact', () => {
    const s = parseSkillText(sf, '---\nname: my-skill\ndescription: "Résumé helper – 履歴書を作成します 📄"\n---\n本文\n');
    expect(s.description).toBe('Résumé helper – 履歴書を作成します 📄');
    expect(s.body).toBe('本文\n');
  });

  it('turns a missing frontmatter into a finding and an empty name', () => {
    const s = parseSkillText(sf, '# Title only\n');
    expect(s.frontmatter).toBeNull();
    expect(s.name).toBe('');
    expect(s.parseFindings.map((f) => f.code)).toEqual(['frontmatter-missing']);
    expect(s.parseFindings[0]?.file).toBe(sf.file);
  });
});
