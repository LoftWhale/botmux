#!/usr/bin/env node
// Run the unit suite on `bun test` — the only runner that executes test BODIES
// on Bun. `vitest` forks Node workers even when launched via `bun x vitest`
// (measured), so Bun-specific behaviour (its `fetch` error taxonomy, the
// startup-frozen `os.homedir()`, `Bun.file`, compiled-binary paths) is invisible
// to `bun run test` and can only regress silently there.
//
// A subset of files cannot run here yet: `vi.doMock` / `vi.doUnmock` /
// `vi.resetModules` and the `importOriginal` callback are module-registry
// semantics, not missing functions. `test/bun-test-shim.ts` deliberately does
// NOT fake them — a fake would report success while silently not mocking, which
// is worse than the current red. Those files keep running under vitest until
// they are rewritten to use dependency injection.
//
// The exclusion list is COMPUTED, never hardcoded: a stale literal list would
// quietly start skipping files (or fail on files that have since been fixed).
// Adding a `vi.doMock` to any file automatically moves it out of this leg, and
// removing one moves it back in.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const TEST_DIR = 'test';

// Matches the APIs whose absence is a module-system gap rather than a missing
// helper. Keep in sync with the "DELIBERATELY NOT SHIMMED" list in
// test/bun-test-shim.ts.
const UNSUPPORTED = /\bvi\s*\.\s*(doMock|doUnmock|resetModules)\b|\bimportOriginal\b/;

const all = readdirSync(TEST_DIR)
  .filter(f => f.endsWith('.test.ts'))
  .map(f => join(TEST_DIR, f))
  .sort();

const runnable = [];
const skipped = [];
for (const file of all) {
  if (UNSUPPORTED.test(readFileSync(file, 'utf8'))) skipped.push(file);
  else runnable.push(file);
}

console.log(`bun test: ${runnable.length} files (${skipped.length} deferred to vitest — module-registry APIs)`);

if (runnable.length === 0) {
  console.error('Refusing to report success: no runnable files were found. Is the test/ directory present?');
  process.exit(1);
}

// Pass an explicit file list rather than letting bun glob, so the deferred files
// cannot sneak in via a future default-glob change.
//
// --timeout: Bun's per-test default is 5s, but the unit project runs at
// vitest's 30s and individual files raise it further via `vi.setConfig({
// testTimeout })` — up to 180s for the mojo suites. `bun test` has no runtime
// equivalent for that per-file call (the shim accepts it as a no-op), so the
// ceiling has to come from the CLI. Use the highest value any file asks for;
// a generous timeout cannot turn a failing test green, it only stops a slow one
// from being cut short. An explicit --timeout in argv wins over this default.
const HIGHEST_FILE_TIMEOUT_MS = 180_000;
const extraArgs = process.argv.slice(2);
const timeoutArgs = extraArgs.some(a => a === '--timeout' || a.startsWith('--timeout='))
  ? []
  : [`--timeout=${HIGHEST_FILE_TIMEOUT_MS}`];

const res = spawnSync('bun', ['test', ...timeoutArgs, ...extraArgs, ...runnable], { stdio: 'inherit' });

if (res.error) {
  console.error(`Failed to launch bun test: ${res.error.message}`);
  process.exit(1);
}
// A signal death (OOM, timeout kill) leaves status null — treat it as failure
// rather than letting `undefined` coerce to a passing 0.
if (res.status === null) {
  console.error(`bun test terminated by signal ${res.signal ?? 'unknown'}`);
  process.exit(1);
}
process.exit(res.status);
