import { describe, expect, it } from 'vitest';
import {
  DASHBOARD_LIVENESS_GRACE_MS,
  DASHBOARD_READY_WAIT_MS,
  dashboardFailureIsTerminal,
  formatDashboardUnreachable,
  shouldKeepWaitingForDashboard,
} from '../src/cli/dashboard-command.js';
import type { DashboardResult } from '../src/cli/dashboard-endpoint.js';

/**
 * Regression tests for the dashboard readiness race.
 *
 * OBSERVED IN PRODUCTION on a 13-member fleet: `botmux restart` waited 6s for the
 * dashboard, but the dashboard needed ~45s to start answering (supervisor up at
 * 14:23:04, `.dashboard-port` written at 14:23:49). So restart always printed its
 * "still booting" fallback, and the operator's natural next step —
 * `botmux dashboard` — reported
 *
 *     dashboard process not reachable on 127.0.0.1:7891 — `botmux restart` will start it
 *
 * Following that advice restarts a daemon that is coming up perfectly well,
 * throwing away the boot that was about to finish. Nothing was broken; the
 * waiting policy and the message were.
 */

function failure(reason: Extract<DashboardResult, { ok: false }>['reason']):
  Extract<DashboardResult, { ok: false }> {
  return { ok: false, reason };
}

describe('dashboard readiness budget', () => {
  it('is long enough for a real fleet (the measured boot was ~45s)', () => {
    // Pin the property, not the constant: the old 6s silently made every large
    // fleet take the failure path.
    expect(DASHBOARD_READY_WAIT_MS).toBeGreaterThanOrEqual(45_000);
  });

  it('keeps waiting while the dashboard member is live and unreachable', () => {
    // The exact shape of the production race: 10s in, port not up yet, process
    // alive and booting.
    expect(shouldKeepWaitingForDashboard({
      elapsedMs: 10_000,
      failure: failure('unreachable'),
      comingUp: true,
    })).toBe(true);
    // ...and still at 44s, where the old 6s budget had long since given up.
    expect(shouldKeepWaitingForDashboard({
      elapsedMs: 44_000,
      failure: failure('unreachable'),
      comingUp: true,
    })).toBe(true);
  });

  it('stops immediately when no dashboard member is live', () => {
    // Otherwise the enlarged budget would be spent in full on a fleet whose
    // dashboard is disabled or already dead — a 90s hang on every start/restart.
    expect(shouldKeepWaitingForDashboard({
      elapsedMs: 0,
      failure: failure('unreachable'),
      comingUp: false,
    })).toBe(false);
  });

  it('stops at the budget even if the member never binds its port', () => {
    // Liveness alone would spin forever on a member that is up but not listening.
    expect(shouldKeepWaitingForDashboard({
      elapsedMs: DASHBOARD_READY_WAIT_MS,
      failure: failure('unreachable'),
      comingUp: true,
    })).toBe(false);
  });

  it('does not spin on failures that waiting cannot fix', () => {
    // Only `no-active-token` is a real answer FROM the dashboard: it is up, it just
    // has no token yet. Nothing is gained by polling.
    expect(dashboardFailureIsTerminal(failure('no-active-token'))).toBe(true);
    expect(shouldKeepWaitingForDashboard({
      elapsedMs: 0,
      failure: failure('no-active-token'),
      comingUp: true,   // live, and it STILL must not retry
    })).toBe(false);
  });

  it('keeps waiting through a FRESH-INSTALL no-secret while the member is live', () => {
    // `.dashboard-secret` is created by the dashboard ITSELF during boot
    // (loadOrCreateSecret() at module scope in dashboard.ts), so on a fresh install
    // the supervisor has a live dashboard pid well before that line runs. Treating
    // this as terminal ended the poll early and then advised a restart of a
    // perfectly healthy, still-booting dashboard.
    expect(dashboardFailureIsTerminal(failure('no-secret'))).toBe(false);
    expect(shouldKeepWaitingForDashboard({
      elapsedMs: 2_000,
      failure: failure('no-secret'),
      comingUp: true,
    })).toBe(true);
    // ...but with no live member it really is "not initialised" — stop at once.
    expect(shouldKeepWaitingForDashboard({
      elapsedMs: 2_000,
      failure: failure('no-secret'),
      comingUp: false,
    })).toBe(false);
  });

  it('treats a `launching` member with pid 0 as coming up', () => {
    // The supervisor records `status='launching', pid=0` while a crashed member is
    // in restart backoff (fleet-supervisor.ts handleExit). A pid-based check called
    // that "not live", ended the poll, and then advised a restart — of a dashboard
    // the supervisor was about to bring back itself. `comingUp` is the supervisor's
    // INTENT, so that state is `true` and this predicate must keep waiting.
    expect(shouldKeepWaitingForDashboard({
      elapsedMs: 20_000,
      failure: failure('unreachable'),
      comingUp: true,
    })).toBe(true);
  });

  it('keeps waiting through the initial "cannot tell yet" (no state/row written)', () => {
    // A just-started supervisor has not written the dashboard row, so the first
    // observation is legitimately unknown. Reading that as "nothing is coming up"
    // would end the wait at t=0 on every single start.
    expect(shouldKeepWaitingForDashboard({
      elapsedMs: 0,
      failure: failure('unreachable'),
      comingUp: null,
    })).toBe(true);
    // ...but unknown forever must not hold the full 90s budget: after the grace
    // window it stops, preserving the old whole-budget behaviour for that stretch.
    expect(shouldKeepWaitingForDashboard({
      elapsedMs: DASHBOARD_LIVENESS_GRACE_MS,
      failure: failure('unreachable'),
      comingUp: null,
    })).toBe(false);
    expect(DASHBOARD_LIVENESS_GRACE_MS).toBeLessThan(DASHBOARD_READY_WAIT_MS);
  });
});

describe('`botmux dashboard` unreachable message', () => {
  it('does not tell the operator to restart a dashboard that is coming up', () => {
    const msg = formatDashboardUnreachable(7891, true);
    // Must not INSTRUCT a restart. A bare `not.toContain('restart')` is wrong
    // here — this message legitimately says "不需要 restart" ("no restart
    // needed"), so match the instruction form the old text used instead.
    expect(msg).not.toContain('botmux restart` will start it');
    expect(msg).not.toMatch(/运行\s*`?botmux restart/);
    expect(msg).toContain('不需要 restart');   // ...it says the opposite, explicitly
    expect(msg).toContain('7891');
    expect(msg).toContain('启动中');            // "still starting"
  });

  it('still says to restart when nothing is coming up', () => {
    // The advice is correct in this case and must not be lost.
    const msg = formatDashboardUnreachable(7891, false);
    expect(msg).toContain('botmux restart');
    expect(msg).toContain('not reachable');
    expect(msg).toContain('7891');
  });

  it('the two cases are actually different messages', () => {
    // Guards against a refactor that collapses them and silently restores the
    // misleading advice for the booting case.
    expect(formatDashboardUnreachable(7891, true))
      .not.toBe(formatDashboardUnreachable(7891, false));
  });

  it('"cannot tell" gets the wait-and-retry advice, not restart', () => {
    // When we do not know, the honest advice is "wait", never "restart" — the
    // restart is the destructive option.
    expect(formatDashboardUnreachable(7891, null))
      .toBe(formatDashboardUnreachable(7891, true));
  });
});
