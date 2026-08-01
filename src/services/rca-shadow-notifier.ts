import { readFileSync } from 'node:fs';
import { sendMessage } from '../im/lark/client.js';
import { logger } from '../utils/logger.js';

interface CandidateDetail {
  event?: { id?: string; title?: string };
  run?: {
    status?: string;
    firstTurn?: { response?: string } | null;
    error?: string | null;
  };
  evaluationState?: {
    acceptance?: string;
    finalVerdict?: string | null;
  };
}

export interface RcaShadowNotifierConfig {
  rcaUrl: string;
  token: string;
  chatId: string;
  pollIntervalMs: number;
  pollTimeoutMs: number;
}

type FetchLike = typeof fetch;
type SendCard = (
  larkAppId: string,
  chatId: string,
  content: string,
  msgType: string,
  uuid?: string,
) => Promise<string>;
type LogLike = Pick<typeof logger, 'warn'>;

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function rcaShadowTokenFromEnv(env: NodeJS.ProcessEnv): string {
  const direct = env.BOTMUX_RCA_MIRROR_TOKEN?.trim();
  if (direct) return direct;
  const file = env.BOTMUX_RCA_MIRROR_TOKEN_FILE?.trim();
  if (!file) return '';
  try {
    return readFileSync(file, 'utf8').trim();
  } catch {
    return '';
  }
}

export function rcaShadowNotifierConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): RcaShadowNotifierConfig {
  return {
    rcaUrl: env.BOTMUX_RCA_MIRROR_URL?.trim() || '',
    token: rcaShadowTokenFromEnv(env),
    chatId: env.BOTMUX_RCA_SHADOW_CHAT_ID?.trim() || '',
    pollIntervalMs: positiveInteger(env.BOTMUX_RCA_SHADOW_POLL_INTERVAL_MS, 1_000),
    pollTimeoutMs: positiveInteger(env.BOTMUX_RCA_SHADOW_POLL_TIMEOUT_MS, 15 * 60_000),
  };
}

function truncate(value: string, limit: number): string {
  const points = Array.from(value);
  return points.length <= limit ? value : `${points.slice(0, limit).join('')}…`;
}

export function buildRcaShadowCard(
  detail: CandidateDetail,
  detailUrl: string,
): Record<string, unknown> {
  const failed = detail.run?.status === 'failed';
  const conclusion = detail.run?.firstTurn?.response
    || detail.run?.error
    || '候选调查尚未形成结论';
  return {
    header: {
      template: failed ? 'red' : 'blue',
      title: {
        tag: 'plain_text',
        content: `RCA Shadow · ${truncate(detail.event?.title || '未命名报警', 60)}`,
      },
    },
    elements: [
      {
        tag: 'div',
        fields: [
          {
            is_short: true,
            text: { tag: 'lark_md', content: '**方案 A**\n当前版结论保留在原报警话题' },
          },
          {
            is_short: true,
            text: {
              tag: 'lark_md',
              content: `**方案 B**\n${failed ? "<font color='red'>运行失败</font>" : '新版候选已完成'}`,
            },
          },
        ],
      },
      { tag: 'hr' },
      {
        tag: 'markdown',
        content: `**方案 B 当前结论**\n${truncate(conclusion, 2_000)}`,
      },
      {
        tag: 'action',
        actions: [
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '评分 / 继续排查' },
            type: 'primary',
            url: detailUrl,
          },
        ],
      },
      {
        tag: 'note',
        elements: [{
          tag: 'plain_text',
          content: 'A/B 仅用于降低先入为主；本卡片不会改变原报警群的当前 RCA 链路。',
        }],
      },
    ],
  };
}

export class RcaShadowNotifier {
  private readonly active = new Map<string, Promise<void>>();
  private readonly notified = new Set<string>();

  constructor(
    private readonly config: RcaShadowNotifierConfig,
    private readonly deps: {
      fetchImpl?: FetchLike;
      sendCard?: SendCard;
      log?: LogLike;
    } = {},
  ) {}

  start(eventId: string, larkAppId: string, viewKey = ''): void {
    if (!this.config.rcaUrl || !this.config.token || !this.config.chatId) return;
    if (this.notified.has(eventId) || this.active.has(eventId)) return;
    const task = this.monitor(eventId, larkAppId, viewKey)
      .catch((error) => {
        (this.deps.log || logger).warn(
          `[rca-shadow] candidate topic delivery failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      })
      .finally(() => this.active.delete(eventId));
    this.active.set(eventId, task);
  }

  async onIdle(): Promise<void> {
    await Promise.all([...this.active.values()]);
  }

  private async monitor(eventId: string, larkAppId: string, viewKey: string): Promise<void> {
    const fetchImpl = this.deps.fetchImpl || fetch;
    const deadline = Date.now() + this.config.pollTimeoutMs;
    const base = this.config.rcaUrl.replace(/\/+$/, '');
    while (Date.now() < deadline) {
      const response = await fetchImpl(`${base}/api/events/${encodeURIComponent(eventId)}`, {
        headers: { authorization: `Bearer ${this.config.token}` },
      });
      if (!response.ok) throw new Error(`RCA detail returned HTTP ${response.status}`);
      const detail = await response.json() as CandidateDetail;
      if (detail.run?.status === 'completed' || detail.run?.status === 'failed') {
        const detailUrl = `${base}/events/${encodeURIComponent(eventId)}${
          viewKey ? `?view=${encodeURIComponent(viewKey)}` : ''
        }`;
        const card = buildRcaShadowCard(detail, detailUrl);
        const sendCard = this.deps.sendCard || sendMessage;
        await sendCard(
          larkAppId,
          this.config.chatId,
          JSON.stringify(card),
          'interactive',
          `search-rca-${eventId}`,
        );
        this.notified.add(eventId);
        if (this.notified.size > 5_000) {
          const oldest = this.notified.values().next().value;
          if (oldest) this.notified.delete(oldest);
        }
        return;
      }
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, this.config.pollIntervalMs);
        timer.unref();
      });
    }
    throw new Error(`candidate was not ready within ${this.config.pollTimeoutMs}ms`);
  }
}

let defaultNotifier: RcaShadowNotifier | null = null;

export function notifyRcaCandidateAccepted(
  eventId: string,
  larkAppId: string,
  viewKey = '',
): void {
  try {
    defaultNotifier ??= new RcaShadowNotifier(rcaShadowNotifierConfigFromEnv());
    defaultNotifier.start(eventId, larkAppId, viewKey);
  } catch (error) {
    logger.warn(
      `[rca-shadow] candidate notification ignored: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
