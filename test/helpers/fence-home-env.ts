import { join } from 'node:path';

/**
 * Neutralise the env vars that point DIRECTLY at a live Botmux/CLI home, so a
 * test run cannot reach the caller's real data through them.
 *
 * WHY THIS IS SEPARATE FROM THE `homedir()` OVERRIDE: these are explicit escape
 * hatches, not home-derivation APIs. `src/bot-registry.ts` treats `BOTS_CONFIG`
 * as the TOP of its resolution chain — an exact file path that deliberately wins
 * over anything derived from `homedir()` — and `src/cli/pm2-existing-client.ts`
 * reads `PM2_HOME` the same way. Mocking `node:os` does nothing for either. In a
 * normal Botmux shell these are already set to the live fleet (measured in a real
 * session: `BOTS_CONFIG=/root/.botmux/bots.json`, `PM2_HOME=/root/.botmux/pm2`),
 * so without this the fence's safety would depend on the runner's environment
 * happening to be clean.
 *
 * DELETE rather than redirect, deliberately. Redirecting `BOTS_CONFIG` into the
 * fenced home looks tidier but changes behaviour for every test that never set it:
 * `resolveBotConfigPath()` THROWS when the var is set and the file is missing
 * ("refusing to fall back to a different registry") instead of falling through to
 * `<home>/.botmux/bots.json`. Deleting lets the normal resolution chain run, and
 * that chain is already fenced because it derives from the mocked `homedir()`. A
 * test that wants an exact path sets the var itself.
 *
 * Shared by both runners' setup files (`test/unit-setup.ts` for vitest,
 * `test/bun-test-fence.ts` for `bun test`) so the two fences cannot drift apart —
 * the `userInfo` gap existed precisely because one side was patched and the other
 * was not.
 */
export function fenceHomeRootedEnv(fencedHome: string): void {
  // Exact-path pointers into a Botmux home. Nothing here has a safe fenced
  // default worth inventing, so drop them and let home-derived resolution win.
  delete process.env.BOTS_CONFIG;
  delete process.env.PM2_HOME;
  delete process.env.PLUGIN_PM2_HOME;

  // Per-CLI config homes that production reads directly (verified present in
  // `src/`: codex, claude, grok, traex, hermes, relay, lark-cli). Each bypasses
  // `homedir()`, so an inherited value would escape the fence. Only rewritten when
  // the caller had one set — an unset value means the adapter derives its own
  // default from the mocked `homedir()`, and inventing a path here could change
  // what a test is asserting.
  const cliHomes: Array<[string, string]> = [
    ['CODEX_HOME', '.codex'],
    ['CLAUDE_CONFIG_DIR', '.claude'],
    ['GROK_HOME', '.grok'],
    ['TRAE_HOME', '.trae'],
    ['HERMES_HOME', '.hermes'],
    ['HERMES_BOTMUX_SOURCE_HOME', '.hermes-source'],
    ['RELAY_CONFIG_DIR', '.relay'],
    ['LARKSUITE_CLI_DATA_DIR', join('.local', 'share', 'lark-cli')],
  ];
  for (const [name, relative] of cliHomes) {
    if (process.env[name]) process.env[name] = join(fencedHome, relative);
  }

  // XDG + Windows profile dirs — defensive. Nothing in `src/` currently resolves a
  // Botmux root from them, but they are the conventional way a spawned CLI gets
  // pointed at a config tree, and a stray inherited value would escape the fence.
  const xdg: Array<[string, string]> = [
    ['XDG_CONFIG_HOME', '.config'],
    ['XDG_DATA_HOME', join('.local', 'share')],
    ['XDG_STATE_HOME', join('.local', 'state')],
    ['XDG_CACHE_HOME', '.cache'],
    ['APPDATA', join('AppData', 'Roaming')],
    ['LOCALAPPDATA', join('AppData', 'Local')],
  ];
  for (const [name, relative] of xdg) {
    if (process.env[name]) process.env[name] = join(fencedHome, relative);
  }
}
