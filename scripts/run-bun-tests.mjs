#!/usr/bin/env node
// Run the unit suite on `bun test` — the only runner that executes test BODIES
// on Bun. `vitest` forks Node workers even when launched via `bun x vitest`
// (measured), so Bun-specific behaviour (its `fetch` error taxonomy, the
// startup-frozen `os.homedir()`, `Bun.file`, compiled-binary paths) is invisible
// to `bun run test` and can only regress silently there.
//
// ONE FILE PER PROCESS, deliberately. `bun test a.ts b.ts …` runs every file in
// a SINGLE process (measured: two files report the same `process.pid`), unlike
// vitest which forks a worker per file. Handing it the whole suite produces
// cascading cross-file interference rather than real failures — measured on this
// repo: 1010 files batched → 933 failures; the same files one-per-process → ~2%
// red; and individual victims (`fleet-supervisor.integration`,
// `ask-custom-reply-candidate`, `dashboard-ipc`) go 23/23, 8/8 and 170/171 green
// in isolation while failing in the batch. A `vi.mock` of a shared module (e.g.
// `utils/logger`) installed by one file stays installed for later files, so a
// deliberately partial mock in file A becomes a `logger.isDebug is not a
// function` crash in file Z. Per-process execution restores the isolation
// boundary vitest gives for free.
//
// The cost is process startup per file (~21 min wall clock for this suite versus
// a few minutes batched). That is the price of trustworthy results; a leg whose
// failures are mostly artefacts is worse than no leg at all.
//
// A subset of files cannot run here yet: `vi.doMock` / `vi.doUnmock` /
// `vi.resetModules`, the `importOriginal` / `importActual` mock-factory callbacks,
// and `vi.hoisted` are module-registry or transform semantics, not missing
// functions. `test/bun-test-shim.ts` deliberately does NOT fake them — a fake
// would report success while silently not mocking (or, for `hoisted`, run the
// factory too late), which is worse than the current red. Those files keep running
// under vitest until they are rewritten to use dependency injection.
//
// The exclusion list is COMPUTED, never hardcoded: a stale literal list would
// quietly start skipping files (or fail on files that have since been fixed).

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { availableParallelism, tmpdir as realTmpdir } from 'node:os';

const TEST_DIR = 'test';

// Mirror vitest's unit include/exclude exactly: `test/**/*.{test,spec}.ts`,
// minus `test/e2e-browser/**` and `*.e2e.ts`. A non-recursive `readdirSync`
// looked right but silently skipped every nested file (measured: 19 files under
// test/desktop/), and the count line would have looked perfectly healthy — the
// worst shape of a miss. Recurse so a newly added subdirectory joins this leg
// automatically instead of quietly sitting out.
const EXCLUDED_DIRS = new Set(['e2e-browser', 'node_modules', 'helpers', 'fixtures', '__snapshots__']);

function collectTestFiles(dir) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (EXCLUDED_DIRS.has(entry.name)) continue;
      found.push(...collectTestFiles(full));
    } else if (/\.(test|spec)\.ts$/.test(entry.name) && !entry.name.endsWith('.e2e.ts')) {
      found.push(full);
    }
  }
  return found;
}

// Matches the APIs whose absence is a module-system gap rather than a missing
// helper. Keep in sync with the "DELIBERATELY NOT SHIMMED" list in
// test/bun-test-shim.ts.
//
// `importOriginal` / `importActual` also appear as the CALLBACK PARAMETER of a
// `vi.mock` factory (`vi.mock('x', async (importActual) => …)`), which is the
// same module-registry feature under a different spelling — matching the bare
// identifier catches both that and any `vi.importActual(…)` call site. Anchoring
// only on `vi.<name>` would miss the callback form entirely (measured: 2 files).
//
// `vi.hoisted` belongs here for the same class of reason: vitest's TRANSFORM
// physically moves the callback above the static imports, so a fixture that reads
// a global at import time sees what the callback set. A runtime shim can only run
// the factory when the module body reaches it — i.e. AFTER the imports — so the
// fixture sees nothing (measured: vitest passes that probe while an eager-factory
// shim reports `missing`). That is module-evaluation ORDER, not a missing
// function, so it is unsupported rather than faked.
const UNSUPPORTED = /\bvi\s*\.\s*(doMock|doUnmock|resetModules|hoisted)\b|\bimportOriginal\b|\bimportActual\b/;

// Comments must not decide whether a file runs. Matching raw source means a file
// that merely MENTIONS one of these names in prose gets silently skipped, and the
// count line still looks healthy — the same shape of miss as the non-recursive
// scan above. This is not hypothetical: the parity guard in
// test/bun-shim-parity.test.ts excluded ITSELF that way while explaining why the
// hoisting helper is unsupported. Strip comments before testing.
//
// Deliberately simple: this is a skip-list heuristic over first-party test files,
// not a parser. `//` inside a string literal would over-strip, which fails
// CLOSED — the file stays in the leg and any real unsupported call there fails
// loudly rather than being quietly dropped.
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

// Bun's per-test default is 5s, but the unit project runs at vitest's 30s and
// individual files raise it further via `vi.setConfig({ testTimeout })` — up to
// 180s for the mojo suites. `bun test` has no runtime equivalent for that
// per-file call (the shim accepts it as a no-op), so the ceiling comes from the
// CLI. A generous timeout cannot turn a failing test green; it only stops a slow
// one from being cut short.
const TEST_TIMEOUT_MS = 180_000;
// Hard wall per file, above the per-test ceiling: a file that wedges (waiting on
// a pty, a lock, a socket) must not hold the whole leg open.
const FILE_WALL_MS = 240_000;

const all = collectTestFiles(TEST_DIR).sort();

const runnable = [];
const skipped = [];
for (const file of all) {
  if (UNSUPPORTED.test(stripComments(readFileSync(file, 'utf8')))) skipped.push(file);
  else runnable.push(file);
}

if (runnable.length === 0) {
  console.error('Refusing to report success: no runnable files were found. Is the test/ directory present?');
  process.exit(1);
}

const extraArgs = process.argv.slice(2);
const hasOwnTimeout = extraArgs.some(a => a === '--timeout' || a.startsWith('--timeout='));
// Keep concurrency moderate: many of these files spawn real daemons, ptys and
// bwrap sandboxes, and oversubscribing turns their internal timeouts into
// spurious reds (measured on a busy host). But do not starve a small runner
// either — one process per file means startup cost dominates, and a 4-core CI
// box running 2 at a time cannot finish 1000+ files inside a sane job timeout.
// Hence: at least 4, at most 8, scaled off the core count in between.
const envConcurrency = Number.parseInt(process.env.BOTMUX_BUN_TEST_CONCURRENCY ?? '', 10);
const concurrency = Number.isFinite(envConcurrency) && envConcurrency > 0
  ? envConcurrency
  : Math.max(4, Math.min(8, Math.floor(availableParallelism() / 4)));

console.log(
  `bun test: ${runnable.length} files, one process each, ${concurrency} at a time `
  + `(${skipped.length} deferred to vitest — module-registry APIs)`,
);

function runOne(file) {
  return new Promise(resolve => {
    const args = ['test', ...(hasOwnTimeout ? [] : [`--timeout=${TEST_TIMEOUT_MS}`]), ...extraArgs, file];
    // Per-child scratch root, used for BOTH tmp and home.
    //
    // TMPDIR: most `tmpdir()` uses in `src/` go through `mkdtemp`, but a few derive
    // a FIXED name — `botmux-codex-app-control-<uid>` (src/worker.ts) and
    // `bmcp-<uid>-<sessionKey>` (core/plugins/mcp/host.ts) — which collide across
    // concurrently running files under the same user. Not a home escape, just a
    // concurrency flake surface.
    //
    // HOME: the preload fence cannot cover Bun's OWN startup. Bun boots, resolves
    // and loads the preload's static imports, and touches its user-level caches
    // BEFORE any of our JS runs — measured: `.bun/install/cache` appears in the
    // INHERITED home even on a fenced run. Setting HOME here means the fence
    // exists from process birth; the preload then narrows it further and installs
    // the in-process `node:os` override. Child processes inherit this too.
    const scratch = mkdtempSync(join(realTmpdir(), 'botmux-bun-child-'));
    const childTmp = join(scratch, 'tmp');
    const childHome = join(scratch, 'home');
    mkdirSync(childTmp);
    mkdirSync(childHome);

    const childEnv = {
      ...process.env,
      TMPDIR: childTmp,
      TMP: childTmp,
      TEMP: childTmp,
      HOME: childHome,
      USERPROFILE: childHome,
    };
    // Exact-path pointers at a live Botmux home never go through `homedir()`, so
    // they have to be dropped in the spawn env too — not just in the preload.
    // Mirrors test/helpers/fence-home-env.ts; kept here as well because that file
    // only runs after Bun has started.
    delete childEnv.BOTS_CONFIG;
    delete childEnv.PM2_HOME;
    delete childEnv.PLUGIN_PM2_HOME;

    const child = spawn('bun', args, { stdio: ['ignore', 'pipe', 'pipe'], env: childEnv });
    let out = '';
    const cap = chunk => { if (out.length < 200_000) out += chunk; };
    child.stdout.on('data', cap);
    child.stderr.on('data', cap);
    const wall = setTimeout(() => child.kill('SIGKILL'), FILE_WALL_MS);
    child.on('error', err => {
      clearTimeout(wall);
      rmSync(scratch, { recursive: true, force: true });
      resolve({ file, ok: false, out: `failed to launch bun: ${err.message}` });
    });
    child.on('close', (code, signal) => {
      clearTimeout(wall);
      rmSync(scratch, { recursive: true, force: true });
      // A signal death (wall-clock kill, OOM) leaves code null — never let that
      // coerce into a pass.
      if (code !== 0) {
        resolve({ file, ok: false, out, signal: signal ?? undefined });
        return;
      }
      // `bun test` exits 0 for a file that collected ZERO tests (measured — both
      // an empty file and an all-`.skip` file exit 0). A file that silently ran
      // nothing is indistinguishable from a passing one by exit code alone, so
      // parse the count and fail closed. `Ran N tests` is bun's own summary line.
      const ran = /^Ran (\d+) tests?/m.exec(out);
      if (!ran) {
        resolve({ file, ok: false, out: `${out}\n[runner] no "Ran N tests" summary — cannot confirm this file executed` });
        return;
      }
      if (Number(ran[1]) === 0) {
        resolve({ file, ok: false, out: `${out}\n[runner] collected 0 tests — a file that runs nothing must not report success` });
        return;
      }
      resolve({ file, ok: true, out });
    });
  });
}

const queue = [...runnable];
const failures = [];
let done = 0;

async function worker() {
  for (;;) {
    const file = queue.shift();
    if (!file) return;
    const res = await runOne(file);
    done += 1;
    if (!res.ok) {
      failures.push(res);
      process.stdout.write(`\nFAIL ${res.file}${res.signal ? ` (killed: ${res.signal})` : ''}\n${res.out}\n`);
    }
    if (done % 50 === 0 || done === runnable.length) {
      process.stdout.write(`… ${done}/${runnable.length} files, ${failures.length} failing\n`);
    }
  }
}

await Promise.all(Array.from({ length: concurrency }, worker));

console.log(`\nbun test: ${runnable.length - failures.length}/${runnable.length} files green, ${failures.length} failing`);
if (failures.length > 0) {
  console.log('Failing files:');
  for (const f of failures) console.log(`  ${f.file}`);
  process.exit(1);
}
