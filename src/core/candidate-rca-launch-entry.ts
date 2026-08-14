import type { DaemonSession } from './types.js';
import { sessionKey } from './types.js';
import { triggerSessionTurn } from './trigger-session.js';
import { listChatMessagesUntil, sendMessage } from '../im/lark/client.js';
import {
  launchCandidateRca,
  candidateRcaTopicContent,
  readCandidateRcaLaunchReceipt,
  type CandidateRcaLaunchRequest,
  type CandidateRcaLaunchResult,
} from '../services/candidate-rca-launch.js';
import type { CandidateBotmuxIdentityOptions } from '../services/candidate-runtime-contract.js';
import {
  CandidateTurnDurability,
  type CandidateTurnReceipt,
} from '../services/candidate-turn-durability.js';
import { getDaemonBootId } from './worker-pool.js';
import type { TriggerRequest } from '../services/trigger-types.js';

const CANDIDATE_TOPIC_RECONCILE_MAX_MESSAGES = 500;
const CANDIDATE_TOPIC_RECONCILE_CLOCK_SKEW_MS = 5 * 60 * 1000;
let launchTurnReceiptReporter: ((receipt: CandidateTurnReceipt) => void) | undefined;
let launchTurnRecovery: ((session: DaemonSession, receipt: CandidateTurnReceipt) => Promise<void>)
  | undefined;

export function setCandidateLaunchTurnReceiptReporter(
  reporter: ((receipt: CandidateTurnReceipt) => void) | undefined,
): void {
  launchTurnReceiptReporter = reporter;
}

export function setCandidateLaunchTurnRecovery(
  recovery: ((session: DaemonSession, receipt: CandidateTurnReceipt) => Promise<void>) | undefined,
): void {
  launchTurnRecovery = recovery;
}

export interface CandidateRcaDaemonEntryDeps extends CandidateBotmuxIdentityOptions {
  dataDir: string;
  larkAppId: string;
  activeSessions: Map<string, DaemonSession>;
  sessionsReady: boolean;
}

export class CandidateRcaSessionRestorePendingError extends Error {
  constructor() {
    super('Candidate RCA session restore pending');
    this.name = 'CandidateRcaSessionRestorePendingError';
  }
}

function activeSessionIdByRoot(
  rootMessageId: string,
  larkAppId: string,
  activeSessions: Map<string, DaemonSession>,
): string | undefined {
  const active = activeSessions.get(sessionKey(rootMessageId, larkAppId));
  return active?.session.sessionId;
}

function candidateTriggerRequest(
  request: CandidateRcaLaunchRequest,
  rootMessageId: string,
  botmuxSessionId?: string,
): TriggerRequest {
  return {
    source: {
      type: 'webhook',
      connectorId: 'search-rca-candidate',
      requestId: request.candidateDispatchId,
    },
    target: {
      kind: 'turn',
      botId: request.larkAppId,
      chatId: request.chatId,
      rootMessageId,
      ...(botmuxSessionId ? { sessionId: botmuxSessionId } : {}),
    },
    envelope: {
      format: 'search-rca.candidate-launch.v1',
      sourceName: 'Search RCA Candidate',
      trusted: false,
      // Runtime identity travels through the trusted internal option below.
      // The model-facing event must contain the alarm itself, not merely the
      // attestation that selects its runtime.
      payload: structuredClone(request.launchContext.investigation),
    },
    presentation: { topicMessage: null },
  };
}

function larkTextContent(message: any): string | undefined {
  const raw = message?.body?.content;
  if (typeof raw !== 'string') return undefined;
  try {
    const parsed = JSON.parse(raw) as { text?: unknown };
    return typeof parsed.text === 'string' ? parsed.text : undefined;
  } catch {
    return undefined;
  }
}

async function candidateTopicIdByDispatch(
  candidateDispatchId: string,
  larkAppId: string,
  chatId: string,
  topicMessage: string,
  receiptCreatedAt: string,
): Promise<string | undefined> {
  const expectedContent = candidateRcaTopicContent(topicMessage, candidateDispatchId);
  const receiptCreatedAtMs = Date.parse(receiptCreatedAt);
  const oldestRelevantMs = Number.isFinite(receiptCreatedAtMs)
    ? receiptCreatedAtMs - CANDIDATE_TOPIC_RECONCILE_CLOCK_SKEW_MS
    : undefined;
  const messages = await listChatMessagesUntil(larkAppId, chatId, {
    pageSize: 50,
    stopAfter: (message, seenCount) => {
      if (seenCount >= CANDIDATE_TOPIC_RECONCILE_MAX_MESSAGES) return true;
      const messageCreatedAtMs = Number(message?.create_time);
      return oldestRelevantMs !== undefined
        && Number.isFinite(messageCreatedAtMs)
        && messageCreatedAtMs < oldestRelevantMs;
    },
  });
  const matches = messages
    .filter(message => message?.msg_type === 'text' && larkTextContent(message) === expectedContent)
    .map(message => message?.message_id)
    .filter((messageId): messageId is string => typeof messageId === 'string' && messageId.length > 0);
  const identities = [...new Set(matches)];
  if (identities.length > 1) {
    throw new Error('candidate dispatch maps to multiple Feishu topics');
  }
  return identities[0];
}

/** Production adapter from the authenticated daemon route to the existing
 * programmatic trigger/session path. It never opens a topic through
 * triggerSessionTurn: the durable launch ledger creates the root first and
 * then supplies that exact root as the target. */
export async function launchCandidateRcaFromDaemon(
  request: CandidateRcaLaunchRequest,
  deps: CandidateRcaDaemonEntryDeps,
): Promise<CandidateRcaLaunchResult> {
  if (!deps.sessionsReady) {
    throw new CandidateRcaSessionRestorePendingError();
  }
  if (request.larkAppId !== deps.larkAppId) {
    return { ok: false, reason: 'identity_conflict' };
  }
  const existingLaunchTurn = new CandidateTurnDurability({ dataDir: deps.dataDir })
    .get(request.candidateDispatchId, request.candidateDispatchId);
  const existingSession = existingLaunchTurn
    ? [...deps.activeSessions.values()].find(
      candidate => candidate.session.sessionId === existingLaunchTurn.botmuxSessionId,
    )
    : undefined;
  if (existingLaunchTurn && existingSession) {
    const receipt = readCandidateRcaLaunchReceipt(deps.dataDir, request.candidateDispatchId);
    if (receipt && (receipt.incidentKey !== request.incidentKey
      || receipt.candidateDispatchId !== request.candidateDispatchId
      || receipt.larkAppId !== request.larkAppId
      || receipt.chatId !== request.chatId)) {
      return { ok: false, reason: 'identity_conflict' };
    }
    if ((!existingSession.worker || existingSession.worker.killed) && launchTurnRecovery) {
      await launchTurnRecovery(existingSession, existingLaunchTurn);
    }
    if (receipt?.rootMessageId && receipt.botmuxSessionId) {
      return { ok: true, ...receipt, status: 'launched' };
    }
  }
  return launchCandidateRca(request, {
    dataDir: deps.dataDir,
    ...(deps.botmuxSourceRoot ? { botmuxSourceRoot: deps.botmuxSourceRoot } : {}),
    ...(deps.observeBotmuxIdentity ? { observeBotmuxIdentity: deps.observeBotmuxIdentity } : {}),
    sendTopic: ({ larkAppId, chatId, content, uuid, timeoutMs }) => (
      sendMessage(larkAppId, chatId, content, 'text', uuid, undefined, { requestTimeoutMs: timeoutMs })
    ),
    findTopicByDispatch: candidateTopicIdByDispatch,
    findSessionByRoot: (rootMessageId, larkAppId) => (
      activeSessionIdByRoot(rootMessageId, larkAppId, deps.activeSessions)
    ),
    prepareLaunchTurn: ({
      request: frozenRequest,
      rootMessageId,
      botmuxSessionId,
      stableTurnId,
      prompt,
      workerGeneration,
    }) => {
      const claimed = new CandidateTurnDurability({ dataDir: deps.dataDir }).acceptAndClaimSync({
        incidentKey: frozenRequest.incidentKey,
        candidateDispatchId: frozenRequest.candidateDispatchId,
        releaseId: frozenRequest.launchContext.releaseId,
        releaseManifestSha256: frozenRequest.launchContext.releaseManifestSha256,
        runtimeBundleId: frozenRequest.launchContext.runtimeBundleId,
        larkAppId: frozenRequest.larkAppId,
        chatId: frozenRequest.chatId,
        rootMessageId,
        botmuxSessionId,
        botmuxCommit: frozenRequest.launchContext.botmuxCommit,
        botmuxArtifactSha256: frozenRequest.launchContext.botmuxArtifactSha256,
        turnId: stableTurnId,
        prompt,
      }, {
        receiverBootId: getDaemonBootId(),
        workerGeneration,
      });
      launchTurnReceiptReporter?.(claimed.receipt);
      return { dispatchAttempt: claimed.dispatch.dispatchAttempt };
    },
    dispatchTurn: async ({
      request: frozenRequest,
      rootMessageId,
      stableTurnId,
      botmuxSessionId,
      beforeDispatch,
    }) => {
      const result = await triggerSessionTurn(
        candidateTriggerRequest(frozenRequest, rootMessageId, botmuxSessionId),
        { larkAppId: deps.larkAppId, activeSessions: deps.activeSessions },
        {
          stableTurnId,
          beforeDispatch,
          candidateRuntimeContract: frozenRequest.launchContext,
        },
      );
      return {
        ok: result.ok,
        ...(result.target?.sessionId ? { sessionId: result.target.sessionId } : {}),
        ...(result.error ? { error: result.error } : {}),
      };
    },
  });
}
