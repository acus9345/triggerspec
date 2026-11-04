import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterAll } from 'vitest';
import { discoverSkills } from '../src/discover.js';
import type { FsLike } from '../src/fsx.js';
import { lintSkill, type LintOptions } from '../src/lint.js';
import { loadSkill } from '../src/parse.js';
import type { Finding, ParsedSkill } from '../src/types.js';

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

/** Fresh temp dir, removed after the test file finishes. */
export function tmp(prefix = 'triggerspec-'): string {
  const d = mkdtempSync(path.join(tmpdir(), prefix));
  roots.push(d);
  return d;
}

export type FileSpec = string | Buffer | { content: string | Buffer; mode?: number };

/** Write files (relative POSIX paths) under root. */
export function writeTree(root: string, files: Record<string, FileSpec>): string {
  for (const [rel, spec] of Object.entries(files)) {
    const abs = path.join(root, ...rel.split('/'));
    mkdirSync(path.dirname(abs), { recursive: true });
    const content = typeof spec === 'string' || Buffer.isBuffer(spec) ? spec : spec.content;
    writeFileSync(abs, content);
    if (typeof spec === 'object' && !Buffer.isBuffer(spec) && spec.mode !== undefined) chmodSync(abs, spec.mode);
  }
  return root;
}

export const GOOD_DESC = 'Convert CSV files into formatted Excel spreadsheets with charts. Use when the user asks to turn CSV data into an xlsx report.';

export function skillMd(fm: Record<string, string> | string, body = '# Title\n\nDo the thing.\n'): string {
  const front = typeof fm === 'string' ? fm : Object.entries(fm).map(([k, v]) => `${k}: ${v}`).join('\n');
  return `---\n${front}\n---\n\n${body}`;
}

/** Create one skill folder `name` inside a fresh root and return its dir. */
export function makeSkill(name: string, files: Record<string, FileSpec> = {}, root = tmp()): string {
  const dir = path.join(root, name);
  writeTree(dir, { 'SKILL.md': skillMd({ name, description: GOOD_DESC }), ...files });
  return dir;
}

export function load(dir: string): ParsedSkill {
  const found = discoverSkills(dir);
  if (found.length !== 1) throw new Error(`expected one skill in ${dir}, found ${found.length}`);
  return loadSkill(found[0]!);
}

export function lintDir(dir: string, opts: Partial<LintOptions> = {}): Finding[] {
  return lintSkill(load(dir), { execChecks: false, ...opts });
}

export const codes = (fs: Finding[]) => fs.map((f) => f.code).sort();
export const byCode = (fs: Finding[], code: string) => fs.filter((f) => f.code === code);

export const isWindows = process.platform === 'win32';

/**
 * Simulates a case-insensitive, case-preserving filesystem (Windows NTFS, default macOS
 * APFS) on top of the real one: any spelling of an existing path opens it, and readdir
 * returns the names as stored. This is exactly the behaviour that fooled existsSync.
 */
export function caseInsensitiveFs(): FsLike {
  const map = (p: string): string | null => {
    const abs = path.resolve(p);
    const { root } = path.parse(abs);
    let cur = root;
    for (const seg of abs.slice(root.length).split(path.sep).filter(Boolean)) {
      let names: string[];
      try {
        names = readdirSync(cur);
      } catch {
        return null;
      }
      const hit = names.find((n) => n === seg) ?? names.find((n) => n.toLowerCase() === seg.toLowerCase());
      if (hit === undefined) return null;
      cur = path.join(cur, hit);
    }
    return cur;
  };
  const enoent = (p: string) => Object.assign(new Error(`ENOENT: no such file or directory, '${p}'`), { code: 'ENOENT' });
  const must = (p: string) => {
    const m = map(p);
    if (m === null) throw enoent(p);
    return m;
  };
  return {
    existsSync: (p) => map(p) !== null,
    readdirSync: (p) => readdirSync(must(p)),
    statSync: (p) => statSync(must(p)),
    readFileSync: (p) => readFileSync(must(p)),
  };
}

/** Swap the letter case of every ASCII letter (C:\Users\Me -> c:\uSERS\mE). */
export const swapCase = (s: string) => s.replace(/[a-zA-Z]/g, (c) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase()));
