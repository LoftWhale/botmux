import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { CliAdapter, PtyHandle } from './types.js';
import { writeRunnerInput } from './runner-input.js';
import { resolveCommand } from './registry.js';

/**
 * DeepSeek Harness (dsh) adapter — drives the harness through its
 * automation-only ACP transport (`@deepseek-ai/dsh-acp`, Agent Client Protocol
 * over JSON-RPC stdio) via a small Node runner (src/dsh-runner.ts), mirroring
 * the `mir` adapter's runner shape.
 *
 * Why ACP instead of the other dsh entry points:
 *   - `--profile headless` is one-shot: every run creates a fresh session, so
 *     multi-turn chat would lose all context;
 *   - the TUI profile has no published app plugin yet (v0.1-rc);
 *   - `dsh web` serves the browser UI over an undocumented client API;
 *   - ACP is the officially designated programmatic channel: one long-lived
 *     process per botmux session, `session/new` once, `session/prompt` per
 *     turn, committed assistant text back — exactly botmux's session model.
 *
 * The runner boots `dsh --profile <name>` (default `acp`; the profile stacks
 * dsh-base + the dsh-acp transport and is auto-provisioned on first use) and
 * ships each turn's final text back over stdout OSC `final` markers (`dsh` is
 * in APP_RUNNER_OSC_CLI_IDS), so delivery needs neither `botmux send` nor a
 * BOTMUX_SESSION_ID.
 *
 * Limitation: the rc-stage ACP server creates fresh sessions only (resume
 * belongs to other dsh entry points). checkResumeTargetExists therefore
 * reports "no resume target" so a daemon restart falls back to a FRESH
 * session with the worker's one-time user notice instead of silently losing
 * context mid-conversation.
 */

function runnerPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const compiledSibling = resolve(here, '..', '..', 'dsh-runner.js');
  if (existsSync(compiledSibling)) return compiledSibling;
  const builtFromSourceTree = resolve(here, '..', '..', '..', 'dist', 'dsh-runner.js');
  if (existsSync(builtFromSourceTree)) return builtFromSourceTree;
  return compiledSibling;
}

function pushOpt(args: string[], key: string, value: string | undefined): void {
  if (value === undefined || value.length === 0) return;
  args.push(key, value);
}

export function createDshAdapter(pathOverride?: string): CliAdapter {
  // A configured cliPathOverride is the dsh binary the runner should spawn
  // (resolvedBin is the node runner itself). Resolve a bare name to an
  // absolute path and hand it to the runner via --dsh-bin; the runner falls
  // back to DSH_BIN / `dsh` on PATH when unset.
  let cachedDshBin: string | undefined;
  const dshBin = (): string | undefined => {
    if (!pathOverride || !pathOverride.trim()) return undefined;
    return (cachedDshBin ??= resolveCommand(pathOverride.trim()));
  };
  return {
    id: 'dsh',
    resolvedBin: process.execPath,

    buildArgs({ sessionId, model, botName, disableCliBypass }) {
      const args = [runnerPath(), '--session-id', sessionId];
      pushOpt(args, '--dsh-bin', dshBin());
      pushOpt(args, '--model', model);
      pushOpt(args, '--bot-name', botName);
      // The ACP bridge surfaces one-shot permission requests; the runner
      // auto-allows them by default (matching the other adapters' bypass
      // norm). A bot with disableCliBypass set must not silently approve, so
      // the runner fails those requests closed instead.
      if (disableCliBypass) args.push('--reject-permissions');
      return args;
    },

    // The conversation lives in the harness's own session store
    // (~/.dsh/sessions), but the rc-stage dsh CLI has no per-session resume
    // entry point, so there is no copy-paste command for the user's terminal.
    buildResumeCommand() {
      return null;
    },

    // ACP sessions cannot be resumed (fresh `session/new` only), so every
    // resume attempt provably has no target: the worker spawns FRESH and
    // notifies the topic once instead of silently dropping context.
    checkResumeTargetExists() {
      return false;
    },

    async writeInput(pty: PtyHandle, content: string) {
      // Chunked + throttled stdin injection (see runner-input.ts) — same path
      // the mira / mir / codex-app runners use.
      return writeRunnerInput(pty, '::botmux-dsh:', content);
    },

    completionPattern: undefined,
    // The runner prints `› ` as its ready prompt between turns.
    readyPattern: /›/,
    systemHints: [],
    // Delivery is the runner's stdout (`final` markers), like mir/mira — so
    // the standard <botmux_routing> block, which would instruct the model to
    // deliver via `botmux send`, must NOT be injected (it would double-deliver
    // every reply). The runner flattens the remaining envelope and prepends
    // its own minimal first-turn context instead.
    injectsSessionContext: true,
    altScreen: false,

    modelChoices: ['deepseek-v4-flash', 'deepseek-v4-pro'],

    // The whole harness home must stay REAL + writable inside the file
    // sandbox: it holds the credential store (.credentials.yaml), the
    // auto-provisioned ACP profile (profiles/acp — package.json + pnpm
    // node_modules + cordis.patch.yml), and the JSONL session store. A narrow
    // carve-out would leave the credential file and profile tree in the
    // short-lived tmpfs, breaking auth on every spawn (see CLAUDE.md sandbox
    // checklist items 1 and 3).
    authPaths: ['~/.dsh'],

    // resolvedBin is the node runner; the real dsh launcher is spawned as a
    // second stage inside the sandbox and must survive the fresh `/run` tmpfs
    // (version-manager shim farms live there on some hosts).
    sandboxExtraExecPaths() {
      const bin = dshBin() ?? resolveCommand('dsh');
      return bin && bin !== 'dsh' ? [bin] : [];
    },
  };
}

export const create = createDshAdapter;
