import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const workerSource = readFileSync(join(process.cwd(), 'src/worker.ts'), 'utf8');

describe('spawned CoCo transcript bridge wiring', () => {
  it('falls back to PID discovery when the legacy events path does not exist', () => {
    const branchStart = workerSource.lastIndexOf("} else if (cfg.cliId === 'coco') {");
    const branchEnd = workerSource.indexOf("} else if (cfg.cliId === 'mtr') {", branchStart);
    const branch = workerSource.slice(branchStart, branchEnd);

    expect(branch).toContain('existsSync(eventsPath)');
    expect(branch).toContain('findCocoSessionByPid(cliPid)');
    expect(branch).toContain('persistCliSessionId(discovered.sessionId)');
    expect(branch).toContain('codexAdoptPendingPid = cliPid');
  });

  it('recovers an unpersisted native id before building resume arguments', () => {
    const preflightStart = workerSource.indexOf('let effectiveResume = cfg.resume ?? false;');
    const preflightEnd = workerSource.indexOf('const tier2ForceFresh', preflightStart);
    const preflight = workerSource.slice(preflightStart, preflightEnd);

    expect(preflight).toContain("cfg.cliId === 'coco'");
    expect(preflight).toContain('findTraexSessionIdByThreadName(effectiveAdapterSessionId)');
    expect(preflight).toContain('persistCliSessionId(recoveredCocoSessionId)');
  });

  it('persists a delayed CoCo rollout discovery from the bridge poller', () => {
    const lateAttachStart = workerSource.indexOf(
      'const path = resolveFileBridgePath(lastInitConfig?.cliId',
    );
    const lateAttachEnd = workerSource.indexOf(
      'codexBridgePendingSessionId = undefined;',
      lateAttachStart,
    );
    const lateAttach = workerSource.slice(lateAttachStart, lateAttachEnd);

    expect(lateAttach).toContain("lastInitConfig?.cliId === 'coco'");
    expect(lateAttach).toContain('persistCliSessionId(discoveredSessionId)');
  });

  it('adopt resolves either legacy events or a native TRAE rollout', () => {
    const setupStart = workerSource.indexOf('function setupAdoptTranscriptBridges');
    const branchStart = workerSource.indexOf(
      "} else if (cfg.cliId === 'coco') {",
      setupStart,
    );
    const branchEnd = workerSource.indexOf(
      "} else if (cfg.cliId === 'mtr') {",
      branchStart,
    );
    const branch = workerSource.slice(branchStart, branchEnd);

    expect(branch).toContain('findTraexRolloutBySessionId(cfg.cliSessionId)');
    expect(branch).toContain('persistCliSessionId(probed.sessionId)');
  });
});
