import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { cliAuthBind, loadDashboardSecret, signCliAuth } from '../dashboard/auth.js';

/**
 * Loopback HMAC client for the dashboard process's `/__cli/*` endpoints, used by
 * `botmux dashboard [current|rotate]` and the post-start/restart hint.
 *
 * Two subtleties this module exists to handle correctly:
 *
 * 1. **404 is ambiguous.** Only the dashboard's `/__cli/current` returns 404 to
 *    mean "no token minted yet" (`{ error: 'no_active_token' }`). Any *other*
 *    404 means the request hit a server that doesn't speak the `/__cli`
 *    protocol — most commonly the daemon IPC server, whose unknown-route 404 is
 *    `{ error: 'not_found', path }`. Conflating the two surfaces the infamous
 *    misleading `Rotation failed: no-active-token` when the real problem is that
 *    `.dashboard-port` points at the wrong service.
 *
 * 2. **`.dashboard-port` can go stale.** The dashboard (wildcard) and the daemon
 *    IPC servers (loopback) both `listenWithProbe` upward. Their base ports are
 *    now kept disjoint (config.dashboard.port 7891 + probe span vs ipcBasePort
 *    7950 — see config.ts, guarded by dashboard-ipc-port-range.test.ts), so a
 *    recorded dashboard port should no longer end up owned by an IPC server. The
 *    HMAC self-heal below stays as defense-in-depth: when the recorded port
 *    answers as the *wrong service* (e.g. a foreign squatter pushed the dashboard
 *    onto an unexpected port), we rediscover the real dashboard by HMAC-probing
 *    the probe range (only the genuine dashboard can validate the signature) and
 *    self-heal `.dashboard-port`.
 */

export type DashboardEndpoint = '/__cli/rotate' | '/__cli/ensure' | '/__cli/current' | '/__cli/reload-binding';

export type DashboardFailReason =
  | 'no-secret'
  | 'unreachable'
  | 'auth-failed'
  | 'http-error'
  | 'no-active-token'
  | 'wrong-service';

export type DashboardResult =
  | { ok: true; url: string; localUrl?: string }
  | { ok: false; reason: DashboardFailReason; detail?: string };

type FetchImpl = typeof fetch;

/**
 * Classify a 404 from a `/__cli/*` request. A genuine "no token yet" only comes
 * from `/__cli/current` carrying `{ error: 'no_active_token' }`; everything else
 * means the port is answering for some other service (daemon IPC, a stray HTTP
 * server, …), not one of the dashboard CLI routes.
 */
export function classifyDashboard404(path: DashboardEndpoint, bodyText: string): DashboardResult {
  let body: unknown = null;
  try { body = JSON.parse(bodyText); } catch { /* non-JSON body → wrong service */ }
  const err = (body && typeof body === 'object') ? (body as { error?: unknown }).error : undefined;
  if (path === '/__cli/current' && err === 'no_active_token') {
    return { ok: false, reason: 'no-active-token' };
  }
  return {
    ok: false,
    reason: 'wrong-service',
    detail: bodyText ? `404 ${bodyText.slice(0, 200)}` : '404',
  };
}

/**
 * A 401 sig_mismatch from the recorded port does NOT prove that we reached the
 * live dashboard. On macOS a wildcard dashboard bind can coexist with another
 * process listening on 127.0.0.1:same-port, so the CLI's loopback request may
 * hit the shadowing process or a stale dashboard. Treat it as rediscoverable.
 */
export function classifyDashboard401(bodyText: string): DashboardResult {
  let body: unknown = null;
  try { body = JSON.parse(bodyText); } catch { /* non-JSON 401 */ }
  const err = (body && typeof body === 'object') ? (body as { error?: unknown }).error : undefined;
  const authReason = (body && typeof body === 'object') ? (body as { reason?: unknown }).reason : undefined;
  if (err === 'unauthorized' && authReason === 'sig_mismatch') {
    return {
      ok: false,
      reason: 'auth-failed',
      detail: bodyText ? `401 ${bodyText.slice(0, 200)}` : '401 sig_mismatch',
    };
  }
  return {
    ok: false,
    reason: 'http-error',
    detail: bodyText ? `401 ${bodyText.slice(0, 200)}` : '401',
  };
}

/**
 * `fetch` for loopback only — **never** the global one.
 *
 * ⚠️ 不要「简化」成 `fetch`。Bun 的 `fetch` 会自动走 `$http_proxy`，而它**不认
 * `no_proxy` 里的 CIDR 写法**（`127.0.0.0/8` 这种）。公司内网开发机的 shell rc 普遍
 * 默认 export 一个 http_proxy + CIDR 形式的 no_proxy，于是这个**本机 loopback 请求
 * 被发到公司代理**，代理拒绝转发内网 IP，回一个 nginx HTML `403 Forbidden` ——
 * 用户看到的就是 `Dashboard lookup failed: 403 <html>…`，而 dashboard 其实活得好好的
 * （它的 `/__cli/*` 只回 JSON，从不回 HTML，所以 HTML 响应本身就是「被代理劫持」的指纹）。
 *
 * 实测（Bun 1.4.0，受控假代理 + 独立标记响应，含 `bun build --compile` 编译态）：
 *
 *   no_proxy=127.0.0.0/8 时          fetch → 403 经代理 ／ node:http → 直连 ✅
 *   fetch(…, {proxy:''/undefined/null})  → 仍然经代理（选项存在 ≠ 生效）
 *   启动后 delete process.env.http_proxy → 仍然经代理（Bun 启动时已快照代理配置）
 *
 * 所以能可靠禁掉代理的只剩「不走 fetch」：`node:http` 完全无视代理 env，Node 与 Bun
 * 下行为一致。同仓先例见 `src/cli/supervisor-shutdown-client.ts`（本机 IPC 也走 node:http）。
 */
async function loopbackFetch(
  url: string,
  init: { method: string; headers: Record<string, string> },
): Promise<Response> {
  const { request } = await import('node:http');
  const target = new URL(url);
  return new Promise<Response>((resolve, reject) => {
    const req = request(
      {
        // Dial the parsed host/port explicitly rather than handing node:http the
        // URL, so no proxy-aware URL handling can re-target the request.
        host: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        method: init.method,
        headers: init.headers,
      },
      res => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer | string) => chunks.push(Buffer.from(chunk)));
        res.on('end', () => resolve(new Response(Buffer.concat(chunks), {
          status: res.statusCode ?? 0,
          headers: Object.fromEntries(
            Object.entries(res.headers)
              .filter(([, v]) => typeof v === 'string')
              .map(([k, v]) => [k, v as string]),
          ),
        })));
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.end();
  });
}

/** Issue a single HMAC-authed request to one candidate port. */
export async function requestDashboardAt(opts: {
  host: string;
  port: number;
  path: DashboardEndpoint;
  secret: string;
  fetchImpl?: FetchImpl;
}): Promise<DashboardResult> {
  const { host, port, path, secret } = opts;
  // Default is the proxy-immune loopback client above, NOT the global `fetch`.
  const fetchImpl = opts.fetchImpl ?? (loopbackFetch as unknown as FetchImpl);
  // Bind the credential to method + path + the port we're dialing. A malicious
  // server handed these headers during discovery therefore can't forward them
  // to a different `/__cli/*` route or to the real dashboard on another port —
  // the verifier reconstructs the bind from the port IT bound, so any forward
  // mismatches the signature (and the attacker can't re-sign without the secret).
  const { ts, nonce, sig } = signCliAuth(secret, cliAuthBind('POST', path, port));

  let res: Response;
  try {
    res = await fetchImpl(`http://${host}:${port}${path}`, {
      method: 'POST',
      headers: {
        'X-Botmux-Cli-Ts': ts,
        'X-Botmux-Cli-Nonce': nonce,
        'X-Botmux-Cli-Auth': sig,
      },
    });
  } catch {
    return { ok: false, reason: 'unreachable' };
  }
  if (res.status === 404) return classifyDashboard404(path, await res.text().catch(() => ''));
  if (res.status === 401) return classifyDashboard401(await res.text().catch(() => ''));
  if (!res.ok) {
    return { ok: false, reason: 'http-error', detail: `${res.status} ${await res.text().catch(() => '')}` };
  }
  // reload-binding 不返回 url，200 即成功（仅用于「捅一下 daemon 重连」）
  if (path === '/__cli/reload-binding') return { ok: true, url: '' };
  const body = await res.json().catch(() => ({})) as { url?: string; localUrl?: string };
  if (!body.url) return { ok: false, reason: 'http-error', detail: 'malformed response (no url)' };
  // localUrl is present only when the dashboard link routes through the central
  // platform — a direct host:port fallback for when the platform is down.
  return { ok: true, url: body.url, localUrl: body.localUrl };
}

/** A result that proves we actually reached the dashboard (vs. wrong port). */
function reachedDashboard(r: DashboardResult): boolean {
  return r.ok || (!r.ok && (r.reason === 'no-active-token' || r.reason === 'http-error'));
}

function shouldRediscover(r: DashboardResult): boolean {
  return !r.ok && (r.reason === 'wrong-service' || r.reason === 'auth-failed');
}

/**
 * Resolve the dashboard URL for `path`, trying the recorded port first and
 * self-healing the port file when it points at the wrong service or a loopback
 * shadow returns an HMAC mismatch.
 */
export async function callDashboard(opts: {
  configDir: string;
  defaultPort: number;
  host?: string;
  envPort?: string;
  probeSpan?: number;
  persistPort?: boolean;
  path: DashboardEndpoint;
  fetchImpl?: FetchImpl;
}): Promise<DashboardResult> {
  const host = opts.host ?? '127.0.0.1';
  const probeSpan = opts.probeSpan ?? 20;
  const persistPort = opts.persistPort ?? true;
  // Same reason as in requestDashboardAt: the default must stay proxy-immune.
  const fetchImpl = opts.fetchImpl ?? (loopbackFetch as unknown as FetchImpl);

  const secretPath = join(opts.configDir, '.dashboard-secret');
  let secret: string | null;
  try {
    secret = loadDashboardSecret(secretPath);
  } catch (e) {
    return { ok: false, reason: 'no-secret', detail: (e as Error).message };
  }
  if (!secret) return { ok: false, reason: 'no-secret' };

  const portFile = join(opts.configDir, '.dashboard-port');
  const recorded = (existsSync(portFile) ? readFileSync(portFile, 'utf8').trim() : '')
    || opts.envPort
    || String(opts.defaultPort);
  const candidate = Number(recorded);

  // 1. Try the recorded port. A success — or any state that proves we reached
  //    the dashboard (no-active-token / http-error) — is returned as-is.
  const first = await requestDashboardAt({ host, port: candidate, path: opts.path, secret, fetchImpl });
  if (reachedDashboard(first)) return first;

  // 2. Rediscover only when some server answered on the recorded loopback port
  //    but failed dashboard identity checks: explicit wrong-service 404, or a
  //    sig_mismatch from a shadow/stale dashboard. (`unreachable` during boot
  //    resolves by retrying the same port, not by scanning — so we leave it to
  //    the caller's retry loop.)
  if (!shouldRediscover(first)) return first;

  const base = Number(opts.envPort || opts.defaultPort);
  for (let p = base; p <= base + probeSpan; p++) {
    if (p === candidate) continue;
    // Probe read-only (`/__cli/current`) so discovery never mints a token on a
    // server we're merely identifying. Only the real dashboard can answer the
    // HMAC-gated route as `ok` or `no-active-token`.
    const probe = await requestDashboardAt({ host, port: p, path: '/__cli/current', secret, fetchImpl });
    if (probe.ok || (!probe.ok && probe.reason === 'no-active-token')) {
      if (persistPort) {
        try { atomicWriteFileSync(portFile, String(p)); } catch { /* best-effort self-heal */ }
      }
      // Found the dashboard — perform the actually-requested op on its port.
      return requestDashboardAt({ host, port: p, path: opts.path, secret, fetchImpl });
    }
  }
  // No dashboard found in the probe range; surface the original wrong-service.
  return first;
}
