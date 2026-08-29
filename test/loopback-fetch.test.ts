/**
 * `loopbackFetch` — the proxy-immune transport shared by every loopback caller
 * (dashboard `/__cli/*`, daemon IPC, current-actor, managed-origin attestation,
 * the dashboard's SSE aggregator, workflow v3 clients, …).
 *
 * Each block below is a defect that was REPRODUCED against an earlier version of
 * this module, and each one failed in a way that ordinary tests do not notice:
 *
 *  · buffer-all body      → SSE callers never got a Response at all, so the
 *                           dashboard's session/event aggregation silently stopped.
 *  · plain `Error` on abort → callers branch on `name === 'AbortError'` to tell a
 *                           timeout (504 wait_timeout / "busy") from an offline
 *                           daemon (503 / "failed"); every timeout took the wrong
 *                           branch.
 *  · listener never removed → one AbortController is reused across an unbounded SSE
 *                           reconnect loop; 12 completed requests left 12 listeners,
 *                           each pinning a finished req/res.
 *
 * Run: npx vitest run test/loopback-fetch.test.ts
 */
import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type RequestListener, type Server } from 'node:http';
import { getEventListeners } from 'node:events';
import { loopbackFetch, isLoopbackUrl } from '../src/core/loopback-fetch.js';

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(s => new Promise<void>(r => s.close(() => r()))));
});

async function listen(handler: RequestListener): Promise<number> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
  return (server.address() as { port: number }).port;
}

describe('loopbackFetch — basic fetch compatibility', () => {
  it('exposes ok/status/json/text like the global fetch', async () => {
    const port = await listen((req, res) => {
      if (req.url === '/json') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"ok":true}');
      } else {
        res.writeHead(201);
        res.end('hello');
      }
    });
    const j = await loopbackFetch(`http://127.0.0.1:${port}/json`);
    expect(j.ok).toBe(true);
    expect(await j.json()).toEqual({ ok: true });

    const t = await loopbackFetch(`http://127.0.0.1:${port}/text`);
    expect(t.status).toBe(201);
    expect(await t.text()).toBe('hello');
  });

  it('sends a body and reports non-2xx without throwing', async () => {
    let seen = '';
    const port = await listen((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', c => chunks.push(Buffer.from(c)));
      req.on('end', () => {
        seen = Buffer.concat(chunks).toString();
        res.writeHead(418);
        res.end('nope');
      });
    });
    const r = await loopbackFetch(`http://127.0.0.1:${port}/p`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ a: 1 }),
    });
    expect(seen).toBe('{"a":1}');
    expect(r.ok).toBe(false);
    expect(r.status).toBe(418);
  });

  it('handles a 204 (a body there would make the Response constructor throw)', async () => {
    const port = await listen((_req, res) => { res.writeHead(204); res.end(); });
    const r = await loopbackFetch(`http://127.0.0.1:${port}/n`);
    expect(r.status).toBe(204);
    expect(r.body).toBeNull();
  });

  it('rejects when nothing is listening (callers distinguish this from a 4xx)', async () => {
    // Port 1 on loopback is not bound in any sane environment.
    await expect(loopbackFetch('http://127.0.0.1:1/x')).rejects.toBeTruthy();
  });

  it('refuses a non-loopback host rather than dialling it', async () => {
    await expect(loopbackFetch('http://example.com/x')).rejects.toBeTruthy();
  });
});

describe('loopbackFetch — streaming (SSE)', () => {
  it('resolves on HEADERS and yields the first frame while the stream stays open', async () => {
    // The regression: a buffer-all implementation waits for `end`, which never
    // comes for SSE, so the caller hangs forever instead of reading frames.
    const port = await listen((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      res.write('data: {"first":true}\n\n');
      // Deliberately no res.end() — the connection is held open, like /api/events.
    });
    const r = await loopbackFetch(`http://127.0.0.1:${port}/api/events`);
    expect(r.ok).toBe(true);
    const reader = r.body!.getReader();
    const { value } = await reader.read();
    expect(Buffer.from(value!).toString()).toContain('"first":true');
    await reader.cancel();
  }, 15_000);

  it('a consumer cancel tears the connection down instead of leaking it', async () => {
    let closed = false;
    const port = await listen((_req, res) => {
      res.on('close', () => { closed = true; });
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: 1\n\n');
    });
    const r = await loopbackFetch(`http://127.0.0.1:${port}/api/events`);
    const reader = r.body!.getReader();
    await reader.read();
    await reader.cancel();
    // Give the socket teardown a tick to reach the server.
    await new Promise(res => setTimeout(res, 200));
    expect(closed).toBe(true);
  }, 15_000);
});

describe('loopbackFetch — abort semantics', () => {
  it('rejects with AbortError when aborted BEFORE the headers arrive', async () => {
    const port = await listen(() => { /* never respond */ });
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 60);
    // The exact property callers branch on — daemon.ts picks 504 vs 503 by it.
    await expect(loopbackFetch(`http://127.0.0.1:${port}/x`, { signal: ctrl.signal }))
      .rejects.toMatchObject({ name: 'AbortError' });
  }, 15_000);

  it('fails the BODY with AbortError too, not the socket ECONNRESET', async () => {
    const port = await listen((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.write('partial');       // headers sent, body never finished
    });
    const ctrl = new AbortController();
    const r = await loopbackFetch(`http://127.0.0.1:${port}/x`, { signal: ctrl.signal });
    setTimeout(() => ctrl.abort(), 60);
    await expect(r.text()).rejects.toMatchObject({ name: 'AbortError' });
  }, 15_000);

  it('rejects immediately when the signal is already aborted', async () => {
    const port = await listen((_req, res) => { res.writeHead(200); res.end('late'); });
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(loopbackFetch(`http://127.0.0.1:${port}/x`, { signal: ctrl.signal }))
      .rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('loopbackFetch — abort listener lifecycle', () => {
  /**
   * `dashboard/aggregator.ts` reuses ONE AbortController across an unbounded SSE
   * reconnect loop. With `{ once: true }` alone, a request that merely COMPLETED
   * kept its listener, so the signal accumulated one per reconnect.
   */
  it('leaves no listener behind after repeated completed requests', async () => {
    const port = await listen((_req, res) => { res.writeHead(200); res.end('ok'); });
    const ctrl = new AbortController();
    for (let i = 0; i < 12; i++) {
      const r = await loopbackFetch(`http://127.0.0.1:${port}/x`, { signal: ctrl.signal });
      await r.text();
    }
    expect(getEventListeners(ctrl.signal, 'abort')).toHaveLength(0);
  }, 20_000);

  it('leaves no listener behind after an SSE stream is cancelled', async () => {
    const port = await listen((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: 1\n\n');
    });
    const ctrl = new AbortController();
    const r = await loopbackFetch(`http://127.0.0.1:${port}/e`, { signal: ctrl.signal });
    const reader = r.body!.getReader();
    await reader.read();
    await reader.cancel();
    expect(getEventListeners(ctrl.signal, 'abort')).toHaveLength(0);
  }, 15_000);

  it('leaves no listener behind when the request fails before headers', async () => {
    const ctrl = new AbortController();
    await expect(loopbackFetch('http://127.0.0.1:1/x', { signal: ctrl.signal })).rejects.toBeTruthy();
    expect(getEventListeners(ctrl.signal, 'abort')).toHaveLength(0);
  });

  it('still aborts correctly after the signal has been reused', async () => {
    // Guard against "fixed the leak by never arming the listener".
    const okPort = await listen((_req, res) => { res.writeHead(200); res.end('ok'); });
    const ctrl = new AbortController();
    for (let i = 0; i < 3; i++) {
      const r = await loopbackFetch(`http://127.0.0.1:${okPort}/x`, { signal: ctrl.signal });
      await r.text();
    }
    const deadPort = await listen(() => { /* never respond */ });
    setTimeout(() => ctrl.abort(), 60);
    await expect(loopbackFetch(`http://127.0.0.1:${deadPort}/y`, { signal: ctrl.signal }))
      .rejects.toMatchObject({ name: 'AbortError' });
  }, 20_000);
});

describe('loopbackFetch — hosts and statuses that used to be mis-handled', () => {
  it('actually dials an IPv6 loopback server (brackets are stripped)', async () => {
    // `URL.hostname` yields `[::1]`, which requestLiteralLoopback's allow-list
    // rejects — so a legal IPv6 URL failed with `remote_host_forbidden` while
    // isLoopbackUrl cheerfully reported true. Assert on a REAL request, not the
    // predicate, or the contradiction stays invisible.
    const server = createServer((_q, r) => { r.writeHead(200); r.end('v6ok'); });
    servers.push(server);
    await new Promise<void>(r => server.listen(0, '::1', () => r()));
    const port = (server.address() as { port: number }).port;
    const res = await loopbackFetch(`http://[::1]:${port}/x`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('v6ok');
  }, 15_000);

  it('does not crash on a 205 (a null-body status the constructor refuses)', async () => {
    // `new Response(stream, {status:205})` throws, and it threw inside the HTTP
    // response callback: on NODE that escaped as an uncaught exception and killed
    // the process. Bun tolerates 205, which is why this needed an explicit test.
    const port = await listen((_q, r) => { r.writeHead(205); r.end(); });
    const res = await loopbackFetch(`http://127.0.0.1:${port}/x`);
    expect(res.status).toBe(205);
    expect(res.body).toBeNull();
  });

  it('REFUSES https rather than silently dialling it as plaintext', async () => {
    // Measured against a plain HTTP server: the earlier implementation returned
    // `200 PLAIN` for an `https://127.0.0.1:PORT` URL — a caller that believed it
    // had TLS would have sent credentials in the clear. The helper must fail closed
    // on its own, not rely on callers consulting isLoopbackUrl first.
    const port = await listen((_q, r) => { r.writeHead(200); r.end('PLAIN'); });
    await expect(loopbackFetch(`https://127.0.0.1:${port}/x`))
      .rejects.toThrow(/only http:/);
  });

  it('gives a HEAD response a null body', async () => {
    const port = await listen((_q, r) => { r.writeHead(200, { 'content-length': '5' }); r.end(); });
    const res = await loopbackFetch(`http://127.0.0.1:${port}/x`, { method: 'HEAD' });
    expect(res.status).toBe(200);
    expect(res.body).toBeNull();
  });
});

describe('isLoopbackUrl', () => {
  it('accepts only literal loopback hosts over http', () => {
    expect(isLoopbackUrl('http://127.0.0.1:7891/x')).toBe(true);
    expect(isLoopbackUrl('http://[::1]:7891/x')).toBe(true);
    // A DNS name is not a loopback guarantee even if it resolves there today.
    expect(isLoopbackUrl('http://localhost:7891/x')).toBe(false);
    expect(isLoopbackUrl('https://dash.example.com/x')).toBe(false);
    expect(isLoopbackUrl('not a url')).toBe(false);
  });

  it('refuses https even on a loopback host (this transport is node:http)', () => {
    // Reporting true here would steer daemon-internal-client onto a transport that
    // cannot serve the URL — "judged safe but guaranteed to fail".
    expect(isLoopbackUrl('https://127.0.0.1:7891/x')).toBe(false);
    expect(isLoopbackUrl('https://[::1]:7891/x')).toBe(false);
  });
});
