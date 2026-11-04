import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { isPlainObject, normalizeNewlines } from './util.js';

/** Trigger test files looked up inside each skill folder, in priority order. */
export const TEST_FILE_NAMES = [
  'triggers.yaml',
  'triggers.yml',
  'triggers.json',
  'skill.test.yaml',
  'skill.test.yml',
  'evals/triggers.json',
  'evals/eval_set.json',
];

export interface TriggerCase {
  prompt: string;
  /** true = this skill should be selected; false = it should not. */
  shouldTrigger: boolean;
  /** For should-trigger cases: pass when the skill ranks within the top N (default 1). */
  top: number;
  /** For should-not cases: the skill that is expected to win instead (optional). `none` = no skill. */
  expect?: string;
}

export interface TriggerSpec {
  file: string;
  threshold?: number;
  cases: TriggerCase[];
}

export class TestFileError extends Error {
  constructor(
    message: string,
    public readonly file: string,
  ) {
    super(message);
  }
}

export function findTestFile(skillDir: string): string | null {
  for (const n of TEST_FILE_NAMES) {
    const p = path.join(skillDir, ...n.split('/'));
    if (existsSync(p)) return p;
  }
  return null;
}

/** Parse a trigger test file. Throws TestFileError with a readable message when invalid. */
export function parseTestFile(file: string, content?: string): TriggerSpec {
  const raw = normalizeNewlines((content ?? readFileSync(file, 'utf8')).replace(/^\uFEFF/, ''));
  let data: unknown;
  try {
    data = file.endsWith('.json') ? JSON.parse(raw) : parseYaml(raw, { uniqueKeys: true });
  } catch (e) {
    throw new TestFileError(`cannot parse: ${(e as Error).message.split('\n')[0]}`, file);
  }
  const cases: TriggerCase[] = [];
  let threshold: number | undefined;

  const caseFrom = (item: unknown, shouldTrigger: boolean, where: string): TriggerCase => {
    if (typeof item === 'string') {
      if (item.trim() === '') throw new TestFileError(`${where}: empty prompt`, file);
      return { prompt: item, shouldTrigger, top: 1 };
    }
    if (!isPlainObject(item)) throw new TestFileError(`${where}: expected a string or {prompt: ...}`, file);
    const allowed = new Set(['prompt', 'query', 'top', 'expect', 'should_trigger', 'note', 'id']);
    for (const k of Object.keys(item)) if (!allowed.has(k)) throw new TestFileError(`${where}: unknown key "${k}"`, file);
    const prompt = item.prompt ?? item.query;
    if (typeof prompt !== 'string' || prompt.trim() === '') throw new TestFileError(`${where}: "prompt" must be a non-empty string`, file);
    let top = 1;
    if (item.top !== undefined) {
      if (typeof item.top !== 'number' || !Number.isInteger(item.top) || item.top < 1) throw new TestFileError(`${where}: "top" must be a positive integer`, file);
      top = item.top;
    }
    let expect: string | undefined;
    if (item.expect !== undefined) {
      if (typeof item.expect !== 'string' || item.expect.trim() === '') throw new TestFileError(`${where}: "expect" must be a skill name or "none"`, file);
      if (shouldTrigger) throw new TestFileError(`${where}: "expect" is only valid in should_not_trigger`, file);
      expect = item.expect.trim();
    }
    return { prompt, shouldTrigger, top, expect };
  };

  if (Array.isArray(data)) {
    // Anthropic skill-creator eval set: [{ "query": "...", "should_trigger": true }]
    data.forEach((item, i) => {
      if (!isPlainObject(item) || typeof item.should_trigger !== 'boolean') {
        throw new TestFileError(`item ${i + 1}: expected {"query": string, "should_trigger": boolean}`, file);
      }
      const { should_trigger, ...rest } = item;
      cases.push(caseFrom(rest, should_trigger as boolean, `item ${i + 1}`));
    });
  } else if (isPlainObject(data)) {
    const allowed = new Set(['threshold', 'should_trigger', 'should_not_trigger']);
    for (const k of Object.keys(data)) if (!allowed.has(k)) throw new TestFileError(`unknown top-level key "${k}" (allowed: ${[...allowed].join(', ')})`, file);
    if (data.threshold !== undefined) {
      if (typeof data.threshold !== 'number' || data.threshold < 0 || data.threshold > 1) throw new TestFileError('"threshold" must be a number between 0 and 1', file);
      threshold = data.threshold;
    }
    for (const [key, flag] of [['should_trigger', true], ['should_not_trigger', false]] as const) {
      const list = data[key];
      if (list === undefined || list === null) continue;
      if (!Array.isArray(list)) throw new TestFileError(`"${key}" must be a list`, file);
      list.forEach((item, i) => cases.push(caseFrom(item, flag, `${key}[${i}]`)));
    }
  } else {
    throw new TestFileError('expected a mapping with should_trigger / should_not_trigger, or a JSON array of {query, should_trigger}', file);
  }
  if (cases.length === 0) throw new TestFileError('no test cases', file);
  return { file, threshold, cases };
}
