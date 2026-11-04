import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkScripts } from '../src/scripts.js';
import { byCode, codes, isWindows, tmp, writeTree } from './helpers.js';

const hasPython = spawnSync('python3', ['--version']).status === 0;
const hasBash = spawnSync('bash', ['--version']).status === 0;

function check(files: Record<string, string | { content: string; mode?: number }>, exec = true) {
  const root = writeTree(tmp(), files);
  return checkScripts(Object.keys(files).map((f) => path.join(root, f)), root, { exec });
}

describe('script checks (never executed)', () => {
  it.skipIf(isWindows)('shebang without the executable bit is info; with it, nothing', () => {
    const f = check({ 'a.py': { content: '#!/usr/bin/env python3\nprint(1)\n', mode: 0o644 }, 'b.py': { content: '#!/usr/bin/env python3\nprint(1)\n', mode: 0o755 } }, false);
    expect(f.map((x) => [x.code, x.severity, path.basename(x.file!)])).toEqual([['script-not-executable', 'info', 'a.py']]);
  });

  it('shell scripts without a shebang are info; CRLF is only a per-file info (aggregated by lint)', () => {
    const f = check({ 'run.sh': 'echo hi\n', 'crlf.sh': { content: '#!/bin/sh\r\necho hi\r\n', mode: 0o755 } }, false);
    expect(codes(f)).toEqual(['crlf-line-endings', 'script-missing-shebang']);
    expect(byCode(f, 'crlf-line-endings')[0]!.severity).toBe('info');
    expect(f.some((x) => x.severity === 'warning' || x.severity === 'error')).toBe(false);
  });

  it.skipIf(!hasPython)('python syntax errors are errors with the line', () => {
    const f = check({ 'ok.py': 'x = 1\n', 'bad.py': 'x = 1\ndef f(:\n  pass\n', 'uni.py': 's = "日本語"\nprint(s)\n' });
    expect(f.map((x) => [x.code, path.basename(x.file!), x.line])).toEqual([['script-syntax-error', 'bad.py', 2]]);
  });

  it.skipIf(!hasBash)('bash -n catches shell syntax errors', () => {
    const f = check({ 'bad.sh': { content: '#!/bin/bash\nif true; then\n  echo x\n', mode: 0o755 } });
    expect(codes(f)).toEqual(['script-syntax-error']);
  });

  it('node --check catches JS syntax errors, including ESM files', () => {
    const f = check({
      'bad.js': 'const = 1;\n',
      'esm.js': "import fs from 'node:fs';\nexport const x = fs;\n",
      'ok.mjs': 'export default 1;\n',
      'ok.cjs': 'module.exports = 1;\n',
    });
    expect(f.map((x) => [x.code, path.basename(x.file!)])).toEqual([['script-syntax-error', 'bad.js']]);
  });

  it('--no-exec skips parser checks', () => {
    expect(check({ 'bad.js': 'const = 1;\n', 'bad.py': 'def (:\n' }, false)).toEqual([]);
  });
});
