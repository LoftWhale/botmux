import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import {
  findBytedcliBinary,
  resolveJwtRefreshCmd,
  refreshBytecloudJwt,
  JWT_REFRESH_DEBOUNCE_MS,
  __resetJwtRefreshDebounceForTest,
} from '../src/adapters/backend/riff-backend.js';

// The refresh helpers are pure + injectable (runner / now / env / platform), so
// none of these tests spawn a real process. findBytedcliBinary is probed against
// a real temp PATH dir (no mocking of node:fs).

describe('findBytedcliBinary — PATH probe', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'bytedcli-path-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('returns "bytedcli" when a matching binary exists on a PATH segment', () => {
    const bin = join(dir, 'bytedcli');
    writeFileSync(bin, '#!/bin/sh\n');
    chmodSync(bin, 0o755);
    const env = { PATH: ['/nope/a', dir, '/nope/b'].join(delimiter) } as NodeJS.ProcessEnv;
    expect(findBytedcliBinary(env, 'linux')).toBe('bytedcli');
  });

  it('returns null with an empty or missing PATH', () => {
    expect(findBytedcliBinary({ PATH: '' }, 'linux')).toBeNull();
    expect(findBytedcliBinary({} as NodeJS.ProcessEnv, 'linux')).toBeNull();
  });

  it('returns null when no PATH segment contains the binary', () => {
    const env = { PATH: ['/nope/a', dir].join(delimiter) } as NodeJS.ProcessEnv;
    expect(findBytedcliBinary(env, 'linux')).toBeNull();
  });
});

describe('resolveJwtRefreshCmd — precedence', () => {
  it('explicit config command wins over everything', () => {
    const env = { BOTMUX_RIFF_JWT_REFRESH_CMD: 'other cmd' } as NodeJS.ProcessEnv;
    expect(resolveJwtRefreshCmd(['my', 'cmd', '--x'], env, 'linux')).toEqual(['my', 'cmd', '--x']);
  });

  it('falls back to the env var (space-split, blanks dropped)', () => {
    const env = {
      BOTMUX_RIFF_JWT_REFRESH_CMD: '  bytedcli auth get-bytecloud-jwt-token --force-refresh  ',
    } as NodeJS.ProcessEnv;
    expect(resolveJwtRefreshCmd(undefined, env, 'linux')).toEqual([
      'bytedcli', 'auth', 'get-bytecloud-jwt-token', '--force-refresh',
    ]);
  });

  it('empty env var is ignored (no phantom command)', () => {
    const env = { BOTMUX_RIFF_JWT_REFRESH_CMD: '   ', PATH: '/nope' } as NodeJS.ProcessEnv;
    expect(resolveJwtRefreshCmd(undefined, env, 'linux')).toBeNull();
  });

  it('returns null when nothing is configured and bytedcli is not on PATH', () => {
    const env = { PATH: '/nope/bin' } as NodeJS.ProcessEnv;
    expect(resolveJwtRefreshCmd(undefined, env, 'linux')).toBeNull();
  });

  it('empty config array is treated as unset (does not shadow env/PATH resolution)', () => {
    const env = { BOTMUX_RIFF_JWT_REFRESH_CMD: 'bytedcli auth x' } as NodeJS.ProcessEnv;
    expect(resolveJwtRefreshCmd([], env, 'linux')).toEqual(['bytedcli', 'auth', 'x']);
  });
});

describe('refreshBytecloudJwt — debounce + fail-closed', () => {
  beforeEach(() => { __resetJwtRefreshDebounceForTest(); });
  afterEach(() => { __resetJwtRefreshDebounceForTest(); });

  it('returns false immediately when no command resolves (fail-closed, no run)', () => {
    const runner = vi.fn();
    expect(refreshBytecloudJwt(null, runner, 1_000)).toBe(false);
    expect(runner).not.toHaveBeenCalled();
  });

  it('runs the command and returns true on success', () => {
    const runner = vi.fn();
    const ok = refreshBytecloudJwt(['bytedcli', 'auth', 'x', '--force-refresh'], runner, 1_000);
    expect(ok).toBe(true);
    expect(runner).toHaveBeenCalledWith('bytedcli', ['auth', 'x', '--force-refresh']);
  });

  it('swallows a throwing runner (non-fatal) and returns false', () => {
    const runner = vi.fn(() => { throw new Error('bytedcli not logged in'); });
    expect(refreshBytecloudJwt(['bytedcli', 'auth', 'x'], runner, 1_000)).toBe(false);
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it('debounces: a second call within the window does not run again', () => {
    const runner = vi.fn();
    const cmd = ['bytedcli', 'auth', 'x'];
    expect(refreshBytecloudJwt(cmd, runner, 1_000)).toBe(true);
    // 1s later — still inside the 60s window
    expect(refreshBytecloudJwt(cmd, runner, 2_000)).toBe(false);
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it('allows another run once the debounce window has fully elapsed', () => {
    const runner = vi.fn();
    const cmd = ['bytedcli', 'auth', 'x'];
    expect(refreshBytecloudJwt(cmd, runner, 1_000)).toBe(true);
    expect(refreshBytecloudJwt(cmd, runner, 1_000 + JWT_REFRESH_DEBOUNCE_MS)).toBe(true);
    expect(runner).toHaveBeenCalledTimes(2);
  });

  it('a FAILED attempt still consumes the debounce window (caps flapping refresh cost)', () => {
    const runner = vi.fn(() => { throw new Error('boom'); });
    const cmd = ['bytedcli', 'auth', 'x'];
    expect(refreshBytecloudJwt(cmd, runner, 1_000)).toBe(false);
    // even though it failed, we don't hammer the command within the window
    expect(refreshBytecloudJwt(cmd, runner, 2_000)).toBe(false);
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it('an empty command array resolves to false without touching the debounce clock', () => {
    const runner = vi.fn();
    expect(refreshBytecloudJwt([], runner, 1_000)).toBe(false);
    // clock untouched → a real command right after still runs
    expect(refreshBytecloudJwt(['bytedcli', 'x'], runner, 1_500)).toBe(true);
    expect(runner).toHaveBeenCalledTimes(1);
  });
});
