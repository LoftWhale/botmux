import { workbenchEntryUrl } from '../core/dashboard-url.js';

import type { DashboardEndpoint, DashboardResult } from './dashboard-endpoint.js';

export const DASHBOARD_COMMAND_USAGE = `用法:
  botmux dashboard           获取当前 Dashboard 登录 URL（没有则创建，不轮换已有 token）
  botmux dashboard current   获取当前 Dashboard 登录 URL（没有则创建，不轮换已有 token）
  botmux dashboard rotate    轮换 token，并打印新的 Dashboard 登录 URL`;

export type DashboardCommandExecution =
  | { kind: 'help' }
  | { kind: 'invalid'; argument: string }
  | { kind: 'endpoint'; action: 'current' | 'rotate'; result: DashboardResult };

const LEGACY_ENSURE_TOKEN_GATE_PREFIX =
  '401 <h1>Token expired</h1><p>Run <code>botmux dashboard</code>';

function legacyEnsureRouteMissing(result: DashboardResult): boolean {
  if (result.ok) return false;
  if (result.reason === 'wrong-service') return true;
  return result.reason === 'http-error'
    && result.detail?.startsWith(LEGACY_ENSURE_TOKEN_GATE_PREFIX) === true;
}

/**
 * `botmux dashboard` 成功时要打印的每一行，按顺序。
 *
 * ⚠️ 契约：**第 0 行永远是且只是那条 URL**，不带任何前缀、标签或修饰。脚本和用户
 * 都靠「取第一行」拿链接（`botmux dashboard | head -1`）。往后追加行可以，动第一行
 * 不行。
 *
 * 第二行是工作台直达入口（`<base>/workbench?t=<token>`）——`/workbench` 是
 * Dashboard 上一个无 fragment 的入口，会 302 到 `/?t=…#/agent-workbench`
 * （见 dashboard.ts）。它和第一行同源同 token，所以第一行能用它就能用；拼不出来
 * （URL 不可解析）时这一行整行省略，不打印半截链接。
 */
export function formatDashboardSuccessLines(result: Extract<DashboardResult, { ok: true }>): string[] {
  const lines = [result.url];
  const workbench = workbenchEntryUrl(result.url);
  if (workbench) lines.push(`工作台: ${workbench}`);
  if (result.localUrl) lines.push(`本地直连(平台异常时可用): ${result.localUrl}`);
  return lines;
}

/**
 * How long `start`/`restart` should keep waiting for the dashboard to answer, and
 * what to tell an operator who asks for the link while it is still coming up.
 *
 * SIZED FROM A REAL FLEET, not from how long a boot "should" take. The budget was
 * 6s; MEASURED on a 13-member fleet the dashboard needed ~45s from supervisor
 * start to answering (supervisor up at 14:23:04, `.dashboard-port` written at
 * 14:23:49). So every `restart` there ended in the "still booting" fallback, and
 * the operator's natural next step — `botmux dashboard` — printed
 * "not reachable ... `botmux restart` will start it": advice that would restart a
 * daemon which was in fact coming up fine, throwing away the boot about to
 * succeed.
 */
export const DASHBOARD_READY_WAIT_MS = 90_000;

/** Failure reasons that no amount of waiting can change: a file-backed
 *  secret/token will not appear mid-poll, and `wrong-service` means the port file
 *  points at a non-dashboard server that discovery already failed to resolve. */
export function dashboardFailureIsTerminal(failure: Extract<DashboardResult, { ok: false }>): boolean {
  return failure.reason === 'no-secret'
    || failure.reason === 'no-active-token'
    || failure.reason === 'wrong-service';
}

/**
 * Should the readiness poll take another turn?
 *
 * Two independent bounds, and BOTH matter. The clock alone would spend the (now
 * much larger) budget in full on a fleet that has no dashboard member at all, or
 * whose dashboard already died — so liveness gates it: keep waiting only while
 * the supervisor still reports a live dashboard process. Liveness alone would
 * spin forever on a member that is up but never binds its port.
 */
export function shouldKeepWaitingForDashboard(input: {
  elapsedMs: number;
  budgetMs?: number;
  failure: Extract<DashboardResult, { ok: false }>;
  dashboardMemberLive: boolean;
}): boolean {
  if (input.elapsedMs >= (input.budgetMs ?? DASHBOARD_READY_WAIT_MS)) return false;
  if (dashboardFailureIsTerminal(input.failure)) return false;
  return input.dashboardMemberLive;
}

/**
 * The message for an `unreachable` result — the one an operator sees from
 * `botmux dashboard`.
 *
 * "Run restart" is right ONLY when nothing is coming up. With a live dashboard
 * member, nothing is broken and a restart would be actively counterproductive, so
 * say "wait" instead. See DASHBOARD_READY_WAIT_MS for the measurement.
 */
export function formatDashboardUnreachable(port: string | number, dashboardMemberLive: boolean): string {
  if (dashboardMemberLive) {
    return `dashboard 正在启动中，还没开始在 127.0.0.1:${port} 上应答（大 fleet 可能要几十秒）。`
      + '稍等几秒后重新运行 `botmux dashboard` 即可，不需要 restart。';
  }
  return `dashboard process not reachable on 127.0.0.1:${port} — \`botmux restart\` will start it`;
}

export function formatDashboardFallbackFailure(
  action: 'current' | 'rotate',
  failure: Extract<DashboardResult, { ok: false }>,
): string {
  const operation = action === 'current' ? 'Dashboard lookup' : 'Rotation';
  return `${operation} failed: ${failure.detail ?? failure.reason}`;
}

/**
 * Parse and dispatch the dashboard subcommand without touching process-global
 * output or credentials. Keeping the endpoint call injected makes the safety
 * property executable in tests: help/invalid invocations cannot accidentally
 * reach the token-rotation endpoint.
 */
export async function executeDashboardCommand(
  args: readonly string[],
  callEndpoint: (path: DashboardEndpoint) => Promise<DashboardResult>,
): Promise<DashboardCommandExecution> {
  if (args.some(arg => ['--help', '-h', 'help'].includes(arg.toLowerCase()))) {
    return { kind: 'help' };
  }
  if (args.length > 1) return { kind: 'invalid', argument: args.join(' ') };

  const raw = args[0]?.toLowerCase();

  if (raw !== undefined && raw !== 'current' && raw !== 'rotate') {
    return { kind: 'invalid', argument: args[0] };
  }

  const action = raw === 'rotate' ? 'rotate' : 'current';
  if (action === 'rotate') {
    return { kind: 'endpoint', action, result: await callEndpoint('/__cli/rotate') };
  }

  const current = await callEndpoint('/__cli/current');
  if (current.ok || current.reason !== 'no-active-token') {
    return { kind: 'endpoint', action, result: current };
  }

  const ensured = await callEndpoint('/__cli/ensure');
  // The immediately preceding current probe proved this is a dashboard with no
  // active token. Older dashboards either 404 an unknown ensure route or pass
  // it through the browser token gate (the exact 401 HTML above). Only those
  // version signatures may fall back to legacy rotate; a new endpoint's 500,
  // auth failure, or transport failure must remain fail-closed.
  if (legacyEnsureRouteMissing(ensured)) {
    // A token may have appeared between the first read and the failed legacy
    // capability probe (or rediscovery may have healed the recorded port).
    // Re-read before using the mutating compatibility endpoint so a concurrent
    // valid link is returned instead of invalidated.
    const legacyCurrent = await callEndpoint('/__cli/current');
    if (legacyCurrent.ok || legacyCurrent.reason !== 'no-active-token') {
      return { kind: 'endpoint', action, result: legacyCurrent };
    }
    return { kind: 'endpoint', action, result: await callEndpoint('/__cli/rotate') };
  }
  return { kind: 'endpoint', action, result: ensured };
}
