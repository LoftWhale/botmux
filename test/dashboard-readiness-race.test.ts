import { describe, expect, it } from 'vitest';
import {
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
      dashboardMemberLive: true,
    })).toBe(true);
    // ...and still at 44s, where the old 6s budget had long since given up.
    expect(shouldKeepWaitingForDashboard({
      elapsedMs: 44_000,
      failure: failure('unreachable'),
      dashboardMemberLive: true,
    })).toBe(true);
  });

  it('stops immediately when no dashboard member is live', () => {
    // Otherwise the enlarged budget would be spent in full on a fleet whose
    // dashboard is disabled or already dead — a 90s hang on every start/restart.
    expect(shouldKeepWaitingForDashboard({
      elapsedMs: 0,
      failure: failure('unreachable'),
      dashboardMemberLive: false,
    })).toBe(false);
  });

  it('stops at the budget even if the member never binds its port', () => {
    // Liveness alone would spin forever on a member that is up but not listening.
    expect(shouldKeepWaitingForDashboard({
      elapsedMs: DASHBOARD_READY_WAIT_MS,
      failure: failure('unreachable'),
      dashboardMemberLive: true,
    })).toBe(false);
  });

  it('does not spin on failures that waiting cannot fix', () => {
    // A file-backed secret/token will not appear mid-poll, and `wrong-service`
    // means discovery already failed to find a dashboard anywhere.
    for (const reason of ['no-secret', 'no-active-token', 'wrong-service'] as const) {
      expect(dashboardFailureIsTerminal(failure(reason))).toBe(true);
      expect(shouldKeepWaitingForDashboard({
        elapsedMs: 0,
        failure: failure(reason),
        dashboardMemberLive: true,   // live, and it STILL must not retry
      })).toBe(false);
    }
    expect(dashboardFailureIsTerminal(failure('unreachable'))).toBe(false);
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
});
