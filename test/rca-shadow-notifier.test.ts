import { describe, expect, it, vi } from 'vitest';
import {
  buildRcaShadowCard,
  RcaShadowNotifier,
} from '../src/services/rca-shadow-notifier.js';

describe('RCA shadow topic notifier', () => {
  it('builds one concise A/B card without inventing a Champion conclusion', () => {
    const card = buildRcaShadowCard({
      event: { id: 'event-1', title: 'panic' },
      run: {
        status: 'completed',
        firstTurn: { response: '候选结论与证据' },
      },
    }, 'http://rca/events/event-1');
    const text = JSON.stringify(card);
    expect(text).toContain('方案 A');
    expect(text).toContain('当前版结论保留在原报警话题');
    expect(text).toContain('候选结论与证据');
    expect(text).toContain('http://rca/events/event-1');
  });

  it('polls a public Event id and sends exactly one top-level topic card', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      event: { id: 'event-1', title: 'panic' },
      run: { status: 'completed', firstTurn: { response: 'candidate result' } },
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const sendCard = vi.fn(async () => 'om_shadow_root');
    const notifier = new RcaShadowNotifier({
      rcaUrl: 'http://rca.internal:7310',
      token: 'token',
      chatId: 'oc_shadow',
      pollIntervalMs: 1,
      pollTimeoutMs: 100,
    }, { fetchImpl, sendCard, log: { warn: vi.fn() } });

    notifier.start('event-1', 'app_rca', 'event-view-key');
    notifier.start('event-1', 'app_rca', 'event-view-key');
    await notifier.onIdle();
    notifier.start('event-1', 'app_rca', 'event-view-key');
    await notifier.onIdle();

    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(sendCard).toHaveBeenCalledOnce();
    expect(sendCard).toHaveBeenCalledWith(
      'app_rca',
      'oc_shadow',
      expect.stringMatching(/candidate result.*event-view-key/s),
      'interactive',
      'search-rca-event-1',
    );
  });

  it('contains delivery failures and leaves the current RCA path untouched', async () => {
    const log = { warn: vi.fn() };
    const notifier = new RcaShadowNotifier({
      rcaUrl: 'http://rca.internal:7310',
      token: 'token',
      chatId: 'oc_shadow',
      pollIntervalMs: 1,
      pollTimeoutMs: 100,
    }, {
      fetchImpl: vi.fn(async () => new Response('', { status: 503 })) as any,
      sendCard: vi.fn(),
      log,
    });
    expect(() => notifier.start('event-2', 'app_rca')).not.toThrow();
    await notifier.onIdle();
    expect(log.warn).toHaveBeenCalled();
  });
});
