import { readFileSync } from 'node:fs';
import { isMap, isScalar, parseDocument } from 'yaml';
import type { Finding, ParsedSkill, SkillFile } from './types.js';
import { isPlainObject, lineAt, normalizeNewlines } from './util.js';

const FENCE = /^---[ \t]*$/;
const CLOSE_FENCE = /^(?:---|\.\.\.)[ \t]*$/;

export interface FrontmatterSplit {
  /** YAML text between the fences, or null when there is no frontmatter. */
  yaml: string | null;
  body: string;
  /** 1-based line where the YAML starts (line after the opening fence). */
  yamlStartLine: number;
  bodyStartLine: number;
  problem?: { code: string; message: string; line: number };
}

/** Split normalized (LF) text into frontmatter and body. */
export function splitFrontmatter(text: string): FrontmatterSplit {
  const lines = text.split('\n');
  if (lines.length === 0 || !FENCE.test(lines[0] ?? '')) {
    // Frontmatter that is present but not on line 1 (leading blank lines, a title, ...).
    const idx = lines.findIndex((l) => FENCE.test(l));
    const before = idx > 0 ? lines.slice(0, idx) : [];
    if (idx > 0 && idx < 10 && before.every((l) => l.trim() === '')) {
      return {
        yaml: null,
        body: text,
        yamlStartLine: 0,
        bodyStartLine: 1,
        problem: {
          code: 'frontmatter-not-at-start',
          message: `Frontmatter must start on line 1; found "---" on line ${idx + 1} after blank lines. Most loaders will ignore it.`,
          line: idx + 1,
        },
      };
    }
    return {
      yaml: null,
      body: text,
      yamlStartLine: 0,
      bodyStartLine: 1,
      problem: {
        code: 'frontmatter-missing',
        message: 'SKILL.md must start with YAML frontmatter ("---" on line 1) containing name and description.',
        line: 1,
      },
    };
  }
  for (let i = 1; i < lines.length; i++) {
    if (CLOSE_FENCE.test(lines[i] ?? '')) {
      return {
        yaml: lines.slice(1, i).join('\n'),
        body: lines.slice(i + 1).join('\n'),
        yamlStartLine: 2,
        bodyStartLine: i + 2,
      };
    }
  }
  return {
    yaml: null,
    body: '',
    yamlStartLine: 2,
    bodyStartLine: lines.length + 1,
    problem: {
      code: 'frontmatter-unterminated',
      message: 'Frontmatter opened with "---" on line 1 but never closed with a second "---" line.',
      line: 1,
    },
  };
}

export interface YamlParseResult {
  value: Record<string, unknown> | null;
  fieldLines: Record<string, number>;
  findings: Omit<Finding, 'file' | 'skillDir'>[];
}

/** Parse frontmatter YAML. `startLine` is the SKILL.md line the YAML begins on. */
export function parseFrontmatterYaml(yamlText: string, startLine: number): YamlParseResult {
  const findings: YamlParseResult['findings'] = [];
  const fieldLines: Record<string, number> = {};
  if (yamlText.trim() === '') {
    findings.push({ code: 'frontmatter-empty', severity: 'error', message: 'Frontmatter is empty; name and description are required.', line: startLine });
    return { value: null, fieldLines, findings };
  }
  const doc = parseDocument(yamlText, { uniqueKeys: true, prettyErrors: false, strict: true });
  if (doc.errors.length > 0) {
    const seen = new Set<number>();
    for (const err of doc.errors) {
      const rel = err.linePos?.[0]?.line ?? (err.pos ? lineAt(yamlText, err.pos[0]) : 1);
      if (seen.has(rel)) continue;
      seen.add(rel);
      let message = `Invalid YAML in frontmatter: ${err.message.split('\n')[0]!.replace(/ at line \d+, column \d+:?$/, '')}`;
      if (/nested mappings|compact mapping|implicit map keys/i.test(err.message)) {
        message += ' (hint: a value containing ": " must be quoted, e.g. description: "Use when: ...")';
      }
      findings.push({ code: 'frontmatter-invalid-yaml', severity: 'error', message, line: startLine + rel - 1 });
    }
    return { value: null, fieldLines, findings };
  }
  const contents = doc.contents;
  if (!isMap(contents)) {
    findings.push({ code: 'frontmatter-not-mapping', severity: 'error', message: 'Frontmatter must be a YAML mapping of key: value pairs.', line: startLine });
    return { value: null, fieldLines, findings };
  }
  for (const item of contents.items) {
    const key = item.key;
    if (isScalar(key) && key.range) {
      fieldLines[String(key.value)] = startLine + lineAt(yamlText, key.range[0]) - 1;
    }
  }
  const value: unknown = doc.toJS();
  if (!isPlainObject(value)) {
    findings.push({ code: 'frontmatter-not-mapping', severity: 'error', message: 'Frontmatter must be a YAML mapping of key: value pairs.', line: startLine });
    return { value: null, fieldLines, findings };
  }
  return { value, fieldLines, findings };
}

export function parseSkillText(sf: SkillFile, raw: string): ParsedSkill {
  const hadBom = raw.charCodeAt(0) === 0xfeff;
  const noBom = hadBom ? raw.slice(1) : raw;
  const hadCrlf = /\r/.test(noBom);
  const text = normalizeNewlines(noBom);
  const parseFindings: Finding[] = [];
  const split = splitFrontmatter(text);
  let frontmatter: Record<string, unknown> | null = null;
  let fieldLines: Record<string, number> = {};
  if (split.problem) {
    parseFindings.push({ code: split.problem.code, severity: 'error', message: split.problem.message, line: split.problem.line, file: sf.file, skillDir: sf.dir });
  }
  if (split.yaml !== null) {
    const res = parseFrontmatterYaml(split.yaml, split.yamlStartLine);
    frontmatter = res.value;
    fieldLines = res.fieldLines;
    for (const f of res.findings) parseFindings.push({ ...f, file: sf.file, skillDir: sf.dir });
  }
  const name = typeof frontmatter?.name === 'string' ? frontmatter.name.trim() : '';
  const description = typeof frontmatter?.description === 'string' ? frontmatter.description.trim() : '';
  return {
    ...sf,
    raw,
    text,
    hadBom,
    hadCrlf,
    frontmatter,
    fieldLines,
    body: split.body,
    bodyStartLine: split.bodyStartLine,
    parseFindings,
    name,
    description,
  };
}

export function loadSkill(sf: SkillFile): ParsedSkill {
  return parseSkillText(sf, readFileSync(sf.file, 'utf8'));
}
