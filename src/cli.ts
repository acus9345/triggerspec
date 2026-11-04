#!/usr/bin/env node
import { run } from './main.js';

run(process.argv.slice(2), {
  out: (s) => process.stdout.write(s + '\n'),
  err: (s) => process.stderr.write(s + '\n'),
  cwd: process.cwd(),
  env: process.env,
  color: Boolean(process.stdout.isTTY),
}).then(
  (code) => {
    process.exitCode = code;
  },
  (e: unknown) => {
    process.stderr.write(`triggerspec: ${(e as Error)?.stack ?? String(e)}\n`);
    process.exitCode = 2;
  },
);
