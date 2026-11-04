import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { findTestFile, parseTestFile, TestFileError } from '../src/testfile.js';
import { tmp, writeTree } from './helpers.js';

const parse = (content: string, name = 'triggers.yaml') => parseTestFile(name, content);

describe('trigger test files', () => {
  it('parses the YAML format with strings and objects', () => {
    const s = parse('threshold: 0.3\nshould_trigger:\n  - fill this form\n  - prompt: complete the PDF\n    top: 2\nshould_not_trigger:\n  - merge docs\n  - prompt: weather?\n    expect: none\n');
    expect(s.threshold).toBe(0.3);
    expect(s.cases).toEqual([
      { prompt: 'fill this form', shouldTrigger: true, top: 1 },
      { prompt: 'complete the PDF', shouldTrigger: true, top: 2, expect: undefined },
      { prompt: 'merge docs', shouldTrigger: false, top: 1 },
      { prompt: 'weather?', shouldTrigger: false, top: 1, expect: 'none' },
    ]);
  });

  it('parses the skill-creator eval set format (JSON array)', () => {
    const s = parse('[{"query": "fill form", "should_trigger": true}, {"query": "merge", "should_trigger": false}]', 'evals/eval_set.json');
    expect(s.cases.map((c) => [c.prompt, c.shouldTrigger])).toEqual([
      ['fill form', true],
      ['merge', false],
    ]);
  });

  it('handles CRLF, BOM and unicode prompts', () => {
    const s = parse('\uFEFFshould_trigger:\r\n  - "请填写这个表格"\r\n  - Résumé PDF ausfüllen\r\n');
    expect(s.cases.map((c) => c.prompt)).toEqual(['请填写这个表格', 'Résumé PDF ausfüllen']);
  });

  const bad: [string, string, RegExp][] = [
    ['unknown top-level key', 'should_trigger: [a]\nshould_not: [b]\n', /unknown top-level key "should_not"/],
    ['threshold out of range', 'threshold: 2\nshould_trigger: [a]\n', /threshold/],
    ['not a list', 'should_trigger: a\n', /must be a list/],
    ['empty prompt', 'should_trigger: [""]\n', /empty prompt/],
    ['bad top', 'should_trigger:\n  - {prompt: a, top: 0}\n', /positive integer/],
    ['expect in should_trigger', 'should_trigger:\n  - {prompt: a, expect: b}\n', /only valid in should_not_trigger/],
    ['unknown case key', 'should_trigger:\n  - {prompt: a, weight: 2}\n', /unknown key "weight"/],
    ['no cases', 'should_trigger: []\n', /no test cases/],
    ['scalar document', 'hello\n', /expected a mapping/],
    ['invalid yaml', 'should_trigger: [a\n', /cannot parse/],
  ];
  for (const [label, content, re] of bad) {
    it(`rejects: ${label}`, () => {
      expect(() => parse(content)).toThrow(TestFileError);
      expect(() => parse(content)).toThrow(re);
    });
  }

  it('rejects eval-set items without should_trigger', () => {
    expect(() => parse('[{"query": "x"}]', 'x.json')).toThrow(/should_trigger/);
  });

  it('finds the test file by priority', () => {
    const root = writeTree(tmp(), { 'evals/eval_set.json': '[]', 'skill.test.yaml': 'x' });
    expect(path.basename(findTestFile(root)!)).toBe('skill.test.yaml');
    expect(findTestFile(tmp())).toBeNull();
  });
});
