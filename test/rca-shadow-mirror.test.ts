import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  RcaShadowMirror,
  rcaShadowMirrorConfigFromEnv,
  type RcaShadowMirrorConfig,
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
    preparedInput: { content: '<user_message>argos panic</user_message>' },
    ...overrides,
  };
}

describe('RCA shadow mirror', () => {
  it('is disabled unless URL, token, and explicit bot allowlist are all present', () => {
    const parsed = rcaShadowMirrorConfigFromEnv({});
    const mirror = new RcaShadowMirror(parsed, { fetchImpl: vi.fn() as any });
    expect(mirror.submit(turn())).toBe('disabled');
  });

  it('sends opaque correlation fields and the exact prepared input', async () => {
    const fetchMock = vi.fn(async () => new Response('', { status: 202 }));
    const mirror = new RcaShadowMirror(config(), { fetchImpl: fetchMock as any });
    expect(mirror.submit(turn())).toBe('queued');
    await mirror.onIdle();

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://rca.internal:7310/api/mirrors/turns');
    const body = JSON.parse(String(init.body));
    expect(body.preparedInput.content).toBe('<user_message>argos panic</user_message>');
    expect(body.signalSource).toBe('argos');
    expect(JSON.stringify(body)).not.toContain('botmux-private-session');
    expect(JSON.stringify(body)).not.toContain('lark-private-message');
    expect(JSON.stringify(body)).not.toContain('lark-private-topic');
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
  });
});
