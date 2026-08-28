import { describe, it, expect, afterEach } from 'vitest';
import { WebSocketServer, WebSocket, type RawData } from 'ws';
import { createServer, connect as tcpConnect, type Server as NetServer } from 'node:net';
import { spawnSyncTsEvalWithRepoImports } from './helpers/ts-runner.js';

/**
 * The platform tunnel's data channel: WebSocket ↔ local dashboard TCP bridge.
 *
 * WHY THIS SUITE EXISTS — a shipped bug with a very misleading signature. The
 * bridge used `createWebSocketStream()` from `ws`, which **throws
 * `Error("Not supported yet in Bun")`**. The compiled single binary runs on Bun,
 * so on any binary install:
 *
 *  • the CONTROL channel connected fine (`new WebSocket` works on Bun), the log
 *    said 「隧道已连接平台」and the platform listed the machine as online;
 *  • but every request that actually needed forwarding died in the bridge, so the
 *    platform-side Dashboard was unreachable — while `http://<lan-ip>:<port>`
 *    worked perfectly, because a direct hit never touches the tunnel.
 *
 * That asymmetry ("dev mode works, the binary doesn't") is the fingerprint, and
 * no existing test caught it: the unit suite runs under whatever runtime the
 * runner uses, and nothing exercised the bridge end to end.
 *
 * So these tests bridge REAL sockets — a real WebSocketServer, a real TCP server —
 * and assert bytes make the round trip. The runtime-parity test below then proves
 * the mechanism works under the runtime that actually ships.
 */

const servers: Array<NetServer | WebSocketServer> = [];
const sockets: WebSocket[] = [];
afterEach(() => {
  for (const s of sockets.splice(0)) { try { s.terminate(); } catch { /* already gone */ } }
  for (const s of servers.splice(0)) { try { s.close(); } catch { /* already closed */ } }
});

/** Normalize a ws payload to one Buffer — mirrors the production helper. */
function toBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data as ArrayBuffer);
}

/**
 * The bridge under test, in the same shape as tunnel-client.ts's `bridge()`:
 * event-based piping in both directions, no `createWebSocketStream`.
 */
function bridge(winner: WebSocket, tcpPort: number): void {
  const tcp = tcpConnect(tcpPort, '127.0.0.1');
  tcp.setNoDelay(true);
  let killed = false;
  const kill = () => {
    if (killed) return;
    killed = true;
    try { winner.terminate(); } catch { /* ignore */ }
    try { tcp.destroy(); } catch { /* ignore */ }
  };
  winner.on('message', (data: RawData) => {
    const buf = toBuffer(data);
    if (!buf.length) return;
    if (!tcp.write(buf)) { try { winner.pause(); } catch { /* ignore */ } }
  });
  tcp.on('drain', () => { try { winner.resume(); } catch { /* ignore */ } });
  tcp.on('data', (chunk: Buffer) => {
    if (winner.readyState !== winner.OPEN) return;
    winner.send(chunk, { binary: true });
  });
  winner.on('close', kill);
  winner.on('error', kill);
  tcp.on('close', kill);
  tcp.on('error', kill);
  tcp.on('end', kill);
}

/** A TCP server standing in for the local dashboard; `handle` sees each chunk. */
async function startTcpTarget(handle: (chunk: Buffer, reply: (b: Buffer) => void) => void): Promise<number> {
  const srv = createServer((s) => {
    s.on('data', (chunk) => handle(chunk, (b) => s.write(b)));
    s.on('error', () => { /* client-side destroy is normal */ });
  });
  servers.push(srv);
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  return (srv.address() as { port: number }).port;
}

/** A WS server that bridges every accepted connection to `tcpPort`. */
async function startBridgingWsServer(tcpPort: number): Promise<number> {
  const wss = new WebSocketServer({ port: 0, perMessageDeflate: false });
  servers.push(wss);
  await new Promise<void>((r) => wss.on('listening', () => r()));
  wss.on('connection', (sock) => { sockets.push(sock); bridge(sock, tcpPort); });
  return (wss.address() as { port: number }).port;
}

function clientTo(port: number): WebSocket {
  const c = new WebSocket(`ws://127.0.0.1:${port}`, { perMessageDeflate: false });
  sockets.push(c);
  return c;
}

describe('platform tunnel data bridge', () => {
  it('round-trips bytes between the tunnel WebSocket and the local TCP port', async () => {
    const tcpPort = await startTcpTarget((chunk, reply) => reply(Buffer.from(chunk.toString().toUpperCase())));
    const wsPort = await startBridgingWsServer(tcpPort);

    const c = clientTo(wsPort);
    const got = await new Promise<string>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('no reply within 8s')), 8_000);
      c.on('open', () => c.send(Buffer.from('hello tunnel'), { binary: true }));
      c.on('message', (m) => { clearTimeout(t); resolve(toBuffer(m as RawData).toString()); });
      c.on('error', reject);
    });
    expect(got).toBe('HELLO TUNNEL');
  }, 20_000);

  it('preserves binary payloads byte-for-byte', async () => {
    // The tunnel is a raw byte bridge: HTTP bodies, images, downloads and PTY
    // escape sequences all contain bytes that are not valid UTF-8, so anything
    // that round-trips them through a string would corrupt the payload.
    //
    // MEASURED, so the comment does not overclaim: `ws` already sends a Buffer as
    // a binary frame (isBinary=true, bytes identical) even without an explicit
    // `binary: true`, so that option is a readability guard rather than the thing
    // keeping bytes safe. What this test actually pins is the end-to-end property —
    // non-UTF-8 bytes survive the bridge unchanged — which would break if someone
    // introduced a string conversion anywhere along the path.
    const raw = Buffer.from([0x00, 0xff, 0xfe, 0x80, 0x7f, 0xc3, 0x28, 0x01]);
    const tcpPort = await startTcpTarget((chunk, reply) => reply(chunk));
    const wsPort = await startBridgingWsServer(tcpPort);

    const c = clientTo(wsPort);
    const got = await new Promise<Buffer>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('no reply within 8s')), 8_000);
      c.on('open', () => c.send(raw, { binary: true }));
      c.on('message', (m) => { clearTimeout(t); resolve(toBuffer(m as RawData)); });
      c.on('error', reject);
    });
    expect(got.equals(raw)).toBe(true);
  }, 20_000);

  it('carries a payload larger than one frame/chunk without loss', async () => {
    // Exercises the backpressure paths: a big body is what made the old
    // `pipe()`-based bridge's flow control load-bearing, so the hand-written
    // version must not drop or reorder under the same conditions.
    const size = 3 * 1024 * 1024;
    const payload = Buffer.alloc(size);
    for (let i = 0; i < size; i++) payload[i] = i & 0xff;

    // Target echoes back everything it receives, in order.
    const tcpPort = await startTcpTarget((chunk, reply) => reply(chunk));
    const wsPort = await startBridgingWsServer(tcpPort);

    const c = clientTo(wsPort);
    const got = await new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = [];
      let total = 0;
      const t = setTimeout(() => reject(new Error(`only ${total}/${size} bytes came back`)), 15_000);
      c.on('open', () => c.send(payload, { binary: true }));
      c.on('message', (m) => {
        const b = toBuffer(m as RawData);
        chunks.push(b);
        total += b.length;
        if (total >= size) { clearTimeout(t); resolve(Buffer.concat(chunks)); }
      });
      c.on('error', reject);
    });
    expect(got.length).toBe(size);
    expect(got.equals(payload)).toBe(true);
  }, 30_000);

  it('does not use createWebSocketStream — it throws on Bun, the runtime the binary ships', async () => {
    // THE REGRESSION GUARD. The bug was invisible to a Node-only test run, so
    // assert the property that actually broke: source must not reach for the API
    // that is unavailable in the shipping runtime.
    const src = await import('node:fs/promises').then((fs) =>
      fs.readFile(new URL('../src/platform/tunnel-client.ts', import.meta.url), 'utf8'));
    // Strip comments before matching: the file deliberately NAMES the banned API
    // when explaining why it is avoided, and a naive substring check would fail on
    // that prose — then get "fixed" by deleting the explanation, which is exactly
    // the knowledge a future reader needs.
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, '')      // block comments
      .replace(/(^|[^:])\/\/.*$/gm, '$1');   // line comments (not `://` in a URL)
    expect(code).not.toContain('createWebSocketStream');
    // And it must still import what it does use, so this test cannot pass simply
    // because the file was renamed or emptied.
    expect(code).toContain("from 'ws'");
  });

  it('bridges under BOTH runtimes — the parity the shipped bug broke', () => {
    // Runs the bridge in a child process so it can be exercised under whichever
    // runtime the helper resolves (Bun natively, Node with a TS loader). Under Bun
    // this is the exact call that used to throw `Not supported yet in Bun`.
    const snippet = `
      const { WebSocketServer, WebSocket } = await import('ws');
      const { createServer, connect } = await import('node:net');
      const wss = new WebSocketServer({ port: 0, perMessageDeflate: false });
      await new Promise((r) => wss.on('listening', r));
      const tcpSrv = createServer((s) => s.on('data', (d) => s.write(Buffer.from(d.toString().toUpperCase()))));
      await new Promise((r) => tcpSrv.listen(0, '127.0.0.1', r));
      const tcpPort = tcpSrv.address().port;
      wss.on('connection', (win) => {
        const tcp = connect(tcpPort, '127.0.0.1');
        tcp.setNoDelay(true);
        win.on('message', (d) => tcp.write(Buffer.isBuffer(d) ? d : Buffer.from(d)));
        tcp.on('data', (c) => { if (win.readyState === 1) win.send(c, { binary: true }); });
      });
      const c = new WebSocket('ws://127.0.0.1:' + wss.address().port, { perMessageDeflate: false });
      c.on('open', () => c.send(Buffer.from('parity'), { binary: true }));
      const out = await new Promise((res) => c.on('message', (m) => res(m.toString())));
      console.log('BRIDGED:' + out);
      try { c.terminate(); } catch {}
      wss.close(); tcpSrv.close();
      process.exit(0);
    `;
    const r = spawnSyncTsEvalWithRepoImports(snippet, { encoding: 'utf-8', timeout: 30_000 });
    const stdout = String(r.stdout ?? '');
    // Surface the child's stderr on failure — a runtime that cannot bridge fails
    // there, and the whole point is to see WHY.
    expect(stdout, `child stderr:\n${String(r.stderr ?? '')}`).toContain('BRIDGED:PARITY');
  }, 40_000);
});
