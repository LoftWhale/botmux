import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  captureRcaSourceSnapshot,
  deliverRcaChampionResult,
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
      body: { content: JSON.stringify({ text: 'please continue oc_1234567890abcdef ou_1234567890abcdef om_1234567890abcdef' }) },
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

  it('captures normal three-RTT context within budget without remotely expanding recent cards', async () => {
    vi.useFakeTimers();
    try {
      const current = {
        message_id: 'om_current', parent_id: 'om_quote', msg_type: 'text', create_time: '30',
        sender: { id: 'ou_human', sender_type: 'user' },
        body: { content: JSON.stringify({ text: 'current alarm' }) },
      };
      const quoted = {
        message_id: 'om_quote', msg_type: 'text', create_time: '20',
        sender: { id: 'ou_human_2', sender_type: 'user' },
        body: { content: JSON.stringify({ text: 'quoted symptom' }) },
      };
      const recentCards = Array.from({ length: 8 }, (_, index) => ({
        message_id: `om_recent_${index}`,
        msg_type: 'interactive',
        create_time: String(10 + index),
        sender: { id: `ou_recent_${index}`, sender_type: 'user' },
        body: { content: JSON.stringify({
          title: `recent ${index}`,
          elements: [[{ tag: 'text', text: `recent card ${index}` }]],
        }) },
      }));
      const resolveMergedCardContent = vi.fn(async () => {
        await new Promise(resolve => setTimeout(resolve, 830));
        return { text: 'remote card', structuredContent: '{}', resources: [] };
      });
      const deps = {
        getMessageDetail: vi.fn(async (_appId: string, messageId: string) => {
          await new Promise(resolve => setTimeout(resolve, messageId === 'om_current' ? 800 : 830));
          return { items: [messageId === 'om_current' ? current : quoted] } as any;
        }),
        listChatMessages: vi.fn(async () => {
          await new Promise(resolve => setTimeout(resolve, 650));
          return recentCards as any;
        }),
        resolveMergedCardContent,
        getBotOpenId: vi.fn(() => 'ou_self'),
        now: () => new Date('2026-08-03T12:00:00.000Z'),
      };
      const fetchMock = vi.fn(async () => new Response('', { status: 202 }));
      const mirror = new RcaShadowMirror(config(), {
        fetchImpl: fetchMock as any,
        captureSnapshot: (input, token) => captureRcaSourceSnapshot(input, token, deps),
      });

      mirror.submit(turn({ turnId: 'om_current' }));
      await vi.advanceTimersByTimeAsync(700);
      expect(deps.listChatMessages).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(1_000);
      await mirror.onIdle();

      const body = JSON.parse(String(fetchMock.mock.calls[0]![1].body));
      expect(body.sourceSnapshot.captureStatus).not.toBe('failed');
      expect(body.sourceSnapshot.timeline.map((item: any) => item.content)).toEqual(
        expect.arrayContaining(['current alarm', 'quoted symptom', '[卡片: recent 0]\nrecent card 0']),
      );
      expect(resolveMergedCardContent).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('uses a complete local current or quoted card body before remote card resolution', async () => {
    const completeCard = (messageId: string, text: string, parentId?: string) => ({
      message_id: messageId,
      ...(parentId ? { parent_id: parentId } : {}),
      msg_type: 'interactive',
      sender: { id: 'ou_human', sender_type: 'user' },
      body: { content: JSON.stringify({
        title: text,
        elements: [[{ tag: 'text', text: `${text} body` }]],
      }) },
    });
    const current = completeCard('om_current', 'current', 'om_quote');
    const quoted = completeCard('om_quote', 'quoted');
    const resolveMergedCardContent = vi.fn(async () => ({
      text: 'remote fallback', structuredContent: '{}', resources: [],
    }));

    const snapshot = await captureRcaSourceSnapshot(turn({ turnId: 'om_current' }), 'mirror-secret', {
      getMessageDetail: vi.fn(async (_appId, messageId) => ({
        items: [messageId === 'om_current' ? current : quoted],
      })),
      listChatMessages: vi.fn(async () => []),
      resolveMergedCardContent,
      getBotOpenId: vi.fn(() => 'ou_self'),
      now: () => new Date('2026-08-03T12:00:00.000Z'),
    });

    expect(snapshot.timeline.map(item => item.content)).toEqual([
      '[卡片: current]\ncurrent body',
      '[卡片: quoted]\nquoted body',
    ]);
    expect(resolveMergedCardContent).not.toHaveBeenCalled();
  });

  it('preserves quoted and recent step warnings when parallel capture partially fails', async () => {
    const current = {
      message_id: 'om_current', parent_id: 'om_quote', msg_type: 'text',
      sender: { id: 'ou_human', sender_type: 'user' },
      body: { content: JSON.stringify({ text: 'current alarm' }) },
    };
    const snapshot = await captureRcaSourceSnapshot(turn({ turnId: 'om_current' }), 'mirror-secret', {
      getMessageDetail: vi.fn(async (_appId, messageId) => {
        if (messageId === 'om_quote') throw new Error('quoted unavailable');
        return { items: [current] };
      }),
      listChatMessages: vi.fn(async () => { throw new Error('recent unavailable'); }),
      resolveMergedCardContent: vi.fn(async () => null),
      getBotOpenId: vi.fn(() => 'ou_self'),
      now: () => new Date('2026-08-03T12:00:00.000Z'),
    });

    expect(snapshot.captureStatus).toBe('partial');
    expect(snapshot.warnings).toEqual([
      'quoted_message_unavailable',
      'recent_messages_unavailable',
    ]);
    expect(snapshot.timeline.map(item => item.content)).toEqual(['current alarm']);
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

  it('neutralizes Botmux commands without deleting surrounding user business text', async () => {
    const fetchMock = vi.fn(async () => new Response('', { status: 202 }));
    const mirror = new RcaShadowMirror(config(), { fetchImpl: fetchMock as any });
    mirror.submit(turn({
      preparedInput: {
        content: [
          '<session_id>session-private-123</session_id>',
          '<botmux_routing>',
          '先执行 botmux history oc_private，再用 botmux quoted om_quote，最后 botmux send ou_owner',
          '</botmux_routing>',
          '[用户引用了消息，请用 botmux quoted om_1234567890abcdef 查看，但 panic 发生在搜索页]',
          '<attachments hint="source files"><image n="1" path="/home/operator/private/alarm.png" /></attachments>',
          '<user_message>on_call 与 om_search 是业务词，必须保留</user_message>',
          '<user_message>Kepler 报警：search panic，请排查 eventId=event-9</user_message>',
        ].join('\n'),
        codexAppInput: {
          text: 'botmux history oc_private\nKepler 报警：search panic',
          additionalContext: {
            route: { type: 'text', value: 'om_private ou_private' },
          },
          clientUserMessageId: 'om_client_private',
        },
      },
      sourceSnapshot: capturedSnapshot,
    }));
    await mirror.onIdle();

    const bodyText = String(fetchMock.mock.calls[0]![1].body);
    const body = JSON.parse(bodyText);
    expect(body.preparedInput.content).toContain('<user_message>Kepler 报警：search panic，请排查 eventId=event-9</user_message>');
    expect(body.preparedInput.content).toContain('panic 发生在搜索页');
    expect(body.preparedInput.content).toContain('on_call 与 om_search 是业务词，必须保留');
    expect(body.preparedInput.content).toContain('source-local paths unavailable');
    expect(body.preparedInput).toEqual({ content: body.preparedInput.content });
    expect(bodyText).not.toMatch(/botmux\s+(?:history|quoted|send|bots)/i);
    expect(bodyText).not.toContain('<botmux_routing>');
    expect(bodyText).not.toContain('session-private-123');
    expect(bodyText).not.toMatch(/\b(?:oc|om|ou|on)_[A-Za-z0-9_-]{16,}\b/);
    expect(bodyText).not.toContain('/home/operator/private/alarm.png');
    expect(bodyText).not.toContain('mirror-secret');
  });

  it('sanitizes caller-supplied snapshot strings and title before outbound persistence', async () => {
    const fetchMock = vi.fn(async () => new Response('', { status: 202 }));
    const mirror = new RcaShadowMirror(config(), { fetchImpl: fetchMock as any });
    mirror.submit(turn({
      title: 'panic om_1234567890abcdef；请执行 botmux history oc_1234567890abcdef 后复核',
      sourceSnapshot: {
        schemaVersion: '1',
        capturedAt: '2026-08-03T12:00:00.000Z',
        captureStatus: 'partial',
        warnings: ['recent om_1234567890abcdef；botmux bots list 不可用'],
        privateMeta: { token: 'snapshot-private-secret' },
        timeline: [{
          referenceKey: 'om_1234567890abcdef',
          relation: 'current',
          senderRole: 'human',
          senderName: 'Alice ou_1234567890abcdef',
          messageType: 'text',
          content: '<botmux_routing>botmux send ou_1234567890abcdef</botmux_routing>业务症状仍是 panic；botmux quoted om_1234567890abcdef 仅用于旧链路',
          at: '2026-08-03 om_1234567890abcdef',
          localPath: '/home/operator/private/snapshot.json',
          privateMeta: 'timeline-private-secret',
        }],
      } as any,
    }));
    await mirror.onIdle();

    const bodyText = String(fetchMock.mock.calls[0]![1].body);
    const body = JSON.parse(bodyText);
    expect(body.title).toContain('panic');
    expect(body.sourceSnapshot.timeline[0].content).toContain('业务症状仍是 panic');
    expect(bodyText).not.toMatch(/botmux\s+(?:history|quoted|send|bots)/i);
    expect(bodyText).not.toMatch(/\b(?:oc|om|ou|on)_[A-Za-z0-9_-]{16,}\b/);
    expect(bodyText).not.toContain('snapshot-private-secret');
    expect(bodyText).not.toContain('timeline-private-secret');
    expect(bodyText).not.toContain('/home/operator/private/snapshot.json');
    expect(body.sourceSnapshot).not.toHaveProperty('privateMeta');
    expect(body.sourceSnapshot.timeline[0]).not.toHaveProperty('localPath');
    expect(body.sourceSnapshot.timeline[0]).not.toHaveProperty('privateMeta');
  });

  it('adds the same opaque incident key for Kepler cards sharing submonitorId and eventId', async () => {
    const fetchMock = vi.fn(async () => new Response('', { status: 202 }));
    const mirror = new RcaShadowMirror(config({ maxInFlight: 2, maxQueued: 2 }), {
      fetchImpl: fetchMock as any,
    });
    const keplerSnapshot: RcaSourceSnapshot = {
      ...capturedSnapshot,
      timeline: [{
        ...capturedSnapshot.timeline[0]!,
        content: 'Kepler alarm submonitorId=submonitor-42&eventId=event-99',
      }],
    };
    mirror.submit(turn({ sessionId: 'session-a', turnId: 'turn-a', sourceSnapshot: keplerSnapshot }));
    mirror.submit(turn({ sessionId: 'session-b', turnId: 'turn-b', sourceSnapshot: keplerSnapshot }));
    await mirror.onIdle();

    const bodies = fetchMock.mock.calls.map(call => JSON.parse(String(call[1].body)));
    expect(bodies[0].incidentKey).toMatch(/^[a-f0-9]{64}$/);
    expect(bodies[1].incidentKey).toBe(bodies[0].incidentKey);
    expect(bodies[0].incidentKey).not.toContain('submonitor-42');
    expect(bodies[0].incidentKey).not.toContain('event-99');
  });

  it('does not guess an incident key when either Kepler stable identifier is missing', async () => {
    const fetchMock = vi.fn(async () => new Response('', { status: 202 }));
    const mirror = new RcaShadowMirror(config(), { fetchImpl: fetchMock as any });
    mirror.submit(turn({
      sourceSnapshot: {
        ...capturedSnapshot,
        timeline: [{ ...capturedSnapshot.timeline[0]!, content: 'Kepler submonitorId=submonitor-42' }],
      },
    }));
    await mirror.onIdle();

    const body = JSON.parse(String(fetchMock.mock.calls[0]![1].body));
    expect(body).not.toHaveProperty('incidentKey');
  });

  it('does not combine Kepler identifiers split across prepared and snapshot messages', async () => {
    const fetchMock = vi.fn(async () => new Response('', { status: 202 }));
    const mirror = new RcaShadowMirror(config(), { fetchImpl: fetchMock as any });
    mirror.submit(turn({
      preparedInput: { content: 'Kepler submonitorId=submonitor-from-prepared' },
      sourceSnapshot: {
        ...capturedSnapshot,
        timeline: [{
          ...capturedSnapshot.timeline[0]!,
          relation: 'current',
          content: 'current card eventId=event-from-current',
        }],
      },
    }));
    await mirror.onIdle();

    const body = JSON.parse(String(fetchMock.mock.calls[0]![1].body));
    expect(body).not.toHaveProperty('incidentKey');
  });

  it('selects one complete candidate pair instead of cross-mixing different messages', async () => {
    const fetchMock = vi.fn(async () => new Response('', { status: 202 }));
    const mirror = new RcaShadowMirror(config(), { fetchImpl: fetchMock as any });
    const recentPair = 'Kepler submonitorId=submonitor-recent&eventId=event-recent';
    mirror.submit(turn({
      sourceSnapshot: {
        ...capturedSnapshot,
        timeline: [
          { ...capturedSnapshot.timeline[0]!, relation: 'current', content: 'Kepler submonitorId=submonitor-incomplete' },
          { ...capturedSnapshot.timeline[0]!, referenceKey: 'opaque-recent', relation: 'recent', content: recentPair },
        ],
      },
    }));
    await mirror.onIdle();
    mirror.submit(turn({
      sessionId: 'baseline-session',
      turnId: 'baseline-turn',
      sourceSnapshot: {
        ...capturedSnapshot,
        timeline: [{ ...capturedSnapshot.timeline[0]!, relation: 'recent', content: recentPair }],
      },
    }));
    await mirror.onIdle();

    const bodies = fetchMock.mock.calls.map(call => JSON.parse(String(call[1].body)));
    expect(bodies[0].incidentKey).toBe(bodies[1].incidentKey);
  });

  it('does not choose an incident key when candidate messages contain different complete pairs', async () => {
    const fetchMock = vi.fn(async () => new Response('', { status: 202 }));
    const mirror = new RcaShadowMirror(config(), { fetchImpl: fetchMock as any });
    mirror.submit(turn({
      preparedInput: { content: 'Kepler submonitorId=submonitor-prepared&eventId=event-prepared' },
      sourceSnapshot: {
        ...capturedSnapshot,
        timeline: [
          {
            ...capturedSnapshot.timeline[0]!,
            relation: 'current',
            content: 'Kepler submonitorId=submonitor-current&eventId=event-current',
          },
          {
            ...capturedSnapshot.timeline[0]!,
            referenceKey: 'opaque-recent',
            relation: 'recent',
            content: 'Kepler submonitorId=submonitor-recent&eventId=event-recent',
          },
        ],
      },
    }));
    await mirror.onIdle();

    const body = JSON.parse(String(fetchMock.mock.calls[0]![1].body));
    expect(body).not.toHaveProperty('incidentKey');
  });

  it('treats interleaved multiple identifier values inside one candidate as ambiguous', async () => {
    const fetchMock = vi.fn(async () => new Response('', { status: 202 }));
    const mirror = new RcaShadowMirror(config(), { fetchImpl: fetchMock as any });
    mirror.submit(turn({
      preparedInput: {
        content: [
          'Kepler submonitorId=submonitor-a eventId=event-a',
          'eventId=event-b submonitorId=submonitor-b',
        ].join('\n'),
      },
      sourceSnapshot: capturedSnapshot,
    }));
    await mirror.onIdle();

    const body = JSON.parse(String(fetchMock.mock.calls[0]![1].body));
    expect(body).not.toHaveProperty('incidentKey');
  });

  it('treats a multi-value candidate as ambiguous even when Kepler is named elsewhere', async () => {
    const fetchMock = vi.fn(async () => new Response('', { status: 202 }));
    const mirror = new RcaShadowMirror(config(), { fetchImpl: fetchMock as any });
    mirror.submit(turn({
      preparedInput: {
        content: 'Kepler submonitorId=submonitor-prepared&eventId=event-prepared',
      },
      sourceSnapshot: {
        ...capturedSnapshot,
        timeline: [{
          ...capturedSnapshot.timeline[0]!,
          relation: 'current',
          content: 'submonitorId=submonitor-a eventId=event-a submonitorId=submonitor-b',
        }],
      },
    }));
    await mirror.onIdle();

    const body = JSON.parse(String(fetchMock.mock.calls[0]![1].body));
    expect(body).not.toHaveProperty('incidentKey');
  });

  it('keeps one incident key when the same complete pair is repeated across candidates', async () => {
    const fetchMock = vi.fn(async () => new Response('', { status: 202 }));
    const mirror = new RcaShadowMirror(config(), { fetchImpl: fetchMock as any });
    const repeatedPair = 'Kepler submonitorId=submonitor-same&eventId=event-same';
    mirror.submit(turn({
      preparedInput: { content: repeatedPair },
      sourceSnapshot: {
        ...capturedSnapshot,
        timeline: [
          { ...capturedSnapshot.timeline[0]!, relation: 'current', content: repeatedPair },
          { ...capturedSnapshot.timeline[0]!, referenceKey: 'opaque-recent', relation: 'recent', content: repeatedPair },
        ],
      },
    }));
    await mirror.onIdle();

    const body = JSON.parse(String(fetchMock.mock.calls[0]![1].body));
    expect(body.incidentKey).toMatch(/^[a-f0-9]{64}$/);
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

  it('posts the online runtime final answer through the same opaque turn identity', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ accepted: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));

    await deliverRcaChampionResult({
      larkAppId: 'app_rca',
      sessionId: 'botmux-private-session',
      turnId: 'lark-private-message',
      result: 'online production conclusion',
      runtime: { cliId: 'coco', model: 'online-model' },
    }, config(), fetchMock as any);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://rca.internal:7310/api/mirrors/champions');
    const body = JSON.parse(String(init.body));
    expect(body.result).toBe('online production conclusion');
    expect(body.runtime).toEqual({ cliId: 'coco', model: 'online-model' });
    expect(body.correlationKey).toMatch(/^[a-f0-9]{64}$/);
    expect(body.turnKey).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(body)).not.toContain('botmux-private-session');
    expect(JSON.stringify(body)).not.toContain('lark-private-message');
  });

  it('captures final_output for Champion diff before forwarding it to the original alarm group', () => {
    const source = readFileSync(
      new URL('../src/core/worker-pool.ts', import.meta.url),
      'utf8',
    );
    const finalOutput = source.slice(
      source.indexOf("case 'final_output':"),
      source.indexOf("case 'adopt_preamble':"),
    );
    expect(finalOutput).toContain('mirrorChampionResult({');
    expect(finalOutput.indexOf('mirrorChampionResult({')).toBeLessThan(
      finalOutput.indexOf('deliverFinalOutput(ds, msg, t, 0)'),
    );
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
