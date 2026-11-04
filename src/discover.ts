import { readdirSync, realpathSync, statSync } from 'node:fs';
import * as path from 'node:path';
import { errCode, SKIPPABLE_ERRORS, VisitedDirs, type FsLike } from './fsx.js';
import type { SkillFile } from './types.js';
import { expandHome } from './util.js';

const SKIP_DIRS = new Set(['node_modules', '.git', '.hg', '.svn', '__pycache__', '.venv', 'venv']);
const MAX_DEPTH = 12;
/** Upper bound on folders visited by one discovery (protects against hostile link farms). */
export const MAX_DISCOVER_DIRS = 20000;

/** A path that discovery or the skill file walk could not (or chose not to) enter. */
export interface WalkIssue {
  path: string;
  reason: string;
}

/** Returns the skill file name in `dir` (exact `SKILL.md` preferred, then any casing), or null. */
export function findSkillFileName(dir: string): string | null {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return null;
  }
  if (entries.includes('SKILL.md')) return 'SKILL.md';
  const alt = entries.find((e) => e.toLowerCase() === 'skill.md');
  if (alt) {
    try {
      if (statSync(path.join(dir, alt)).isFile()) return alt;
    } catch {
      /* ignore */
    }
  }
  return null;
}

export interface DiscoverOptions {
  /** Called for each folder that was skipped because of an error or a limit. */
  onIssue?: (issue: WalkIssue) => void;
  /** Overrides for tests (realpath quirks, stat identity). */
  fs?: Pick<FsLike, 'statSync' | 'realpathSync'>;
  maxDirs?: number;
}

/**
 * Discover skills under `input`. `input` may be a SKILL.md file, a single skill
 * folder, or any directory tree containing skill folders (nested to any depth).
 * A folder containing SKILL.md is a skill; its subfolders are not searched further.
 */
export function discoverSkills(input: string, options: DiscoverOptions = {}): SkillFile[] {
  const abs = path.resolve(expandHome(input));
  const st = statSync(abs); // throws ENOENT for a missing path; the CLI reports it.
  if (st.isFile()) {
    if (path.basename(abs).toLowerCase() !== 'skill.md') {
      throw new Error(`${input} is a file but not a SKILL.md`);
    }
    return [{ dir: path.dirname(abs), file: abs, fileName: path.basename(abs) }];
  }
  const stat = options.fs?.statSync ?? ((p: string) => statSync(p));
  const visited = new VisitedDirs({
    existsSync: () => true,
    readdirSync: () => [],
    readFileSync: () => Buffer.alloc(0),
    statSync: stat,
    realpathSync: options.fs ? options.fs.realpathSync : (p) => realpathSync.native(p),
  });
  const maxDirs = options.maxDirs ?? MAX_DISCOVER_DIRS;
  const issue = (p: string, reason: string) => options.onIssue?.({ path: p, reason });
  const out: SkillFile[] = [];
  let count = 0;
  let capped = false;
  // Symlinked / junctioned folders are followed (common in ~/.claude/skills). Folders
  // already visited (same real path or same dev/ino) are skipped, so link cycles and
  // duplicate links terminate; depth and total folder count are capped as well.
  const walk = (dir: string, depth: number, dst: ReturnType<typeof stat>): void => {
    if (!visited.enter(dir, dst)) return;
    if (++count > maxDirs) {
      if (!capped) issue(abs, `stopped after ${maxDirs} folders`);
      capped = true;
      return;
    }
    const fileName = findSkillFileName(dir);
    if (fileName) {
      out.push({ dir, file: path.join(dir, fileName), fileName });
      return;
    }
    if (depth >= MAX_DEPTH) return;
    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      if (SKIPPABLE_ERRORS.has(errCode(e))) issue(dir, `cannot read folder (${errCode(e)})`);
      return;
    }
    for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      if (capped) return;
      if (SKIP_DIRS.has(e.name)) continue;
      if (!e.isSymbolicLink() && !e.isDirectory()) continue;
      const child = path.join(dir, e.name);
      let cst;
      try {
        cst = stat(child);
      } catch (err) {
        if (SKIPPABLE_ERRORS.has(errCode(err))) issue(child, `cannot follow (${errCode(err)})`);
        continue; // ENOENT: dangling link
      }
      if (!cst.isDirectory()) continue;
      // Linked folders are searched after the real tree, so a skill reachable both
      // directly and through a link is reported under its real location.
      if (e.isSymbolicLink()) deferred.push([child, depth + 1, cst]);
      else walk(child, depth + 1, cst);
    }
  };
  const deferred: [string, number, ReturnType<typeof stat>][] = [];
  walk(abs, 0, st);
  while (deferred.length > 0 && !capped) walk(...deferred.shift()!);
  return out;
}
