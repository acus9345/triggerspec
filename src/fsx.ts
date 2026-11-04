import * as nodeFs from 'node:fs';
import * as path from 'node:path';

/**
 * The few filesystem calls lint needs. Injectable so case-insensitive (Windows NTFS,
 * macOS APFS) and other platform behaviour can be simulated in tests.
 */
export interface FsLike {
  existsSync(p: string): boolean;
  readdirSync(p: string): string[];
  statSync(p: string): { isFile(): boolean; isDirectory(): boolean; size: number; mode: number; dev?: number | bigint; ino?: number | bigint };
  readFileSync(p: string): Buffer;
  /** Real path with links resolved (optional; used for loop detection and link escapes). */
  realpathSync?(p: string): string;
}

export const nodeFsLike: FsLike = {
  existsSync: (p) => nodeFs.existsSync(p),
  readdirSync: (p) => nodeFs.readdirSync(p),
  statSync: (p) => nodeFs.statSync(p),
  readFileSync: (p) => nodeFs.readFileSync(p),
  realpathSync: (p) => nodeFs.realpathSync.native(p),
};

/** Error codes that make one entry unreadable; it is skipped (with a note), the walk goes on. */
export const SKIPPABLE_ERRORS = new Set(['ELOOP', 'EACCES', 'EPERM', 'ENAMETOOLONG', 'EBUSY', 'EIO', 'EINVAL', 'ENOTDIR', 'UNKNOWN']);

export const errCode = (e: unknown): string => (e && typeof e === 'object' && 'code' in e ? String((e as { code: unknown }).code) : 'ERROR');

/**
 * Remembers folders already walked so link loops terminate. A folder counts as seen when
 * EITHER its real path OR its (dev, ino) pair was seen: on Windows, realpath of a junction
 * inside a junction loop can fail or come back unresolved, while (dev, ino) still matches
 * (and vice versa on filesystems that report ino 0).
 */
export class VisitedDirs {
  private readonly reals = new Set<string>();
  private readonly ids = new Set<string>();
  constructor(private readonly fs: FsLike = nodeFsLike) {}

  /** Real path of `p`, or null when it cannot be resolved. */
  real(p: string): string | null {
    if (!this.fs.realpathSync) return null;
    try {
      return this.fs.realpathSync(p);
    } catch {
      return null;
    }
  }

  /** "dev:ino" of a stat result, or null when the filesystem reports no inode numbers. */
  static idOf(st?: { dev?: number | bigint; ino?: number | bigint }): string | null {
    return st && st.ino !== undefined && st.dev !== undefined && BigInt(st.ino) !== 0n ? `${st.dev}:${st.ino}` : null;
  }

  /** Marks `p` visited; returns false if it (or the same folder under another name) was visited before. */
  enter(p: string, st?: { dev?: number | bigint; ino?: number | bigint }): boolean {
    const real = this.real(p);
    const id = VisitedDirs.idOf(st);
    if ((real !== null && this.reals.has(real)) || (id !== null && this.ids.has(id))) return false;
    if (real !== null) this.reals.add(real);
    if (id !== null) this.ids.add(id);
    return true;
  }
}

export function isWithin(root: string, p: string): boolean {
  const rel = path.relative(root, p);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

const fold = (s: string) => s.normalize('NFC').toLowerCase();

export interface CaseResolution {
  status: 'exact' | 'case' | 'missing';
  /** On-disk spelling (for 'exact' and 'case'); for paths outside `root`, the input path. */
  actual?: string;
}

/**
 * Resolve `abs` against the real directory entries below `root`, one segment at a time.
 *
 * - Never trusts `existsSync` below the root: on case-insensitive filesystems it succeeds
 *   for a wrongly-cased path, which made the mentioned spelling look like the real file.
 * - Never checks the case of segments at or above `root`: the user may type the skill
 *   path in any case on Windows/macOS, and that is not the skill's problem.
 * - Unicode normalization differences (NFC vs NFD names on macOS) count as exact.
 * - Paths outside `root` are only checked for existence.
 */
export function resolveCase(root: string, abs: string, fs: FsLike = nodeFsLike): CaseResolution {
  if (!isWithin(root, abs)) return fs.existsSync(abs) ? { status: 'exact', actual: abs } : { status: 'missing' };
  const rel = path.relative(root, abs);
  if (rel === '') return fs.existsSync(root) ? { status: 'exact', actual: root } : { status: 'missing' };
  let cur = root;
  let caseDiff = false;
  for (const seg of rel.split(/[\\/]+/).filter(Boolean)) {
    let entries: string[];
    try {
      entries = fs.readdirSync(cur);
    } catch {
      return { status: 'missing' };
    }
    let hit = entries.find((e) => e === seg) ?? entries.find((e) => e.normalize('NFC') === seg.normalize('NFC'));
    if (hit === undefined) {
      hit = entries.find((e) => fold(e) === fold(seg));
      if (hit === undefined) return { status: 'missing' };
      caseDiff = true;
    }
    cur = path.join(cur, hit);
  }
  return { status: caseDiff ? 'case' : 'exact', actual: cur };
}
