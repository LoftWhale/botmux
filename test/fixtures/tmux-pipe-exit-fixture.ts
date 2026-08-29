/**
 * Fixture for tmux-pipe-backend-exit.test.ts — run as a CHILD process.
 *
 * Exercises the REAL TmuxPipeBackend fifo lifecycle (spawn → kill) and then
 * lets the process exit naturally. The parent asserts the child actually
 * exits: the bug under test wedges `process.exit()` forever, which is
 * invisible in-process and therefore cannot be caught by an in-test assertion.
 *
 * tmux itself is neutralized by a fake `tmux` executable the parent puts first
 * on PATH, so nothing here touches the real tmux server (the production code
 * targets the DEFAULT socket, shared with every live daemon on the machine).
 * Everything else — mkfifo, the O_RDWR open, the libuv read stream, the
 * teardown — is the real production path.
 *
 * argv[2] selects the teardown variant so the parent can run reverse mutations:
 *   real     — the shipped kill() path
 *   paneexit — the OTHER teardown site, handlePaneExit(); without this a fix
 *              applied to only one of the two sites would look complete
 *   full     — pipe deliberately full at teardown (tmux left output behind and
 *              the reader is no longer draining). Distinguishes a NON-BLOCKING
 *              wake-up write from a blocking one: a blocking write on our own
 *              O_RDWR fd hangs here, recreating the very bug being fixed
 *   nowake   — reproduces the pre-fix teardown (destroy + unlink, no wake-up
 *              byte) and MUST hang, proving the harness has teeth
 */
import fs from 'node:fs';
import { TmuxPipeBackend } from '../../src/adapters/backend/tmux-pipe-backend.js';

const mode = process.argv[2] ?? 'real';

const backend = new TmuxPipeBackend('bmx-exit-fixture');
backend.spawn('/bin/true', [], { cwd: process.cwd(), cols: 80, rows: 24, env: {} });

// Prove the fifo reader is actually live before tearing it down — otherwise a
// spawn() that silently failed to open the fifo would make this test pass for
// the wrong reason (no blocked read to wedge on in the first place).
const fifoFd = (backend as unknown as { fifoFd: number | null }).fifoFd;
const readStream = (backend as unknown as { readStream: unknown }).readStream;
if (typeof fifoFd !== 'number' || !readStream) {
  process.stdout.write('FIXTURE_NO_FIFO\n');
  process.exit(2);
}
const fifoPath = (backend as unknown as { fifoPath: string }).fifoPath;

// Give libuv a moment to park a threadpool read on the fifo. Without a read in
// flight there is nothing to wedge and both variants would exit cleanly.
setTimeout(() => {
  if (mode === 'full') {
    // Fill the pipe (Linux default 64KB) BEFORE teardown. The reader is about
    // to stop draining, so a blocking wake-up write would park here forever —
    // which is what separates the correct non-blocking write from the naive one.
    try {
      const stuffFd = fs.openSync(fifoPath, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK);
      try { for (;;) fs.writeSync(stuffFd, Buffer.alloc(4096, 0x41)); }
      catch { /* EAGAIN — pipe is now full, which is the point */ }
      fs.closeSync(stuffFd);
    } catch { /* best effort */ }
  }
  process.stdout.write('TEARDOWN\n');
  if (mode === 'nowake') {
    // Pre-fix teardown, inlined: destroy the stream and unlink, but never wake
    // the parked read. This is the reverse mutation — it must hang.
    (backend as unknown as { readStream: { destroy(): void } | null }).readStream?.destroy();
    (backend as unknown as { readStream: unknown }).readStream = null;
    try { fs.closeSync(fifoFd); } catch { /* already closed */ }
    try { fs.unlinkSync(fifoPath); } catch { /* already gone */ }
  } else if (mode === 'paneexit') {
    // The other teardown site. Private, and reached in production when the
    // lifecycle watcher notices the pane vanished.
    (backend as unknown as { handlePaneExit(): void }).handlePaneExit();
  } else {
    backend.kill();
  }
  process.stdout.write('EXITING\n');
  process.exit(0);
}, 250);
