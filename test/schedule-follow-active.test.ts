/**
 * schedule-follow-active.test.ts
 *
 * `botmux schedule add --follow-active`: at fire time the task re-targets to the
 * topic in its chat where a HUMAN most recently spoke.
 *
 *  - pickMostRecentHumanTopic: newest lastHumanMessageAt wins; chat-scope rows,
 *    rows without a root, rows from other chats and rows with only bot activity
 *    (no lastHumanMessageAt) are ignored
 *  - resolveFollowActiveRoot: falls back to the retained root when nothing
 *    qualifies or the lookup throws; never invents a topic
 *  - applyFollowActive: no-op for non-follow tasks and for tasks parked away
 *    from topic execution; persists the landing point only when it changes;
 *    a failing persist does not block the fire
 *  - default deps reach the cross-bot session-store lookup and schedule-store
 *    (stubbed here)
 *  - markSessionActivity({ human: true }) stamps lastHumanMessageAt; a bot
 *    turn advances lastMessageAt only
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ScheduledTask, Session } from '../src/types.js';
import type { DaemonSession } from '../src/core/types.js';

const findActiveThreadSessionsByChat = vi.fn<(chatId: string) => Session[]>(() => []);
const updateSession = vi.fn();
vi.mock('../src/services/session-store.js', () => ({
  findActiveThreadSessionsByChat: (...a: any[]) => findActiveThreadSessionsByChat(...(a as [string])),
  updateSession: (...a: any[]) => updateSession(...a),
}));

const storeUpdateTask = vi.fn();
vi.mock('../src/services/schedule-store.js', () => ({
  updateTask: (...a: any[]) => storeUpdateTask(...a),
}));

vi.mock('../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const publish = vi.fn();
vi.mock('../src/core/dashboard-events.js', () => ({ dashboardEventBus: { publish: (...a: any[]) => publish(...a) } }));
vi.mock('../src/core/dashboard-rows.js', () => ({ composeRowFromActive: vi.fn(() => ({})) }));
vi.mock('../src/core/session-message-preview.js', () => ({ buildSessionMessagePreview: vi.fn(() => undefined) }));

const { pickMostRecentHumanTopic, resolveFollowActiveRoot, applyFollowActive } = await import('../src/core/schedule-follow-active.js');
const { markSessionActivity, stampHumanActivity } = await import('../src/core/session-activity.js');

const CHAT = 'oc_chat_A';
const OTHER_CHAT = 'oc_chat_B';

function session(overrides: Partial<Session> & { rootMessageId?: string }): Session {
  return {
    sessionId: `s-${overrides.rootMessageId ?? 'x'}-${Math.random().toString(36).slice(2, 6)}`,
    chatId: CHAT,
    title: 't',
    status: 'active',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  } as Session;
}

function task(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: 'task-1',
    name: 'sentinel',
    schedule: 'every 30m',
    prompt: 'check',
    workingDir: '/w',
    chatId: CHAT,
    rootMessageId: 'om_origin',
    scope: 'thread',
    executionPosition: 'topic',
    larkAppId: 'cli_app_1',
    enabled: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    followActive: true,
    ...overrides,
  } as ScheduledTask;
}

beforeEach(() => {
  findActiveThreadSessionsByChat.mockReset();
  findActiveThreadSessionsByChat.mockImplementation(() => []);
  storeUpdateTask.mockReset();
  updateSession.mockReset();
  publish.mockReset();
});

describe('pickMostRecentHumanTopic', () => {
  it('picks the root with the newest human activity', () => {
    const root = pickMostRecentHumanTopic(CHAT, [
      session({ rootMessageId: 'om_old', lastHumanMessageAt: '2026-01-01T10:00:00.000Z' }),
      session({ rootMessageId: 'om_new', lastHumanMessageAt: '2026-01-01T12:00:00.000Z' }),
      session({ rootMessageId: 'om_mid', lastHumanMessageAt: '2026-01-01T11:00:00.000Z' }),
    ]);
    expect(root).toBe('om_new');
  });

  it('ignores bot-only activity: lastMessageAt alone never qualifies a topic', () => {
    // The sentinel's own topic was just written by the bot (lastMessageAt is
    // the newest of all) but no human has spoken there.
    const root = pickMostRecentHumanTopic(CHAT, [
      session({ rootMessageId: 'om_bot_only', lastMessageAt: '2026-01-01T23:00:00.000Z' }),
      session({ rootMessageId: 'om_human', lastMessageAt: '2026-01-01T09:00:00.000Z', lastHumanMessageAt: '2026-01-01T09:00:00.000Z' }),
    ]);
    expect(root).toBe('om_human');
  });

  it('ignores chat-scope rows, other chats, missing roots and roots equal to the chat id', () => {
    const root = pickMostRecentHumanTopic(CHAT, [
      session({ rootMessageId: 'om_chat_scope', scope: 'chat', lastHumanMessageAt: '2026-01-01T23:00:00.000Z' }),
      session({ chatId: OTHER_CHAT, rootMessageId: 'om_elsewhere', lastHumanMessageAt: '2026-01-01T22:00:00.000Z' }),
      session({ rootMessageId: CHAT, lastHumanMessageAt: '2026-01-01T21:00:00.000Z' }),
      session({ rootMessageId: undefined, lastHumanMessageAt: '2026-01-01T20:00:00.000Z' }),
      session({ rootMessageId: 'om_bad_ts', lastHumanMessageAt: 'not-a-date' }),
      session({ rootMessageId: 'om_ok', lastHumanMessageAt: '2026-01-01T01:00:00.000Z' }),
    ]);
    expect(root).toBe('om_ok');
  });

  it('returns undefined when no candidate has human activity', () => {
    expect(pickMostRecentHumanTopic(CHAT, [])).toBeUndefined();
    expect(pickMostRecentHumanTopic(CHAT, [session({ rootMessageId: 'om_x' })])).toBeUndefined();
  });
});

describe('resolveFollowActiveRoot', () => {
  it('keeps the retained root when nothing qualifies — never a new topic', () => {
    const r = resolveFollowActiveRoot({ chatId: CHAT, rootMessageId: 'om_origin' }, () => []);
    expect(r).toEqual({ rootMessageId: 'om_origin', source: 'retained' });
  });

  it('keeps the retained root when the lookup throws', () => {
    const r = resolveFollowActiveRoot({ chatId: CHAT, rootMessageId: 'om_origin' }, () => { throw new Error('sqlite unavailable'); });
    expect(r).toEqual({ rootMessageId: 'om_origin', source: 'retained' });
  });

  it('reports the active topic when one qualifies', () => {
    const r = resolveFollowActiveRoot({ chatId: CHAT, rootMessageId: 'om_origin' }, () => [
      session({ rootMessageId: 'om_live', lastHumanMessageAt: '2026-01-01T12:00:00.000Z' }),
    ]);
    expect(r).toEqual({ rootMessageId: 'om_live', source: 'active' });
  });
});

describe('applyFollowActive', () => {
  it('returns the task untouched when followActive is not set', () => {
    const persist = vi.fn();
    const t = task({ followActive: undefined });
    expect(applyFollowActive(t, { listCandidates: () => [session({ rootMessageId: 'om_live', lastHumanMessageAt: '2026-01-01T12:00:00.000Z' })], persist })).toBe(t);
    expect(persist).not.toHaveBeenCalled();
  });

  it('leaves tasks parked at top-level / new-topic alone even if the flag is still set', () => {
    const persist = vi.fn();
    const list = () => [session({ rootMessageId: 'om_live', lastHumanMessageAt: '2026-01-01T12:00:00.000Z' })];
    for (const executionPosition of ['top-level', 'new-topic'] as const) {
      const t = task({ executionPosition, scope: 'chat', rootMessageId: undefined });
      expect(applyFollowActive(t, { listCandidates: list, persist })).toBe(t);
    }
    expect(persist).not.toHaveBeenCalled();
  });

  it('re-targets to the human-active topic and persists the new landing point (with the task appId)', () => {
    const persist = vi.fn();
    const out = applyFollowActive(task(), {
      listCandidates: () => [
        session({ rootMessageId: 'om_origin', lastHumanMessageAt: '2026-01-01T08:00:00.000Z' }),
        session({ rootMessageId: 'om_live', lastHumanMessageAt: '2026-01-01T12:00:00.000Z' }),
      ],
      persist,
    });
    expect(out.rootMessageId).toBe('om_live');
    expect(out.scope).toBe('thread');
    expect(persist).toHaveBeenCalledTimes(1);
    expect(persist).toHaveBeenCalledWith('task-1', 'om_live', 'cli_app_1');
  });

  it('does not persist when the active topic is already the retained one', () => {
    const persist = vi.fn();
    const t = task();
    const out = applyFollowActive(t, {
      listCandidates: () => [session({ rootMessageId: 'om_origin', lastHumanMessageAt: '2026-01-01T12:00:00.000Z' })],
      persist,
    });
    expect(out).toBe(t);
    expect(persist).not.toHaveBeenCalled();
  });

  it('falls back to the retained root on an empty lookup without persisting', () => {
    const persist = vi.fn();
    const t = task();
    expect(applyFollowActive(t, { listCandidates: () => [], persist })).toBe(t);
    expect(persist).not.toHaveBeenCalled();
  });

  it('still fires into the resolved topic when persisting fails', () => {
    const out = applyFollowActive(task(), {
      listCandidates: () => [session({ rootMessageId: 'om_live', lastHumanMessageAt: '2026-01-01T12:00:00.000Z' })],
      persist: () => { throw new Error('disk full'); },
    });
    expect(out.rootMessageId).toBe('om_live');
  });

  it('by default reads candidates across bots via session-store and persists via schedule-store', () => {
    findActiveThreadSessionsByChat.mockImplementation(() => [
      session({ rootMessageId: 'om_other_bot_topic', lastHumanMessageAt: '2026-01-01T12:00:00.000Z' }),
    ]);
    const out = applyFollowActive(task());
    expect(findActiveThreadSessionsByChat).toHaveBeenCalledWith(CHAT);
    expect(out.rootMessageId).toBe('om_other_bot_topic');
    expect(storeUpdateTask).toHaveBeenCalledWith('task-1', { rootMessageId: 'om_other_bot_topic' }, 'cli_app_1');
  });
});

describe('human activity clock', () => {
  function ds(): DaemonSession {
    const s = session({ rootMessageId: 'om_r', lastMessageAt: '2026-01-01T00:00:00.000Z' });
    return { session: s, lastMessageAt: 0 } as unknown as DaemonSession;
  }

  it('a human turn stamps both clocks; a bot turn only the generic one', () => {
    const human = ds();
    markSessionActivity(human, Date.parse('2026-01-01T10:00:00.000Z'), { human: true });
    expect(human.session.lastMessageAt).toBe('2026-01-01T10:00:00.000Z');
    expect(human.session.lastHumanMessageAt).toBe('2026-01-01T10:00:00.000Z');
    expect(human.lastHumanMessageAt).toBe(Date.parse('2026-01-01T10:00:00.000Z'));

    const bot = ds();
    markSessionActivity(bot, Date.parse('2026-01-01T11:00:00.000Z'));
    expect(bot.session.lastMessageAt).toBe('2026-01-01T11:00:00.000Z');
    expect(bot.session.lastHumanMessageAt).toBeUndefined();
    expect(bot.lastHumanMessageAt).toBeUndefined();
    expect(updateSession).toHaveBeenCalledTimes(2);
  });

  it('a later bot turn does not move the human clock', () => {
    const d = ds();
    markSessionActivity(d, Date.parse('2026-01-01T10:00:00.000Z'), { human: true });
    markSessionActivity(d, Date.parse('2026-01-01T12:00:00.000Z'), { human: false });
    expect(d.session.lastMessageAt).toBe('2026-01-01T12:00:00.000Z');
    expect(d.session.lastHumanMessageAt).toBe('2026-01-01T10:00:00.000Z');
  });

  it('stampHumanActivity seeds the human clock on a freshly created session', () => {
    const s = session({ rootMessageId: 'om_r' });
    stampHumanActivity(s, Date.parse('2026-01-01T09:30:00.000Z'));
    expect(s.lastHumanMessageAt).toBe('2026-01-01T09:30:00.000Z');
  });
});
