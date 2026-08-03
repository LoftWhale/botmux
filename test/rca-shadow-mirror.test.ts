import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  captureRcaSourceSnapshot,
  RcaShadowMirror,
  rcaShadowMirrorConfigFromEnv,
  SOURCE_SNAPSHOT_CAPTURE_TIMEOUT_MS,
  type RcaShadowMirrorConfig,
  type RcaSourceSnapshot,
} from '../src/services/rca-shadow-mirror.js';

function config(overrides: Partial<RcaShadowMirrorConfig> = {}): RcaShadowMirrorConfig {
  return {
    url: 'http://rca.internal:7310',
    token: 'mirror-secret',
    botAppIds: ['app_rca'],
    timeoutMs: 25,
    maxInFlight: 1,
    maxQueued: 1,
    ...overrides,
  };
}

function turn(overrides = {}) {
  return {
    larkAppId: 'app_rca',
    sessionId: 'botmux-private-session',
    turnId: 'lark-private-message',
    topicId: 'lark-private-topic',
    title: 'panic',
    turnKind: 'follow_up' as const,
    chatId: 'lark-private-chat',
    preparedInput: { content: '<user_message>argos panic</user_message>' },
    ...overrides,
  };
}

const capturedSnapshot: RcaSourceSnapshot = {
  schemaVersion: '1',
  capturedAt: '2026-08-03T12:00:00.000Z',
  captureStatus: 'complete',
  warnings: [],
  timeline: [{
    referenceKey: 'opaque-current',
    relation: 'current',
    senderRole: 'human',
    messageType: 'text',
    content: 'panic happened',
    at: '123',
  }],
};

describe('RCA shadow mirror', () => {
  it('is disabled unless URL, token, and explicit bot allowlist are all present', () => {
    const parsed = rcaShadowMirrorConfigFromEnv({});
    const mirror = new RcaShadowMirror(parsed, { fetchImpl: vi.fn() as any });
    expect(mirror.submit(turn())).toBe('disabled');
  });

  it('can load the mirror token from a protected file', () => {
    const parsed = rcaShadowMirrorConfigFromEnv({
      BOTMUX_RCA_MIRROR_TOKEN_FILE: new URL(
        './fixtures/rca-mirror-token.txt',
        import.meta.url,
      ).pathname,
    });
    expect(parsed.token).toBe('file-secret');
  });

  it('sends opaque correlation fields, source snapshot, turn kind and the exact prepared input', async () => {
    const fetchMock = vi.fn(async () => new Response('', { status: 202 }));
    const mirror = new RcaShadowMirror(config(), {
      fetchImpl: fetchMock as any,
      captureSnapshot: vi.fn(async () => capturedSnapshot),
    });
    expect(mirror.submit(turn({ sourceSnapshot: capturedSnapshot }))).toBe('queued');
    await mirror.onIdle();

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://rca.internal:7310/api/mirrors/turns');
    const body = JSON.parse(String(init.body));
    expect(body.preparedInput.content).toBe('<user_message>argos panic</user_message>');
    expect(body.turnKind).toBe('follow_up');
    expect(body.sourceSnapshot).toEqual(capturedSnapshot);
    expect(body.signalSource).toBe('argos');
    expect(JSON.stringify(body)).not.toContain('botmux-private-session');
    expect(JSON.stringify(body)).not.toContain('lark-private-message');
    expect(JSON.stringify(body)).not.toContain('lark-private-topic');
    expect(JSON.stringify(body)).not.toContain('lark-private-chat');
  });

  it('captures current, explicitly quoted, and recent messages while excluding ordinary self-bot history', async () => {
    const current = {
      message_id: 'om_current', parent_id: 'om_quote', msg_type: 'text', create_time: '30',
      sender: { id: 'ou_human', sender_type: 'user', sender_name: 'Alice' },
      body: { content: JSON.stringify({ text: 'please continue oc_private ou_private om_private' }) },
    };
    const quotedSelf = {
      message_id: 'om_quote', msg_type: 'interactive', create_time: '20',
      sender: { id: 'ou_self', sender_type: 'app', sender_name: 'RCA bot' },
      body: { content: JSON.stringify({ title: 'fallback' }) },
    };
    const ordinarySelf = {
      message_id: 'om_old_self', msg_type: 'text', create_time: '10',
      sender: { id: 'ou_self', sender_type: 'app', sender_name: 'RCA bot' },
      body: { content: JSON.stringify({ text: 'champion conclusion' }) },
    };
    const recentHuman = {
      message_id: 'om_recent', msg_type: 'text', create_time: '15',
      sender: { id: 'ou_human_2', sender_type: 'user', sender_name: 'Bob' },
      body: { content: JSON.stringify({ text: '下游正在升级' }) },
    };

    const snapshot = await captureRcaSourceSnapshot(turn({ turnId: 'om_current' }), 'mirror-secret', {
      getMessageDetail: vi.fn(async (_appId, messageId) => ({
        items: [messageId === 'om_current' ? current : quotedSelf],
      })),
      listChatMessages: vi.fn(async () => [ordinarySelf, recentHuman, quotedSelf, current]),
      resolveMergedCardContent: vi.fn(async () => ({
        text: 'full quoted RCA card', structuredContent: '{}', resources: [],
      })),
      getBotOpenId: vi.fn(() => 'ou_self'),
      now: () => new Date('2026-08-03T12:00:00.000Z'),
    });

    expect(snapshot).toMatchObject({
      schemaVersion: '1',
      capturedAt: '2026-08-03T12:00:00.000Z',
      warnings: [],
    });
    expect(snapshot.captureStatus).toBe('complete');
    expect(snapshot.timeline.map(message => [message.relation, message.senderRole, message.content])).toEqual([
      ['current', 'human', 'please continue [redacted-reference] [redacted-reference] [redacted-reference]'],
      ['quoted', 'self_bot', 'full quoted RCA card'],
      ['recent', 'human', '下游正在升级'],
    ]);
    expect(snapshot.timeline[0]?.at).toBe('30');
    expect(JSON.stringify(snapshot)).not.toContain('om_current');
    expect(JSON.stringify(snapshot)).not.toContain('om_quote');
    expect(JSON.stringify(snapshot)).not.toContain('om_recent');
    expect(JSON.stringify(snapshot)).not.toContain('ou_');
    expect(JSON.stringify(snapshot)).not.toContain('champion conclusion');
  });

  it('marks a character-bounded snapshot partial and records truncation', async () => {
    const current = {
      message_id: 'om_large', msg_type: 'text', create_time: '30',
      sender: { id: 'ou_human', sender_type: 'user' },
      body: { content: JSON.stringify({ text: 'x'.repeat(13_000) }) },
    };
    const snapshot = await captureRcaSourceSnapshot(turn({ turnId: 'om_large' }), 'mirror-secret', {
      getMessageDetail: vi.fn(async () => ({ items: [current] })),
      listChatMessages: vi.fn(async () => []),
      resolveMergedCardContent: vi.fn(async () => null),
      getBotOpenId: vi.fn(() => 'ou_self'),
      now: () => new Date('2026-08-03T12:00:00.000Z'),
    });
    expect(snapshot.captureStatus).toBe('partial');
    expect(snapshot.warnings).toEqual(['source_snapshot_truncated']);
    expect(snapshot.timeline[0]?.content).toHaveLength(12_000);
  });

  it('degrades snapshot capture failures without suppressing HTTP delivery', async () => {
    const fetchMock = vi.fn(async () => new Response('', { status: 202 }));
    const mirror = new RcaShadowMirror(config(), {
      fetchImpl: fetchMock as any,
      captureSnapshot: vi.fn(async () => { throw new Error('lark unavailable'); }),
    });
    expect(mirror.submit(turn())).toBe('queued');
    await mirror.onIdle();

    expect(fetchMock).toHaveBeenCalledOnce();
    const body = JSON.parse(String(fetchMock.mock.calls[0]![1].body));
    expect(body.sourceSnapshot).toEqual({
      schemaVersion: '1',
      capturedAt: expect.any(String),
      captureStatus: 'failed',
      warnings: ['source_snapshot_capture_failed'],
      timeline: [],
    });
  });

  it('times out a stuck source capture and continues HTTP delivery', async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi.fn(async () => new Response('', { status: 202 }));
      const mirror = new RcaShadowMirror(config(), {
        fetchImpl: fetchMock as any,
        captureSnapshot: vi.fn(async () => new Promise<RcaSourceSnapshot>(() => {})),
      });
      mirror.submit(turn());
      await vi.advanceTimersByTimeAsync(SOURCE_SNAPSHOT_CAPTURE_TIMEOUT_MS);
      await mirror.onIdle();
      expect(fetchMock).toHaveBeenCalledOnce();
      const body = JSON.parse(String(fetchMock.mock.calls[0]![1].body));
      expect(body.sourceSnapshot.captureStatus).toBe('failed');
      expect(body.sourceSnapshot.warnings).toEqual(['source_snapshot_capture_timeout']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('serializes turns within one session while allowing another session to run concurrently', async () => {
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const deliveredKinds: string[] = [];
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      deliveredKinds.push(`${body.title}:${body.turnKind}`);
      if (body.title === 'session-a-first') await firstBlocked;
      return new Response('', { status: 202 });
    });
    const mirror = new RcaShadowMirror(config({ maxInFlight: 2, maxQueued: 4 }), {
      fetchImpl: fetchMock as any,
    });

    mirror.submit(turn({
      sessionId: 'session-a', turnId: 'a-first', title: 'session-a-first',
      turnKind: 'first_turn', sourceSnapshot: capturedSnapshot,
    }));
    mirror.submit(turn({
      sessionId: 'session-a', turnId: 'a-follow', title: 'session-a-follow',
      turnKind: 'follow_up', sourceSnapshot: capturedSnapshot,
    }));
    mirror.submit(turn({
      sessionId: 'session-b', turnId: 'b-first', title: 'session-b-first',
      turnKind: 'first_turn', sourceSnapshot: capturedSnapshot,
    }));

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(deliveredKinds).toEqual(['session-a-first:first_turn', 'session-b-first:first_turn']);
    releaseFirst();
    await mirror.onIdle();
    expect(deliveredKinds).toEqual([
      'session-a-first:first_turn',
      'session-b-first:first_turn',
      'session-a-follow:follow_up',
    ]);
  });

  it('bounds queued turns for an already active session even when global capacity remains', async () => {
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const mirror = new RcaShadowMirror(config({ maxInFlight: 2, maxQueued: 1 }), {
      fetchImpl: vi.fn(async () => {
        await firstBlocked;
        return new Response('', { status: 202 });
      }) as any,
      log: { info: vi.fn(), warn: vi.fn() },
    });
    expect(mirror.submit(turn({ sessionId: 'same', turnId: 'first', sourceSnapshot: capturedSnapshot }))).toBe('queued');
    expect(mirror.submit(turn({ sessionId: 'same', turnId: 'second', sourceSnapshot: capturedSnapshot }))).toBe('queued');
    expect(mirror.submit(turn({ sessionId: 'same', turnId: 'third', sourceSnapshot: capturedSnapshot }))).toBe('dropped');
    releaseFirst();
    await mirror.onIdle();
  });

  it('infers the signal source from captured context without changing prepared input', async () => {
    const fetchMock = vi.fn(async () => new Response('', { status: 202 }));
    const keplerSnapshot: RcaSourceSnapshot = {
      ...capturedSnapshot,
      timeline: [{ ...capturedSnapshot.timeline[0]!, content: 'Kepler 服务成功率下降' }],
    };
    const mirror = new RcaShadowMirror(config(), { fetchImpl: fetchMock as any });
    mirror.submit(turn({
      preparedInput: { content: '<user_message>请开始排查</user_message>' },
      sourceSnapshot: keplerSnapshot,
    }));
    await mirror.onIdle();
    const body = JSON.parse(String(fetchMock.mock.calls[0]![1].body));
    expect(body.preparedInput.content).toBe('<user_message>请开始排查</user_message>');
    expect(body.signalSource).toBe('kepler');
  });

  it('emits only the RCA Server source snapshot contract fields', async () => {
    const fetchMock = vi.fn(async () => new Response('', { status: 202 }));
    const mirror = new RcaShadowMirror(config(), {
      fetchImpl: fetchMock as any,
      captureSnapshot: vi.fn(async () => capturedSnapshot),
    });
    mirror.submit(turn());
    await mirror.onIdle();
    const body = JSON.parse(String(fetchMock.mock.calls[0]![1].body));
    expect(Object.keys(body.sourceSnapshot).sort()).toEqual([
      'captureStatus', 'capturedAt', 'schemaVersion', 'timeline', 'warnings',
    ]);
    expect(Object.keys(body.sourceSnapshot.timeline[0]).sort()).toEqual([
      'at', 'content', 'messageType', 'referenceKey', 'relation', 'senderRole',
    ]);
  });

  it.each([
    ['timeout', async (_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
    })],
    ['HTTP rejection', async () => new Response('', { status: 503 })],
    ['network failure', async () => { throw new Error('unreachable'); }],
  ])('contains %s without rejecting the caller', async (_name, fetchImpl) => {
    const log = { info: vi.fn(), warn: vi.fn() };
    const mirror = new RcaShadowMirror(config(), {
      fetchImpl: fetchImpl as any,
      log,
    });
    expect(() => mirror.submit(turn())).not.toThrow();
    await mirror.onIdle();
    expect(log.warn).toHaveBeenCalled();
  });

  it('drops excess work at the configured bound', async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const mirror = new RcaShadowMirror(config({ maxQueued: 0 }), {
      fetchImpl: vi.fn(async () => {
        await blocked;
        return new Response('', { status: 202 });
      }) as any,
      log: { info: vi.fn(), warn: vi.fn() },
    });
    expect(mirror.submit(turn())).toBe('queued');
    expect(mirror.submit(turn({ turnId: 'second' }))).toBe('dropped');
    release();
    await mirror.onIdle();
  });

  it('mirrors only after both primary worker dispatch sites', () => {
    const source = readFileSync(
      new URL('../src/core/worker-pool.ts', import.meta.url),
      'utf8',
    );
    const live = source.slice(
      source.indexOf('export function sendWorkerInput'),
      source.indexOf('export function forkWorker'),
    );
    expect(live.indexOf('ds.worker.send({')).toBeGreaterThan(-1);
    expect(live.indexOf('mirrorPreparedTurn({')).toBeGreaterThan(live.indexOf('ds.worker.send({'));

    const cold = source.slice(
      source.indexOf('export function forkWorker'),
      source.indexOf('// ─── Shared worker IPC handler'),
    );
    expect(cold.indexOf('worker.send(initMsg)')).toBeGreaterThan(-1);
    expect(cold.indexOf('mirrorPreparedTurn({')).toBeGreaterThan(cold.indexOf('worker.send(initMsg)'));
    expect(live).toContain("turnKind: 'follow_up'");
    expect(cold).toContain("turnKind: resume ? 'follow_up' : 'first_turn'");
  });

  it('attributes both auto group-join spawn paths to a stable synthetic first turn', () => {
    const source = readFileSync(new URL('../src/daemon.ts', import.meta.url), 'utf8');
    const joinHandler = source.slice(
      source.indexOf('async function handleBotAdded'),
      source.indexOf('/** Reverse-lookup a foreign bot'),
    );
    expect(joinHandler).toContain('pendingTurnId: groupJoinSyntheticTurnId(chatId)');
    expect(joinHandler.match(/forkWorker\(ds, prompt, \{ turnId: groupJoinSyntheticTurnId\(chatId\) \}\)/g)).toHaveLength(2);
    expect(joinHandler.match(/ds\.pendingTurnId = undefined/g)).toHaveLength(2);

    const cardHandler = readFileSync(new URL('../src/im/lark/card-handler.ts', import.meta.url), 'utf8');
    expect(cardHandler).toContain('pendingTurnId && wrappedInput.content.trim().length > 0');
  });
});
