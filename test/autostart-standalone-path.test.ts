import { describe, expect, it, afterEach } from 'vitest';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  launchProgram, launchCommand, unitContent, plistContent, windowsScriptContent,
  type AutostartOpts,
} from '../src/autostart.js';

/**
 * Regression tests for the autostart boot hook under the COMPILED BINARY.
 *
 * THE BUG (observed in production, on a devbox running the npm-installed
 * compiled binary): every boot hook was rendered as
 * `<exe> <pkgRoot>/dist/cli.js start`, with pkgRoot derived from `__dirname`.
 * Inside a compiled binary the module graph lives in the virtual, read-only
 * `/$bunfs/`, so the written systemd unit was literally
 *
 *     ExecStart=/…/botmux-linux-x64/botmux /$bunfs/dist/cli.js start
 *
 * and `/$bunfs` does not exist outside the process (`ls /$bunfs` → ENOENT).
 *
 * IT FAILED SILENTLY, which is why it went unnoticed: the binary treats the
 * bogus path as its subcommand token, does not recognise it, prints help and
 * EXITS 0. systemd records success while `start` is swallowed as an argument and
 * no daemon ever starts — the fleet does not come back after a reboot, with no
 * error anywhere. `botmux restart` re-synced the unit each run, so the broken
 * path stayed fresh.
 *
 * This is the same `__dirname` hazard as the wrapper self-destruct covered by
 * `wrapper-standalone-guard.test.ts`; these tests cover the boot-hook renderers,
 * which had NO coverage of either runtime shape.
 */

const tempDirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'botmux-autostart-'));
  tempDirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** pkgRoot as it really looks inside a compiled binary (the value that produced
 *  the broken unit in production). */
const BUNFS_PKG_ROOT = '/$bunfs';
const BINARY = '/home/u/.local/lib/node_modules/botmux/node_modules/botmux-linux-x64/botmux';
const NODE = '/usr/bin/node';
const NODE_PKG_ROOT = '/opt/botmux';

function opts(over: Partial<AutostartOpts> = {}): AutostartOpts {
  return {
    pkgRoot: BUNFS_PKG_ROOT,
    configDir: '/home/u/.botmux',
    logDir: '/home/u/.botmux/logs',
    standalone: true,
    execPath: BINARY,
    ...over,
  };
}

/** The Node-install shape, for the backward-compatibility assertions. */
function nodeOpts(over: Partial<AutostartOpts> = {}): AutostartOpts {
  return opts({ pkgRoot: NODE_PKG_ROOT, standalone: false, execPath: NODE, ...over });
}

describe('autostart boot hook — compiled binary (standalone) shape', () => {
  it('execs the binary itself: no /$bunfs path, no dist/cli.js', () => {
    expect(launchProgram(opts())).toEqual([BINARY]);
    const cmd = launchCommand(opts(), 'start');
    expect(cmd).not.toContain('$bunfs');
    expect(cmd).not.toContain('cli.js');
    expect(cmd).toBe(`${BINARY} start`);
  });

  it('renders no /$bunfs into the systemd unit (ExecStart AND ExecStop)', () => {
    const unit = unitContent(opts());
    expect(unit).not.toContain('$bunfs');
    expect(unit).not.toContain('cli.js');
    expect(unit).toContain(`ExecStart=${BINARY} start`);
    // ExecStop was broken the same way and is just as load-bearing: a bad path
    // there makes `systemctl --user stop botmux` a no-op that reports success.
    expect(unit).toContain(`ExecStop=${BINARY} stop`);
  });

  it('renders no /$bunfs into the launchd plist or the Windows startup script', () => {
    const plist = plistContent(opts());
    expect(plist).not.toContain('$bunfs');
    expect(plist).not.toContain('cli.js');
    // ProgramArguments is an array: exactly the binary, then the subcommand.
    expect(plist).toContain(`        <string>${BINARY}</string>\n        <string>start</string>`);

    const bat = windowsScriptContent(opts());
    expect(bat).not.toContain('$bunfs');
    expect(bat).not.toContain('cli.js');
    expect(bat).toContain(`"${BINARY}" "start"`);
  });

  it('the rendered ExecStart actually starts botmux (not: prints help and exits 0)', () => {
    // THE HEART OF THE BUG. A string assertion alone would have passed even in
    // production, because the broken command was still a well-formed command
    // line — it just did the wrong thing and reported success. So run it.
    //
    // The stand-in binary behaves like the real one where it matters: it accepts
    // `start` and rejects anything else with help-on-stdout + exit 0, which is
    // exactly what made the failure invisible to systemd.
    const dir = tmp();
    const fakeBinary = join(dir, 'botmux');
    writeFileSync(fakeBinary, [
      '#!/bin/sh',
      'if [ "$1" = "start" ]; then echo "DAEMON_STARTED"; exit 0; fi',
      'echo "botmux — usage: botmux <command>"',   // help text, like the real CLI
      'exit 0',                                    // ...and a SUCCESS exit code
    ].join('\n'), { mode: 0o755 });
    chmodSync(fakeBinary, 0o755);

    const execStart = unitContent(opts({ execPath: fakeBinary }))
      .split('\n').find((l) => l.startsWith('ExecStart='))!.slice('ExecStart='.length);
    const r = spawnSync('/bin/sh', ['-c', execStart], { encoding: 'utf-8' });

    expect(r.status).toBe(0);
    expect(r.stdout).toContain('DAEMON_STARTED');
    // The pre-fix command line hit this branch — and still exited 0.
    expect(r.stdout).not.toContain('usage');
  });

  it('proves the stand-in reproduces the silent failure (control for the test above)', () => {
    // Without this, "DAEMON_STARTED" could pass for a reason unrelated to the
    // fix. Feed the fake binary the PRE-FIX argv and show it is the documented
    // silent failure: help text, no daemon, exit 0.
    const dir = tmp();
    const fakeBinary = join(dir, 'botmux');
    writeFileSync(fakeBinary, [
      '#!/bin/sh',
      'if [ "$1" = "start" ]; then echo "DAEMON_STARTED"; exit 0; fi',
      'echo "botmux — usage: botmux <command>"',
      'exit 0',
    ].join('\n'), { mode: 0o755 });
    chmodSync(fakeBinary, 0o755);

    // Quoted so this test observes the real argv shape rather than sh's own
    // expansion of `$bunfs` (unquoted, sh would expand it to the empty string —
    // a second, independent way the old unit was wrong).
    const r = spawnSync('/bin/sh', ['-c', `${fakeBinary} '/$bunfs/dist/cli.js' start`], { encoding: 'utf-8' });
    expect(r.status).toBe(0);              // systemd saw success...
    expect(r.stdout).toContain('usage');   // ...while botmux only printed help
    expect(r.stdout).not.toContain('DAEMON_STARTED');
  });
});

describe('autostart boot hook — Node install shape stays unchanged', () => {
  // The fix must not "work" by breaking the path that was already correct.
  it('still runs `node <pkgRoot>/dist/cli.js`', () => {
    expect(launchProgram(nodeOpts())).toEqual([NODE, `${NODE_PKG_ROOT}/dist/cli.js`]);
    expect(launchCommand(nodeOpts(), 'start')).toBe(`${NODE} ${NODE_PKG_ROOT}/dist/cli.js start`);
  });

  it('unit, plist and .bat all keep the two-element program', () => {
    expect(unitContent(nodeOpts()))
      .toContain(`ExecStart=${NODE} ${NODE_PKG_ROOT}/dist/cli.js start`);
    expect(unitContent(nodeOpts()))
      .toContain(`ExecStop=${NODE} ${NODE_PKG_ROOT}/dist/cli.js stop`);
    expect(plistContent(nodeOpts()))
      .toContain(`        <string>${NODE}</string>\n        <string>${NODE_PKG_ROOT}/dist/cli.js</string>`);
    expect(windowsScriptContent(nodeOpts()))
      .toContain(`"${NODE}" "${NODE_PKG_ROOT}/dist/cli.js" "start"`);
  });
});
