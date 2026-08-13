#!/usr/bin/env node
/**
 * DeepSeek Harness (dsh) runner — the `dsh` adapter's backend.
 *
 * Boots ONE long-lived `dsh --profile <name>` process (default profile `acp`:
 * dsh-base + the automation-only `@deepseek-ai/dsh-acp` transport) and speaks
 * the Agent Client Protocol over its stdio: JSON-RPC 2.0, one JSON frame per
 * line (ndjson).
 *
 *     initialize → session/new (cwd = botmux workspace) → per botmux turn:
 *     session/prompt → collect committed `agent_message_chunk` text →
 *     OSC `final` marker (parsed by the worker, see APP_RUNNER_OSC_CLI_IDS).
 *
 * Why ACP instead of `--profile headless` / the TUI / `dsh web`: headless is
 * one-shot (fresh session per run — no multi-turn context), the TUI app plugin
 * is unpublished at v0.1-rc, and the web profile serves a browser UI over an
 * undocumented client API. ACP is dsh's designated programmatic channel and
 * matches botmux's session model one-to-one.
 *
 * The ACP profile is auto-provisioned on first use (`dsh plugin --profile acp
 * add @deepseek-ai/dsh-acp` + a cordis.patch.yml mounting the transport); the
 * DeepSeek API key comes from the harness's own credential store
 * (`~/.dsh/.credentials.yaml`, written by the web Models page) or a
 * DEEPSEEK_API_KEY environment variable.
 *
 * Limitation: the rc-stage ACP server creates fresh sessions only, so a
 * runner restart starts a new conversation (the adapter reports "no resume
 * target" and the worker notifies the topic once).
 */
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { Buffer } from 'node:buffer';
import { RunnerControlWriter } from './adapters/cli/runner-control-channel.js';
// Generic, side-effect-free botmux-envelope flattener (unwraps <user_message>,
// summarizes sender/mentions/attachments into prose). Shared with the mir
// runner — both consume the same envelope through a stdout-delivery bridge.
import { normalizeMircliPrompt } from './mir-prompt.js';

interface Args {
  sessionId: string;
  dshBin?: string;
  model?: string;
  botName?: string;
  rejectPermissions?: boolean;
}

const output = new RunnerControlWriter();
const MARKER_PREFIX = '::botmux-dsh:';
const DEFAULT_TURN_TIMEOUT_MS = 12 * 60 * 1000;
const ACP_PLUGIN_PACKAGE = '@deepseek-ai/dsh-acp';
const DEFAULT_PROVIDER = 'deepseek-official';
const DEFAULT_MODEL = 'deepseek-v4-flash';

function parseArgs(argv: string[]): Args {
  const out: Args = { sessionId: '' };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    const val = argv[i + 1];
    if (key === '--session-id' && val !== undefined) { out.sessionId = val; i++; }
    else if (key === '--dsh-bin' && val !== undefined) { out.dshBin = val; i++; }
    else if (key === '--model' && val !== undefined) { out.model = val; i++; }
    else if (key === '--bot-name' && val !== undefined) { out.botName = val; i++; }
    else if (key === '--reject-permissions') { out.rejectPermissions = true; }
  }
  if (!out.sessionId) throw new Error('--session-id is required');
  return out;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function writeLine(text = ''): void {
  output.line(text);
}

function prompt(): void {
  output.display('› ');
}

/** Ensure the version-manager shim dirs dsh installs under are on PATH. */
function localPathEnv(): string {
  const existing = process.env.PATH || '';
  const parts = existing.split(':');
  const extra = [
    join(homedir(), '.local', 'share', 'mise', 'shims'),
    join(homedir(), '.local', 'bin'),
  ].filter(dir => !parts.includes(dir));
  return extra.length > 0 ? `${extra.join(':')}:${existing}` : existing;
}

function dshHome(): string {
  return process.env.DSH_HOME || join(homedir(), '.dsh');
}

function profileName(): string {
  return process.env.DSH_ACP_PROFILE || 'acp';
}

/** The patch layer that mounts the ACP transport over dsh-base. */
function acpMountPatch(): string {
  return [
    '# botmux: mount the automation-only ACP transport over dsh-base.',
    '# stdout is reserved for JSON-RPC frames; keep stdout-writing plugins out.',
    '- id: hmr',
    '  disabled: true',
    '',
    '- insert:',
    `    - id: acp`,
    `      name: '${ACP_PLUGIN_PACKAGE}'`,
    '      config:',
    `        provider: ${process.env.DSH_ACP_PROVIDER || DEFAULT_PROVIDER}`,
    `        model: ${DEFAULT_MODEL}`,
    '',
  ].join('\n');
}

/**
 * Provision the ACP profile on first use. `dsh plugin --profile <p> add`
 * scaffolds the profile (dsh-base bundle) and pnpm-installs the transport;
 * the patch layer then mounts it. Existing profiles are trusted as-is —
 * except a missing ACP mount in the patch file, which is appended (top-level
 * YAML array entries compose).
 */
function ensureAcpProfile(dshBin: string): void {
  const profileDir = join(dshHome(), 'profiles', profileName());
  const patchPath = join(profileDir, 'cordis.patch.yml');
  if (!existsSync(join(profileDir, 'package.json'))) {
    output.error(`[dsh] provisioning ACP profile "${profileName()}" (first use)...\n`);
    const result = spawnSync(dshBin, ['plugin', '--profile', profileName(), 'add', ACP_PLUGIN_PACKAGE], {
      encoding: 'utf-8',
      timeout: 180_000,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PATH: localPathEnv() },
    });
    if (result.status !== 0) {
      const detail = `${result.stderr ?? ''}${result.stdout ?? ''}`.trim().slice(0, 800);
      throw new Error(
        `failed to provision the dsh ACP profile (dsh plugin --profile ${profileName()} add ${ACP_PLUGIN_PACKAGE}): `
        + `${detail || `exit ${result.status}`}. Run that command manually, then retry.`,
      );
    }
  }
  const existingPatch = existsSync(patchPath) ? readFileSync(patchPath, 'utf-8') : '';
  if (existingPatch.includes(ACP_PLUGIN_PACKAGE)) return;
  // Scaffolded patch files carry only comments and `[]`; replace those, but
  // append to a user-authored layer so their entries survive.
  const scaffoldOnly = existingPatch.split('\n').every(line => {
    const t = line.trim();
    return t === '' || t.startsWith('#') || t === '[]';
  });
  if (scaffoldOnly) {
    writeFileSync(patchPath, acpMountPatch());
  } else {
    appendFileSync(patchPath, `\n${acpMountPatch()}`);
  }
}

interface PendingRequest {
  resolve: (result: any) => void;
  reject: (err: Error) => void;
}

class DshAcpClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private nextId = 0;
  private readonly pending = new Map<number, PendingRequest>();
  private chunks: string[] = [];
  private acpSessionId = '';
  private exited = false;

  constructor(private readonly args: Args) {}

  private dshBin(): string {
    return this.args.dshBin || process.env.DSH_BIN || 'dsh';
  }

  /** Boot args: the profile, plus a --patch overlay when a per-bot model
   *  override must replace the profile's acp config (patch layers replace the
   *  whole config object, so the overlay always carries provider AND model). */
  private bootArgs(): string[] {
    const args = ['--profile', profileName()];
    if (this.args.model) {
      const overlay = join(mkdtempSync(join(tmpdir(), 'botmux-dsh-')), 'model-patch.yml');
      writeFileSync(overlay, [
        '- id: acp',
        '  config:',
        `    provider: ${process.env.DSH_ACP_PROVIDER || DEFAULT_PROVIDER}`,
        `    model: ${this.args.model}`,
        '',
      ].join('\n'));
      args.push('--patch', overlay);
    }
    return args;
  }

  async start(): Promise<string> {
    ensureAcpProfile(this.dshBin());
    const child = spawn(this.dshBin(), this.bootArgs(), {
      cwd: process.cwd(),
      env: { ...process.env, PATH: localPathEnv() },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;
    child.stderr.on('data', (chunk: Buffer) => {
      output.error(chunk.toString('utf8'));
    });
    const rl = createInterface({ input: child.stdout });
    rl.on('line', line => { this.handleFrame(line); });
    child.on('error', err => {
      this.failAll(new Error(`failed to start dsh (${this.dshBin()}): ${errorMessage(err)}`));
    });
    child.on('close', (code, signal) => {
      this.exited = true;
      this.failAll(new Error(`dsh exited (${code ?? `signal ${signal ?? 'unknown'}`})`));
      // Let an in-flight turn settle its error `final` first, then exit so the
      // worker's crash handling respawns a fresh runner instead of keeping a
      // zombie bridge whose every turn would fail.
      const timer = setTimeout(() => process.exit(code === 0 ? 0 : 1), 250);
      timer.unref();
    });

    await this.request('initialize', { protocolVersion: 1, clientCapabilities: {} });
    const session = await this.request('session/new', { cwd: process.cwd(), mcpServers: [] });
    if (typeof session?.sessionId !== 'string' || session.sessionId === '') {
      throw new Error('dsh ACP session/new returned no sessionId');
    }
    this.acpSessionId = session.sessionId;
    return this.acpSessionId;
  }

  async complete(content: string): Promise<{ finalText: string; turnId: string }> {
    if (this.exited || !this.child) throw new Error('dsh process is not running');
    this.chunks = [];
    const timeoutMs = Number(process.env.DSH_RUNNER_TIMEOUT_MS || DEFAULT_TURN_TIMEOUT_MS);
    let timer: NodeJS.Timeout | undefined;
    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      timer = setTimeout(() => {
        // Cancellation settles the pending prompt with stopReason `cancelled`;
        // the collected chunks (if any) still ship back below.
        this.notify('session/cancel', { sessionId: this.acpSessionId });
      }, timeoutMs);
      timer.unref();
    }
    try {
      const result = await this.request('session/prompt', {
        sessionId: this.acpSessionId,
        prompt: [{ type: 'text', text: content }],
      });
      let finalText = this.chunks.filter(Boolean).join('\n\n').trim();
      if (result?.stopReason && result.stopReason !== 'end_turn') {
        finalText = finalText === ''
          ? `[dsh] turn ended without text output (stopReason: ${result.stopReason})`
          : `${finalText}\n\n[dsh] stopReason: ${result.stopReason}`;
      }
      return { finalText, turnId: `${this.acpSessionId}:${Date.now()}` };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  shutdown(): void {
    this.child?.kill('SIGTERM');
  }

  private request(method: string, params: unknown): Promise<any> {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      if (this.exited || !this.child) {
        reject(new Error('dsh process is not running'));
        return;
      }
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  private notify(method: string, params: unknown): void {
    if (this.exited || !this.child) return;
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  }

  private respond(id: unknown, result: unknown): void {
    if (this.exited || !this.child) return;
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
  }

  private failAll(err: Error): void {
    for (const [, request] of this.pending) request.reject(err);
    this.pending.clear();
  }

  private handleFrame(line: string): void {
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      return; // not a protocol frame; ignore
    }
    if (msg.id !== undefined && this.pending.has(msg.id)) {
      const request = this.pending.get(msg.id)!;
      this.pending.delete(msg.id);
      if (msg.error) {
        let detail = typeof msg.error.message === 'string' ? msg.error.message : JSON.stringify(msg.error);
        if (detail.includes('MISSING_CREDENTIAL')) {
          detail += ' — store the DeepSeek API key through the dsh credentials service'
            + ' (~/.dsh/.credentials.yaml, written by the web Models page) or export DEEPSEEK_API_KEY.';
        }
        request.reject(new Error(detail));
      } else {
        request.resolve(msg.result);
      }
      return;
    }
    if (msg.method === 'session/update') {
      const update = msg.params?.update;
      if (update?.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text'
        && typeof update.content.text === 'string') {
        this.chunks.push(update.content.text);
      }
      return;
    }
    if (msg.method === 'session/request_permission' && msg.id !== undefined) {
      const options: Array<{ optionId: string; kind?: string }> = msg.params?.options ?? [];
      const wanted = this.args.rejectPermissions ? 'reject_once' : 'allow_once';
      const choice = options.find(option => option.kind === wanted) ?? options[0];
      if (!choice) {
        this.respond(msg.id, { outcome: { outcome: 'cancelled' } });
        return;
      }
      if (this.args.rejectPermissions) {
        output.error('[dsh] permission request rejected (disableCliBypass is set for this bot)\n');
      }
      this.respond(msg.id, { outcome: { outcome: 'selected', optionId: choice.optionId } });
    }
  }
}

let args: Args;
try {
  args = parseArgs(process.argv.slice(2));
} catch (err) {
  output.error(`dsh runner: ${errorMessage(err)}\n`);
  process.exit(2);
}

const client = new DshAcpClient(args);
const queue: string[] = [];
let inputBuffer = '';
let processing = false;
let firstTurn = true;

/** Minimal session context for the first prompt. The ACP transport has no
 *  per-session system-prompt surface, and the standard <botmux_routing>
 *  envelope is suppressed (delivery is this runner's stdout, not `botmux
 *  send`), so the model learns its situation here. */
function firstTurnContext(): string {
  return [
    args.botName ? `You are the agent behind the bot "${args.botName}", bridged into a Lark (Feishu) topic by botmux.` : 'You are bridged into a Lark (Feishu) topic by botmux.',
    'Your final reply text is delivered to the user automatically — do NOT try to send messages through other channels.',
    'Attachments arrive as local file paths; read them with your file tools.',
    '',
  ].join('\n');
}

async function runTurn(content: string): Promise<void> {
  const startedAtMs = Date.now();
  writeLine();
  writeLine('[user]');
  writeLine(content);
  writeLine();
  writeLine('[dsh] thinking...');

  // Flatten botmux's XML envelope (sender/mentions/attachments → prose) —
  // the ACP prompt is one plain user message.
  let promptText = normalizeMircliPrompt(content);
  if (firstTurn) {
    promptText = `${firstTurnContext()}\n${promptText}`;
    firstTurn = false;
  }
  const result = await client.complete(promptText);
  const completedAtMs = Date.now();
  if (result.finalText) {
    writeLine();
    writeLine(result.finalText);
    output.marker('final', {
      nativeTurnId: result.turnId,
      content: result.finalText,
      startedAtMs,
      completedAtMs,
    });
  } else {
    writeLine('[dsh] completed without text output.');
  }
}

async function drainQueue(): Promise<void> {
  if (processing) return;
  processing = true;
  try {
    while (queue.length > 0) {
      const next = queue.shift()!;
      try {
        await runTurn(next);
      } catch (err) {
        const now = Date.now();
        const message = `dsh runner error: ${errorMessage(err)}`;
        writeLine(message);
        output.marker('final', {
          content: message,
          startedAtMs: now,
          completedAtMs: now,
        });
      }
      prompt();
    }
  } finally {
    processing = false;
  }
}

function enqueueLine(line: string): void {
  const trimmed = line.trim();
  if (!trimmed) return;
  if (trimmed.startsWith(MARKER_PREFIX)) {
    const encoded = trimmed.slice(MARKER_PREFIX.length);
    try {
      const decoded = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
      if (decoded?.type === 'message' && typeof decoded.content === 'string') {
        queue.push(decoded.content);
        void drainQueue();
      }
    } catch (err) {
      writeLine(`[dsh] bad botmux input: ${errorMessage(err)}`);
    }
    return;
  }
  queue.push(line);
  void drainQueue();
}

function handleInput(data: Buffer): void {
  const text = data.toString('utf8');
  for (const ch of text) {
    const code = ch.charCodeAt(0);
    if (code === 3) {           // Ctrl-C
      client.shutdown();
      process.exit(130);
    } else if (ch === '\r' || ch === '\n') {
      const line = inputBuffer;
      inputBuffer = '';
      enqueueLine(line);
    } else if (code === 127 || code === 8) {  // DEL / Backspace
      inputBuffer = inputBuffer.slice(0, -1);
    } else {
      inputBuffer += ch;
    }
  }
}

async function main(): Promise<void> {
  const acpSessionId = await client.start();
  output.marker('thread', { threadId: acpSessionId });
  writeLine('DeepSeek Harness ACP runner ready.');
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on('data', handleInput);
  prompt();
}

process.on('SIGTERM', () => {
  client.shutdown();
  process.exit(0);
});

main().catch(err => {
  output.error(`dsh runner failed: ${errorMessage(err)}\n`);
  process.exit(1);
});
