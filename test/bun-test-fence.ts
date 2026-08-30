import { afterAll, beforeEach, mock } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import * as realOs from 'node:os';

/**
 * `bun test` counterpart of `test/unit-setup.ts`.
 *
 * WHY A SEPARATE FILE: the vitest fence is mounted through
 * `vitest.config.ts` → `setupFiles`, which `bun test` never reads. Nothing else
 * fences the home directory, and every `~/.botmux` path in `src/` is a hardcoded
 * `join(homedir(), '.botmux', …)` with no env indirection (210 `homedir()` call
 * sites across 111 files) — so an unfenced run writes straight into the
 * developer's real home. That is not hypothetical: a `bun test` run overwrote a
 * live `~/.botmux/config.json` with this repo's own test fixture, dropping
 * `remoteAccess` and silently turning central-platform links back to localhost.
 * The blast radius is wider than `~/.botmux`: `src/` also derives `~/.claude`,
 * `~/.claude.json`, `~/.codex`, `~/.gemini`, `~/.dsh`, `~/.pm2` and more, so an
 * unfenced run can corrupt the user's OTHER CLI configs too.
 *
 * WHY `mock.module` AND NOT JUST `process.env.HOME`: Bun snapshots
 * `os.homedir()` before any JS runs, so assigning `process.env.HOME` here does
 * NOT move `homedir()` in this process (measured — a preload that only sets the
 * env still resolves to the real home). Overriding the module is what actually
 * redirects in-process callers. The env assignment is still required: child
 * processes inherit it and snapshot the fenced value at their own startup.
 *
 * Keep the mocked `homedir()` reading `process.env` on every call (not a
 * captured constant) so a test that legitimately re-points HOME still works, and
 * keep the win32 USERPROFILE rule so the override matches Node's POSIX
 * behaviour rather than inventing a third semantic.
 */

const inheritedDataDir = process.env.SESSION_DATA_DIR;

// One disposable root per test PROCESS — note that `bun test` runs every file
// it was given in a single process (measured: two files report the same
// `process.pid`), unlike vitest which forks a worker per file. So this root is
// shared by the whole invocation rather than per-file. That is fine for the
// purpose here (keeping writes out of the real home) but it means `afterAll`
// below fires once at the end, not between files. `bun test` also has no
// globalSetup hook to hand a shared parent down (vitest uses
// `unit-global-setup.ts` for that), so the root is minted here, under the real
// tmpdir — captured from the unmocked module before the override is installed.
const fileRoot = mkdtempSync(join(realOs.tmpdir(), 'botmux-bun-unit-'));

const dataDir = join(fileRoot, 'data');
mkdirSync(dataDir);
process.env.SESSION_DATA_DIR = dataDir;

const fileHome = join(fileRoot, 'home');
mkdirSync(fileHome);
process.env.HOME = fileHome;
process.env.USERPROFILE = fileHome;

mock.module('node:os', () => ({
  ...realOs,
  // Bun resolves `import os from 'node:os'` through the default export, so a
  // spread alone would leave default-import callers on the real implementation.
  default: realOs,
  homedir: () => (process.platform === 'win32'
    ? process.env.USERPROFILE || realOs.homedir()
    : process.env.HOME || realOs.homedir()),
}));

// Mirrors the vitest fence: mojo mints per-session workspaces under the real
// `~/.botmux/mojo-workspaces` unless redirected (observed live before the vitest
// side was fenced). Tests that assert the path pass an explicit home instead.
const mojoWorkspaceRoot = join(fileRoot, 'mojo-workspaces');
mkdirSync(mojoWorkspaceRoot);
process.env.BOTMUX_MOJO_WORKSPACE_ROOT = mojoWorkspaceRoot;

// A preload runs before the test module, so a file-wide override made at module
// scope or in beforeAll must be captured once and then repaired per test.
let fileDataDir = '';
beforeEach(() => {
  if (!fileDataDir) {
    const candidate = process.env.SESSION_DATA_DIR;
    fileDataDir = candidate && candidate !== inheritedDataDir ? candidate : dataDir;
  }
  process.env.SESSION_DATA_DIR = fileDataDir;
});

afterAll(() => {
  // Keep leaked async work fenced inside the managed root until the process
  // exits; restoring the invoking environment here could briefly re-expose live
  // Botmux data to a straggling write.
  process.env.SESSION_DATA_DIR = dataDir;
  rmSync(fileRoot, { recursive: true, force: true });
});
