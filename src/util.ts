import { homedir } from 'node:os';
import * as path from 'node:path';

/** Convert any path (Windows or POSIX) to forward-slash form. */
export function toPosix(p: string): string {
  return p.replace(/\\/g, '/');
}

/** Relative path for display, always forward slashes. */
export function displayPath(p: string, cwd: string = process.cwd()): string {
  const rel = path.relative(cwd, p);
  if (rel === '') return '.';
  if (rel.startsWith('..') && path.isAbsolute(p)) {
    // Outside cwd: prefer the absolute path if it is shorter to read.
    const abs = toPosix(p);
    return abs.length < rel.length ? abs : toPosix(rel);
  }
  return toPosix(rel);
}

/** 1-based line number of `index` inside `text`. */
export function lineAt(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

export function normalizeNewlines(s: string): string {
  return s.replace(/\r\n?/g, '\n');
}

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Rough token estimate: ~4 ASCII chars per token, 1 token per non-ASCII char. */
export function estimateTokens(s: string): number {
  let ascii = 0;
  let other = 0;
  for (const ch of s) {
    if (ch.charCodeAt(0) < 128) ascii++;
    else other++;
  }
  return Math.ceil(ascii / 4) + other;
}

export function plural(n: number, word: string, pluralWord = word + 's'): string {
  return `${n} ${n === 1 ? word : pluralWord}`;
}

/**
 * Expand a leading `~` / `~/` / `~\\` to the home directory. cmd.exe and Windows PowerShell
 * pass `~` to native programs literally, so `--catalog ~/.claude/skills` needs this there.
 */
export function expandHome(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(homedir(), p.slice(2));
  return p;
}
