import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { DaemonSession } from './types.js';
import { sessionKey } from './types.js';
import type { CandidateRcaLaunchReceipt } from '../services/candidate-rca-launch.js';

const CANDIDATE_LAUNCH_RECEIPT_DIR = 'candidate-rca-launches';

export type CandidateFeishuConversationResolution =
  | { kind: 'not_candidate' }
  | { kind: 'identity_gap'; reason: 'missing_root' | 'unknown_root' | 'session_not_found' }
  | { kind: 'identity_conflict'; reason: 'ambiguous_root' | 'session_mismatch' }
  | { kind: 'candidate'; incidentKey: string; candidateDispatchId: string; rootMessageId: string; botmuxSessionId: string };

function launchedCandidateReceipts(dataDir: string): CandidateRcaLaunchReceipt[] {
  const dir = join(dataDir, CANDIDATE_LAUNCH_RECEIPT_DIR);
  if (!existsSync(dir)) return [];
  const receipts: CandidateRcaLaunchReceipt[] = [];
  try {
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.json')) continue;
      try {
        const value = JSON.parse(readFileSync(join(dir, name), 'utf8')) as CandidateRcaLaunchReceipt;
        if (value?.schemaVersion === 1
          && typeof value.larkAppId === 'string'
          && typeof value.chatId === 'string') {
          receipts.push(value);
        }
      } catch {
        // A corrupt receipt is not authority for routing. Launch reconciliation
        // owns surfacing that corruption; inbound must simply fail closed.
      }
    }
  } catch {
    return [];
  }
  return receipts;
}

/** Resolve Candidate inbound identity from the durable launch receipt and the
 * canonical active-session registry. A Candidate chat is never allowed to
 * fall through to BotMux's ordinary "missing session => create" behavior. */
export function resolveCandidateFeishuConversation(input: {
  dataDir: string;
  larkAppId: string;
  chatId: string;
  rootMessageId?: string;
  activeSessions: Map<string, DaemonSession>;
}): CandidateFeishuConversationResolution {
  const chatReceipts = launchedCandidateReceipts(input.dataDir)
    .filter(receipt => receipt.larkAppId === input.larkAppId && receipt.chatId === input.chatId);
  if (chatReceipts.length === 0) return { kind: 'not_candidate' };
  if (!input.rootMessageId) return { kind: 'identity_gap', reason: 'missing_root' };

  const matches = chatReceipts.filter(receipt =>
    receipt.rootMessageId === input.rootMessageId
    && typeof receipt.botmuxSessionId === 'string'
    && receipt.botmuxSessionId.length > 0);
  if (matches.length === 0) return { kind: 'identity_gap', reason: 'unknown_root' };
  const identities = new Set(matches.map(receipt => receipt.botmuxSessionId));
  if (identities.size !== 1) return { kind: 'identity_conflict', reason: 'ambiguous_root' };

  const botmuxSessionId = matches[0]!.botmuxSessionId!;
  const active = input.activeSessions.get(sessionKey(input.rootMessageId, input.larkAppId));
  if (!active) return { kind: 'identity_gap', reason: 'session_not_found' };
  if (active.session.sessionId !== botmuxSessionId
    || active.session.rootMessageId !== input.rootMessageId
    || active.chatId !== input.chatId
    || active.larkAppId !== input.larkAppId
    || !active.session.candidateRuntimeContract) {
    return { kind: 'identity_conflict', reason: 'session_mismatch' };
  }
  return {
    kind: 'candidate',
    incidentKey: matches[0]!.incidentKey,
    candidateDispatchId: matches[0]!.candidateDispatchId,
    rootMessageId: input.rootMessageId,
    botmuxSessionId,
  };
}
