import { execSync, spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { isWindows } from './helpers.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = path.join(root, 'dist', 'cli.js');

beforeAll(() => {
  if (!existsSync(bin)) execSync('npm run build', { cwd: root, stdio: 'ignore' });
}, 120_000);

function cli(args: string[], cwd = root, env: Record<string, string> = {}) {
  const r = spawnSync(process.execPath, [bin, ...args], { cwd, encoding: 'utf8', env: { ...process.env, ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '', ...env } });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

describe('built CLI (dist/cli.js)', () => {
  it('has a shebang and is executable', () => {
    expect(require_text(bin).startsWith('#!/usr/bin/env node')).toBe(true);
    if (!isWindows) expect(statSync(bin).mode & 0o111).not.toBe(0);
  });

  it('lint / test / collisions / check exit codes on the examples', () => {
    expect(cli(['lint', 'examples/good']).code).toBe(0);
    expect(cli(['lint', 'examples/broken']).code).toBe(1);
    expect(cli(['test', 'examples/good']).code).toBe(0);
    expect(cli(['test', 'examples/colliding']).code).toBe(1);
    expect(cli(['collisions', 'examples/colliding']).code).toBe(1);
    expect(cli(['check', 'examples/good']).code).toBe(0);
    expect(cli(['nope']).code).toBe(2);
  });

  it('--json output is valid JSON on stdout only', () => {
    const r = cli(['lint', 'examples/broken', '--json']);
    const data = JSON.parse(r.out);
    expect(data.counts.error).toBeGreaterThan(0);
    expect(r.err).toBe('');
  });

  it('works on a single SKILL.md path and from another cwd', () => {
    const r = cli(['lint', path.join(root, 'examples/good/pdf-form-filler/SKILL.md')], path.join(root, 'test'));
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/1 skill checked/);
  });

  it('never emits ANSI colors when piped or with NO_COLOR', () => {
    expect(cli(['lint', 'examples/broken']).out).not.toMatch(/\u001b\[/);
    expect(cli(['lint', 'examples/broken'], root, { NO_COLOR: '1' }).out).not.toMatch(/\u001b\[/);
  });

  it('offline mode needs no network or keys; --llm without keys is a skip', () => {
    const r = cli(['test', 'examples/good', '--llm']);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/skipped/);
  });
});

function require_text(p: string): string {
  return execSync(`node -e "process.stdout.write(require('fs').readFileSync(process.argv[1],'utf8').slice(0,40))" "${p}"`, { encoding: 'utf8' });
}
