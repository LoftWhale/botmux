/**
 * Inbound-webhook idempotency (duplicate-delivery suppression).
 *
 * The scenario these tests encode is a real production report: an at-least-once
 * upstream (EventHub) re-POSTed the SAME Codebase event ~33.5s later; both
 * deliveries were dispatched and each opened its own CLI session. The upstream
 * already sends a unique id in `x-idempotency-key`; botmux ignored it.
 */
import { createHmac } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConnectorDefinition } from '../src/services/connector-store.js';

let server: Server | null = null;
let baseUrl = '';
let dataDir = '';
let prevDataDir: string | undefined;
let proxyToDaemon: any;

/** Every dispatch gets a distinct triggerId so a test can prove a suppressed
 *  retry echoes the FIRST delivery's id rather than a freshly minted one. */
let dispatchCount = 0;

async function startWebhookServer(): Promise<void> {
  vi.resetModules();
  const { handleWebhookRoute } = await import('../src/dashboard/webhook-routes.js');
  const { __testOnly_resetWebhookIdempotency } = await import('../src/services/webhook-idempotency.js');
  __testOnly_resetWebhookIdempotency();
  dispatchCount = 0;
  proxyToDaemon = vi.fn(async () => ({
    status: 200,
    text: async () => JSON.stringify({
      ok: true,
      triggerId: `trg_${++dispatchCount}`,
      action: 'queued',
      target: { kind: 'turn', chatId: 'oc_fixed' },
    }),
  }));
  server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
    if (await handleWebhookRoute(req, res, url, {
      proxyToDaemon,
      createLifecycleGroup: async () => ({ chatId: 'oc_created' }),
    })) return;
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not_found' }));
  });
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('bad test server address');
  baseUrl = `http://127.0.0.1:${addr.port}`;
}

/** Token-mode connector on the FIXED-group path — exactly the shape from the
 *  report (`verify.type=token`, `target.mode=fixed`, no lifecycle dedup). */
async function seedConnector(
  overrides: Partial<ConnectorDefinition> = {},
  id = 'conn_idem',
): Promise<ConnectorDefinition> {
  const { createWebhookSecret } = await import('../src/services/webhook-key.js');
  const { upsertConnector } = await import('../src/services/connector-store.js');
  const secret = createWebhookSecret('tok_secret_value');
  return upsertConnector({
    id,
    name: 'Codebase MR review',
    enabled: true,
    verify: {
      type: 'token',
      secretRef: secret.ref,
      signatureHeader: 'x-botmux-signature',
      timestampHeader: 'x-botmux-timestamp',
      nonceHeader: 'x-botmux-nonce',
      toleranceSeconds: 300,
    },
    target: { mode: 'fixed', kind: 'turn', botId: 'app1', chatId: 'oc_fixed' },
    promptEnvelope: { sourceName: 'codebase', headerAllowlist: [], includeRawText: false, maxBodyBytes: 4096 },
    loggingPolicy: { storePayload: false, storeHeaders: false, retentionDays: 14 },
    lifecycleExtractors: null,
    createdAt: '2026-08-20T00:00:00.000Z',
    updatedAt: '2026-08-20T00:00:00.000Z',
    ...overrides,
  });
}

async function post(
  connectorId: string,
  body: unknown,
  headers: Record<string, string> = {},
  query = '',
): Promise<{ status: number; body: any }> {
  const raw = typeof body === 'string' ? body : JSON.stringify(body);
  const res = await fetch(
    `${baseUrl}/webhook/${encodeURIComponent(connectorId)}/tok_secret_value${query}`,
    { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: raw },
  );
  return { status: res.status, body: await res.json() };
}

const MR_EVENT = {
  event: 'merge_request',
  object_attributes: { iid: 2227, title: 'fix: something', state: 'opened' },
};

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'botmux-webhook-idem-'));
  prevDataDir = process.env.SESSION_DATA_DIR;
  process.env.SESSION_DATA_DIR = dataDir;
  await startWebhookServer();
});

afterEach(async () => {
  if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
  server = null;
  if (prevDataDir === undefined) delete process.env.SESSION_DATA_DIR;
  else process.env.SESSION_DATA_DIR = prevDataDir;
  vi.restoreAllMocks();
});

describe('inbound webhook idempotency', () => {
  it('suppresses a re-delivered event carrying the same x-idempotency-key (the reported bug)', async () => {
    await seedConnector();
    const key = { 'x-idempotency-key': 'rec_1787211053887175595_2228_aedff72c' };

    const first = await post('conn_idem', MR_EVENT, key);
    const retry = await post('conn_idem', MR_EVENT, key);

    // First delivery dispatches and says so.
    expect(first.status).toBe(200);
    expect(first.body.action).toBe('queued');
    expect(first.body.idempotency).toEqual({ key: 'rec_1787211053887175595_2228_aedff72c', action: 'accepted' });

    // The retry is collapsed: 2xx (an at-least-once sender must not keep
    // retrying), no new dispatch, and it points at the turn that really ran.
    expect(retry.status).toBe(200);
    expect(retry.body.ok).toBe(true);
    expect(retry.body.action).toBe('ignored');
    expect(retry.body.idempotency).toMatchObject({ action: 'duplicate', firstTriggerId: 'trg_1' });

    // The whole point: exactly ONE session was created, not two.
    expect(proxyToDaemon).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['x-botmux-idempotency-key', 'botmux control-plane spelling'],
    ['idempotency-key', 'IETF draft / Stripe spelling'],
    ['x-idempotency-key', 'the header EventHub sends today'],
  ])('honours %s (%s)', async header => {
    await seedConnector();
    await post('conn_idem', MR_EVENT, { [header]: 'evt_same' });
    const retry = await post('conn_idem', MR_EVENT, { [header]: 'evt_same' });
    expect(retry.body.action).toBe('ignored');
    expect(proxyToDaemon).toHaveBeenCalledTimes(1);
  });

  it('prefers the botmux-specific header when several are present', async () => {
    await seedConnector();
    const first = await post('conn_idem', MR_EVENT, {
      'x-botmux-idempotency-key': 'from_botmux',
      'idempotency-key': 'from_ietf',
      'x-idempotency-key': 'from_vendor',
    });
    expect(first.body.idempotency.key).toBe('from_botmux');
  });

  it('accepts the key from a query parameter for senders that cannot set headers', async () => {
    await seedConnector();
    await post('conn_idem', MR_EVENT, {}, '?idempotencyKey=evt_q');
    const retry = await post('conn_idem', MR_EVENT, {}, '?idempotencyKey=evt_q');
    expect(retry.body.action).toBe('ignored');
    expect(proxyToDaemon).toHaveBeenCalledTimes(1);
  });

  it('accepts the key from a configured body path', async () => {
    await seedConnector({ idempotency: { keyPath: '$.object_attributes.iid' } });
    await post('conn_idem', MR_EVENT);
    const retry = await post('conn_idem', MR_EVENT);
    expect(retry.body.action).toBe('ignored');
    expect(proxyToDaemon).toHaveBeenCalledTimes(1);
  });

  it('treats distinct keys as distinct events', async () => {
    await seedConnector();
    await post('conn_idem', MR_EVENT, { 'x-idempotency-key': 'evt_a' });
    await post('conn_idem', MR_EVENT, { 'x-idempotency-key': 'evt_b' });
    expect(proxyToDaemon).toHaveBeenCalledTimes(2);
  });

  it('changes nothing when no key is presented (existing connectors keep today\'s behaviour)', async () => {
    await seedConnector();
    const first = await post('conn_idem', MR_EVENT);
    const second = await post('conn_idem', MR_EVENT);
    expect(proxyToDaemon).toHaveBeenCalledTimes(2);
    expect(first.body.idempotency).toBeUndefined();
    expect(second.body.idempotency).toBeUndefined();
  });

  it('FAILS OPEN when the same key arrives with a different body', async () => {
    await seedConnector();
    const key = { 'x-idempotency-key': 'reused_key' };
    await post('conn_idem', MR_EVENT, key);
    const other = await post('conn_idem', { ...MR_EVENT, object_attributes: { iid: 9999 } }, key);

    // A key that is not a reliable unique id must not silently swallow what may
    // be a genuinely different production event.
    expect(other.status).toBe(200);
    expect(other.body.action).toBe('queued');
    expect(proxyToDaemon).toHaveBeenCalledTimes(2);
  });

  it('keeps the first record after a conflicting body, so the good key still dedupes', async () => {
    await seedConnector();
    const key = { 'x-idempotency-key': 'reused_key' };
    await post('conn_idem', MR_EVENT, key);
    await post('conn_idem', { junk: true }, key);      // conflict → dispatched, not stamped
    const realRetry = await post('conn_idem', MR_EVENT, key);
    expect(realRetry.body.action).toBe('ignored');
    expect(realRetry.body.idempotency.firstTriggerId).toBe('trg_1');
  });

  it('does not let a FAILED dispatch consume the key (the sender\'s retry must still work)', async () => {
    await seedConnector();
    proxyToDaemon.mockImplementationOnce(async () => ({
      status: 502,
      text: async () => JSON.stringify({ ok: false, errorCode: 'daemon_offline', error: 'daemon offline' }),
    }));
    const key = { 'x-idempotency-key': 'evt_retry_after_failure' };

    const failed = await post('conn_idem', MR_EVENT, key);
    expect(failed.body.ok).toBe(false);

    // at-least-once retry after a failure is the recovery path — it must run.
    const retry = await post('conn_idem', MR_EVENT, key);
    expect(retry.body.ok).toBe(true);
    expect(retry.body.action).toBe('queued');
    expect(proxyToDaemon).toHaveBeenCalledTimes(2);
  });

  it('does not let an unauthenticated request burn the key', async () => {
    await seedConnector();
    const raw = JSON.stringify(MR_EVENT);
    const bad = await fetch(`${baseUrl}/webhook/conn_idem/WRONG_TOKEN`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-idempotency-key': 'evt_auth' },
      body: raw,
    });
    expect(bad.status).toBe(401);

    const good = await post('conn_idem', MR_EVENT, { 'x-idempotency-key': 'evt_auth' });
    expect(good.body.action).toBe('queued');
    expect(proxyToDaemon).toHaveBeenCalledTimes(1);
  });

  it('does not let a dryRun consume the key', async () => {
    await seedConnector();
    const key = { 'x-idempotency-key': 'evt_dry' };
    await post('conn_idem', MR_EVENT, key, '?dryRun=1');
    const real = await post('conn_idem', MR_EVENT, key);
    expect(real.body.action).toBe('queued');
  });

  it('scopes keys per connector so two upstreams cannot collide', async () => {
    await seedConnector({}, 'conn_a');
    await seedConnector({}, 'conn_b');
    await post('conn_a', MR_EVENT, { 'x-idempotency-key': 'shared_id' });
    const onB = await post('conn_b', MR_EVENT, { 'x-idempotency-key': 'shared_id' });
    expect(onB.body.action).toBe('queued');
    expect(proxyToDaemon).toHaveBeenCalledTimes(2);
  });

  it('can be disabled per connector for an upstream that reuses ids', async () => {
    await seedConnector({ idempotency: { disabled: true } });
    const key = { 'x-idempotency-key': 'evt_same' };
    await post('conn_idem', MR_EVENT, key);
    const retry = await post('conn_idem', MR_EVENT, key);
    expect(retry.body.action).toBe('queued');
    expect(retry.body.idempotency).toBeUndefined();
    expect(proxyToDaemon).toHaveBeenCalledTimes(2);
  });

  it('suppresses duplicates on the new-group path too (no second group is created)', async () => {
    const createLifecycleGroup = vi.fn(async () => ({ chatId: 'oc_created' }));
    if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
    vi.resetModules();
    const { handleWebhookRoute } = await import('../src/dashboard/webhook-routes.js');
    const { __testOnly_resetWebhookIdempotency } = await import('../src/services/webhook-idempotency.js');
    __testOnly_resetWebhookIdempotency();
    dispatchCount = 0;
    proxyToDaemon = vi.fn(async () => ({
      status: 200,
      text: async () => JSON.stringify({ ok: true, triggerId: `trg_${++dispatchCount}`, action: 'queued' }),
    }));
    server = createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
      if (await handleWebhookRoute(req, res, url, { proxyToDaemon, createLifecycleGroup })) return;
      res.writeHead(404).end();
    });
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
    const addr = server.address() as any;
    baseUrl = `http://127.0.0.1:${addr.port}`;

    await seedConnector({ target: { mode: 'new-group', kind: 'turn', botId: 'app1' } }, 'conn_ng');
    const key = { 'x-idempotency-key': 'evt_ng' };
    await post('conn_ng', MR_EVENT, key);
    const retry = await post('conn_ng', MR_EVENT, key);

    expect(retry.body.action).toBe('ignored');
    expect(createLifecycleGroup).toHaveBeenCalledTimes(1);
    expect(proxyToDaemon).toHaveBeenCalledTimes(1);
  });

  it('ignores an over-long key instead of trusting a truncated one', async () => {
    await seedConnector();
    const huge = { 'x-idempotency-key': 'x'.repeat(201) };
    await post('conn_idem', MR_EVENT, huge);
    const retry = await post('conn_idem', MR_EVENT, huge);
    expect(retry.body.action).toBe('queued');
    expect(proxyToDaemon).toHaveBeenCalledTimes(2);
  });

  it('collapses CONCURRENT duplicates that overlap while the first is still in flight', async () => {
    await seedConnector();
    // A slow dispatch is the very condition that makes an upstream time out and
    // retry — so the retry OVERLAPS the original rather than following it.
    proxyToDaemon.mockImplementation(async () => {
      await new Promise(r => setTimeout(r, 150));
      return {
        status: 200,
        text: async () => JSON.stringify({ ok: true, triggerId: `trg_${++dispatchCount}`, action: 'queued' }),
      };
    });
    const key = { 'x-idempotency-key': 'evt_concurrent' };

    const [a, b] = await Promise.all([
      post('conn_idem', MR_EVENT, key),
      post('conn_idem', MR_EVENT, key),
    ]);

    const actions = [a.body.action, b.body.action].sort();
    expect(actions).toEqual(['ignored', 'queued']);
    expect(proxyToDaemon).toHaveBeenCalledTimes(1);
  });

  it('still dedupes after a successful dispatch settles (reservation is not released by response close)', async () => {
    await seedConnector();
    const key = { 'x-idempotency-key': 'evt_settle' };
    const first = await post('conn_idem', MR_EVENT, key);
    expect(first.body.action).toBe('queued');
    // Give the response 'close' hook a chance to run before retrying — a naive
    // release-on-close would have dropped the record here.
    await new Promise(r => setTimeout(r, 50));
    const retry = await post('conn_idem', MR_EVENT, key);
    expect(retry.body.action).toBe('ignored');
    expect(retry.body.idempotency.firstTriggerId).toBe('trg_1');
    expect(proxyToDaemon).toHaveBeenCalledTimes(1);
  });

  it('releases the reservation when the request never reaches dispatch (bad target)', async () => {
    // A dynamic-mode connector with no chatId fails AFTER the key was reserved.
    await seedConnector({ target: { mode: 'dynamic', kind: 'turn', botId: 'app1' } }, 'conn_dyn');
    const key = { 'x-idempotency-key': 'evt_no_target' };

    const failed = await post('conn_dyn', MR_EVENT, key);
    expect(failed.status).toBe(400);
    await new Promise(r => setTimeout(r, 50));

    // The sender fixes the call and retries the SAME event: it must run, not be
    // swallowed as a "duplicate" of a delivery that never happened.
    const fixed = await post('conn_dyn', MR_EVENT, key, '?chatId=oc_target');
    expect(fixed.body.action).toBe('queued');
    expect(proxyToDaemon).toHaveBeenCalledTimes(1);
  });
  it('does not release the reservation when the CLIENT ABORTS mid-dispatch', async () => {
    // The upstream aborting on timeout is the very thing that provokes the retry
    // this feature collapses — and 'close' fires on abort while the dispatch is
    // still in flight. Releasing there made the retry dispatch a SECOND time.
    await seedConnector();
    proxyToDaemon.mockImplementation(async () => {
      await new Promise(r => setTimeout(r, 400));
      return {
        status: 200,
        text: async () => JSON.stringify({ ok: true, triggerId: `trg_${++dispatchCount}`, action: 'queued' }),
      };
    });
    const headers = { 'content-type': 'application/json', 'x-idempotency-key': 'evt_abort' };
    const raw = JSON.stringify(MR_EVENT);

    const ac = new AbortController();
    const inflight = fetch(`${baseUrl}/webhook/conn_idem/tok_secret_value`, {
      method: 'POST', headers, body: raw, signal: ac.signal,
    }).catch(() => null);
    setTimeout(() => ac.abort(), 80);
    await inflight;
    // Let the abandoned dispatch finish and any close handler run.
    await new Promise(r => setTimeout(r, 600));
    expect(proxyToDaemon).toHaveBeenCalledTimes(1);   // the turn really ran

    // The sender believes delivery failed and retries the same event: it must be
    // recognised as a duplicate of the turn that is already running/ran.
    const retry = await post('conn_idem', MR_EVENT, { 'x-idempotency-key': 'evt_abort' });
    expect(retry.body.action).toBe('ignored');
    expect(proxyToDaemon).toHaveBeenCalledTimes(1);
  });
});

/**
 * Store-level tests with INJECTED time. The route-level suite above cannot reach
 * these branches: they only trigger after the 10-minute TTL or under the 10k
 * entry cap, neither of which an HTTP test can drive.
 */
describe('webhook idempotency store (time-dependent branches)', () => {
  const body = Buffer.from('{"evt":"mr","iid":2227}');

  it('forgets a settled key once its TTL elapses', async () => {
    const store = await import('../src/services/webhook-idempotency.js');
    store.__testOnly_resetWebhookIdempotency();
    const t0 = 1_000_000;
    expect(store.inspectWebhookIdempotency('c', 'k', body, t0).kind).toBe('first');
    store.settleWebhookIdempotency('c', 'k', 'trg_1', t0);
    expect(store.inspectWebhookIdempotency('c', 'k', body, t0 + 1000).kind).toBe('duplicate');
    // Past the window the sender is entitled to a fresh delivery again.
    expect(
      store.inspectWebhookIdempotency('c', 'k', body, t0 + store.WEBHOOK_IDEMPOTENCY_TTL_MS + 1).kind,
    ).toBe('first');
  });

  it('never evicts an IN-FLIGHT reservation while it could still be a live dispatch', async () => {
    const store = await import('../src/services/webhook-idempotency.js');
    store.__testOnly_resetWebhookIdempotency();
    const t0 = 1_000_000;
    expect(store.inspectWebhookIdempotency('c', 'k', body, t0).kind).toBe('first');
    // A slow-but-legitimate dispatch: the trigger API caps timeoutMs at 300s, so
    // anything inside the 600s window may still be running and must be shielded.
    expect(store.inspectWebhookIdempotency('c', 'k', body, t0 + 300_000).kind).toBe('duplicate');
    expect(store.inspectWebhookIdempotency('c', 'k', body, t0 + 599_000).kind).toBe('duplicate');
  });

  it('reclaims a reservation whose dispatch never settled, instead of wedging the key forever', async () => {
    const store = await import('../src/services/webhook-idempotency.js');
    store.__testOnly_resetWebhookIdempotency();
    const t0 = 1_000_000;
    store.inspectWebhookIdempotency('c', 'k', body, t0);   // reserved, never settled
    // Past the window no live dispatch can still own it (max dispatch 300s < TTL
    // 600s). Holding it forever would permanently swallow every retry of this
    // event — the exact event loss this module refuses everywhere else.
    expect(
      store.inspectWebhookIdempotency('c', 'k', body, t0 + store.WEBHOOK_IDEMPOTENCY_TTL_MS + 1).kind,
    ).toBe('first');
  });

  it('does not let an alert storm preempt an in-flight reservation via the size cap', async () => {
    const store = await import('../src/services/webhook-idempotency.js');
    store.__testOnly_resetWebhookIdempotency();
    const t0 = 1_000_000;
    // Volume is not evidence that a dispatch finished, so pressure-based eviction
    // must skip in-flight entries (otherwise a storm reopens double-dispatch).
    expect(store.inspectWebhookIdempotency('c', 'held', body, t0).kind).toBe('first');
    for (let i = 0; i < store.WEBHOOK_IDEMPOTENCY_MAX_ENTRIES + 50; i++) {
      store.inspectWebhookIdempotency('c', `k${i}`, body, t0);
      store.settleWebhookIdempotency('c', `k${i}`, `trg_${i}`, t0);
    }
    expect(store.inspectWebhookIdempotency('c', 'held', body, t0).kind).toBe('duplicate');
  });

  it('enforces the entry cap without evicting in-flight reservations', async () => {
    const store = await import('../src/services/webhook-idempotency.js');
    store.__testOnly_resetWebhookIdempotency();
    const t0 = 1_000_000;
    // One in-flight reservation, then flood past the cap with settled entries.
    expect(store.inspectWebhookIdempotency('c', 'held', body, t0).kind).toBe('first');
    for (let i = 0; i < store.WEBHOOK_IDEMPOTENCY_MAX_ENTRIES + 50; i++) {
      store.inspectWebhookIdempotency('c', `k${i}`, body, t0);
      store.settleWebhookIdempotency('c', `k${i}`, `trg_${i}`, t0);
    }
    // The protected reservation survived the flood.
    expect(store.inspectWebhookIdempotency('c', 'held', body, t0).kind).toBe('duplicate');
  });

  it('a settled key survives a later settle call (settle is idempotent)', async () => {
    const store = await import('../src/services/webhook-idempotency.js');
    store.__testOnly_resetWebhookIdempotency();
    const t0 = 1_000_000;
    store.inspectWebhookIdempotency('c', 'k', body, t0);
    store.settleWebhookIdempotency('c', 'k', 'trg_1', t0);
    // The route's response-close hook fires a release AFTER a successful commit;
    // it must be a no-op rather than dropping the dedup record.
    store.settleWebhookIdempotency('c', 'k', undefined, t0);
    const hit = store.inspectWebhookIdempotency('c', 'k', body, t0);
    expect(hit.kind).toBe('duplicate');
    expect(hit.kind === 'duplicate' && hit.firstTriggerId).toBe('trg_1');
  });
});
