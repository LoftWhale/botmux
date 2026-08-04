import { createHmac } from 'node:crypto';
import type { CliTurnPayload } from '../types.js';
import type { getBotOpenId } from '../bot-registry.js';
import type { getMessageDetail, listChatMessages } from '../im/lark/client.js';
import {
  cardContentHasUpgradeFallback,
  parseApiMessage,
  resolveMergedCardContent,
} from '../im/lark/message-parser.js';
import { logger } from '../utils/logger.js';
import {
  notifyRcaCandidateAccepted,
  rcaShadowTokenFromEnv,
} from './rca-shadow-notifier.js';

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
  turnKind: 'first_turn' | 'follow_up';
  /** Source-only lookup key. Never serialized into the RCA Server request. */
  chatId: string;
  topicId: string;
  title?: string;
  preparedInput: string | CliTurnPayload;
  sourceSnapshot?: RcaSourceSnapshot;
}

export interface RcaSourceSnapshotMessage {
  referenceKey: string;
  relation: 'current' | 'quoted' | 'recent';
  senderRole: 'human' | 'external_bot' | 'self_bot' | 'unknown';
  senderName?: string;
  messageType: string;
  content: string;
  at?: string;
}

export interface RcaSourceSnapshot {
  schemaVersion: '1';
  capturedAt: string;
  captureStatus: 'complete' | 'partial' | 'failed';
  warnings: string[];
  timeline: RcaSourceSnapshotMessage[];
}

export interface SnapshotCaptureDeps {
  getMessageDetail: typeof getMessageDetail;
  listChatMessages: typeof listChatMessages;
  resolveMergedCardContent: typeof resolveMergedCardContent;
  getBotOpenId: typeof getBotOpenId;
  now: () => Date;
}

async function loadDefaultCaptureDeps(): Promise<SnapshotCaptureDeps> {
  const [larkClient, botRegistry] = await Promise.all([
    import('../im/lark/client.js'),
    import('../bot-registry.js'),
  ]);
  return {
    getMessageDetail: larkClient.getMessageDetail,
    listChatMessages: larkClient.listChatMessages,
    resolveMergedCardContent,
    getBotOpenId: botRegistry.getBotOpenId,
    now: () => new Date(),
  };
}

const SOURCE_SNAPSHOT_MAX_MESSAGES = 8;
const SOURCE_SNAPSHOT_MAX_CHARS = 12_000;
const SOURCE_SNAPSHOT_RECENT_MESSAGES = 8;
export const SOURCE_SNAPSHOT_CAPTURE_TIMEOUT_MS = 5_000;

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
    token: rcaShadowTokenFromEnv(env),
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

const RAW_LARK_IDENTIFIER = /\b(?:oc|om|ou|on)_[A-Za-z0-9_-]{16,}\b/g;

function sanitizeTransportText(value: string): string {
  return value
    .replace(
      /<attachments\b[^>]*>[\s\S]*?<\/attachments>/gi,
      '[attachments omitted: source-local paths unavailable]',
    )
    .replace(/<session_id>[\s\S]*?<\/session_id>/gi, '')
    .replace(/<botmux_routing>[\s\S]*?<\/botmux_routing>/gi, '')
    .replace(/<botmux_reminder>[\s\S]*?<\/botmux_reminder>/gi, '')
    .replace(/<botmux_builtin_skills>[\s\S]*?<\/botmux_builtin_skills>/gi, '')
    .replace(
      /\bbotmux\s+(?:history|quoted|send|bots)\b(?:\s+(?:(?:oc|om|ou|on)_[A-Za-z0-9_-]+|list|--?[A-Za-z][A-Za-z0-9_-]*(?:=[^\s,，。；;]+)?|\d+)){0,3}/gi,
      '[transport-command-removed]',
    )
    .replace(RAW_LARK_IDENTIFIER, '[redacted-reference]')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function sanitizedInput(input: string | CliTurnPayload): CliTurnPayload {
  const content = sanitizeTransportText(normalizedInput(input).content);
  return { content: content || '[transport metadata removed]' };
}

function stableKeplerIdentifiers(
  content: string,
  name: 'submonitorId' | 'eventId',
): Set<string> {
  const values = new Set<string>();
  const pattern = new RegExp(
    `["']?${name}["']?\\s*(?:=|:)\\s*["']?([A-Za-z0-9._:-]{1,256})`,
    'gi',
  );
  for (const match of content.matchAll(pattern)) {
    if (match[1]) values.add(match[1]);
  }
  return values;
}

function keplerIncidentKey(token: string, candidates: string[]): string | null {
  if (!candidates.some(content => content.toLowerCase().includes('kepler'))) return null;
  const completePairs = new Set<string>();
  for (const content of candidates) {
    const submonitorIds = stableKeplerIdentifiers(content, 'submonitorId');
    const eventIds = stableKeplerIdentifiers(content, 'eventId');
    if (submonitorIds.size > 1 || eventIds.size > 1) return null;
    if (submonitorIds.size === 1 && eventIds.size === 1) {
      completePairs.add(`${[...submonitorIds][0]}\0${[...eventIds][0]}`);
    }
  }
  if (completePairs.size !== 1) return null;
  return opaqueKey(token, 'kepler-incident', [...completePairs][0]!);
}

function sanitizedSourceSnapshot(snapshot: RcaSourceSnapshot): RcaSourceSnapshot {
  return {
    schemaVersion: sanitizeTransportText(snapshot.schemaVersion) as RcaSourceSnapshot['schemaVersion'],
    capturedAt: sanitizeTransportText(snapshot.capturedAt),
    captureStatus: sanitizeTransportText(snapshot.captureStatus) as RcaSourceSnapshot['captureStatus'],
    warnings: snapshot.warnings.map(sanitizeTransportText),
    timeline: snapshot.timeline.map(item => ({
      referenceKey: sanitizeTransportText(item.referenceKey),
      relation: sanitizeTransportText(item.relation) as RcaSourceSnapshotMessage['relation'],
      senderRole: sanitizeTransportText(item.senderRole) as RcaSourceSnapshotMessage['senderRole'],
      ...(item.senderName ? { senderName: sanitizeTransportText(item.senderName) } : {}),
      messageType: sanitizeTransportText(item.messageType),
      content: sanitizeTransportText(item.content),
      ...(item.at ? { at: sanitizeTransportText(item.at) } : {}),
    })),
  };
}

function incidentCandidates(
  preparedInput: CliTurnPayload,
  sourceSnapshot: RcaSourceSnapshot,
): string[] {
  const byRelation = (relation: RcaSourceSnapshotMessage['relation']) => sourceSnapshot.timeline
    .filter(item => item.relation === relation)
    .map(item => item.content);
  return [
    ...byRelation('current'),
    preparedInput.content,
    ...byRelation('quoted'),
    ...byRelation('recent'),
  ];
}

function failedSourceSnapshot(
  warning = 'source_snapshot_capture_failed',
  now: Date = new Date(),
): RcaSourceSnapshot {
  return {
    schemaVersion: '1',
    capturedAt: now.toISOString(),
    captureStatus: 'failed',
    warnings: [warning],
    timeline: [],
  };
}

function rawMessageItem(detail: any): any | null {
  return detail?.items?.[0] ?? detail?.message ?? null;
}

function rawSenderId(message: any): string {
  return typeof message?.sender?.id === 'string' ? message.sender.id : '';
}

function senderRole(message: any, selfBotOpenId: string | undefined): RcaSourceSnapshotMessage['senderRole'] {
  const senderId = rawSenderId(message);
  if (selfBotOpenId && senderId === selfBotOpenId) return 'self_bot';
  const senderType = message?.sender?.sender_type;
  if (senderType === 'user') return 'human';
  if (senderType === 'app' || senderType === 'bot') return 'external_bot';
  return 'unknown';
}

function redactLarkIdentifiers(content: string): string {
  return content.replace(RAW_LARK_IDENTIFIER, '[redacted-reference]');
}

async function snapshotContent(
  turn: RcaShadowTurn,
  message: any,
  deps: SnapshotCaptureDeps,
  allowRemoteResolution: boolean,
): Promise<string> {
  const parsed = parseApiMessage(message).content;
  const hasCompleteLocalBody = message?.msg_type !== 'interactive'
    || Boolean(
      parsed
      && parsed !== '[卡片]'
      && parsed !== '[卡片 (模板)]'
      && parsed.includes('\n')
      && !cardContentHasUpgradeFallback(parsed),
    );
  if (hasCompleteLocalBody || !allowRemoteResolution) return parsed;
  if (message?.msg_type === 'interactive' && typeof message?.message_id === 'string') {
    const merged = await deps.resolveMergedCardContent(turn.larkAppId, message.message_id).catch(() => null);
    if (merged?.text) return merged.text;
  }
  return parsed;
}

/** Capture bounded Lark context on the source daemon. Raw Lark identifiers are
 * used only for lookup and are replaced with HMAC reference keys before return. */
export async function captureRcaSourceSnapshot(
  turn: RcaShadowTurn,
  token: string,
  providedDeps?: SnapshotCaptureDeps,
): Promise<RcaSourceSnapshot> {
  const deps = providedDeps ?? await loadDefaultCaptureDeps();
  const warnings: string[] = [];
  const messages: RcaSourceSnapshotMessage[] = [];
  const seenMessageIds = new Set<string>();
  const selfBotOpenId = deps.getBotOpenId(turn.larkAppId);
  let remainingChars = SOURCE_SNAPSHOT_MAX_CHARS;
  let truncated = false;

  const append = async (message: any, relation: RcaSourceSnapshotMessage['relation']): Promise<void> => {
    const messageId = typeof message?.message_id === 'string' ? message.message_id : '';
    if (!messageId || seenMessageIds.has(messageId)) return;
    seenMessageIds.add(messageId);
    if (messages.length >= SOURCE_SNAPSHOT_MAX_MESSAGES || remainingChars <= 0) {
      truncated = true;
      return;
    }
    const role = senderRole(message, selfBotOpenId);
    if (relation === 'recent' && role === 'self_bot') return;
    let content = redactLarkIdentifiers(await snapshotContent(
      turn,
      message,
      deps,
      relation !== 'recent',
    ).catch(() => ''));
    if (!content) return;
    if (content.length > remainingChars) {
      content = content.slice(0, remainingChars);
      truncated = true;
    }
    remainingChars -= content.length;
    const parsed = parseApiMessage(message);
    messages.push({
      referenceKey: opaqueKey(token, 'message', messageId),
      relation,
      senderRole: role,
      ...(parsed.senderName ? { senderName: parsed.senderName } : {}),
      messageType: parsed.msgType,
      content,
      ...(parsed.createTime ? { at: parsed.createTime } : {}),
    });
  };

  const currentRequest = deps.getMessageDetail(turn.larkAppId, turn.turnId)
    .then(detail => ({ detail, failed: false as const }))
    .catch(() => ({ detail: null, failed: true as const }));
  const recentRequest = deps.listChatMessages(
    turn.larkAppId,
    turn.chatId,
    SOURCE_SNAPSHOT_RECENT_MESSAGES,
  )
    .then(recent => ({ recent, failed: false as const }))
    .catch(() => ({ recent: [] as Awaited<ReturnType<typeof deps.listChatMessages>>, failed: true as const }));

  let current: any | null = null;
  const currentResult = await currentRequest;
  if (!currentResult.failed) {
    current = rawMessageItem(currentResult.detail);
    if (current) await append(current, 'current');
    else warnings.push('current_message_unavailable');
  } else {
    warnings.push('current_message_unavailable');
  }

  const quotedMessageId = typeof current?.parent_id === 'string' ? current.parent_id : '';
  if (quotedMessageId) {
    try {
      const quoted = rawMessageItem(await deps.getMessageDetail(turn.larkAppId, quotedMessageId));
      if (quoted) await append(quoted, 'quoted');
      else warnings.push('quoted_message_unavailable');
    } catch {
      warnings.push('quoted_message_unavailable');
    }
  }

  const recentResult = await recentRequest;
  if (recentResult.failed) {
    warnings.push('recent_messages_unavailable');
  } else {
    for (const message of recentResult.recent) await append(message, 'recent');
  }

  const finalWarnings = truncated ? [...warnings, 'source_snapshot_truncated'] : warnings;
  return {
    schemaVersion: '1',
    capturedAt: deps.now().toISOString(),
    captureStatus: messages.length === 0
      ? 'failed'
      : finalWarnings.length > 0 ? 'partial' : 'complete',
    warnings: finalWarnings,
    timeline: messages,
  };
}

export class RcaShadowMirror {
  private readonly config: RcaShadowMirrorConfig;
  private readonly fetchImpl: FetchLike;
  private readonly log: LogLike;
  private readonly captureSnapshot: (turn: RcaShadowTurn, token: string) => Promise<RcaSourceSnapshot>;
  private readonly queue: RcaShadowTurn[] = [];
  private readonly activeSessionIds = new Set<string>();
  private readonly idleWaiters: Array<() => void> = [];
  private inFlight = 0;

  constructor(
    config: RcaShadowMirrorConfig,
    {
      fetchImpl = fetch,
      log = logger,
      captureSnapshot = captureRcaSourceSnapshot,
    }: {
      fetchImpl?: FetchLike;
      log?: LogLike;
      captureSnapshot?: (turn: RcaShadowTurn, token: string) => Promise<RcaSourceSnapshot>;
    } = {},
  ) {
    this.config = config;
    this.fetchImpl = fetchImpl;
    this.log = log;
    this.captureSnapshot = captureSnapshot;
  }

  submit(turn: RcaShadowTurn): 'disabled' | 'filtered' | 'queued' | 'dropped' {
    if (!this.config.url || !this.config.token || this.config.botAppIds.length === 0) {
      return 'disabled';
    }
    if (!this.config.botAppIds.includes(turn.larkAppId)) return 'filtered';
    const canStartImmediately = this.inFlight < this.config.maxInFlight
      && !this.activeSessionIds.has(turn.sessionId);
    if (!canStartImmediately && this.queue.length >= this.config.maxQueued) {
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
      const nextIndex = this.queue.findIndex(turn => !this.activeSessionIds.has(turn.sessionId));
      if (nextIndex < 0) return;
      const [turn] = this.queue.splice(nextIndex, 1);
      this.inFlight += 1;
      this.activeSessionIds.add(turn.sessionId);
      void this.deliver(turn)
        .catch((error) => {
          this.log.warn(
            `[rca-shadow] mirror failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        })
        .finally(() => {
          this.inFlight -= 1;
          this.activeSessionIds.delete(turn.sessionId);
          this.drain();
          if (this.inFlight === 0 && this.queue.length === 0) {
            for (const resolve of this.idleWaiters.splice(0)) resolve();
          }
        });
    }
  }

  private async captureSourceSnapshot(turn: RcaShadowTurn): Promise<RcaSourceSnapshot> {
    let timeout: NodeJS.Timeout | undefined;
    const timedOut = new Promise<RcaSourceSnapshot>((resolve) => {
      timeout = setTimeout(
        () => resolve(failedSourceSnapshot('source_snapshot_capture_timeout')),
        SOURCE_SNAPSHOT_CAPTURE_TIMEOUT_MS,
      );
      timeout.unref();
    });
    try {
      return await Promise.race([
        this.captureSnapshot(turn, this.config.token)
          .catch(() => failedSourceSnapshot()),
        timedOut,
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  private async deliver(turn: RcaShadowTurn): Promise<void> {
    const preparedInput = sanitizedInput(turn.preparedInput);
    const sourceSnapshot = sanitizedSourceSnapshot(
      turn.sourceSnapshot ?? await this.captureSourceSnapshot(turn),
    );
    const incidentContent = [
      preparedInput.content,
      ...sourceSnapshot.timeline.map(item => item.content),
    ].join('\n');
    const incidentKey = keplerIncidentKey(
      this.config.token,
      incidentCandidates(preparedInput, sourceSnapshot),
    );
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
            turnKind: turn.turnKind,
            preparedInput,
            sourceSnapshot,
            signalSource: signalSource(incidentContent),
            ...(incidentKey ? { incidentKey } : {}),
            title: sanitizeTransportText(turn.title ?? '') || 'Botmux RCA mirror',
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
