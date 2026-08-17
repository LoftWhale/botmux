import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  WEB_TERMINAL_RESIZE_MIN_INTERVAL_MS,
  resolveWebTerminalResize,
} from '../src/utils/web-terminal-resize.js';

describe('resolveWebTerminalResize', () => {
  it('rejects every resize from a read-only observer', () => {
    expect(
      resolveWebTerminalResize({
        hasWrite: false,
        cols: 120,
        rows: 40,
        now: 1_000,
        lastAcceptedAt: null,
      }),
    ).toBeNull();
  });

  it('clamps an authorized resize to the supported render grid', () => {
    expect(
      resolveWebTerminalResize({
        hasWrite: true,
        cols: 100_000,
        rows: 100_000,
        now: 1_000,
        lastAcceptedAt: null,
      }),
    ).toMatchObject({ cols: 320, rows: 100, acceptedAt: 1_000 });
  });

  it('rejects malformed and over-frequent authorized resizes', () => {
    expect(
      resolveWebTerminalResize({
        hasWrite: true,
        cols: Number.NaN,
        rows: 40,
        now: 1_000,
        lastAcceptedAt: null,
      }),
    ).toBeNull();
    expect(
      resolveWebTerminalResize({
        hasWrite: true,
        cols: 120,
        rows: 40,
        now: 1_000 + WEB_TERMINAL_RESIZE_MIN_INTERVAL_MS - 1,
        lastAcceptedAt: 1_000,
      }),
    ).toBeNull();
  });

  it('keeps view-capability clients from emitting resize and pins terminal assets', () => {
    const workerSource = readFileSync(new URL('../src/worker.ts', import.meta.url), 'utf8');
    expect(workerSource).toContain('function sendResize(){\n  if(!hasToken)return;');
    expect(workerSource).toContain('@xterm/xterm@5.5.0/lib/xterm.min.js');
    expect(workerSource).not.toContain('@xterm/xterm@5/lib/xterm.min.js');
    expect(workerSource).toContain('integrity="sha384-J4qzUjBl1FxyLsl/');
    expect(workerSource).toContain('crossorigin="anonymous"');
  });
});
