/**
 * Put `~/.botmux/bin` on the user's PATH by writing their shell's startup file.
 *
 * WHY THIS EXISTS
 * `npm i -g botmux` has no `bin` field (removed with the Node fallback — see
 * postinstall-bin.mjs), so the ONLY `botmux` command is the launcher written to
 * `~/.botmux/bin/botmux`. If that directory is not on PATH, a successful install
 * still leaves the user with `botmux: command not found`.
 *
 * Both installers used to just PRINT a hint, and the hint was:
 *
 *     echo 'export PATH="…"' >> ~/.profile
 *
 * which is wrong for a large share of users, because **zsh never reads
 * `~/.profile`** (measured: `zsh -lic` on a home dir containing `.profile` reads
 * `.zshenv` + `.zprofile` + `.zshrc` and the `.profile` echo never fires). A zsh
 * user who followed the hint verbatim got a file that is silently ignored — the
 * command stayed missing with no indication why. That was the reported bug.
 *
 * ── WHICH FILE PER SHELL (all measured, not recalled) ─────────────────────────
 * Startup files actually sourced, by shell and invocation mode:
 *
 *   zsh   -c  → .zshenv
 *         -i  → .zshenv .zshrc
 *         -li → .zshenv .zprofile .zshrc
 *   bash  -c  → (none)
 *         -i  → .bashrc
 *         -li → the FIRST of .bash_profile → .bash_login → .profile
 *   fish      → ~/.config/fish/conf.d/*.fish in all three modes
 *
 * So the target per shell is the file that covers the most modes:
 *   • zsh  → ~/.zshenv                       (the only file read in all 3)
 *   • bash → ~/.bashrc AND its login file    (login vs interactive are disjoint)
 *   • fish → ~/.config/fish/conf.d/botmux.fish
 *
 * bash genuinely needs both: writing only `.bashrc` misses login shells, and
 * writing only the login file misses ordinary interactive ones.
 *
 * ⚠️ bash's login file is "the first that EXISTS", not always `.bash_profile` —
 * see bashLoginFile() below for why creating the wrong one destroys the user's
 * existing login config.
 *
 * ── fish SYNTAX ──────────────────────────────────────────────────────────────
 * fish is not POSIX; `export PATH="$INSTALL_DIR:$PATH"` is not its syntax. (fish
 * 3.6 happens to tolerate `export` as a compatibility shim and even produces a
 * correct PATH — measured — but `set -gx` is the real form and is what we write.)
 */

import { existsSync, readFileSync, appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { basename } from 'node:path';

/** Marker so we can detect our own previous edit and never write twice. */
export const PATH_ENTRY_MARKER = '# added by botmux installer';

/**
 * Which shell is the user actually on? `$SHELL` is the login shell recorded in
 * passwd, which is what future terminals will start — the right question here,
 * and better than `process.ppid` guessing (the parent of a postinstall is npm,
 * not the user's shell).
 */
export function detectShell(env = process.env) {
  const shell = env.SHELL ?? '';
  const name = basename(shell);
  if (name.includes('zsh')) return 'zsh';
  if (name.includes('fish')) return 'fish';
  if (name.includes('bash')) return 'bash';
  // Unknown or unset (containers, cron, exotic shells): POSIX `.profile` is the
  // most portable thing we can offer, and sh/ksh/dash all read it at login.
  return name ? 'other' : 'unknown';
}

/**
 * bash's LOGIN startup file, chosen without shadowing anything.
 *
 * ⚠️ bash reads only the FIRST of `.bash_profile` → `.bash_login` → `.profile`.
 * So creating `.bash_profile` on a machine whose login config lives in
 * `.profile` (or `.bash_login`) silently stops that file from ever being read.
 * Measured — a sentinel exported from `.profile` is visible to `bash -lic`, and
 * becomes MISSING the moment an unrelated `.bash_profile` appears; same for
 * `.bash_login`. That is destroying the user's environment to fix a PATH entry,
 * which is far worse than the bug being fixed.
 *
 * So: append to whichever of the three already exists (that is the file bash is
 * actually reading), and only fall back to CREATING `.bash_profile` when none of
 * them exists — in which case there is nothing to shadow.
 */
function bashLoginFile(home) {
  for (const name of ['.bash_profile', '.bash_login', '.profile']) {
    const file = join(home, name);
    if (existsSync(file)) return file;
  }
  return join(home, '.bash_profile');
}

/**
 * The startup files to write for a shell, plus the line to write into each.
 * Returns [] when we have nothing safe to say.
 */
export function pathEntryTargets(shell, installDir, home = homedir()) {
  const posix = `export PATH="${installDir}:$PATH"  ${PATH_ENTRY_MARKER}`;
  switch (shell) {
    case 'zsh':
      // .zshenv is the only file read by non-interactive, interactive and login
      // zsh alike, so a script/ssh command finds botmux too.
      return [{ file: join(home, '.zshenv'), line: posix }];
    case 'bash': {
      // Disjoint coverage — see header. Both, or one of the two common ways of
      // opening a terminal is left broken. The login half must not shadow (above).
      const login = bashLoginFile(home);
      const targets = [{ file: join(home, '.bashrc'), line: posix }];
      // When bash's login file IS .bashrc-adjacent there is nothing more to add;
      // dedupe so we never append the same line to the same file twice.
      if (login !== join(home, '.bashrc')) targets.push({ file: login, line: posix });
      return targets;
    }
    case 'fish':
      return [{
        file: join(home, '.config', 'fish', 'conf.d', 'botmux.fish'),
        line: `set -gx PATH "${installDir}" $PATH  ${PATH_ENTRY_MARKER}`,
      }];
    case 'other':
    case 'unknown':
    default:
      return [{ file: join(home, '.profile'), line: posix }];
  }
}

/** Is `installDir` already handled by this file (ours or the user's own line)? */
export function fileAlreadyHasEntry(file, installDir) {
  if (!existsSync(file)) return false;
  let text;
  try { text = readFileSync(file, 'utf8'); } catch { return false; }
  // Any line that already puts the directory on PATH counts — the user may have
  // added it by hand in a form we would not generate, and appending a second
  // entry would be noise, not a fix. Match the ASSIGNMENT forms rather than the
  // bare word "path": a temp/checkout directory can easily contain "path" in its
  // name (measured — a `/tmp/bmx-path-XXXX` fixture matched a bare `\bpath\b` and
  // made an unrelated comment line look like a PATH export).
  const PATH_ASSIGNMENT = new RegExp(
    [
      'export\\s+PATH\\s*=',      // POSIX: export PATH="…"
      '^\\s*PATH\\s*=',           // POSIX: PATH=…
      'set\\s+(-\\w+\\s+)*PATH',  // fish:  set -gx PATH …
      'fish_add_path',            // fish:  fish_add_path …
      '\\bpath\\+=',              // zsh:   path+=(…)
      '\\bpath=\\(',              // zsh:   path=(…)
    ].join('|'),
    'i',
  );
  return text.split('\n').some(l => l.includes(installDir) && PATH_ASSIGNMENT.test(l));
}

/**
 * Append the PATH line to every startup file the user's shell reads.
 *
 * Returns `{ written: string[], skipped: string[], failed: [{file, error}] }`.
 * Never throws: a PATH edit failing must not fail the install (the launcher is
 * already in place and the caller prints a manual fallback).
 */
export function ensurePathEntry(opts) {
  const installDir = opts.installDir;
  const home = opts.home ?? homedir();
  const shell = opts.shell ?? detectShell();
  const targets = pathEntryTargets(shell, installDir, home);

  const written = [], skipped = [], failed = [];
  for (const { file, line } of targets) {
    if (fileAlreadyHasEntry(file, installDir)) { skipped.push(file); continue; }
    try {
      mkdirSync(dirname(file), { recursive: true });
      if (existsSync(file)) {
        // Keep the user's file intact; only append, and only with a leading
        // newline so we never glue onto an unterminated last line.
        const prev = readFileSync(file, 'utf8');
        appendFileSync(file, `${prev.endsWith('\n') || prev === '' ? '' : '\n'}${line}\n`);
      } else {
        writeFileSync(file, `${line}\n`);
      }
      written.push(file);
    } catch (err) {
      failed.push({ file, error: err && err.message ? err.message : String(err) });
    }
  }
  return { shell, written, skipped, failed };
}
