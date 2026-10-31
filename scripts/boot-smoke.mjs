// Boots the BUILT app (dist/main) with no config and checks it dies on config,
// not on module loading. Catches what unit tests cannot: an ESM-only dependency
// that the compiled CommonJS cannot require, or a dist laid out under the wrong root.
// Run after `npm run build`. No network: it fails before any Redis connect.
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const main = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'main.js');
// Empty cwd so neither dotenv nor ConfigModule finds a .env file.
const cwd = mkdtempSync(join(tmpdir(), 'gw-boot-'));
const child = spawn(process.execPath, [main], {
  cwd,
  env: { PATH: process.env.PATH, NODE_ENV: 'production', NO_COLOR: '1' },
});

let out = '';
child.stdout.on('data', (c) => (out += c));
child.stderr.on('data', (c) => (out += c));
const timer = setTimeout(() => child.kill('SIGKILL'), 30_000);

child.on('exit', (code, signal) => {
  clearTimeout(timer);
  const loadError = /ERR_REQUIRE_ESM|ERR_REQUIRE_ASYNC_MODULE|Must use import|Cannot find module|SyntaxError/;
  const configError = /is not set/;
  const fail = (why) => {
    console.error(`boot-smoke FAILED: ${why}\n--- output ---\n${out}`);
    process.exit(1);
  };
  if (signal) fail(`no exit within 30s (${signal})`);
  if (code === 0) fail('exited 0 with no config');
  if (loadError.test(out)) fail('module load error');
  if (!configError.test(out)) fail('did not fail on a missing env var');
  console.log(`boot-smoke ok: ${out.match(/Error: [^\n]*is not set/)?.[0] ?? 'config error'}`);
});
