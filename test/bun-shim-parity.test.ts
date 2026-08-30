import { describe, expect, it, vi } from 'vitest';
import osDefault from 'node:os';
import { homedir, userInfo } from 'node:os';

/**
 * Guards the `vi.*` / `it.*` helpers that `test/bun-test-shim.ts` fills in under
 * `bun test`.
 *
 * WHY THIS FILE EXISTS: the shim's whole risk is *semantic drift* — a fill that
 * returns without reproducing the real effect turns a loud failure into a silent
 * false green. This repo already paid for that once (an ad-hoc `vi.stubEnv` shim
 * made the suite green while it kept writing to the developer's real
 * `~/.botmux`). So each shimmed behaviour is asserted here rather than assumed.
 *
 * Deliberately runs under BOTH runners: under vitest these assertions describe
 * the reference semantics, and under `bun test` they check the shim reproduces
 * them. A change that makes the two diverge fails on one side.
 */

describe('vi shim parity (vitest reference / bun shim)', () => {
  it('stubEnv sets, stubEnv(undefined) deletes, unstubAllEnvs restores', () => {
    process.env.BOTMUX_SHIM_PARITY_PRESET = 'orig';
    delete process.env.BOTMUX_SHIM_PARITY_ABSENT;

    vi.stubEnv('BOTMUX_SHIM_PARITY_PRESET', 'changed');
    vi.stubEnv('BOTMUX_SHIM_PARITY_ABSENT', 'added');
    expect(process.env.BOTMUX_SHIM_PARITY_PRESET).toBe('changed');
    expect(process.env.BOTMUX_SHIM_PARITY_ABSENT).toBe('added');

    // Passing undefined REMOVES the key rather than setting the string
    // "undefined" — measured against vitest, and the reason the shim branches.
    vi.stubEnv('BOTMUX_SHIM_PARITY_PRESET', undefined as unknown as string);
    expect('BOTMUX_SHIM_PARITY_PRESET' in process.env).toBe(false);

    vi.unstubAllEnvs();
    expect(process.env.BOTMUX_SHIM_PARITY_PRESET).toBe('orig');
    // A key that did not exist before stubbing is removed again, not left set.
    expect('BOTMUX_SHIM_PARITY_ABSENT' in process.env).toBe(false);

    delete process.env.BOTMUX_SHIM_PARITY_PRESET;
  });

  it('stubGlobal replaces and unstubAllGlobals restores or deletes', () => {
    const g = globalThis as Record<string, unknown>;
    g.botmuxShimParityExisting = 'before';
    delete g.botmuxShimParityFresh;

    vi.stubGlobal('botmuxShimParityExisting', 'after');
    vi.stubGlobal('botmuxShimParityFresh', 'new');
    expect(g.botmuxShimParityExisting).toBe('after');
    expect(g.botmuxShimParityFresh).toBe('new');

    vi.unstubAllGlobals();
    expect(g.botmuxShimParityExisting).toBe('before');
    expect('botmuxShimParityFresh' in g).toBe(false);

    delete g.botmuxShimParityExisting;
  });

  it('waitFor resolves with the callback value once it stops throwing', async () => {
    let ticks = 0;
    const timer = setInterval(() => { ticks += 1; }, 5);
    try {
      const got = await vi.waitFor(
        () => { if (ticks < 3) throw new Error('not yet'); return ticks; },
        { timeout: 2_000, interval: 5 },
      );
      expect(got).toBeGreaterThanOrEqual(3);
    } finally {
      clearInterval(timer);
    }
  });

  it('waitFor surfaces the LAST failure on timeout, not a generic message', async () => {
    await expect(
      vi.waitFor(() => { throw new Error('distinctive-shim-parity-failure'); }, { timeout: 60, interval: 10 }),
    ).rejects.toThrow('distinctive-shim-parity-failure');
  });

  // Real timers have their own deadline boundary, and it broke independently of
  // the fake one: the sleep must be clamped to the REMAINING timeout, or the loop
  // oversleeps and then accepts a condition that only became true afterwards
  // (measured: interval 50 / timeout 30, condition at 40ms — vitest rejected at
  // ~33ms while an unclamped shim resolved).
  it('waitFor under real timers REJECTS a condition that arrives after the timeout', async () => {
    let ready = false;
    const timer = setTimeout(() => { ready = true; }, 40);
    try {
      await expect(
        vi.waitFor(
          () => { if (!ready) throw new Error('real-late-marker'); return 'too-late'; },
          { interval: 50, timeout: 30 },
        ),
      ).rejects.toThrow('real-late-marker');
    } finally {
      clearTimeout(timer);
    }
  });

  // Fake timers are a separate code path in the shim: vitest's waitFor pumps the
  // faked clock itself, so a naive real `setTimeout` sleep deadlocks there. These
  // four pin the boundary behaviour in both directions — the shim must neither
  // hang nor accept a condition that only becomes true after the deadline.
  it('waitFor under fake timers resolves when the condition arrives in time', async () => {
    vi.useFakeTimers();
    try {
      let ready = false;
      setTimeout(() => { ready = true; }, 50);
      const got = await vi.waitFor(
        () => { if (!ready) throw new Error('not yet'); return 'arrived'; },
        { interval: 10, timeout: 500 },
      );
      expect(got).toBe('arrived');
    } finally {
      vi.useRealTimers();
    }
  });

  it('waitFor under fake timers REJECTS a condition that only arrives after the timeout', async () => {
    vi.useFakeTimers();
    try {
      let ready = false;
      setTimeout(() => { ready = true; }, 120);
      await expect(
        vi.waitFor(
          () => { if (!ready) throw new Error('late-arrival-marker'); return 'too-late'; },
          { interval: 10, timeout: 100 },
        ),
      ).rejects.toThrow('late-arrival-marker');
    } finally {
      vi.useRealTimers();
    }
  });

  it('waitFor under fake timers still observes a condition arriving exactly at the timeout', async () => {
    vi.useFakeTimers();
    try {
      let ready = false;
      setTimeout(() => { ready = true; }, 100);
      const got = await vi.waitFor(
        () => { if (!ready) throw new Error('not yet'); return 'boundary'; },
        { interval: 10, timeout: 100 },
      );
      expect(got).toBe('boundary');
    } finally {
      vi.useRealTimers();
    }
  });

  it('waitFor under fake timers surfaces the last failure when never ready', async () => {
    vi.useFakeTimers();
    try {
      await expect(
        vi.waitFor(() => { throw new Error('fake-never-ready-marker'); }, { interval: 10, timeout: 60 }),
      ).rejects.toThrow('fake-never-ready-marker');
    } finally {
      vi.useRealTimers();
    }
  });

  it('runAllTimersAsync settles a timer callback that awaits', async () => {
    vi.useFakeTimers();
    try {
      const seen: string[] = [];
      setTimeout(async () => { await Promise.resolve(); seen.push('fired'); }, 10);
      await vi.runAllTimersAsync();
      expect(seen).toEqual(['fired']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('advanceTimersByTimeAsync settles a timer callback that awaits', async () => {
    vi.useFakeTimers();
    try {
      const seen: string[] = [];
      setTimeout(async () => { await Promise.resolve(); seen.push('fired'); }, 10);
      await vi.advanceTimersByTimeAsync(20);
      expect(seen).toEqual(['fired']);
    } finally {
      vi.useRealTimers();
    }
  });

  // NOTE: the hoisting helper is intentionally NOT asserted here, for two
  // reasons. (1) vitest's transform physically lifts that call to the top of the
  // module, above the imports — so merely writing it inside a test body makes the
  // file unparseable under vitest ("Expected a semicolon … after a statement").
  // (2) scripts/run-bun-tests.mjs matches the bare identifier to decide which
  // files the bun leg must skip, so even naming it in prose here would exclude
  // THIS file from the very leg it is meant to guard. It is unsupported under
  // bun, not shimmed — see the "DELIBERATELY NOT SHIMMED" list in
  // test/bun-test-shim.ts.
});

// The home fence has TWO override targets and TWO import forms; all four
// combinations must land inside the fenced home. `userInfo().homedir` does not go
// through `homedir()` (it leaked to the real `/root` before it was overridden),
// and the default export is a separate binding from the namespace — an earlier
// shape of the bun fence pointed `default` at the UNFENCED module. Assert the
// cross-product so neither route can regress silently on either runner.
describe('home fence parity (both override targets, both import forms)', () => {
  it('homedir() and userInfo().homedir agree and are not the real home', () => {
    expect(homedir()).not.toBe('/root');
    expect(userInfo().homedir).toBe(homedir());
  });

  it('the default import sees the same fenced values as the named import', () => {
    expect(osDefault.homedir()).toBe(homedir());
    expect(osDefault.userInfo().homedir).toBe(homedir());
  });

  it('non-home fields of userInfo are left real', () => {
    expect(typeof userInfo().uid).toBe('number');
    expect(typeof userInfo().username).toBe('string');
  });
});

// `.sequential` is shimmed under bun as an IDENTITY, which is only correct because
// `bun test` runs tests sequentially by default. Assert that default directly, so
// a future Bun release that makes concurrency the default turns this red instead
// of letting the identity silently stop meaning what the caller asked for.
describe.sequential('sequential parity', () => {
  const order: string[] = [];

  it('first test yields, then finishes', async () => {
    order.push('first-start');
    await new Promise(resolve => setTimeout(resolve, 30));
    order.push('first-end');
    expect(order).toEqual(['first-start', 'first-end']);
  });

  it('second test starts only after the first fully finished', () => {
    order.push('second');
    // Interleaving would give ['first-start', 'second', …] instead.
    expect(order).toEqual(['first-start', 'first-end', 'second']);
  });
});

// `it.runIf(cond)` must behave exactly like `skipIf(!cond)`: Bun ships skipIf but
// not runIf, and the shim inverts it. Asserting the ran/skipped split (rather
// than just "did not crash") is what makes the equivalence testable.
const runIfRan: string[] = [];

describe('it.runIf parity', () => {
  it.runIf(true)('runs when the condition is true', () => {
    runIfRan.push('true-branch');
    expect(true).toBe(true);
  });

  it.runIf(false)('is skipped when the condition is false', () => {
    runIfRan.push('false-branch');
    expect(true).toBe(true);
  });

  it('observes exactly the true branch having run', () => {
    expect(runIfRan).toEqual(['true-branch']);
  });
});

describe.runIf(false)('describe.runIf(false) skips the whole block', () => {
  it('must never run', () => {
    runIfRan.push('block-branch');
    expect(true).toBe(true);
  });
});
