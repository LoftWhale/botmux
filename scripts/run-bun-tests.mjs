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
import { spawn, spawnSync } from 'node:child_process';
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
// `inject` is vitest's globalSetup→test value channel (`project.provide` /
// `inject`). It is a NAMED EXPORT of the `vitest` module, and `bun test` resolves
// `vitest` to its own `bun:test` — which has no such export, so the file dies at
// import with `SyntaxError: Export named 'inject' not found`. A preload cannot
// paper over it: `mock.module('vitest', … inject: … )` still fails, because the
// static import is validated against `bun:test`'s real export list before any
// mock applies (measured). Runner-config plumbing, not a missing helper.
const UNSUPPORTED = /\bvi\s*\.\s*(doMock|doUnmock|resetModules|hoisted)\b|\bimportOriginal\b|\bimportActual\b/;

// `inject` needs its OWN, anchored pattern. Adding a bare `\binject\b` to the
// list above looks equivalent but silently deferred 20 innocent files — measured:
// of the 21 files it newly excluded, exactly ONE actually imports `inject`; the
// rest merely contain the English word in a test title ("does not inject …"), a
// script name (`inject-optional-binaries.mjs`), a callback parameter, or a domain
// term (`inject-queue-policy`). Same failure shape as the comment-matching bug
// this file already guards against — and the population count looks perfectly
// healthy while it happens. So match the thing that actually breaks: a NAMED
// IMPORT of `inject` from `vitest` (the specifier list may span lines and carry
// other names alongside it).
const IMPORTS_INJECT = /import\s*\{[^}]*\binject\b[^}]*\}\s*from\s*['"]vitest['"]/s;

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
  const source = stripComments(readFileSync(file, 'utf8'));
  if (UNSUPPORTED.test(source) || IMPORTS_INJECT.test(source)) skipped.push(file);
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

// Every child currently running, mapped to the scratch dir minted for it, so a
// cancelled run can take both the processes AND their temp trees with it.
const liveChildren = new Map();

/**
 * Remove a scratch tree without ever taking the run down with it.
 *
 * `rmSync({ recursive: true, force: true })` still THROWS `ENOTEMPTY` when
 * something creates a file mid-delete — `force` only suppresses "already gone".
 * A process we just SIGKILLed has not necessarily reaped yet, so the sweep above
 * races it, and an uncaught throw in a `close` handler killed a 994-file run at
 * file 950 (measured). Retry briefly, then give up: a leftover temp dir is a
 * nuisance, losing the whole run's results is not.
 */
function removeScratch(scratch) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      rmSync(scratch, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      return;
    } catch (err) {
      if (attempt === 4) {
        process.stderr.write(`[runner] could not remove ${scratch}: ${err?.code ?? err}\n`);
      }
    }
  }
}

/**
 * Signal a child's process GROUP — deliberately not called a "tree".
 *
 * A grandchild that calls `setsid()` or spawns with `detached: true` leaves this
 * group and survives (measured: a fixture server with PID == PGID == SID outlived
 * its group leader). Killing the group covers the common case — a test's spawned
 * server or pty — and is what makes normal-close and cancellation sweeps work; it
 * is not a guarantee against a descendant that deliberately detaches. Those are
 * the test's own responsibility to clean up.
 *
 * POSIX: `detached: true` gave the child its own process group, and a negative pid
 * signals that whole group. Windows has no process groups in this sense and
 * rejects a negative pid, so shell out to `taskkill /T` (which walks the child
 * tree) and fall back to the direct kill only if that is unavailable — a bare
 * `child.kill()` there would leave the servers and ptys the test spawned running.
 */
function killTree(child, signal) {
  if (child.pid === undefined) return;
  if (process.platform === 'win32') {
    // `spawnSync` reports a missing/unstartable binary through the RETURN VALUE
    // (`{ error: ENOENT, status: null }`), not by throwing — verified. Returning
    // unconditionally here would treat "taskkill never ran" as success and skip the
    // fallback entirely, so check both fields before trusting it.
    let killed = false;
    try {
      const res = spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
      killed = !res.error && res.status === 0;
    } catch { /* fall through to the direct kill below */ }
    if (killed) return;
  } else {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch { /* group already gone, or never created — fall through */ }
  }
  try { child.kill(signal); } catch { /* already gone */ }
}

// Without this, killing the runner (Ctrl-C, an outer timeout, a supervisor) leaves
// its `bun test` children orphaned to PID 1 — they keep holding ports and CPU and
// corrupt whatever runs next. Reap the tree, then exit with the conventional code.
let shuttingDown = false;
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    for (const [child, scratch] of liveChildren) {
      killTree(child, 'SIGKILL');
      // Cancellation is exactly when these would otherwise accumulate: the close
      // handler that normally removes them never runs.
      removeScratch(scratch);
    }
    process.exit(sig === 'SIGINT' ? 130 : 143);
  });
}

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

    // `detached: true` puts the child in its OWN process group, so a kill can take
    // the whole tree — `child.kill()` alone signals only the Bun parent and leaves
    // servers/ptys it spawned running (measured: cancelling a run left `bun test`
    // children with PPID=1 alive for minutes, competing for ports and load with the
    // next run and silently poisoning its results).
    const child = spawn('bun', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: childEnv,
      detached: process.platform !== 'win32',
    });
    liveChildren.set(child, scratch);
    let out = '';
    const cap = chunk => { if (out.length < 200_000) out += chunk; };
    child.stdout.on('data', cap);
    child.stderr.on('data', cap);
    const wall = setTimeout(() => killTree(child, 'SIGKILL'), FILE_WALL_MS);
    child.on('error', err => {
      clearTimeout(wall);
      liveChildren.delete(child);
      removeScratch(scratch);
      resolve({ file, ok: false, out: `failed to launch bun: ${err.message}` });
    });
    child.on('close', (code, signal) => {
      clearTimeout(wall);
      liveChildren.delete(child);
      // Sweep whatever is LEFT in the child's process group. A test that spawns a
      // grandchild and only kills the intermediate process leaves the grandchild
      // running when the Bun parent exits — measured with
      // test/session-preview-ownership.test.ts, whose `LISTEN_SCRIPT` server
      // survived a NORMAL file close as a PPID=1 process holding a port. Deleting
      // the scratch dir without this made a directory-based check look clean while
      // the process was still alive, so sweep BEFORE removing the evidence.
      killTree(child, 'SIGKILL');
      removeScratch(scratch);
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

// `allSettled`, so one worker blowing up does not discard the verdicts the others
// already collected — but a rejected worker still FAILS the run. There is deliberately
// NO global `uncaughtException` net: it could not distinguish a scratch-cleanup hiccup
// from a bookkeeping bug, and swallowing the latter could let the process exit 0 with
// an incomplete result set — trading a loud crash for a silent false green. Scratch
// removal degrades locally (see removeScratch); everything else fails closed.
const settled = await Promise.allSettled(Array.from({ length: concurrency }, worker));
const workerErrors = settled.filter(r => r.status === 'rejected').map(r => r.reason);

if (failures.length > 0) {
  console.log('\nFailing files:');
  for (const f of failures) console.log(`  ${f.file}`);
}

// Completeness FIRST, then the summary. Printing "N/N files green" before checking
// these would count files that never ran: a worker crash after 2 of 9 files still
// showed a prominent `9/9 files green` with the INCOMPLETE notice below it — the
// exit code was right but the headline contradicted it, and a human or a log
// excerpt reads the headline.
const incomplete = workerErrors.length > 0 || done !== runnable.length;
if (incomplete) {
  console.error(
    `\nbun test: INCOMPLETE — ${done}/${runnable.length} files ran`
    + `, ${done - failures.length} of those green, ${failures.length} failing`,
  );
  for (const err of workerErrors) console.error(`  worker crashed: ${err?.stack ?? err}`);
  if (workerErrors.length === 0) {
    console.error('  no worker crashed, yet files are missing — results cannot be trusted');
  }
  process.exit(1);
}

console.log(`\nbun test: ${runnable.length - failures.length}/${runnable.length} files green, ${failures.length} failing`);
if (failures.length > 0) process.exit(1);
