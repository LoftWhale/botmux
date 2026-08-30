import { afterEach, expect, jest, mock, setSystemTime } from 'bun:test';
import { vi } from 'vitest';

/**
 * Fills in the `vi.*` helpers `bun test` does not implement, for the subset
 * whose vitest semantics can be reproduced exactly.
 *
 * ⚠️ READ BEFORE ADDING ANYTHING HERE. A shim that makes a call *return* without
 * reproducing its *effect* converts a loud failure into a silent false green,
 * which is strictly worse than the red it replaced. This repo has already paid
 * for that once: `vi.stubEnv` threw under `bun test` (a red that correctly said
 * "this run is not isolated"), an ad-hoc shim set the env var and let the suite
 * go green — but Bun snapshots `os.homedir()` before any JS runs, so the tests
 * kept writing to the developer's REAL home and overwrote a live
 * `~/.botmux/config.json`. The env half of `stubEnv` is only safe here because
 * `test/bun-test-fence.ts` overrides `node:os` itself; the shim alone would not
 * make an unfenced run safe.
 *
 * DELIBERATELY NOT SHIMMED — these are module-system semantics, not missing
 * functions, and any fake would silently not-mock while reporting success:
 *   `vi.doMock` / `vi.doUnmock`  — re-point a module mid-file
 *   `vi.resetModules`            — clear the module registry
 *   `importOriginal`             — the callback arg that yields the real module
 * Files using them stay red under `bun test` and keep running under vitest until
 * they are rewritten to use dependency injection. See `package.json:test:bun`.
 */

const anyVi = vi as unknown as Record<string, unknown>;

/** Install only when Bun lacks it, so a future Bun release wins automatically. */
function fill(name: string, impl: unknown): void {
  if (typeof anyVi[name] !== 'function') anyVi[name] = impl;
}

// ---------------------------------------------------------------------------
// Env stubbing. Semantics measured against vitest (not assumed):
//   stubEnv(k, 'v')      → sets
//   stubEnv(k, undefined) → DELETES the key (`k in process.env === false`)
//   unstubAllEnvs()      → restores pre-stub values; keys that did not exist
//                          before are removed again
// ---------------------------------------------------------------------------
const savedEnv = new Map<string, string | undefined>();

fill('stubEnv', (key: string, value: string | undefined) => {
  if (!savedEnv.has(key)) savedEnv.set(key, process.env[key]);
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  return vi;
});

fill('unstubAllEnvs', () => {
  for (const [key, original] of savedEnv) {
    if (original === undefined) delete process.env[key];
    else process.env[key] = original;
  }
  savedEnv.clear();
  return vi;
});

// ---------------------------------------------------------------------------
// Global stubbing — same restore-or-delete rule as the env pair, on globalThis.
// ---------------------------------------------------------------------------
const savedGlobals = new Map<string, { existed: boolean; value: unknown }>();

fill('stubGlobal', (key: string, value: unknown) => {
  if (!savedGlobals.has(key)) {
    savedGlobals.set(key, {
      existed: key in (globalThis as Record<string, unknown>),
      value: (globalThis as Record<string, unknown>)[key],
    });
  }
  (globalThis as Record<string, unknown>)[key] = value;
  return vi;
});

fill('unstubAllGlobals', () => {
  for (const [key, saved] of savedGlobals) {
    if (saved.existed) (globalThis as Record<string, unknown>)[key] = saved.value;
    else delete (globalThis as Record<string, unknown>)[key];
  }
  savedGlobals.clear();
  return vi;
});

// ---------------------------------------------------------------------------
// Pass-throughs to a real Bun/jest implementation under a different name.
// ---------------------------------------------------------------------------

// `vi.hoisted` in vitest runs its factory before the module body. Bun's own
// `mock.module` factories are already evaluated lazily at import time, so
// running the factory eagerly here matches what callers depend on: the returned
// value is available to a later `vi.mock` factory in the same file.
fill('hoisted', <T>(factory: () => T): T => factory());

// Type-only helper in vitest — the runtime value is the argument itself.
fill('mocked', <T>(item: T): T => item);

// `vi.importActual` bypasses the mock registry. Bun has no mock-aware resolver
// to bypass: an un-mocked path imports the real module, and a path this process
// HAS mocked cannot be un-mocked per-call. Only safe because it is used in
// files that do not also mock the same specifier — a file that does will get
// the mocked copy and fail loudly on the assertion rather than silently pass.
fill('importActual', (specifier: string) => import(specifier));

fill('setSystemTime', (time?: string | number | Date) => {
  setSystemTime(time === undefined ? undefined : new Date(time));
  return vi;
});

// Bun implements the sync variant; vitest's async form awaits pending
// microtasks between ticks so timer callbacks that resolve promises settle.
fill('advanceTimersByTimeAsync', async (ms: number) => {
  jest.advanceTimersByTime(ms);
  await Promise.resolve();
  return vi;
});

// ---------------------------------------------------------------------------
// vi.waitFor — poll until the callback stops throwing (or its promise rejects).
// Mirrors vitest's default 1000ms timeout / 50ms interval and its behaviour of
// surfacing the LAST failure, not a generic timeout message.
// ---------------------------------------------------------------------------
fill('waitFor', async <T>(
  callback: () => T | Promise<T>,
  options?: number | { timeout?: number; interval?: number },
): Promise<T> => {
  const timeout = typeof options === 'number' ? options : options?.timeout ?? 1000;
  const interval = typeof options === 'number' ? 50 : options?.interval ?? 50;
  const deadline = Date.now() + timeout;
  let lastError: unknown;
  for (;;) {
    try {
      return await callback();
    } catch (err) {
      lastError = err;
    }
    if (Date.now() >= deadline) {
      throw lastError ?? new Error(`vi.waitFor timed out after ${timeout}ms`);
    }
    await new Promise(resolve => setTimeout(resolve, interval));
  }
});

// Keep stubs from bleeding across tests within a file. vitest scopes them the
// same way when `unstubEnvs`/`unstubGlobals` are configured; doing it here means
// a file that stubs without restoring cannot poison its neighbours.
afterEach(() => {
  (anyVi.unstubAllEnvs as () => void)();
  (anyVi.unstubAllGlobals as () => void)();
});

// `expect(...).toMatchObject` etc. already exist in Bun; assert the pieces this
// shim depends on are really present so a Bun upgrade that moves them fails
// here with a clear message instead of deep inside an unrelated test.
if (typeof mock.module !== 'function') {
  throw new Error('bun:test mock.module is unavailable — test/bun-test-fence.ts cannot fence node:os');
}
if (typeof expect !== 'function') {
  throw new Error('bun:test expect is unavailable');
}
