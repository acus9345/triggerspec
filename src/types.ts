export type Severity = 'error' | 'warning' | 'info';

export interface Finding {
  /** Stable rule id, e.g. `broken-link`. */
  code: string;
  severity: Severity;
  message: string;
  /** Absolute path of the file the finding is about. */
  file?: string;
  /** 1-based line number inside `file`. */
  line?: number;
  /** Skill directory (absolute) the finding belongs to. */
  skillDir?: string;
  /** Absolute paths of all files an aggregated finding covers (e.g. crlf-line-endings). */
  files?: string[];
}

export interface SkillFile {
  /** Absolute path to the skill directory. */
  dir: string;
  /** Absolute path to SKILL.md (or the wrongly-cased variant that was found). */
  file: string;
  /** Name of the skill file as found on disk (normally `SKILL.md`). */
  fileName: string;
}

export interface ParsedSkill extends SkillFile {
  /** Raw file contents. */
  raw: string;
  /** Contents with BOM stripped and CRLF/CR normalized to LF. */
  text: string;
  hadBom: boolean;
  hadCrlf: boolean;
  /** Parsed frontmatter mapping or null when missing/invalid. */
  frontmatter: Record<string, unknown> | null;
  /** 1-based line of each top-level frontmatter key in SKILL.md. */
  fieldLines: Record<string, number>;
  /** Markdown body after the closing fence. */
  body: string;
  /** 1-based line number in SKILL.md where the body starts. */
  bodyStartLine: number;
  /** Problems found while splitting / parsing the frontmatter. */
  parseFindings: Finding[];
  /** Convenience accessors (empty string when absent or not a string). */
  name: string;
  description: string;
}
