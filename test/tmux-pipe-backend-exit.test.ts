/**
 * Regression: tearing down the fifo reader must not wedge process exit.
 *
 * THE BUG (production incident): TmuxPipeBackend opens its fifo O_RDWR and
 * reads it with a libuv threadpool read that is deliberately BLOCKING (see the
 * O_NONBLOCK rationale in spawn()). `readStream.destroy()` detaches the JS
 * stream but leaves that thread parked inside the kernel `read()`, and since we
 * hold the write end ourselves the read never sees EOF. `process.exit()` then
 * blocks forever in uv__threadpool_cleanup joining the thread — with the event
 * loop already stopped, so the process cannot self-kill on a timer. Every
 * worker of one daemon ended up stuck mid-exit; the daemon still believed they
 * were live and kept delivering turns, so every user message came back as
 * "Worker 未能接收这条消息" (worker.input_delivery_failed), permanently.
 *
 * WHY A CHILD PROCESS: the failure IS "the process never exits". Nothing
 * in-process can observe it — an in-test assertion would itself hang. So the
 * only honest probe is to spawn a real process and assert it terminates.
 *
 * WHY tmux IS FAKED: the production code targets the DEFAULT tmux socket,
 * shared with every live daemon on this machine. A fake `tmux` first on PATH
 * keeps the real fifo/read/teardown path intact while touching no real server.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chmodSync, mkdtempSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnTsScript } from './helpers/ts-runner.js';

const FIXTURE = resolve(__dirname, 'fixtures/tmux-pipe-exit-fixture.ts');
// Generous vs. the ~250ms the fixture needs: on a loaded box a slow start must
// not look like a wedge. The wedged variant hangs forever, so a false PASS is
// impossible in the other direction.
const EXIT_TIMEOUT_MS = 20_000;

let fakeBinDir: string;

/** Run the fixture; resolve with how it ended. `timedOut` means it wedged. */
async function runFixture(mode: 'real' | 'nowake' | 'paneexit' | 'full'): Promise<{
  timedOut: boolean;
  code: number | null;
  stdout: string;
}> {
  const child = spawnTsScript(FIXTURE, [mode], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PATH: `${fakeBinDir}:${process.env.PATH ?? ''}` },
  });
  let stdout = '';
  child.stdout?.on('data', (b) => { stdout += String(b); });
  child.stderr?.on('data', (b) => { stdout += String(b); });

  return await new Promise((resolvePromise) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolvePromise({ timedOut: true, code: null, stdout });
    }, EXIT_TIMEOUT_MS);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolvePromise({ timedOut: false, code, stdout });
    });
  });
}

beforeAll(() => {
  fakeBinDir = mkdtempSync(join(tmpdir(), 'botmux-fake-tmux-'));
  const fake = join(fakeBinDir, 'tmux');
  // `pipe-pane` must succeed (exit 0) or spawn() throws before a fifo exists.
  writeFileSync(fake, '#!/bin/sh\nexit 0\n');
  chmodSync(fake, 0o755);
});

afterAll(() => {
  rmSync(fakeBinDir, { recursive: true, force: true });
});

describe('TmuxPipeBackend fifo teardown', () => {
  it('lets the process exit after kill() (does not wedge in uv_thread_join)', async () => {
    const r = await runFixture('real');

    // Order matters: assert the fixture got far enough BEFORE judging the exit,
    // so a fixture that died early can never masquerade as a clean pass.
    expect(r.stdout).toContain('TEARDOWN');
    expect(r.stdout).not.toContain('FIXTURE_NO_FIFO');
    expect(r.stdout).toContain('EXITING');
    expect(r.timedOut).toBe(false);
    expect(r.code).toBe(0);
  }, EXIT_TIMEOUT_MS + 15_000);

  // The OTHER teardown site. kill() and handlePaneExit() each own a copy of
  // this logic, so a fix landed on only one of them would still ship the bug
  // on the pane-vanished path.
  it('lets the process exit after handlePaneExit() too', async () => {
    const r = await runFixture('paneexit');

    expect(r.stdout).toContain('TEARDOWN');
    expect(r.stdout).not.toContain('FIXTURE_NO_FIFO');
    expect(r.stdout).toContain('EXITING');
    expect(r.timedOut).toBe(false);
    expect(r.code).toBe(0);
  }, EXIT_TIMEOUT_MS + 15_000);

  // The wake-up write MUST be non-blocking. At teardown nobody drains the pipe,
  // so if tmux left it full a blocking write parks forever — the same wedge,
  // moved one line down. Only this case tells the two implementations apart.
  it('still exits when the pipe is full at teardown (wake-up write must not block)', async () => {
    const r = await runFixture('full');

    expect(r.stdout).toContain('TEARDOWN');
    expect(r.stdout).not.toContain('FIXTURE_NO_FIFO');
    expect(r.timedOut).toBe(false);
    expect(r.code).toBe(0);
  }, EXIT_TIMEOUT_MS + 15_000);

  // Reverse mutation. Without this the tests above prove nothing: if the fifo
  // read were never actually parked, every variant would exit cleanly and they
  // would pass against the broken code too. This asserts the harness has teeth
  // by reproducing the pre-fix teardown and requiring it to hang.
  it('reproduces the wedge when the wake-up byte is omitted', async () => {
    const r = await runFixture('nowake');

    expect(r.stdout).toContain('TEARDOWN');
    // It reaches process.exit(0) and prints EXITING, then never dies — that is
    // exactly the production signature, so the wedge is the timeout, not a
    // missing line.
    expect(r.timedOut).toBe(true);
  }, EXIT_TIMEOUT_MS + 15_000);

  it('leaves no fifo behind after teardown', async () => {
    const before = new Set(readdirSync(tmpdir()).filter((f) => f.startsWith('botmux-pipe-')));
    const r = await runFixture('real');
    expect(r.timedOut).toBe(false);
    const after = readdirSync(tmpdir()).filter((f) => f.startsWith('botmux-pipe-'));
    expect(after.filter((f) => !before.has(f))).toEqual([]);
  }, EXIT_TIMEOUT_MS + 15_000);
});
