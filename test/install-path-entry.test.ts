/**
 * PATH entry written by both installers (`npm i -g` postinstall and install.sh).
 *
 * THE BUG THIS GUARDS: `npm i -g botmux` succeeded but left `botmux: command not
 * found`. There is no `bin` field any more, so the launcher at `~/.botmux/bin/botmux`
 * is the only `botmux` there is — and both installers merely PRINTED
 * `echo 'export PATH=…' >> ~/.profile`. **zsh never reads ~/.profile**, so a zsh
 * user who followed that hint verbatim got a silently-ignored file.
 *
 * The per-shell file choices below are measured, not recalled (see the module
 * header for the full matrix): zsh reads .zshenv in all three invocation modes;
 * bash's login (.bash_profile) and interactive (.bashrc) files are disjoint, so
 * both are needed; fish uses conf.d/*.fish and is not POSIX (`set -gx`).
 *
 * Run: npx vitest run test/install-path-entry.test.ts
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import {
  detectShell,
  pathEntryTargets,
  fileAlreadyHasEntry,
  ensurePathEntry,
  PATH_ENTRY_MARKER,
} from '../scripts/install-path-entry.mjs';

let home: string;
let installDir: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'bmx-path-'));
  installDir = join(home, '.botmux', 'bin');
  mkdirSync(installDir, { recursive: true });
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const rel = (f: string) => f.slice(home.length);

describe('detectShell', () => {
  it('reads the login shell from $SHELL', () => {
    expect(detectShell({ SHELL: '/usr/bin/zsh' })).toBe('zsh');
    expect(detectShell({ SHELL: '/bin/bash' })).toBe('bash');
    expect(detectShell({ SHELL: '/usr/local/bin/fish' })).toBe('fish');
    expect(detectShell({ SHELL: '/bin/dash' })).toBe('other');
    expect(detectShell({})).toBe('unknown');
  });

  it('matches versioned/prefixed shell paths', () => {
    expect(detectShell({ SHELL: '/opt/homebrew/bin/zsh-5.9' })).toBe('zsh');
    expect(detectShell({ SHELL: '/usr/bin/bash' })).toBe('bash');
  });
});

describe('pathEntryTargets', () => {
  it('zsh gets .zshenv — the only file read by -c, -i AND -li alike', () => {
    const t = pathEntryTargets('zsh', installDir, home);
    expect(t.map(x => rel(x.file))).toEqual(['/.zshenv']);
    // NOT .profile: that is the exact bug being fixed.
    expect(t.map(x => rel(x.file))).not.toContain('/.profile');
  });

  it('bash gets BOTH .bashrc and .bash_profile (login vs interactive are disjoint)', () => {
    const t = pathEntryTargets('bash', installDir, home);
    expect(t.map(x => rel(x.file)).sort()).toEqual(['/.bash_profile', '/.bashrc']);
  });

  it('fish gets conf.d/botmux.fish with NATIVE fish syntax, not POSIX export', () => {
    const t = pathEntryTargets('fish', installDir, home);
    expect(rel(t[0].file)).toBe('/.config/fish/conf.d/botmux.fish');
    expect(t[0].line).toContain('set -gx PATH');
    expect(t[0].line).not.toContain('export ');
  });

  it('unknown/other shells fall back to .profile', () => {
    for (const s of ['other', 'unknown']) {
      expect(rel(pathEntryTargets(s, installDir, home)[0].file)).toBe('/.profile');
    }
  });

  it('every generated line carries the installer marker and the install dir', () => {
    for (const s of ['zsh', 'bash', 'fish', 'other']) {
      for (const { line } of pathEntryTargets(s, installDir, home)) {
        expect(line).toContain(PATH_ENTRY_MARKER);
        expect(line).toContain(installDir);
      }
    }
  });
});

describe('ensurePathEntry', () => {
  it('creates the file when absent, and is idempotent on a second run', () => {
    const first = ensurePathEntry({ installDir, home, shell: 'zsh' });
    expect(first.written.map(rel)).toEqual(['/.zshenv']);
    const body = readFileSync(join(home, '.zshenv'), 'utf8');
    expect(body).toContain(installDir);

    const second = ensurePathEntry({ installDir, home, shell: 'zsh' });
    expect(second.written).toEqual([]);
    expect(second.skipped.map(rel)).toEqual(['/.zshenv']);
    // The file must not have grown a duplicate line.
    expect(readFileSync(join(home, '.zshenv'), 'utf8')).toBe(body);
  });

  it('appends without destroying existing content, and never glues onto an unterminated line', () => {
    // Deliberately NO trailing newline — the case that corrupts a naive append.
    writeFileSync(join(home, '.zshenv'), 'alias ll="ls -la"');
    ensurePathEntry({ installDir, home, shell: 'zsh' });
    const lines = readFileSync(join(home, '.zshenv'), 'utf8').split('\n');
    expect(lines[0]).toBe('alias ll="ls -la"');
    expect(lines[1]).toContain(installDir);
  });

  it("respects a PATH line the user already wrote in their own style", () => {
    writeFileSync(join(home, '.zshenv'), `path+=(${installDir})\n`);
    const r = ensurePathEntry({ installDir, home, shell: 'zsh' });
    expect(r.written).toEqual([]);
    expect(r.skipped.map(rel)).toEqual(['/.zshenv']);
  });

  it('a mention of the dir that is NOT a PATH line does not count as handled', () => {
    writeFileSync(join(home, '.zshenv'), `# I once installed things into ${installDir}\n`);
    expect(fileAlreadyHasEntry(join(home, '.zshenv'), installDir)).toBe(false);
    expect(ensurePathEntry({ installDir, home, shell: 'zsh' }).written.map(rel)).toEqual(['/.zshenv']);
  });

  it('reports a failure instead of throwing when the target cannot be written', () => {
    // A file where the parent dir must be — mkdir/append both fail, install must not.
    writeFileSync(join(home, '.config'), 'not a directory');
    const r = ensurePathEntry({ installDir, home, shell: 'fish' });
    expect(r.written).toEqual([]);
    expect(r.failed).toHaveLength(1);
    expect(r.failed[0].file).toContain('botmux.fish');
  });
});

/**
 * The payoff assertion: after writing, does the real shell actually FIND the
 * command? Anything short of this can pass while the user still sees
 * `command not found` — which is precisely how the original bug shipped.
 */
describe('the written file actually puts botmux on PATH (real shells)', () => {
  function fakeLauncher() {
    const p = join(installDir, 'botmux');
    writeFileSync(p, '#!/bin/sh\necho BOTMUX_OK\n', { mode: 0o755 });
    return p;
  }
  function have(bin: string): boolean {
    try { execFileSync('command', ['-v', bin], { shell: true, stdio: 'ignore' }); return true; }
    catch { return false; }
  }
  /** Run `botmux` through a shell, with HOME pointed at the fixture. */
  function runIn(shell: string, args: string[]): string {
    return execFileSync(shell, args, {
      env: { ...process.env, HOME: home, ZDOTDIR: home, PATH: '/usr/bin:/bin' },
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20_000,
    });
  }

  it('zsh finds it in non-interactive mode (scripts and ssh commands)', () => {
    if (!have('zsh')) return;
    fakeLauncher();
    ensurePathEntry({ installDir, home, shell: 'zsh' });
    expect(runIn('zsh', ['-c', 'botmux'])).toContain('BOTMUX_OK');
  });

  it('bash finds it in BOTH interactive and login mode', () => {
    if (!have('bash')) return;
    fakeLauncher();
    ensurePathEntry({ installDir, home, shell: 'bash' });
    // Two different startup files answer these two invocations; that is why the
    // implementation writes both.
    expect(runIn('bash', ['-ic', 'botmux'])).toContain('BOTMUX_OK');
    expect(runIn('bash', ['-lic', 'botmux'])).toContain('BOTMUX_OK');
  });

  it('fish finds it (native syntax really evaluates)', () => {
    if (!have('fish')) return;
    fakeLauncher();
    ensurePathEntry({ installDir, home, shell: 'fish' });
    expect(runIn('fish', ['-c', 'botmux'])).toContain('BOTMUX_OK');
  });

  it('a POSIX shell finds it via .profile', () => {
    if (!have('dash')) return;
    fakeLauncher();
    ensurePathEntry({ installDir, home, shell: 'other' });
    expect(runIn('dash', ['-lc', 'botmux'])).toContain('BOTMUX_OK');
  });
});

// install.sh must keep the same per-shell mapping as the .mjs above; if one is
// edited alone the two installers diverge and only one kind of user is fixed.
describe('install.sh stays in step with the shared module', () => {
  const sh = readFileSync(join(__dirname, '..', 'install.sh'), 'utf8');

  /**
   * The body of one `case` branch of the shell dispatch, so an assertion is about
   * what that shell ACTUALLY writes.
   *
   * ⚠️ Do NOT weaken this back to `expect(sh).toContain('.zshenv')`: measured, a
   * mutation that points install.sh's zsh branch at `.profile` (the original bug,
   * reintroduced) still leaves the string `.zshenv` in the surrounding comments,
   * so `toContain` stays green — an assertion satisfied by both the correct and
   * the broken file has no teeth.
   */
  function caseBranch(pattern: string): string {
    const start = sh.search(new RegExp(`^\\s*${pattern}\\)`, 'm'));
    expect(start).toBeGreaterThan(-1);
    const rest = sh.slice(start);
    const end = rest.indexOf(';;');
    expect(end).toBeGreaterThan(-1);
    return rest.slice(0, end);
  }

  it('the zsh branch writes .zshenv, not .profile', () => {
    const branch = caseBranch('\\*zsh\\*');
    expect(branch).toContain('.zshenv');
    expect(branch).not.toContain('.profile');
  });

  it('the bash branch writes BOTH .bashrc and .bash_profile', () => {
    const branch = caseBranch('\\*bash\\*');
    expect(branch).toContain('.bashrc');
    expect(branch).toContain('.bash_profile');
  });

  it('the fish branch writes conf.d/botmux.fish using native fish syntax', () => {
    const branch = caseBranch('\\*fish\\*');
    expect(branch).toContain('conf.d/botmux.fish');
    expect(branch).toContain('set -gx PATH');
  });

  it('carries the same marker so the two installers recognise each other\'s line', () => {
    expect(sh).toContain(PATH_ENTRY_MARKER);
  });
});

void existsSync;
