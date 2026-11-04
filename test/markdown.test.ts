import { describe, expect, it } from 'vitest';
import { extractPathMentions, headingSlugs, scanLines, slugify, stripInlineCode } from '../src/markdown.js';

describe('markdown helpers', () => {
  it('slugify follows GitHub rules', () => {
    expect(slugify('Hello, World!')).toBe('hello-world');
    expect(slugify('Step 2: Run `fill.py`')).toBe('step-2-run-fillpy');
    expect(slugify('Über uns')).toBe('über-uns');
    expect(slugify('  A -- B ')).toBe('a----b');
  });

  it('headingSlugs de-duplicates like GitHub and ignores headings in code', () => {
    const s = headingSlugs('# Intro\n## Intro\n```\n# not a heading\n```\nSetext\n===\n');
    expect([...s].sort()).toEqual(['intro', 'intro-1', 'setext']);
  });

  it('scanLines tracks fenced code (``` and ~~~)', () => {
    const lines = scanLines('a\n```py\nb\n```\n~~~\nc\n~~~\nd', 10);
    expect(lines.filter((l) => !l.inCode).map((l) => l.text)).toEqual(['a', 'd']);
    expect(lines[0]!.line).toBe(10);
  });

  it('stripInlineCode blanks code spans, keeping columns', () => {
    const src = 'a `[x](y)` b ``c ` d`` e';
    const out = stripInlineCode(src);
    expect(out.length).toBe(src.length);
    expect(out.replace(/ +/g, ' ')).toBe('a b e');
  });

  it('extractPathMentions finds slash and backslash paths in prose and code', () => {
    const m = extractPathMentions('Run `python scripts/fill.py`.\n\n```\npython references\\api.md\n```\nscripts/a.py, and (assets/logo.png).\nnot http://x.com/scripts/x.py', ['scripts', 'references', 'assets']);
    expect(m.map((x) => [x.path, x.inCode])).toEqual([
      ['scripts/fill.py', false],
      ['references\\api.md', true],
      ['scripts/a.py', false],
      ['assets/logo.png', false],
    ]);
  });
});
