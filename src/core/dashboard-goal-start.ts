import { buildGoalStartBrief } from '../cli/goal-start.js';
import type { CreateGroupOpts, CreateGroupResult } from '../services/group-creator.js';
import {
  checkpointGoalStartChat,
  claimGoalStartMutation,
  finishGoalStartMutation,
  goalStartRequestHash,
} from '../services/goal-start-mutation-store.js';
import { assertGoalChatStoreReadable, registerGoalChat } from '../services/goal-chat-store.js';
import {
  evaluateDispatchReadiness,
  resolveDispatchMentionIdentities,
  type A2APeerCapability,
  type ChatBotMembershipProbe,
} from './a2a-readiness.js';
import type {
  GoalSuperviseError,
  GoalSuperviseRequest,
  GoalSuperviseResponse,
} from './goal-supervisor.js';

export interface DashboardGoalStartWorker {
  larkAppId: string;
  name: string;
  cliId?: string;
  unionId?: string;
  botmuxVersion?: string;
  a2aCapabilities?: string[];
  local: boolean;
}

export interface DashboardGoalStartRequest {
  clientMutationId: string;
  title: string;
  brief?: string;
  supervisorLarkAppId: string;
  workers: DashboardGoalStartWorker[];
  workingDir: string;
  requiredRepo?: string;
  userOpenIds?: string[];
  ownerUnionIds?: string[];
  transferOwnerTo?: string;
  notifyOwnerOpenId?: string;
}

export interface DashboardGoalStartResult {
  status: number;
  body: Record<string, unknown>;
}

export interface DashboardGoalStartDeps {
  dataDir: string;
  ownerBootId: string;
  createGroup: (input: CreateGroupOpts) => Promise<CreateGroupResult>;
  probeMembership: (larkAppId: string, chatId: string) => Promise<ChatBotMembershipProbe>;
  startSupervisor: (
    input: GoalSuperviseRequest,
  ) => Promise<GoalSuperviseResponse | GoalSuperviseError>;
  sleep?: (ms: number) => Promise<void>;
}

export const DASHBOARD_GOAL_TITLE_MAX_LENGTH = 200;
export const DASHBOARD_GOAL_BRIEF_MAX_LENGTH = 50_000;

export type DashboardGoalRepoInspection =
  | { ok: true; remoteIdentity: string }
  | { ok: false; reason: string; detail?: string };

const inFlight = new Map<string, Promise<DashboardGoalStartResult>>();

export function validateDashboardGoalText(title: string, brief?: string): boolean {
  return title.length > 0
    && title.length <= DASHBOARD_GOAL_TITLE_MAX_LENGTH
    && (brief?.length ?? 0) <= DASHBOARD_GOAL_BRIEF_MAX_LENGTH;
}

export function resolveDashboardGoalRepoBinding(
  workers: DashboardGoalStartWorker[],
  inspection: DashboardGoalRepoInspection,
): { ok: true; requiredRepo?: string } | { ok: false; error: string } {
  if (inspection.ok) return { ok: true, requiredRepo: inspection.remoteIdentity };
  if (!workers.some(worker => !worker.local)) return { ok: true };
  return {
    ok: false,
    error: `remote workers require a canonical origin: ${inspection.detail ?? inspection.reason}`,
  };
}

function canonicalRequest(req: DashboardGoalStartRequest): Record<string, unknown> {
  return {
    title: req.title,
    brief: req.brief ?? '',
    supervisorLarkAppId: req.supervisorLarkAppId,
    workerLarkAppIds: req.workers.map(worker => worker.larkAppId),
    workingDir: req.workingDir,
    requiredRepo: req.requiredRepo ?? '',
  };
}

function failure(input: {
  outcome: 'rejected' | 'committed' | 'unknown';
  stage: string;
  errorCode: string;
  error: string;
  chatId?: string;
  shareLink?: string;
  extra?: Record<string, unknown>;
}): Record<string, unknown> {
  return {
    ok: false,
    outcome: input.outcome,
    stage: input.stage,
    errorCode: input.errorCode,
    error: input.error,
    ...(input.chatId ? { chatId: input.chatId } : {}),
    ...(input.shareLink ? { shareLink: input.shareLink } : {}),
    ...input.extra,
  };
}

function terminal(
  req: DashboardGoalStartRequest,
  deps: DashboardGoalStartDeps,
  requestHash: string,
  result: DashboardGoalStartResult,
  chatId?: string,
  shareLink?: string,
): DashboardGoalStartResult {
  try {
    finishGoalStartMutation({
      dataDir: deps.dataDir,
      clientMutationId: req.clientMutationId,
      requestHash,
      status: result.status,
      response: result.body,
      chatId,
      shareLink,
    });
    return result;
  } catch (error) {
    return {
      status: 503,
      body: failure({
        outcome: chatId ? 'committed' : 'unknown',
        stage: 'idempotency_terminal',
        errorCode: 'terminal_checkpoint_failed',
        error: error instanceof Error ? error.message : String(error),
        chatId,
        shareLink,
      }),
    };
  }
}

async function resolveReadiness(
  req: DashboardGoalStartRequest,
  deps: DashboardGoalStartDeps,
  chatId: string,
): Promise<{
  ok: boolean;
  issues: ReturnType<typeof evaluateDispatchReadiness>['issues'];
  mentionOpenIds: string[];
}> {
  const specs = req.workers.map(worker => ({
    openId: worker.larkAppId,
    name: worker.name,
    larkAppId: worker.larkAppId,
    cliId: worker.cliId,
    unionId: worker.unionId,
    local: worker.local,
  }));
  const peers: A2APeerCapability[] = req.workers.map(worker => ({
    larkAppId: worker.larkAppId,
    unionId: worker.unionId,
    name: worker.name,
    cliId: worker.cliId,
    botmuxVersion: worker.botmuxVersion,
    a2aCapabilities: worker.a2aCapabilities,
  }));
  let membership: ChatBotMembershipProbe = { known: false, members: [], reason: 'not_probed' };
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      membership = await deps.probeMembership(req.supervisorLarkAppId, chatId);
    } catch (error) {
      membership = { known: false, members: [], reason: error instanceof Error ? error.message : String(error) };
    }
    const resolution = resolveDispatchMentionIdentities({ workers: specs, membership, peers });
    if (!resolution.issues.some(issue => issue.severity === 'error') || attempt === 3) break;
    await (deps.sleep ?? ((ms) => new Promise(resolve => setTimeout(resolve, ms))))(500);
  }
  const readiness = evaluateDispatchReadiness({ workers: specs, membership, peers });
  const resolution = resolveDispatchMentionIdentities({ workers: specs, membership, peers });
  return {
    ok: readiness.ok,
    issues: readiness.issues,
    mentionOpenIds: resolution.workers.map(worker => worker.openId),
  };
}

async function startDashboardGoalInner(
  req: DashboardGoalStartRequest,
  deps: DashboardGoalStartDeps,
): Promise<DashboardGoalStartResult> {
  // Goal registry tombstones are an authority boundary. A corrupt registry
  // cannot be treated as empty before creating an irreversible Feishu group.
  assertGoalChatStoreReadable(deps.dataDir);
  const requestHash = goalStartRequestHash(canonicalRequest(req));
  const claim = claimGoalStartMutation({
    dataDir: deps.dataDir,
    clientMutationId: req.clientMutationId,
    requestHash,
    ownerBootId: deps.ownerBootId,
    supervisorLarkAppId: req.supervisorLarkAppId,
  });
  if (claim.kind === 'replay') {
    return { status: claim.status, body: claim.response as Record<string, unknown> };
  }
  if (claim.kind === 'conflict') {
    return { status: 409, body: failure({
      outcome: 'rejected', stage: 'claim', errorCode: 'client_mutation_conflict',
      error: 'clientMutationId was already used with a different request',
    }) };
  }
  if (claim.kind === 'in-progress') {
    return { status: 409, body: failure({
      outcome: 'unknown', stage: claim.record.state, errorCode: 'mutation_in_progress',
      error: 'the matching goal start is still in progress', chatId: claim.record.chatId,
    }) };
  }
  if (claim.kind === 'outcome-unknown') {
    return { status: 409, body: failure({
      outcome: 'unknown', stage: claim.record.state, errorCode: 'start_outcome_unknown',
      error: 'a previous daemon stopped before the goal creation outcome was checkpointed',
      chatId: claim.record.chatId,
    }) };
  }

  let chatId = claim.kind === 'resume' ? claim.record.chatId : undefined;
  let shareLink = claim.kind === 'resume' ? claim.record.shareLink : undefined;
  let group: CreateGroupResult | undefined;
  if (!chatId) {
    try {
      group = await deps.createGroup({
        creatorLarkAppId: req.supervisorLarkAppId,
        larkAppIds: [req.supervisorLarkAppId, ...req.workers.map(worker => worker.larkAppId)],
        name: req.title,
        userOpenIds: req.userOpenIds,
        ownerUnionIds: req.ownerUnionIds,
        transferOwnerTo: req.transferOwnerTo,
        notifyOwnerOpenId: req.notifyOwnerOpenId,
        onChatCreated: createdChatId => {
          chatId = createdChatId;
          checkpointGoalStartChat({
            dataDir: deps.dataDir,
            clientMutationId: req.clientMutationId,
            requestHash,
            chatId: createdChatId,
          });
          registerGoalChat(createdChatId, {
            title: req.title,
            brief: req.brief,
            larkAppId: req.supervisorLarkAppId,
            workingDir: req.workingDir,
            origin: 'dashboard',
            parentKind: 'dashboard',
          });
        },
      });
      chatId = group.chatId;
      shareLink = group.shareLink ?? undefined;
      checkpointGoalStartChat({
        dataDir: deps.dataDir,
        clientMutationId: req.clientMutationId,
        requestHash,
        chatId,
        shareLink,
      });
    } catch (error) {
      const body = failure({
        outcome: chatId ? 'committed' : 'unknown',
        stage: chatId ? 'group_members' : 'group_create',
        errorCode: chatId ? 'group_initialization_failed' : 'group_create_outcome_unknown',
        error: error instanceof Error ? error.message : String(error),
        chatId,
      });
      return terminal(req, deps, requestHash, { status: 502, body }, chatId, shareLink);
    }
  } else {
    try {
      registerGoalChat(chatId, {
        title: req.title, brief: req.brief, larkAppId: req.supervisorLarkAppId,
        workingDir: req.workingDir, origin: 'dashboard', parentKind: 'dashboard',
      });
    } catch (error) {
      const body = failure({
        outcome: 'committed', stage: 'goal_registry', errorCode: 'goal_register_failed',
        error: error instanceof Error ? error.message : String(error), chatId, shareLink,
      });
      return terminal(req, deps, requestHash, { status: 503, body }, chatId, shareLink);
    }
  }

  if (group?.invalidBotIds.length) {
    const body = failure({
      outcome: 'committed', stage: 'group_members', errorCode: 'group_members_incomplete',
      error: 'the goal group was created but one or more selected bots could not join',
      chatId, shareLink, extra: { invalidBotIds: group.invalidBotIds },
    });
    return terminal(req, deps, requestHash, { status: 409, body }, chatId, shareLink);
  }

  let readiness: Awaited<ReturnType<typeof resolveReadiness>>;
  try {
    readiness = await resolveReadiness(req, deps, chatId);
  } catch (error) {
    const body = failure({
      outcome: 'committed', stage: 'group_readiness', errorCode: 'group_readiness_failed',
      error: error instanceof Error ? error.message : String(error), chatId, shareLink,
    });
    return terminal(req, deps, requestHash, { status: 502, body }, chatId, shareLink);
  }
  if (!readiness.ok) {
    const body = failure({
      outcome: 'committed', stage: 'group_readiness', errorCode: 'group_not_dispatch_ready',
      error: 'the goal group exists but selected workers do not have reliable mention identities',
      chatId, shareLink, extra: { readiness: { ok: false, issues: readiness.issues } },
    });
    return terminal(req, deps, requestHash, { status: 409, body }, chatId, shareLink);
  }

  const effectiveBrief = buildGoalStartBrief({
    brief: req.brief,
    supervisorName: req.supervisorLarkAppId,
    workers: req.workers.map((worker, index) => ({
      name: worker.name,
      larkAppId: worker.larkAppId,
      mentionOpenId: readiness.mentionOpenIds[index],
      local: worker.local,
    })),
    localWorkingDir: req.workingDir,
    requiredRepo: req.requiredRepo,
  });
  let supervised: GoalSuperviseResponse | GoalSuperviseError;
  try {
    supervised = await deps.startSupervisor({
      chatId,
      origin: 'dashboard',
      parentKind: 'dashboard',
      title: req.title,
      brief: effectiveBrief,
      workingDir: req.workingDir,
    });
  } catch (error) {
    const body = failure({
      outcome: 'committed', stage: 'supervise', errorCode: 'supervisor_start_failed',
      error: error instanceof Error ? error.message : String(error), chatId, shareLink,
    });
    return terminal(req, deps, requestHash, { status: 502, body }, chatId, shareLink);
  }
  if (!supervised.ok) {
    const body = failure({
      outcome: 'committed', stage: 'supervise', errorCode: supervised.errorCode,
      error: supervised.error, chatId, shareLink,
    });
    return terminal(req, deps, requestHash, { status: 502, body }, chatId, shareLink);
  }

  const warnings = [
    ...readiness.issues.filter(issue => issue.severity === 'warning').map(issue => issue.detail),
    ...(group?.invalidUserIds.length ? [`users_not_invited:${group.invalidUserIds.join(',')}`] : []),
    ...(group?.invalidOwnerUnionIds.length ? [`owners_not_invited:${group.invalidOwnerUnionIds.join(',')}`] : []),
    ...(group?.transferError ? [`owner_transfer:${group.transferError}`] : []),
  ];
  const body = {
    ok: true,
    stage: 'supervised',
    chatId,
    ...(shareLink ? { shareLink } : {}),
    supervisorSessionId: supervised.supervisorSessionId,
    workers: req.workers,
    ...(warnings.length ? { warnings } : {}),
  };
  return terminal(req, deps, requestHash, { status: 201, body }, chatId, shareLink);
}

export function startDashboardGoal(
  req: DashboardGoalStartRequest,
  deps: DashboardGoalStartDeps,
): Promise<DashboardGoalStartResult> {
  const requestHash = goalStartRequestHash(canonicalRequest(req));
  const key = `${deps.dataDir}\0${req.clientMutationId}\0${requestHash}`;
  const existing = inFlight.get(key);
  if (existing) return existing;
  const started = startDashboardGoalInner(req, deps).finally(() => {
    if (inFlight.get(key) === started) inFlight.delete(key);
  });
  inFlight.set(key, started);
  return started;
}

export function _resetDashboardGoalStartForTest(): void {
  inFlight.clear();
}
