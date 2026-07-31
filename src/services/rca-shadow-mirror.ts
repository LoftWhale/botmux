import { createHmac } from 'node:crypto';
import type { CliTurnPayload } from '../types.js';
import { logger } from '../utils/logger.js';
import { notifyRcaCandidateAccepted } from './rca-shadow-notifier.js';

export interface RcaShadowMirrorConfig {
  url: string;
  token: string;
  botAppIds: string[];
  timeoutMs: number;
  maxInFlight: number;
  maxQueued: number;
}

export interface RcaShadowTurn {
  larkAppId: string;
  sessionId: string;
  turnId: string;
  topicId: string;
  title?: string;
  preparedInput: string | CliTurnPayload;
}

type FetchLike = typeof fetch;
type LogLike = Pick<typeof logger, 'info' | 'warn'>;

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function nonNegativeInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

export function rcaShadowMirrorConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): RcaShadowMirrorConfig {
  return {
    url: env.BOTMUX_RCA_MIRROR_URL?.trim() || '',
    token: env.BOTMUX_RCA_MIRROR_TOKEN?.trim() || '',
    botAppIds: (env.BOTMUX_RCA_MIRROR_BOT_APP_IDS || '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean),
    timeoutMs: positiveInteger(env.BOTMUX_RCA_MIRROR_TIMEOUT_MS, 500),
    maxInFlight: positiveInteger(env.BOTMUX_RCA_MIRROR_MAX_IN_FLIGHT, 2),
    maxQueued: nonNegativeInteger(env.BOTMUX_RCA_MIRROR_MAX_QUEUED, 16),
  };
}

function opaqueKey(token: string, namespace: string, value: string): string {
  return createHmac('sha256', token)
    .update(`${namespace}\0${value}`)
    .digest('hex');
}

function signalSource(content: string): string {
  const lower = content.toLowerCase();
  if (lower.includes('slardar')) return 'slardar';
  if (lower.includes('kepler')) return 'kepler';
  if (lower.includes('argos')) return 'argos';
  return 'botmux';
}

function normalizedInput(input: string | CliTurnPayload): CliTurnPayload {
  return typeof input === 'string' ? { content: input } : input;
}

export class RcaShadowMirror {
  private readonly config: RcaShadowMirrorConfig;
  private readonly fetchImpl: FetchLike;
  private readonly log: LogLike;
  private readonly queue: RcaShadowTurn[] = [];
  private readonly idleWaiters: Array<() => void> = [];
  private inFlight = 0;

  constructor(
    config: RcaShadowMirrorConfig,
    {
      fetchImpl = fetch,
      log = logger,
    }: { fetchImpl?: FetchLike; log?: LogLike } = {},
  ) {
    this.config = config;
    this.fetchImpl = fetchImpl;
    this.log = log;
  }

  submit(turn: RcaShadowTurn): 'disabled' | 'filtered' | 'queued' | 'dropped' {
    if (!this.config.url || !this.config.token || this.config.botAppIds.length === 0) {
      return 'disabled';
    }
    if (!this.config.botAppIds.includes(turn.larkAppId)) return 'filtered';
    if (this.inFlight >= this.config.maxInFlight
      && this.queue.length >= this.config.maxQueued) {
      this.log.warn('[rca-shadow] mirror queue saturated; dropping challenger turn');
      return 'dropped';
    }
    this.queue.push(turn);
    this.drain();
    return 'queued';
  }

  async onIdle(): Promise<void> {
    if (this.inFlight === 0 && this.queue.length === 0) return;
    await new Promise<void>((resolve) => this.idleWaiters.push(resolve));
  }

  private drain(): void {
    while (this.inFlight < this.config.maxInFlight && this.queue.length > 0) {
      const turn = this.queue.shift()!;
      this.inFlight += 1;
      void this.deliver(turn)
        .catch((error) => {
          this.log.warn(
            `[rca-shadow] mirror failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        })
        .finally(() => {
          this.inFlight -= 1;
          this.drain();
          if (this.inFlight === 0 && this.queue.length === 0) {
            for (const resolve of this.idleWaiters.splice(0)) resolve();
          }
        });
    }
  }

  private async deliver(turn: RcaShadowTurn): Promise<void> {
    const preparedInput = normalizedInput(turn.preparedInput);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);
    timeout.unref();
    try {
      const response = await this.fetchImpl(
        `${this.config.url.replace(/\/+$/, '')}/api/mirrors/turns`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${this.config.token}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            correlationKey: opaqueKey(this.config.token, 'session', turn.sessionId),
            turnKey: opaqueKey(this.config.token, 'turn', turn.turnId),
            preparedInput,
            signalSource: signalSource(preparedInput.content),
            title: turn.title?.trim() || 'Botmux RCA mirror',
            symptom: preparedInput.content.slice(0, 2_000),
            championReference: {
              delivery: 'original_alarm_group',
              topicKey: opaqueKey(this.config.token, 'topic', turn.topicId),
            },
          }),
          signal: controller.signal,
        },
      );
      if (!response.ok) {
        throw new Error(`RCA Server returned HTTP ${response.status}`);
      }
      const result = await response.json().catch(() => null) as {
        eventId?: unknown;
        viewKey?: unknown;
      } | null;
      if (typeof result?.eventId === 'string' && result.eventId) {
        notifyRcaCandidateAccepted(
          result.eventId,
          turn.larkAppId,
          typeof result.viewKey === 'string' ? result.viewKey : '',
        );
      }
    } finally {
      clearTimeout(timeout);
    }
  }
}

let defaultMirror: RcaShadowMirror | null = null;

/** Fire-and-forget boundary used only after the primary Coco IPC dispatch.
 * Configuration, hashing, queueing, fetch and logging are all contained here;
 * no failure is allowed to escape into the current RCA path. */
export function mirrorPreparedTurn(turn: RcaShadowTurn): void {
  try {
    defaultMirror ??= new RcaShadowMirror(rcaShadowMirrorConfigFromEnv());
    defaultMirror.submit(turn);
  } catch (error) {
    logger.warn(
      `[rca-shadow] mirror submission ignored: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
