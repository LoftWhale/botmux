import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { config } from '../src/config.js';
import {
  _resetDashboardGoalStartForTest,
  resolveDashboardGoalRepoBinding,
  startDashboardGoal,
  validateDashboardGoalText,
  type DashboardGoalStartRequest,
} from '../src/core/dashboard-goal-start.js';
import { claimGoalStartMutation } from '../src/services/goal-start-mutation-store.js';
import { _resetGoalChatStoreForTest } from '../src/services/goal-chat-store.js';
import type { CreateGroupOpts, CreateGroupResult } from '../src/services/group-creator.js';

let dataDir: string;
let previousDataDir: string;

const request: DashboardGoalStartRequest = {
  clientMutationId: 'desktop-goal-1',
  title: '可信交付',
  brief: '先拆分再验收',
  supervisorLarkAppId: 'cli_supervisor',
  workers: [{ larkAppId: 'cli_worker', name: 'worker', cliId: 'codex', local: true }],
  workingDir: process.cwd(),
  userOpenIds: ['ou_owner'],
};

function groupResult(chatId = 'oc_goal'): CreateGroupResult {
  return {
    ok: true,
    chatId,
    creator: 'cli_supervisor',
    invalidBotIds: [],
    invalidUserIds: [],
    invalidOwnerUnionIds: [],
    ownerTransferredTo: 'ou_owner',
    transferError: null,
    notifyMessageId: null,
    notifyError: null,
    shareLink: 'https://example.test/goal',
    shareLinkError: null,
    oncallBindings: [],
    roleProfileBootstrapMessageId: null,
    roleProfileBootstrapError: null,
    kickoffMessageId: null,
    kickoffError: null,
  };
}

function deps(createGroup = vi.fn(async (input: CreateGroupOpts) => {
  input.onChatCreated?.('oc_goal');
  return groupResult();
})) {
  return {
    dataDir,
    ownerBootId: 'boot-1',
    createGroup,
    probeMembership: vi.fn(async () => ({
      known: true as const,
      members: [{ openId: 'ou_worker_seen', name: 'worker' }],
    })),
    startSupervisor: vi.fn(async () => ({
      ok: true as const,
      goalChatId: 'oc_goal',
      supervisorSessionId: 'session-supervisor',
    })),
    sleep: vi.fn(async () => undefined),
  };
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'dashboard-goal-start-'));
  previousDataDir = config.session.dataDir;
  config.session.dataDir = dataDir;
  _resetGoalChatStoreForTest();
  _resetDashboardGoalStartForTest();
});

afterEach(() => {
  config.session.dataDir = previousDataDir;
  _resetGoalChatStoreForTest();
  _resetDashboardGoalStartForTest();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('dashboard goal start', () => {
  it('replays a completed mutation without creating a second group', async () => {
    const d = deps();
    const first = await startDashboardGoal(request, d);
    const replay = await startDashboardGoal(request, d);

    expect(first).toEqual(replay);
    expect(first).toMatchObject({
      status: 201,
      body: { ok: true, chatId: 'oc_goal', supervisorSessionId: 'session-supervisor' },
    });
    expect(d.createGroup).toHaveBeenCalledTimes(1);
    expect(d.startSupervisor).toHaveBeenCalledTimes(1);
  });

  it('rejects reuse of a mutation id with a different payload', async () => {
    const d = deps();
    await startDashboardGoal(request, d);
    const conflict = await startDashboardGoal({ ...request, title: '另一个目标' }, d);

    expect(conflict).toMatchObject({
      status: 409,
      body: { ok: false, outcome: 'rejected', errorCode: 'client_mutation_conflict' },
    });
    expect(d.createGroup).toHaveBeenCalledTimes(1);
  });

  it('rejects a different payload even while the first mutation is in flight', async () => {
    let completeGroup!: () => void;
    const create = vi.fn((input: CreateGroupOpts) => new Promise<CreateGroupResult>((resolve) => {
      input.onChatCreated?.('oc_goal');
      completeGroup = () => resolve(groupResult());
    }));
    const d = deps(create);
    const first = startDashboardGoal(request, d);
    await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(1));

    const conflict = await startDashboardGoal({ ...request, title: '另一个目标' }, d);
    expect(conflict).toMatchObject({
      status: 409,
      body: { ok: false, outcome: 'rejected', errorCode: 'client_mutation_conflict' },
    });

    completeGroup();
    await expect(first).resolves.toMatchObject({ status: 201 });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('checkpoints chatId before later group initialization fails and replays the committed partial', async () => {
    const create = vi.fn(async (input: CreateGroupOpts) => {
      input.onChatCreated?.('oc_committed');
      throw new Error('member invitation timed out');
    });
    const d = deps(create);
    const first = await startDashboardGoal(request, d);
    const replay = await startDashboardGoal(request, d);

    expect(first).toEqual(replay);
    expect(first).toMatchObject({
      status: 502,
      body: {
        ok: false,
        outcome: 'committed',
        stage: 'group_members',
        chatId: 'oc_committed',
      },
    });
    expect(create).toHaveBeenCalledTimes(1);
    expect(d.startSupervisor).not.toHaveBeenCalled();
  });

  it('fails closed when the durable idempotency ledger is corrupt', () => {
    const dir = join(dataDir, 'verified-delivery');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'goal-start-mutations.json'), '{not-json');

    expect(() => claimGoalStartMutation({
      dataDir,
      clientMutationId: 'new-mutation',
      requestHash: 'hash',
      ownerBootId: 'boot-1',
      supervisorLarkAppId: 'cli_supervisor',
    })).toThrow('goal_start_mutation_store_corrupt');
  });

  it('does not create a group when the goal lifecycle registry is corrupt', async () => {
    const dir = join(dataDir, 'verified-delivery');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'goal-chats.json'), JSON.stringify({ goals: [{ chatId: 'oc_old' }] }));
    const d = deps();

    await expect(startDashboardGoal(request, d)).rejects.toThrow('goal_chat_store_corrupt');
    expect(d.createGroup).not.toHaveBeenCalled();
    expect(d.startSupervisor).not.toHaveBeenCalled();
  });

  it('fails closed on valid JSON with a malformed mutation record', () => {
    const dir = join(dataDir, 'verified-delivery');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'goal-start-mutations.json'), JSON.stringify({
      records: [{ version: 1, clientMutationId: 'old-side-effect', state: 'attempting' }],
    }));

    expect(() => claimGoalStartMutation({
      dataDir,
      clientMutationId: 'new-mutation',
      requestHash: 'hash',
      ownerBootId: 'boot-1',
      supervisorLarkAppId: 'cli_supervisor',
    })).toThrow('goal_start_mutation_store_corrupt');
  });

  it('fails closed when the valid JSON ledger does not contain a records array', () => {
    const dir = join(dataDir, 'verified-delivery');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'goal-start-mutations.json'), JSON.stringify({ records: {} }));

    expect(() => claimGoalStartMutation({
      dataDir,
      clientMutationId: 'new-mutation',
      requestHash: 'b'.repeat(64),
      ownerBootId: 'boot-1',
      supervisorLarkAppId: 'cli_supervisor',
    })).toThrow('goal_start_mutation_store_corrupt');
  });

  it('fails closed when a terminal mutation has a malformed response', () => {
    const dir = join(dataDir, 'verified-delivery');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'goal-start-mutations.json'), JSON.stringify({
      records: [{
        version: 1,
        clientMutationId: 'old-side-effect',
        requestHash: 'a'.repeat(64),
        ownerBootId: 'boot-old',
        supervisorLarkAppId: 'cli_supervisor',
        state: 'terminal',
        status: 201,
        response: 'not-a-structured-response',
        createdAt: new Date(1_000).toISOString(),
        updatedAt: new Date(2_000).toISOString(),
      }],
    }));

    expect(() => claimGoalStartMutation({
      dataDir,
      clientMutationId: 'new-mutation',
      requestHash: 'b'.repeat(64),
      ownerBootId: 'boot-1',
      supervisorLarkAppId: 'cli_supervisor',
    })).toThrow('goal_start_mutation_store_corrupt');
  });

  it('returns the committed chatId when the terminal checkpoint itself fails', async () => {
    const create = vi.fn(async (input: CreateGroupOpts) => {
      input.onChatCreated?.('oc_checkpointed');
      writeFileSync(join(dataDir, 'verified-delivery', 'goal-start-mutations.json'), '{corrupt');
      return groupResult('oc_checkpointed');
    });

    const result = await startDashboardGoal(request, deps(create));

    expect(result).toMatchObject({
      status: 503,
      body: {
        ok: false,
        outcome: 'committed',
        stage: 'idempotency_terminal',
        errorCode: 'terminal_checkpoint_failed',
        chatId: 'oc_checkpointed',
      },
    });
  });

  it('accepts a 50000-character brief and rejects the next character', () => {
    expect(validateDashboardGoalText('Goal', 'a'.repeat(50_000))).toBe(true);
    expect(validateDashboardGoalText('Goal', 'a'.repeat(50_001))).toBe(false);
  });

  it('fails remote workers closed when the workspace has no canonical origin', () => {
    const noOrigin = { ok: false as const, reason: 'missing_remote', detail: 'origin is missing' };
    expect(resolveDashboardGoalRepoBinding(request.workers, noOrigin)).toEqual({ ok: true });
    expect(resolveDashboardGoalRepoBinding(
      [{ ...request.workers[0]!, local: false }],
      noOrigin,
    )).toEqual({
      ok: false,
      error: 'remote workers require a canonical origin: origin is missing',
    });
    expect(resolveDashboardGoalRepoBinding(
      [{ ...request.workers[0]!, local: false }],
      { ok: true, remoteIdentity: 'github.com/acme/repo' },
    )).toEqual({ ok: true, requiredRepo: 'github.com/acme/repo' });
  });

  it('includes the canonical repo requirement in the supervisor charter brief', async () => {
    const d = deps();
    await startDashboardGoal({
      ...request,
      requiredRepo: 'github.com/acme/repo',
      workers: [{ ...request.workers[0]!, local: false }],
    }, d);

    expect(d.startSupervisor).toHaveBeenCalledWith(expect.objectContaining({
      brief: expect.stringContaining('跨设备代码任务必须使用 --needs-repo "github.com/acme/repo"'),
    }));
  });
});
