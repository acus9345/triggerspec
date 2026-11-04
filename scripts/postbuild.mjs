// Make the CLI entry executable after tsc (tsc does not preserve modes).
import { chmodSync, readFileSync } from 'node:fs';
const cli = new URL('../dist/cli.js', import.meta.url);
const src = readFileSync(cli, 'utf8');
if (!src.startsWith('#!')) throw new Error('dist/cli.js is missing its shebang');
chmodSync(cli, 0o755);
