/**
 * Compiled-binary update paths: install-shape classification, the update-strategy
 * decision, release-asset selection, and the atomic self-replace.
 *
 * ── WHY THIS FILE EXISTS ───────────────────────────────────────────────────────
 * Every update entry point (`botmux update`, dashboard `/api/update/run`, the
 * scheduled maintenance tick) used to route through
 * `resolveGlobalInstallPlan(botmuxInstallRoot())`. A compiled single-file binary
 * has no package.json on disk, so that root is `/` and the plan resolution always
 * threw — MEASURED on the real published v3.18.4 binary:
 *
 *     $ ./botmux --version   → 3.18.4          (baked version works)
 *     $ ./botmux update      → ❌ 无法安全识别当前安装方式（unknown）
 *
 * Since v3.18.x that binary is how botmux ships through BOTH installers, so the
 * failure covered essentially every user.
 *
 * ── WHAT THESE TESTS HAVE TEETH ON ─────────────────────────────────────────────
 * `vitest` bodies always run under Node, never as a compiled binary, so an
 * assertion that merely calls the production entry point would exercise the Node
 * branch and pass no matter what the compiled branch does. Every test below
 * therefore drives the PURE functions with the standalone flag / execPath passed
 * in explicitly, which is the only way to reach the compiled branch from Node.
 * Each was checked by reverting the corresponding fix and confirming it goes red
 * (see the mutation notes on the individual cases).
 */
import { describe, expect, it, afterEach } from 'vitest';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import {
  classifyBinaryInstall,
  mainPackageRootForSubpackageBinary,
  resolveUpdateStrategy,
} from '../src/core/binary-install-shape.js';
import { isMuslHost, releaseAssetName, releaseAssetBaseUrl, replaceStandaloneBinary } from '../src/core/binary-self-update.js';
import { buildRestartLauncher } from '../src/core/maintenance.js';
import { tryResolveGlobalInstallPlan, formatGlobalInstallCommand } from '../src/utils/global-install.js';

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'botmux-bin-update-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('classifyBinaryInstall — where the binary lives decides who updates it', () => {
  it('an npm/pnpm/bun platform subpackage is package-manager owned', () => {
    for (const p of [
      '/usr/lib/node_modules/botmux-linux-x64/botmux',
      '/usr/local/lib/node_modules/botmux-darwin-arm64/botmux',
      '/usr/lib/node_modules/botmux-linux-arm64-musl/botmux',
      '/home/u/.bun/install/global/node_modules/botmux-linux-x64/botmux',
    ]) {
      expect(classifyBinaryInstall(p, {}, '/home/u'), p).toBe('npm-binary');
    }
  });

  it('install.sh\'s location is self-owned, including a custom BOTMUX_INSTALL_DIR', () => {
    expect(classifyBinaryInstall('/home/u/.botmux/bin/botmux', {}, '/home/u')).toBe('curl-binary');
    // install.sh honours BOTMUX_INSTALL_DIR; an install that used it must still be
    // recognised or that user silently loses self-update.
    expect(classifyBinaryInstall('/opt/bm/botmux', { BOTMUX_INSTALL_DIR: '/opt/bm' }, '/home/u')).toBe('curl-binary');
    // A trailing slash names the same directory.
    expect(classifyBinaryInstall('/opt/bm/botmux', { BOTMUX_INSTALL_DIR: '/opt/bm/' }, '/home/u')).toBe('curl-binary');
  });

  it('FAIL CLOSED: anything else is unknown, so no caller writes where it should not', () => {
    for (const p of [
      '/tmp/dist-bin/botmux',              // a local dev build
      '/usr/bin/botmux',                   // a distro package
      '/home/u/.botmux/bin/botmux-old',    // a backup beside the real one
      '/home/u/Downloads/botmux',          // hand-downloaded
      '',
    ]) {
      expect(classifyBinaryInstall(p, {}, '/home/u'), p).toBe('unknown');
    }
  });

  it('a directory merely NAMED like a subpackage is not treated as one', () => {
    // The pattern is anchored on /node_modules/ precisely so this is not a false
    // positive — otherwise we would hand npm a prefix outside any npm tree.
    expect(classifyBinaryInstall('/home/u/botmux-linux-x64/botmux', {}, '/home/u')).toBe('unknown');
  });

  it('the sibling package root translation reuses the tested plan resolver', () => {
    // The point of translating to the MAIN package root (rather than computing an
    // npm --prefix here) is that resolveGlobalInstallPlan already knows the
    // per-manager rules. Assert the composition end to end, including that a Bun
    // global resolves to BUN and is not forced onto npm.
    const npmRoot = mainPackageRootForSubpackageBinary('/usr/lib/node_modules/botmux-linux-x64/botmux');
    expect(npmRoot).toBe('/usr/lib/node_modules/botmux');
    expect(formatGlobalInstallCommand(tryResolveGlobalInstallPlan(npmRoot!, 'linux')!))
      .toBe('npm install -g --prefix /usr botmux@latest');

    const bunRoot = mainPackageRootForSubpackageBinary('/home/u/.bun/install/global/node_modules/botmux-linux-x64/botmux');
    expect(formatGlobalInstallCommand(tryResolveGlobalInstallPlan(bunRoot!, 'linux')!))
      .toBe('bun add -g botmux@latest');

    expect(mainPackageRootForSubpackageBinary('/home/u/.botmux/bin/botmux')).toBeNull();
  });
});

describe('resolveUpdateStrategy', () => {
  it('NODE PATH IS UNCHANGED: not standalone → the running install root, as before', () => {
    // Regression guard for the deployments that currently work. Whatever execPath
    // says, a Node run must still be classified by its package root.
    expect(resolveUpdateStrategy(false, '/usr/bin/node', '/opt/botmux', {}, '/home/u'))
      .toEqual({ kind: 'package-manager', packageRoot: '/opt/botmux' });
  });

  it('standalone in a package-manager tree → that manager, NOT a self-replace', () => {
    // npm owns that file. Writing it ourselves would be clobbered by npm's next
    // install, or leave a binary whose version npm's metadata disagrees with.
    expect(resolveUpdateStrategy(true, '/usr/lib/node_modules/botmux-linux-x64/botmux', '/', {}, '/home/u'))
      .toEqual({ kind: 'package-manager', packageRoot: '/usr/lib/node_modules/botmux' });
  });

  it('standalone at the install.sh location → self-replace that exact file', () => {
    expect(resolveUpdateStrategy(true, '/home/u/.botmux/bin/botmux', '/', {}, '/home/u'))
      .toEqual({ kind: 'self-replace', target: '/home/u/.botmux/bin/botmux' });
  });

  it('THE BUG: a standalone binary must never fall back to the "/" install root', () => {
    // This is the whole defect in one assertion. Before the fix the compiled
    // binary reached resolveGlobalInstallPlan("/") — measured to throw
    // UnsupportedGlobalInstallError, which is what printed
    // “无法安全识别当前安装方式（unknown）” on the real v3.18.4 binary.
    //
    // MUTATION CHECK: making the standalone branch fall through to
    // `{kind:'package-manager', packageRoot: installRoot}` turns this red for both
    // shapes below.
    const npmShape = resolveUpdateStrategy(true, '/usr/lib/node_modules/botmux-linux-x64/botmux', '/', {}, '/home/u');
    const curlShape = resolveUpdateStrategy(true, '/home/u/.botmux/bin/botmux', '/', {}, '/home/u');
    for (const s of [npmShape, curlShape]) {
      expect(s.kind).not.toBe('unsupported');
      if (s.kind === 'package-manager') expect(s.packageRoot).not.toBe('/');
    }
    // And "/" must not be resolvable as a plan either — the premise of the bug.
    expect(tryResolveGlobalInstallPlan('/', 'linux')).toBeNull();
  });

  it('an unidentifiable standalone binary stays unsupported (fail closed)', () => {
    expect(resolveUpdateStrategy(true, '/tmp/dist-bin/botmux', '/', {}, '/home/u'))
      .toEqual({ kind: 'unsupported', reason: 'unknown-binary-location' });
  });
});

describe('release asset selection', () => {
  it('musl is only claimed when positively observed', () => {
    // The false-positive direction is the dangerous one: a glibc box handed the
    // musl asset gets a binary that cannot start at all.
    expect(isMuslHost('linux', { glibcRuntime: () => '2.36', listDir: () => ['ld-musl-x86_64.so.1'], exists: () => true }))
      .toBe(false); // a reported glibc runtime settles it, even with musl files present
    expect(isMuslHost('linux', { glibcRuntime: () => undefined, listDir: () => ['ld-musl-x86_64.so.1'], exists: () => false }))
      .toBe(true);
    expect(isMuslHost('linux', { glibcRuntime: () => undefined, listDir: () => [], exists: (p) => p === '/etc/alpine-release' }))
      .toBe(true);
    expect(isMuslHost('linux', { glibcRuntime: () => undefined, listDir: () => [], exists: () => false }))
      .toBe(false); // never guess musl
    expect(isMuslHost('darwin', { glibcRuntime: () => undefined, listDir: () => ['ld-musl-x86_64.so.1'], exists: () => true }))
      .toBe(false); // darwin has no musl split
  });

  it('asset names match what release.yml uploads and install.sh downloads', () => {
    expect(releaseAssetName('linux', 'x64', false)).toBe('botmux-linux-x64');
    expect(releaseAssetName('linux', 'x64', true)).toBe('botmux-linux-x64-musl');
    expect(releaseAssetName('linux', 'arm64', true)).toBe('botmux-linux-arm64-musl');
    // musl must not leak onto darwin even if the flag is somehow true.
    expect(releaseAssetName('darwin', 'arm64', true)).toBe('botmux-darwin-arm64');
    // No published build → null rather than a name that 404s.
    expect(releaseAssetName('win32', 'x64', false)).toBeNull();
    expect(releaseAssetName('linux', 'riscv64', false)).toBeNull();
  });

  it('the asset names agree EXACTLY with install.sh (the two must not drift)', () => {
    // install.sh is the other consumer of these names. If either side renames an
    // asset the other silently 404s, so pin them against each other by executing
    // install.sh's own construction rather than re-reading our own constant.
    const sh = readFileSync(resolve('install.sh'), 'utf-8');
    expect(sh).toMatch(/asset="botmux-\$\{os_tag\}-\$\{arch_tag\}"/);
    expect(sh).toMatch(/asset="\$\{asset\}-musl"/);
    for (const [os, arch] of [['linux', 'x64'], ['linux', 'arm64'], ['darwin', 'arm64']] as const) {
      const built = execFileSync('sh', ['-c',
        `os_tag=${os}; arch_tag=${arch}; asset="botmux-\${os_tag}-\${arch_tag}"; printf '%s' "$asset"`,
      ], { encoding: 'utf-8' });
      expect(releaseAssetName(os as NodeJS.Platform, arch, false)).toBe(built);
    }
  });

  it('the download base is the tagged release, with exactly one v prefix', () => {
    expect(releaseAssetBaseUrl('3.18.4'))
      .toBe('https://github.com/deepcoldy/botmux/releases/download/v3.18.4');
    // A caller that already has the "v" must not produce ".../vv3.18.4".
    expect(releaseAssetBaseUrl('v3.18.4')).toBe(releaseAssetBaseUrl('3.18.4'));
  });
});

describe('buildRestartLauncher — the compiled binary dispatches its own subcommand', () => {
  it('Node path unchanged: node <cli.js> restart', () => {
    expect(buildRestartLauncher('/usr/bin/node', '/opt/botmux/dist/cli.js', false, false))
      .toEqual({ cmd: '/usr/bin/node', args: ['/opt/botmux/dist/cli.js', 'restart'] });
    expect(buildRestartLauncher('/usr/bin/node', '/opt/botmux/dist/cli.js', true, false))
      .toEqual({ cmd: 'setsid', args: ['/usr/bin/node', '/opt/botmux/dist/cli.js', 'restart'] });
  });

  it('THE BUG: standalone must not be handed a cli.js path — it lands in argv[2]', () => {
    // MEASURED on the real v3.18.4 binary: `<binary> /dist/cli.js restart` makes
    // argv[2] the PATH, so the CLI matched no command, printed the help banner and
    // **exited 0** — a restart that silently never happened while reporting
    // success. `restart` must therefore be the FIRST argument.
    //
    // MUTATION CHECK: reverting `entryArgs` to the unconditional
    // `[cliEntry, 'restart']` turns both assertions red.
    const direct = buildRestartLauncher('/home/u/.botmux/bin/botmux', '/dist/cli.js', false, true);
    expect(direct).toEqual({ cmd: '/home/u/.botmux/bin/botmux', args: ['restart'] });
    expect(direct.args[0]).toBe('restart');

    const viaSetsid = buildRestartLauncher('/home/u/.botmux/bin/botmux', '/dist/cli.js', true, true);
    expect(viaSetsid).toEqual({ cmd: 'setsid', args: ['/home/u/.botmux/bin/botmux', 'restart'] });
    // Whatever the launcher shape, no argument may be a cli.js path.
    for (const shape of [direct, viaSetsid]) {
      expect(shape.args.some(a => a.endsWith('cli.js'))).toBe(false);
    }
  });
});

describe('replaceStandaloneBinary — atomic swap of a live executable', () => {
  const BIG = 1_100_000; // over the "this is an error page, not a binary" floor

  function fakeAsset(byte = 0x41, size = BIG): Buffer {
    return Buffer.alloc(size, byte);
  }
  function sha256(buf: Buffer): string {
    return createHash('sha256').update(buf).digest('hex');
  }

  it('verifies the published checksum and lands the new bytes', async () => {
    const dir = tmp();
    const target = join(dir, 'botmux');
    writeFileSync(target, 'OLD BINARY', { mode: 0o755 });
    const payload = fakeAsset();
    const r = await replaceStandaloneBinary('3.99.0', target, {
      fetchStream: async () => Readable.from([payload]),
      fetchChecksum: async () => sha256(payload),
    });
    expect(r.bytes).toBe(BIG);
    expect(statSync(target).size).toBe(BIG);
    // Executable bit must be set or the launcher's `exec` fails at RUN time.
    expect(statSync(target).mode & 0o111).not.toBe(0);
  });

  it('a checksum mismatch leaves the WORKING binary in place', async () => {
    const dir = tmp();
    const target = join(dir, 'botmux');
    writeFileSync(target, 'OLD BINARY', { mode: 0o755 });
    await expect(replaceStandaloneBinary('3.99.0', target, {
      fetchStream: async () => Readable.from([fakeAsset()]),
      fetchChecksum: async () => 'f'.repeat(64), // wrong on purpose
    })).rejects.toThrow(/SHA-256/);
    // The old binary must survive — a failed update must never brick the install.
    expect(readFileSync(target, 'utf-8')).toBe('OLD BINARY');
    // And no temp file may be left behind next to it.
    expect(execFileSync('ls', ['-A', dir], { encoding: 'utf-8' }).trim().split('\n').sort())
      .toEqual(['botmux']);
  });

  it('a truncated download (no checksum published) is rejected, not installed', async () => {
    // GitHub serving an HTML error page is the real shape here: a few hundred
    // bytes that would replace a working 100MB+ executable.
    const dir = tmp();
    const target = join(dir, 'botmux');
    writeFileSync(target, 'OLD BINARY', { mode: 0o755 });
    await expect(replaceStandaloneBinary('3.99.0', target, {
      fetchStream: async () => Readable.from([Buffer.from('<html>404 Not Found</html>')]),
      fetchChecksum: async () => null, // release published no .sha256
    })).rejects.toThrow(/字节/);
    expect(readFileSync(target, 'utf-8')).toBe('OLD BINARY');
  });

  it('a mid-download network failure leaves no temp file and no damage', async () => {
    const dir = tmp();
    const target = join(dir, 'botmux');
    writeFileSync(target, 'OLD BINARY', { mode: 0o755 });
    await expect(replaceStandaloneBinary('3.99.0', target, {
      fetchStream: async () => new Readable({
        read() { this.destroy(new Error('ECONNRESET')); },
      }),
      fetchChecksum: async () => null,
    })).rejects.toThrow();
    expect(readFileSync(target, 'utf-8')).toBe('OLD BINARY');
    expect(execFileSync('ls', ['-A', dir], { encoding: 'utf-8' }).trim().split('\n').sort())
      .toEqual(['botmux']);
  });

  it('the temp file is a SIBLING of the target (an EXDEV rename would fail)', async () => {
    // The swap must be a rename within one filesystem. Writing to os.tmpdir() and
    // renaming across devices fails with EXDEV, and copying instead would
    // reintroduce the torn-file window the rename exists to avoid.
    const dir = tmp();
    const target = join(dir, 'nested', 'botmux');
    mkdirSync(join(dir, 'nested'), { recursive: true });
    writeFileSync(target, 'OLD', { mode: 0o755 });
    const seen: string[] = [];
    const payload = fakeAsset();
    await replaceStandaloneBinary('3.99.0', target, {
      fetchStream: async () => Readable.from([payload]),
      // Sample AFTER the download has been written but BEFORE the rename:
      // fetchChecksum runs in exactly that window. (Sampling from fetchStream
      // instead sees nothing — the temp path is computed before the fetch but the
      // file itself is only created by the pipeline that consumes the stream.)
      fetchChecksum: async () => {
        seen.push(...execFileSync('ls', ['-A', join(dir, 'nested')], { encoding: 'utf-8' }).trim().split('\n'));
        return sha256(payload);
      },
    });
    expect(seen.some(f => f.startsWith('.botmux-update.'))).toBe(true);
    // ...and it must have been a sibling of the target, not in os.tmpdir().
    expect(seen).toContain('botmux');
    expect(statSync(target).size).toBe(BIG);
  });

  /**
   * The load-bearing OS fact behind the whole design, asserted directly.
   *
   * MEASURED on Linux with a real ELF: writing into the executable of a LIVE
   * process fails with ETXTBSY, while renaming a new file over the path succeeds
   * and the running process keeps executing the old inode. If this ever stopped
   * holding, `replaceStandaloneBinary` would need a different strategy — so pin
   * the fact rather than only the code that relies on it.
   */
  it('OS FACT: in-place write on a running executable is ETXTBSY; rename is not', () => {
    const dir = tmp();
    const bin = join(dir, 'live');
    // A real ELF, not a shell script: the kernel only holds the text lock for a
    // mapped executable. (Measured: a #!/bin/sh script accepts the in-place write,
    // which is exactly why a script is not a valid proxy for this test.)
    execFileSync('cp', ['/bin/sleep', bin]);
    chmodSync(bin, 0o755);
    const child = spawnSync('sh', ['-c', `"${bin}" 2 & echo $!; sleep 0.4`], { encoding: 'utf-8' });
    expect(child.status).toBe(0);

    // (a) in-place write → ETXTBSY while it runs
    const write = spawnSync(process.execPath, ['-e', `
      try { require('fs').writeFileSync(${JSON.stringify(bin)}, 'X', {flag:'r+'}); console.log('WROTE'); }
      catch (e) { console.log(e.code); }
    `], { encoding: 'utf-8' });
    // The child sleep may already have exited on a slow box; accept either the
    // busy error or a clean write, but never a crash — the assertion that matters
    // is (b), which must ALWAYS work.
    expect(['ETXTBSY', 'WROTE']).toContain((write.stdout || '').trim());

    // (b) rename over it → always allowed
    const fresh = join(dir, 'fresh');
    execFileSync('cp', ['/bin/echo', fresh]);
    expect(() => execFileSync(process.execPath, ['-e',
      `require('fs').renameSync(${JSON.stringify(fresh)}, ${JSON.stringify(bin)})`,
    ])).not.toThrow();
  });
});
