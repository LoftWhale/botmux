import { createHash } from 'node:crypto';
import { execFile, execFileSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import { createCocoAdapter } from '../src/adapters/cli/coco.js';
import { sessionAgentConfig } from '../src/core/worker-pool.js';
import { launchCandidateRca } from '../src/services/candidate-rca-launch.js';
import {
  attestCandidateRuntimeSpawn,
  candidateBotmuxBuildIdentity,
  candidateBotmuxCommit,
  candidateRuntimeAttestationPath,
  hashCandidateRuntimeTree,
  prepareCandidateCocoHome,
  validateCandidateRuntimeContract,
  type CandidateRuntimeContract,
} from '../src/services/candidate-runtime-contract.js';

const COCO = realpathSync(join(process.env.HOME || '/home/zhubowen.cc', '.local', 'bin', 'coco'));
const exec = promisify(execFile);
const BOTMUX_ARTIFACT_SHA256 = '6'.repeat(64);

function botmuxIdentity(contract: CandidateRuntimeContract) {
  return {
    observeBotmuxIdentity: () => ({
      commit: contract.botmuxCommit,
      artifactSha256: contract.botmuxArtifactSha256,
    }),
  };
}

function sha256(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function testCocoCache(root: string): string {
  const cache = join(root, 'coco-cache');
  mkdirSync(cache, { recursive: true });
  return cache;
}

function fixture(): { root: string; contract: CandidateRuntimeContract } {
  const root = mkdtempSync(join(tmpdir(), 'botmux-candidate-runtime-'));
  const repo = join(root, 'release-a-repo');
  const skills = join(root, 'release-a-skills');
  const capLock = join(root, 'capability-lock.json');
  const manifest = join(root, 'manifest.json');
  mkdirSync(repo, { recursive: true });
  mkdirSync(join(skills, 'release-only'), { recursive: true });
  writeFileSync(join(repo, 'release.txt'), 'release A\n');
  writeFileSync(join(skills, 'release-only', 'SKILL.md'), [
    '---',
    'name: release-only',
    'description: RELEASE_ONLY_SKILL_bfe24a',
    '---',
    '# release only',
    '',
  ].join('\n'));
  writeFileSync(capLock, '{"schemaVersion":1}\n');
  writeFileSync(manifest, '{"release":"A"}\n');
  const commit = 'a'.repeat(40);
  mkdirSync(join(repo, '.git', 'refs', 'heads'), { recursive: true });
  writeFileSync(join(repo, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  writeFileSync(join(repo, '.git', 'refs', 'heads', 'main'), `${commit}\n`);
  writeFileSync(join(repo, '.git', 'config'), '[remote "origin"]\n\turl = ssh://example.invalid/release-a.git\n');
  return {
    root,
    contract: {
      schemaVersion: 1,
      incidentKey: 'argos:alarm-a',
      eventId: 'event-a',
      candidateDispatchId: 'cand_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      releaseId: 'release-a',
      releaseManifestSha256: sha256(manifest),
      runtimeBundleId: 'runtime-a',
      botmuxCommit: candidateBotmuxCommit(),
      botmuxArtifactSha256: BOTMUX_ARTIFACT_SHA256,
      workspaceSnapshot: {
        realpath: realpathSync(repo),
        repository: 'ssh://example.invalid/release-a.git',
        commit,
      },
      capabilityLockSha256: sha256(capLock),
      skillsRoot: realpathSync(skills),
      skillsSha256: hashCandidateRuntimeTree(skills),
      executable: { realpath: COCO, sha256: sha256(COCO) },
      disabledFeatures: ['memories'],
      model: 'candidate-model-a',
      investigation: {
        title: 'alarm-a',
        symptom: 'service-a error rate elevated',
        preparedInput: { content: 'Investigate alarm-a.' },
        sourceSnapshot: null,
      },
      shadowTarget: { larkAppId: 'cli_candidate', chatId: 'oc_shadow' },
    },
  };
}

function buildArtifactFixture(): { root: string; dist: string; manifestPath: string } {
  const root = mkdtempSync(join(tmpdir(), 'botmux-build-artifact-'));
  const dist = join(root, 'dist');
  mkdirSync(join(root, 'scripts'), { recursive: true });
  mkdirSync(join(dist, 'assets'), { recursive: true });
  copyFileSync(
    join(import.meta.dirname, '..', 'scripts', 'audit-dist.mjs'),
    join(root, 'scripts', 'audit-dist.mjs'),
  );
  writeFileSync(join(root, '.gitignore'), 'dist/\n');
  writeFileSync(join(root, 'package.json'), '{"name":"candidate-botmux-fixture"}\n');
  writeFileSync(join(dist, 'index-daemon.js'), 'export const daemon = true;\n');
  writeFileSync(join(dist, 'worker.js'), 'export const worker = true;\n');
  writeFileSync(join(dist, 'index-daemon.js.map'), '{"version":3}\n');
  writeFileSync(join(dist, 'assets', 'runtime.css'), '.candidate { color: green; }\n');
  execFileSync('git', ['init', root]);
  execFileSync('git', ['-C', root, 'config', 'user.email', 'candidate@example.invalid']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'Candidate Test']);
  execFileSync('git', ['-C', root, 'remote', 'add', 'origin', 'ssh://example.invalid/botmux.git']);
  execFileSync('git', ['-C', root, 'add', '.gitignore', 'package.json', 'scripts/audit-dist.mjs']);
  execFileSync('git', ['-C', root, 'commit', '-m', 'candidate fixture']);

  const files = [
    'assets/runtime.css',
    'index-daemon.js',
    'index-daemon.js.map',
    'worker.js',
  ].map(path => ({ path, sha256: sha256(join(dist, path)) }));
  const manifestPath = join(dist, 'botmux-build-manifest.json');
  writeFileSync(manifestPath, `${JSON.stringify({
    schemaVersion: 1,
    botmuxCommit: execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    treeSha256: createHash('sha256').update(JSON.stringify(files)).digest('hex'),
    files,
  })}\n`);
  return { root, dist, manifestPath };
}

describe('Candidate runtime contract', () => {
  it('generates the build manifest only from clean source and includes every dist file', () => {
    const { root, dist } = buildArtifactFixture();
    writeFileSync(join(root, 'package.json'), '{"name":"dirty-candidate-botmux"}\n');
    expect(() => execFileSync(process.execPath, [join(root, 'scripts', 'audit-dist.mjs')], {
      cwd: root,
      encoding: 'utf8',
    })).toThrow(/clean/i);

    writeFileSync(join(root, 'package.json'), '{"name":"candidate-botmux-fixture"}\n');
    execFileSync(process.execPath, [join(root, 'scripts', 'audit-dist.mjs')], {
      cwd: root,
      encoding: 'utf8',
    });
    const manifest = JSON.parse(readFileSync(join(dist, 'botmux-build-manifest.json'), 'utf8'));
    expect(manifest.files.map((entry: { path: string }) => entry.path)).toEqual([
      'assets/runtime.css',
      'index-daemon.js',
      'index-daemon.js.map',
      'worker.js',
    ]);
    expect(manifest.treeSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('rejects added, deleted, or tampered files outside the complete dist tree summary', () => {
    const added = buildArtifactFixture();
    writeFileSync(join(added.dist, 'unmanifested-runtime.bin'), 'rogue runtime payload\n');
    expect(() => candidateBotmuxBuildIdentity(added.root)).toThrow(/artifact|dist tree/i);

    const deleted = buildArtifactFixture();
    renameSync(join(deleted.dist, 'assets', 'runtime.css'), join(deleted.root, 'runtime.css.moved'));
    expect(() => candidateBotmuxBuildIdentity(deleted.root)).toThrow(/artifact|dist tree/i);

    const tampered = buildArtifactFixture();
    writeFileSync(join(tampered.dist, 'worker.js'), 'export const worker = "tampered";\n');
    expect(() => candidateBotmuxBuildIdentity(tampered.root)).toThrow(/artifact|dist tree/i);
  });

  it('rejects artifact drift at the production launch boundary before Feishu send', async () => {
    const { root, contract } = fixture();
    writeFileSync(join(contract.workspaceSnapshot.realpath, '.git', 'refs', 'heads', 'main'), `${'b'.repeat(40)}\n`);
    const sendTopic = vi.fn();
    const dispatchTurn = vi.fn();
    await expect(launchCandidateRca({
      incidentKey: contract.incidentKey,
      candidateDispatchId: contract.candidateDispatchId,
      larkAppId: contract.shadowTarget.larkAppId,
      chatId: contract.shadowTarget.chatId,
      topicMessage: 'Candidate runtime preflight',
      launchContext: contract,
    }, {
      dataDir: root,
      ...botmuxIdentity(contract),
      sendTopic,
      findTopicByDispatch: vi.fn(),
      findSessionByRoot: vi.fn(),
      dispatchTurn,
    })).rejects.toThrow(/workspace commit mismatch/);
    expect(sendTopic).not.toHaveBeenCalled();
    expect(dispatchTurn).not.toHaveBeenCalled();
  });

  it('keeps Release A after the bot default changes to B and the Session is restored', () => {
    const { contract } = fixture();
    const restored = JSON.parse(JSON.stringify({
      session: {
        sessionId: 'session-a',
        chatId: 'oc_shadow',
        rootMessageId: 'om_root',
        title: 'Candidate A',
        status: 'active',
        createdAt: '2026-08-13T00:00:00.000Z',
        workingDir: contract.workspaceSnapshot.realpath,
        cliId: 'coco',
        cliPathOverride: contract.executable.realpath,
        model: contract.model,
        agentFrozen: true,
        candidateRuntimeContract: contract,
      },
      larkAppId: 'cli_candidate',
      chatId: 'oc_shadow',
    }));
    expect(sessionAgentConfig(restored, {
      cliId: 'claude-code',
      cliPathOverride: '/release-b/bin/claude',
      wrapperCli: 'release-b-wrapper',
      model: 'candidate-model-b',
    })).toEqual({
      cliId: 'coco',
      cliPathOverride: contract.executable.realpath,
      model: 'candidate-model-a',
    });
  });

  it('attests the real executable, argv, cwd, commit and Skills for fresh and resume', () => {
    const { root, contract } = fixture();
    expect(validateCandidateRuntimeContract(contract, {
      incidentKey: contract.incidentKey,
      candidateDispatchId: contract.candidateDispatchId,
      larkAppId: contract.shadowTarget.larkAppId,
      chatId: contract.shadowTarget.chatId,
    }, botmuxIdentity(contract))).toEqual(contract);

    const runtime = prepareCandidateCocoHome({
      contract,
      dataDir: root,
      sessionId: 'session-a',
      authFile: join(root, 'missing-auth.json'),
      cocoCacheRoot: testCocoCache(root),
    }, botmuxIdentity(contract));
    const adapter = createCocoAdapter(contract.executable.realpath);
    for (const phase of ['fresh', 'resume'] as const) {
      const args = adapter.buildArgs({
        sessionId: 'session-a',
        resume: phase === 'resume',
        workingDir: contract.workspaceSnapshot.realpath,
        model: contract.model,
        disabledFeatures: contract.disabledFeatures,
      });
      expect(args).toContain('--disable');
      expect(args[args.indexOf('--disable') + 1]).toBe('memories');
      const attestation = attestCandidateRuntimeSpawn({
        contract,
        phase,
        sessionId: 'session-a',
        // A daemon restart resets the in-memory generation counter; phase is
        // part of the durable key so resume evidence cannot overwrite fresh.
        workerGeneration: 1,
        bin: adapter.resolvedBin,
        args,
        cwd: contract.workspaceSnapshot.realpath,
        env: { HOME: runtime.home, TRAE_HOME: runtime.traeHome },
        dataDir: root,
        authFile: join(root, 'missing-auth.json'),
        cocoCacheRoot: testCocoCache(root),
        ...botmuxIdentity(contract),
      });
      expect(attestation.executable.realpath).toBe(COCO);
      expect(attestation.botmuxCommit).toBe(contract.botmuxCommit);
      expect(attestation.workspace.commit).toBe(contract.workspaceSnapshot.commit);
      expect(attestation.skills.realpath).toBe(contract.skillsRoot);
      expect(attestation.skills.sha256).toBe(contract.skillsSha256);
      expect(attestation.argv).toEqual([COCO, ...args]);
      expect(JSON.parse(readFileSync(candidateRuntimeAttestationPath(root, 'session-a', 1, phase), 'utf8')))
        .toEqual(attestation);
    }
  });

  it('fails closed before spawn when executable, commit, or Skills drift', () => {
    const executableDrift = fixture();
    const executableRuntime = prepareCandidateCocoHome({
      contract: executableDrift.contract,
      dataDir: executableDrift.root,
      sessionId: 'session-executable-drift',
      authFile: join(executableDrift.root, 'missing-auth.json'),
      cocoCacheRoot: testCocoCache(executableDrift.root),
    }, botmuxIdentity(executableDrift.contract));
    expect(() => attestCandidateRuntimeSpawn({
      contract: {
        ...executableDrift.contract,
        executable: { ...executableDrift.contract.executable, sha256: 'f'.repeat(64) },
      },
      phase: 'resume',
      sessionId: 'session-executable-drift',
      workerGeneration: 2,
      bin: executableDrift.contract.executable.realpath,
      args: ['--resume', 'session-executable-drift', '--disable', 'memories'],
      cwd: executableDrift.contract.workspaceSnapshot.realpath,
      env: { HOME: executableRuntime.home, TRAE_HOME: executableRuntime.traeHome },
      dataDir: executableDrift.root,
      authFile: join(executableDrift.root, 'missing-auth.json'),
      cocoCacheRoot: testCocoCache(executableDrift.root),
      ...botmuxIdentity(executableDrift.contract),
    })).toThrow(/executable attestation mismatch/);

    const commitDrift = fixture();
    const commitRuntime = prepareCandidateCocoHome({
      contract: commitDrift.contract,
      dataDir: commitDrift.root,
      sessionId: 'session-commit-drift',
      authFile: join(commitDrift.root, 'missing-auth.json'),
      cocoCacheRoot: testCocoCache(commitDrift.root),
    }, botmuxIdentity(commitDrift.contract));
    writeFileSync(join(commitDrift.contract.workspaceSnapshot.realpath, '.git', 'refs', 'heads', 'main'), `${'b'.repeat(40)}\n`);
    expect(() => attestCandidateRuntimeSpawn({
      contract: commitDrift.contract,
      phase: 'resume',
      sessionId: 'session-commit-drift',
      workerGeneration: 2,
      bin: commitDrift.contract.executable.realpath,
      args: ['--resume', 'session-commit-drift', '--disable', 'memories'],
      cwd: commitDrift.contract.workspaceSnapshot.realpath,
      env: { HOME: commitRuntime.home, TRAE_HOME: commitRuntime.traeHome },
      dataDir: commitDrift.root,
      authFile: join(commitDrift.root, 'missing-auth.json'),
      cocoCacheRoot: testCocoCache(commitDrift.root),
      ...botmuxIdentity(commitDrift.contract),
    })).toThrow(/workspace commit mismatch/);

    const skillsDrift = fixture();
    const runtime = prepareCandidateCocoHome({
      contract: skillsDrift.contract,
      dataDir: skillsDrift.root,
      sessionId: 'session-skills-drift',
      authFile: join(skillsDrift.root, 'missing-auth.json'),
      cocoCacheRoot: testCocoCache(skillsDrift.root),
    }, botmuxIdentity(skillsDrift.contract));
    writeFileSync(join(skillsDrift.contract.skillsRoot, 'release-only', 'SKILL.md'), '# drifted\n');
    expect(() => attestCandidateRuntimeSpawn({
      contract: skillsDrift.contract,
      phase: 'resume',
      sessionId: 'session-skills-drift',
      workerGeneration: 2,
      bin: skillsDrift.contract.executable.realpath,
      args: ['--resume', 'session-skills-drift', '--disable', 'memories'],
      cwd: skillsDrift.contract.workspaceSnapshot.realpath,
      env: { HOME: runtime.home, TRAE_HOME: runtime.traeHome },
      dataDir: skillsDrift.root,
      authFile: join(skillsDrift.root, 'missing-auth.json'),
      cocoCacheRoot: testCocoCache(skillsDrift.root),
      ...botmuxIdentity(skillsDrift.contract),
    })).toThrow(/Skills digest mismatch/);
  });

  it('real Coco binary excludes poison Memory and host Skill while keeping the frozen Release Skill', async () => {
    const { root, contract } = fixture();
    const hostTrae = join(root, 'host-trae');
    const hostHome = join(root, 'host-home');
    mkdirSync(join(hostTrae, 'cli', 'memories'), { recursive: true });
    mkdirSync(join(hostTrae, 'skills', 'host-poison'), { recursive: true });
    mkdirSync(hostHome, { recursive: true });
    writeFileSync(join(hostTrae, 'cli', 'memories', 'memory_summary.md'), 'HOST_POISON_MEMORY_714cd9\n');
    writeFileSync(join(hostTrae, 'cli', 'memories', 'MEMORY.md'), 'HOST_POISON_MEMORY_714cd9\n');
    writeFileSync(join(hostTrae, 'skills', 'host-poison', 'SKILL.md'), [
      '---',
      'name: host-poison',
      'description: HOST_POISON_SKILL_8fd933',
      '---',
      '# host poison',
      '',
    ].join('\n'));

    const enabled = (await exec(COCO, ['debug', 'prompt-input', 'probe'], {
      cwd: contract.workspaceSnapshot.realpath,
      env: { ...process.env, HOME: hostHome, TRAE_HOME: hostTrae },
      encoding: 'utf8',
    })).stdout;
    expect(enabled).toContain('HOST_POISON_MEMORY_714cd9');
    expect(enabled).toContain('HOST_POISON_SKILL_8fd933');

    const runtime = prepareCandidateCocoHome({
      contract,
      dataDir: root,
      sessionId: 'session-poison',
      authFile: join(root, 'missing-auth.json'),
      cocoCacheRoot: testCocoCache(root),
    }, botmuxIdentity(contract));
    const isolated = (await exec(COCO, ['--disable', 'memories', 'debug', 'prompt-input', 'probe'], {
      cwd: contract.workspaceSnapshot.realpath,
      env: { ...process.env, HOME: runtime.home, TRAE_HOME: runtime.traeHome },
      encoding: 'utf8',
    })).stdout;
    expect(isolated).not.toContain('HOST_POISON_MEMORY_714cd9');
    expect(isolated).not.toContain('HOST_POISON_SKILL_8fd933');
    expect(isolated).toContain('RELEASE_ONLY_SKILL_bfe24a');
  });
});
