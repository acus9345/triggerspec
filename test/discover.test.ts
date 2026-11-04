import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { discoverSkills, findSkillFileName } from '../src/discover.js';
import { skillMd, tmp, writeTree } from './helpers.js';

const md = (name: string) => skillMd({ name, description: 'x' });

describe('discoverSkills', () => {
  it('finds skills in nested folders, sorted, and skips node_modules/.git', () => {
    const root = writeTree(tmp(), {
      'b-skill/SKILL.md': md('b-skill'),
      'group/a-skill/SKILL.md': md('a-skill'),
      'group/deeper/c-skill/SKILL.md': md('c-skill'),
      'node_modules/pkg/SKILL.md': md('pkg'),
      '.git/x/SKILL.md': md('x'),
    });
    const found = discoverSkills(root).map((s) => path.relative(root, s.dir).split(path.sep).join('/'));
    expect(found).toEqual(['b-skill', 'group/a-skill', 'group/deeper/c-skill']);
  });

  it('does not descend into a skill folder (examples inside a skill are not separate skills)', () => {
    const root = writeTree(tmp(), {
      'outer/SKILL.md': md('outer'),
      'outer/assets/template/SKILL.md': md('template'),
    });
    expect(discoverSkills(root).map((s) => path.basename(s.dir))).toEqual(['outer']);
  });

  it('accepts a skill folder or the SKILL.md file itself', () => {
    const root = writeTree(tmp(), { 'one/SKILL.md': md('one') });
    expect(discoverSkills(path.join(root, 'one'))).toHaveLength(1);
    const viaFile = discoverSkills(path.join(root, 'one', 'SKILL.md'));
    expect(viaFile).toHaveLength(1);
    expect(viaFile[0]!.dir).toBe(path.join(root, 'one'));
  });

  it('detects a wrongly-cased skill.md', () => {
    const root = writeTree(tmp(), { 'lower/skill.md': md('lower') });
    expect(findSkillFileName(path.join(root, 'lower'))).toBe('skill.md');
    const [s] = discoverSkills(root);
    expect(s?.fileName).toBe('skill.md');
  });

  it('accepts Windows-style separators in the input path', () => {
    const root = writeTree(tmp(), { 'win/SKILL.md': md('win') });
    const winish = root + '\\win';
    // On POSIX a backslash is a valid filename character, so only test what is meaningful.
    if (process.platform === 'win32') expect(discoverSkills(winish)).toHaveLength(1);
    else expect(discoverSkills(path.join(root, 'win'))).toHaveLength(1);
  });

  it('throws ENOENT for a missing path', () => {
    expect(() => discoverSkills(path.join(tmp(), 'nope'))).toThrow(/ENOENT|no such/i);
  });
});
