import { describe, expect, it, vi } from 'vitest';

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

  // NOTE: `vi.hoisted` is intentionally NOT asserted here. vitest's transform
  // physically hoists any `vi.hoisted(…)` call to the top of the module, above
  // the imports — so merely mentioning it inside a test body makes the file
  // unparseable under vitest ("Expected a semicolon … after a statement").
  // Its shim is exercised implicitly by the 111 files that already use it.
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
