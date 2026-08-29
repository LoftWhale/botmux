/**
 * Regression net for the inbound-webhook idempotency invariants that PR #1086's
 * own suite leaves uncovered. Each case here was written against a specific
 * mutation of the shipped code and verified to go red under it — the four areas
 * are the ones a re-review flagged as highest risk:
 *
 *  1. singleflight join: `aborted` must NOT fall through to re-inspect
 *     (an aborted waiter taking over as owner re-opens double-dispatch).
 *  2. two-stage rate limiter: no double-charge, no unauthenticated bypass.
 *  3. `dispatchDidRun` classification: only a provably-forked turn keeps the key.
 *  4. HMAC ordering: verify-then-claim, so a bogus signature cannot burn a nonce.
 *
 * Why these live in their own file: they are invariant guards rather than feature
 * tests, and keeping the mutation each one answers next to it is what stops them
 * from being "simplified" into something that passes on broken code.
 */
import { createHmac } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let server: Server | null = null;
let baseUrl = '';
let dataDir = '';
let prevDataDir: string | undefined;
let proxyToDaemon: any;
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
      ok: true, triggerId: `trg_${++dispatchCount}`, action: 'queued',
      target: { kind: 'turn', chatId: 'oc_fixed' },
    }),
  }));
  server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
    if (await handleWebhookRoute(req, res, url, { proxyToDaemon })) return;
    res.writeHead(404).end(JSON.stringify({ error: 'not_found' }));
  });
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as any).port}`;
}

async function seedConnector(overrides: Record<string, unknown> = {}, id = 'conn_idem'): Promise<void> {
  const { createWebhookSecret } = await import('../src/services/webhook-key.js');
  const { upsertConnector } = await import('../src/services/connector-store.js');
  const secret = createWebhookSecret('tok_secret_value');
  upsertConnector({
    id, name: 'probe', enabled: true,
    verify: {
      type: 'token', secretRef: secret.ref,
      signatureHeader: 'x-botmux-signature', timestampHeader: 'x-botmux-timestamp',
      nonceHeader: 'x-botmux-nonce', toleranceSeconds: 300,
    },
    target: { mode: 'fixed', kind: 'turn', botId: 'app1', chatId: 'oc_fixed' },
    promptEnvelope: { sourceName: 'probe', headerAllowlist: [], includeRawText: false, maxBodyBytes: 4096 },
    loggingPolicy: { storePayload: false, storeHeaders: false, retentionDays: 14 },
    lifecycleExtractors: null,
    createdAt: '2026-08-20T00:00:00.000Z', updatedAt: '2026-08-20T00:00:00.000Z',
    ...overrides,
  } as any);
}

const post = (connectorId: string, body: unknown, headers: Record<string, string> = {}, query = '') => {
  const raw = typeof body === 'string' ? body : JSON.stringify(body);
  return fetch(`${baseUrl}/webhook/${encodeURIComponent(connectorId)}/tok_secret_value${query}`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: raw,
  }).then(async r => ({ status: r.status, body: await r.json() as any }));
};

const EVT = { event: 'mr', iid: 1 };

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'botmux-probe-'));
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

describe('probe 1: join aborted vs released (integration)', () => {
  it('a WAITER whose client aborts does NOT dispatch; the later retry dispatches fresh', async () => {
    // Owner A will FAIL (daemon_offline) after 300ms. Waiter B joins at 80ms and
    // its client hangs up. B must stop (aborted), not re-inspect and take over.
    // The upstream's retry C must then become the new owner and dispatch.
    // Mutation that should REDDEN this probe: drop the `aborted` early-return in
    // webhook-routes.ts so an aborted waiter falls through to re-inspect — B would
    // then take over after A fails and settle, so C would fold (ignored) instead
    // of dispatching.
    await seedConnector();
    let attempt = 0;
    proxyToDaemon.mockImplementation(async () => {
      attempt += 1;
      if (attempt === 1) {
        // A: the owner, fails after 300ms so its reservation is released.
        await new Promise(r => setTimeout(r, 300));
        return { status: 502, text: async () => JSON.stringify({ ok: false, errorCode: 'daemon_offline', error: 'down' }) };
      }
      // C (and anything else): a healthy daemon.
      return { status: 200, text: async () => JSON.stringify({ ok: true, triggerId: `trg_${++dispatchCount}`, action: 'queued' }) };
    });
    const key = { 'x-idempotency-key': 'evt_abort_waiter' };
    const first = post('conn_idem', EVT, key);          // A: owner, will fail
    await new Promise(r => setTimeout(r, 80));
    const ac = new AbortController();
    const waiter = fetch(`${baseUrl}/webhook/conn_idem/tok_secret_value`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...key },
      body: JSON.stringify(EVT), signal: ac.signal,
    }).catch(() => null);                              // B: waiter, aborts
    setTimeout(() => ac.abort(), 60);
    await waiter;
    const a = await first;
    expect(a.body.ok).toBe(false);                     // A failed
    await new Promise(r => setTimeout(r, 50));
    // C: upstream retry. A's failure released the slot; B (aborted) never took it.
    const c = await post('conn_idem', EVT, key);
    expect(c.body.action).toBe('queued');              // C dispatched, NOT folded
    // A's failed attempt + C's dispatch = 2 daemon calls; B contributed none.
    expect(proxyToDaemon).toHaveBeenCalledTimes(2);
  });
});

describe('probe 2: two-stage rate limiter', () => {
  it('charges a dispatch exactly ONCE in the dispatch bucket (no double-charge)', async () => {
    // If a single delivery were charged twice in the dispatch bucket, the 429
    // would arrive at ceil(N/2) instead of N.
    await seedConnector({ rateLimit: { windowSeconds: 60, maxRequests: 4 } });
    const key = (i: number) => ({ 'x-idempotency-key': `evt_${i}` });
    for (let i = 0; i < 4; i++) {
      const r = await post('conn_idem', EVT, key(i));
      expect([r.status, r.body.action]).toEqual([200, 'queued']);
    }
    const fifth = await post('conn_idem', EVT, key(4));
    expect([fifth.status, fifth.body.errorCode]).toEqual([429, 'rate_limited']);
    expect(proxyToDaemon).toHaveBeenCalledTimes(4);
  });

  it('a collapsed duplicate is charged admission but NOT dispatch quota', async () => {
    // After N unique dispatches exhaust the dispatch bucket, a duplicate of an
    // earlier event must still fold (200 ignored), not be refused 429.
    await seedConnector({ rateLimit: { windowSeconds: 60, maxRequests: 2 } });
    const k0 = { 'x-idempotency-key': 'evt_dup_0' };
    const k1 = { 'x-idempotency-key': 'evt_dup_1' };
    await post('conn_idem', EVT, k0);                  // dispatch 1
    await post('conn_idem', EVT, k1);                  // dispatch 2 (bucket exhausted)
    const dup = await post('conn_idem', EVT, k0);      // folded, must not be 429
    expect([dup.status, dup.body.action]).toEqual([200, 'ignored']);
    const unique = await post('conn_idem', EVT, { 'x-idempotency-key': 'evt_dup_2' });
    expect([unique.status, unique.body.errorCode]).toEqual([429, 'rate_limited']);
    expect(proxyToDaemon).toHaveBeenCalledTimes(2);
  });

  it('every POST is metered at admission, even before auth (no bypass)', async () => {
    await seedConnector({ rateLimit: { windowSeconds: 60, maxRequests: 2 } });
    const codes: number[] = [];
    for (let i = 0; i < 12; i++) {
      const r = await fetch(`${baseUrl}/webhook/conn_idem/WRONG_TOKEN`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(EVT),
      });
      codes.push(r.status);
    }
    expect(codes).toContain(401);
    expect(codes).toContain(429);                      // admission bucket (x4 = 8) engaged
    expect(proxyToDaemon).not.toHaveBeenCalled();
  });
});

describe('probe 3: dispatchDidRun enumeration', () => {
  it('classifies every errorCode in the contract', async () => {
    const { dispatchDidRun } = await import('../src/services/webhook-idempotency.js');
    // Proven ran:
    expect(dispatchDidRun({ ok: true, triggerId: 't' })).toBe(true);
    expect(dispatchDidRun({ ok: false, errorCode: 'wait_timeout', triggerId: 't' })).toBe(true);
    // wait_timeout WITHOUT a triggerId cannot be folded onto anything -> release.
    expect(dispatchDidRun({ ok: false, errorCode: 'wait_timeout' })).toBe(false);
    // Pre-dispatch / commit-unknown -> release (fail-open):
    for (const errorCode of ['daemon_offline', 'bad_request', 'target_required', 'bot_not_found',
      'trigger_failed', 'no_output', 'idempotency_conflict', 'chat_not_allowed', 'session_not_found']) {
      expect(dispatchDidRun({ ok: false, errorCode, triggerId: 't' })).toBe(false);
    }
    // trigger_failed WITH a triggerId: the turn forked then failed. Releasing is
    // the at-least-once recovery (a failed attempt is retried), NOT a silent keep.
    expect(dispatchDidRun({ ok: false, errorCode: 'trigger_failed', triggerId: 't' })).toBe(false);
  });

  it('a turn that forked then failed (trigger_failed) releases so the retry re-runs', async () => {
    await seedConnector();
    proxyToDaemon.mockImplementation(async () => ({
      status: 502,
      text: async () => JSON.stringify({ ok: false, triggerId: `trg_${++dispatchCount}`, errorCode: 'trigger_failed', error: 'cli exited 1' }),
    }));
    const key = { 'x-idempotency-key': 'evt_fork_fail' };
    const first = await post('conn_idem', EVT, key);
    expect(first.body.errorCode).toBe('trigger_failed');
    const retry = await post('conn_idem', EVT, key);
    // The retry must dispatch again (the failed attempt is recoverable), not fold.
    expect(retry.body.errorCode).toBe('trigger_failed');
    expect(proxyToDaemon).toHaveBeenCalledTimes(2);
  });
});

describe('probe 4: HMAC verify/nonce ordering', () => {
  const sign = (ts: string, raw: string) =>
    createHmac('sha256', 'hmac_secret_value').update(ts).update('.').update(raw).digest('base64url');

  async function seedHmac(): Promise<void> {
    const { createWebhookSecret } = await import('../src/services/webhook-key.js');
    const { upsertConnector } = await import('../src/services/connector-store.js');
    const secret = createWebhookSecret('hmac_secret_value');
    upsertConnector({
      id: 'conn_hmac', name: 'signed', enabled: true,
      verify: {
        type: 'hmac-sha256', secretRef: secret.ref,
        signatureHeader: 'x-botmux-signature', timestampHeader: 'x-botmux-timestamp',
        nonceHeader: 'x-botmux-nonce', toleranceSeconds: 300,
      },
      target: { mode: 'fixed', kind: 'turn', botId: 'app1', chatId: 'oc_fixed' },
      promptEnvelope: { sourceName: 'signed', headerAllowlist: [], includeRawText: false, maxBodyBytes: 99999 },
      loggingPolicy: { storePayload: false, storeHeaders: false, retentionDays: 14 },
      lifecycleExtractors: null,
      createdAt: '2026-08-20T00:00:00.000Z', updatedAt: '2026-08-20T00:00:00.000Z',
    } as any);
  }
  const sendSigned = (headers: Record<string, string>, raw: string) =>
    fetch(`${baseUrl}/webhook/conn_hmac`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: raw,
    }).then(async r => ({ status: r.status, body: await r.json() as any }));

  it('a bogus signature does NOT burn the nonce (order: verify then claim)', async () => {
    // Mutation that should REDDEN: swap claimNonce before verifyWebhookSignature
    // in webhook-routes.ts — the bogus request would then claim 'victim' and the
    // genuine retry would get 409 replay.
    await seedHmac();
    const raw = JSON.stringify(EVT);
    const ts = String(Math.floor(Date.now() / 1000));
    const bogus = await sendSigned(
      { 'x-botmux-timestamp': ts, 'x-botmux-nonce': 'victim', 'x-botmux-signature': 'sha256=deadbeef' }, raw);
    expect(bogus.status).toBe(401);
    const genuine = await sendSigned(
      { 'x-botmux-timestamp': ts, 'x-botmux-nonce': 'victim', 'x-botmux-signature': sign(ts, raw) }, raw);
    expect(genuine.body.action).toBe('queued');
  });

  it('a captured signature replayed with a FRESH nonce is not made worse by the new ordering', async () => {
    // The signature covers only `ts.rawBody`, NOT the nonce, so a captured
    // signature can be replayed with a fresh nonce inside the tolerance window.
    // That window is PRE-EXISTING and documented (webhook.md: "要正确支持需要给
    // nonce 也做一套绑定完整请求指纹的 reserve/settle"); this PR's verify-then-claim
    // reordering must not widen it.
    //
    // Deliberately NOT asserting `action === 'queued'` for the unkeyed replay:
    // that would pin the weakness as required behaviour, so whoever finally binds
    // the nonce into the signature would see this test go RED for FIXING it — and
    // a test that fires on correct code gets deleted. We accept either outcome
    // (dispatched today, rejected once bound) and pin only what must not change:
    // an idempotency key still folds the replay.
    await seedHmac();
    const raw = JSON.stringify(EVT);
    const ts = String(Math.floor(Date.now() / 1000));
    const captured = { 'x-botmux-timestamp': ts, 'x-botmux-nonce': 'n1', 'x-botmux-signature': sign(ts, raw) };
    await sendSigned(captured, raw);

    const replay = await sendSigned({ ...captured, 'x-botmux-nonce': 'n2' }, raw);
    expect(['queued', undefined]).toContain(replay.body.action);   // dispatched, or rejected by a future nonce binding
    expect(replay.status === 200 || replay.status === 401).toBe(true);

    // INVARIANT (this is the part that must hold): the same replay carrying an
    // idempotency key folds onto the first keyed delivery instead of running twice.
    const keyed = { ...captured, 'x-idempotency-key': 'evt_hmac_replay' };
    const first = await sendSigned({ ...keyed, 'x-botmux-nonce': 'n3' }, raw);
    expect(first.body.action).toBe('queued');
    const folded = await sendSigned({ ...keyed, 'x-botmux-nonce': 'n4' }, raw);
    expect(folded.body.action).toBe('ignored');
  });
});
