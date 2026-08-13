import { createHash } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { atomicWriteFile, atomicWriteFileSync } from '../utils/atomic-write.js';
import { withFileLock, withFileLockSync } from '../utils/file-lock.js';

const RECEIPT_DIR = 'candidate-rca-turns';

export type CandidateTurnStatus = 'accepted' | 'submitted' | 'completed' | 'failed';

export interface CandidateTurnIdentity {
  incidentKey: string;
  candidateDispatchId: string;
  larkAppId: string;
  chatId: string;
  rootMessageId: string;
  botmuxSessionId: string;
  botmuxCommit: string;
  botmuxArtifactSha256: string;
  turnId: string;
}

export interface CandidateTurnAcceptInput extends CandidateTurnIdentity {
  prompt: string;
  acceptedAt?: string;
}

export type CandidateSubmitEvidence =
  | { kind: 'cli_transcript'; nativeSessionId: string; transcriptRef: string }
  | { kind: 'native_rpc'; nativeSessionId: string; transcriptRef: string };

export type CandidateTerminalEvidence = {
  kind: 'cli_transcript_terminal' | 'runtime_terminal';
  nativeSessionId: string;
  transcriptRef: string;
  output?: string;
};

export interface CandidateTurnTransition {
  status: CandidateTurnStatus;
  occurredAt: string;
  dispatchAttempt: number;
  workerGeneration: number;
  evidence: Record<string, unknown>;
}

export interface CandidateTurnReceipt extends CandidateTurnIdentity {
  schemaVersion: 1;
  sequence: number;
  inputHash: string;
  prompt: string;
  status: CandidateTurnStatus;
  dispatchAttempt: number;
  receiverBootId?: string;
  workerGeneration: number;
  nativeSessionId?: string;
  /** Durable projection cursor for Search RCA. A callback attempt is recorded
   * before the HTTP request, so a daemon crash never turns a failed/ambiguous
   * terminal delivery into an in-memory-only retry. */
  controlPlaneDelivery?: {
    acknowledgedTransitions: number;
    terminalRejectedTransitions?: number;
    attempts: number;
    nextAttemptAt?: string;
    lastError?: string;
    terminalRejection?: string;
    updatedAt: string;
  };
  /** Write-ahead fence for the user-visible answer. Both the normal worker
   * path and transcript recovery use the same provider UUID. */
  outputDelivery?: {
    status: 'dispatching' | 'delivered';
    uuid: string;
    dispatchAttempt: number;
    workerGeneration: number;
    messageId?: string;
    output?: string;
    updatedAt: string;
  };
  transitions: CandidateTurnTransition[];
  createdAt: string;
  updatedAt: string;
}

interface CandidateTurnStream {
  schemaVersion: 1;
  incidentKey: string;
  candidateDispatchId: string;
  larkAppId: string;
  chatId: string;
  rootMessageId: string;
  botmuxSessionId: string;
  botmuxCommit: string;
  botmuxArtifactSha256: string;
  turns: CandidateTurnReceipt[];
  updatedAt: string;
}

export interface CandidateTurnDispatch extends CandidateTurnIdentity {
  prompt: string;
  sequence: number;
  dispatchAttempt: number;
  workerGeneration: number;
}

export type CandidateTurnClaim =
  | { kind: 'empty' }
  | { kind: 'in_flight'; receipt: CandidateTurnReceipt }
  | { kind: 'submitted'; receipt: CandidateTurnReceipt }
  | { kind: 'dispatch'; dispatch: CandidateTurnDispatch; receipt: CandidateTurnReceipt };

export type CandidateOutputClaim =
  | { kind: 'send'; uuid: string }
  | { kind: 'ambiguous'; uuid: string }
  | { kind: 'already_delivered'; uuid: string; messageId: string };

function dispatchFromReceipt(receipt: CandidateTurnReceipt): CandidateTurnDispatch {
  return {
    incidentKey: receipt.incidentKey,
    candidateDispatchId: receipt.candidateDispatchId,
    larkAppId: receipt.larkAppId,
    chatId: receipt.chatId,
    rootMessageId: receipt.rootMessageId,
    botmuxSessionId: receipt.botmuxSessionId,
    botmuxCommit: receipt.botmuxCommit,
    botmuxArtifactSha256: receipt.botmuxArtifactSha256,
    turnId: receipt.turnId,
    prompt: receipt.prompt,
    sequence: receipt.sequence,
    dispatchAttempt: receipt.dispatchAttempt,
    workerGeneration: receipt.workerGeneration,
  };
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function inputHash(prompt: string): string {
  return createHash('sha256').update(prompt).digest('hex');
}

export function candidateTurnOutputUuid(botmuxSessionId: string, turnId: string): string {
  if (!nonEmpty(botmuxSessionId) || !nonEmpty(turnId)) {
    throw new Error('Candidate output identity gap');
  }
  return `cturn_${createHash('sha256')
    .update(`${botmuxSessionId}\0${turnId}\0output`)
    .digest('hex')
    .slice(0, 40)}`;
}

function streamName(candidateDispatchId: string): string {
  return `${createHash('sha256').update(candidateDispatchId).digest('hex')}.json`;
}

function streamPath(dataDir: string, candidateDispatchId: string): string {
  return join(dataDir, RECEIPT_DIR, streamName(candidateDispatchId));
}

function syncPath(path: string): void {
  const fd = openSync(path, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

async function durableWrite(path: string, stream: CandidateTurnStream): Promise<void> {
  await atomicWriteFile(path, `${JSON.stringify(stream, null, 2)}\n`, { mode: 0o600 });
  syncPath(path);
  syncPath(dirname(path));
}

function durableWriteSync(path: string, stream: CandidateTurnStream): void {
  atomicWriteFileSync(path, `${JSON.stringify(stream, null, 2)}\n`, { mode: 0o600 });
  syncPath(path);
  syncPath(dirname(path));
}

function readStream(dataDir: string, candidateDispatchId: string): CandidateTurnStream | undefined {
  const path = streamPath(dataDir, candidateDispatchId);
  if (!existsSync(path)) return undefined;
  const stream = JSON.parse(readFileSync(path, 'utf8')) as CandidateTurnStream;
  if (stream.schemaVersion !== 1 || stream.candidateDispatchId !== candidateDispatchId
    || !Array.isArray(stream.turns)) {
    throw new Error('Candidate turn receipt stream is corrupt');
  }
  return stream;
}

function sameStreamIdentity(stream: CandidateTurnStream, input: CandidateTurnIdentity): boolean {
  return stream.incidentKey === input.incidentKey
    && stream.candidateDispatchId === input.candidateDispatchId
    && stream.larkAppId === input.larkAppId
    && stream.chatId === input.chatId
    && stream.rootMessageId === input.rootMessageId
    && stream.botmuxSessionId === input.botmuxSessionId
    && stream.botmuxCommit === input.botmuxCommit
    && stream.botmuxArtifactSha256 === input.botmuxArtifactSha256;
}

function assertIdentity(input: CandidateTurnIdentity): void {
  for (const field of ['incidentKey', 'candidateDispatchId', 'larkAppId', 'chatId', 'rootMessageId', 'botmuxSessionId', 'botmuxCommit', 'botmuxArtifactSha256', 'turnId'] as const) {
    if (!nonEmpty(input[field])) throw new Error(`Candidate turn identity gap: ${field}`);
  }
  if (!/^[0-9a-f]{40}$/.test(input.botmuxCommit)) {
    throw new Error('Candidate turn BotMux commit must be a full lowercase git SHA');
  }
  if (!/^[0-9a-f]{64}$/.test(input.botmuxArtifactSha256)) {
    throw new Error('Candidate turn BotMux artifact must be a SHA-256 digest');
  }
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

export class CandidateTurnDurability {
  readonly dataDir: string;

  constructor({ dataDir }: { dataDir: string }) {
    this.dataDir = dataDir;
    mkdirSync(join(dataDir, RECEIPT_DIR), { recursive: true });
  }

  async accept(input: CandidateTurnAcceptInput): Promise<{ kind: 'accepted' | 'existing'; receipt: CandidateTurnReceipt }> {
    assertIdentity(input);
    if (!nonEmpty(input.prompt)) throw new Error('Candidate turn prompt is required');
    const path = streamPath(this.dataDir, input.candidateDispatchId);
    return withFileLock(path, async () => {
      let stream = readStream(this.dataDir, input.candidateDispatchId);
      if (stream && !sameStreamIdentity(stream, input)) {
        throw new Error('Candidate turn stream identity conflict');
      }
      const hash = inputHash(input.prompt);
      const existing = stream?.turns.find(turn => turn.turnId === input.turnId);
      if (existing) {
        if (existing.inputHash !== hash || existing.prompt !== input.prompt) {
          throw new Error('Candidate turn input identity conflict');
        }
        return { kind: 'existing' as const, receipt: clone(existing) };
      }
      const now = input.acceptedAt ?? new Date().toISOString();
      if (!nonEmpty(now) || Number.isNaN(Date.parse(now))) {
        throw new Error('Candidate acceptedAt must be an ISO timestamp');
      }
      if (!stream) {
        stream = {
          schemaVersion: 1,
          incidentKey: input.incidentKey,
          candidateDispatchId: input.candidateDispatchId,
          larkAppId: input.larkAppId,
          chatId: input.chatId,
          rootMessageId: input.rootMessageId,
          botmuxSessionId: input.botmuxSessionId,
          botmuxCommit: input.botmuxCommit,
          botmuxArtifactSha256: input.botmuxArtifactSha256,
          turns: [],
          updatedAt: now,
        };
      }
      const receipt: CandidateTurnReceipt = {
        schemaVersion: 1,
        ...clone(input),
        sequence: stream.turns.length + 1,
        inputHash: hash,
        status: 'accepted',
        dispatchAttempt: 0,
        workerGeneration: 0,
        transitions: [],
        createdAt: now,
        updatedAt: now,
      };
      receipt.transitions.push({
        status: 'accepted',
        occurredAt: now,
        dispatchAttempt: 0,
        workerGeneration: 0,
        evidence: { kind: 'lark_inbound', messageId: input.turnId },
      });
      stream.turns.push(receipt);
      stream.updatedAt = now;
      await durableWrite(path, stream);
      return { kind: 'accepted' as const, receipt: clone(receipt) };
    });
  }

  /** Candidate launch has to persist accepted + the exact dispatch claim from
   * triggerSessionTurn's synchronous write-ahead hook. Keeping both updates
   * under one lock guarantees the first turn has the same durable identity as
   * later Feishu follow-ups before worker IPC/fork becomes callable. */
  acceptAndClaimSync(input: CandidateTurnAcceptInput, context: {
    receiverBootId: string;
    workerGeneration: number;
  }): { receipt: CandidateTurnReceipt; dispatch: CandidateTurnDispatch } {
    assertIdentity(input);
    if (!nonEmpty(input.prompt) || !nonEmpty(context.receiverBootId)
      || !Number.isSafeInteger(context.workerGeneration) || context.workerGeneration < 1) {
      throw new Error('Candidate launch turn dispatch identity gap');
    }
    const path = streamPath(this.dataDir, input.candidateDispatchId);
    return withFileLockSync(path, () => {
      let stream = readStream(this.dataDir, input.candidateDispatchId);
      if (stream && !sameStreamIdentity(stream, input)) {
        throw new Error('Candidate turn stream identity conflict');
      }
      const hash = inputHash(input.prompt);
      let receipt = stream?.turns.find(turn => turn.turnId === input.turnId);
      if (receipt) {
        if (receipt.inputHash !== hash || receipt.prompt !== input.prompt) {
          throw new Error('Candidate turn input identity conflict');
        }
        if (receipt.status !== 'accepted') {
          throw new Error('Candidate launch turn was already submitted');
        }
        if (receipt.dispatchAttempt > 0) {
          if (receipt.receiverBootId !== context.receiverBootId
            || receipt.workerGeneration !== context.workerGeneration) {
            throw new Error('Candidate launch turn has an unresolved prior dispatch');
          }
          return { receipt: clone(receipt), dispatch: dispatchFromReceipt(receipt) };
        }
      } else {
        const now = input.acceptedAt ?? new Date().toISOString();
        if (!nonEmpty(now) || Number.isNaN(Date.parse(now))) {
          throw new Error('Candidate acceptedAt must be an ISO timestamp');
        }
        if (!stream) {
          stream = {
            schemaVersion: 1,
            incidentKey: input.incidentKey,
            candidateDispatchId: input.candidateDispatchId,
            larkAppId: input.larkAppId,
            chatId: input.chatId,
            rootMessageId: input.rootMessageId,
            botmuxSessionId: input.botmuxSessionId,
            botmuxCommit: input.botmuxCommit,
            botmuxArtifactSha256: input.botmuxArtifactSha256,
            turns: [],
            updatedAt: now,
          };
        }
        receipt = {
          schemaVersion: 1,
          ...clone(input),
          sequence: stream.turns.length + 1,
          inputHash: hash,
          status: 'accepted',
          dispatchAttempt: 0,
          workerGeneration: 0,
          transitions: [{
            status: 'accepted',
            occurredAt: now,
            dispatchAttempt: 0,
            workerGeneration: 0,
            evidence: {
              kind: 'candidate_launch',
              candidateDispatchId: input.candidateDispatchId,
            },
          }],
          createdAt: now,
          updatedAt: now,
        };
        stream.turns.push(receipt);
      }
      if (!stream || !receipt) throw new Error('Candidate launch turn persistence failed');
      const claimedAt = new Date().toISOString();
      receipt.dispatchAttempt += 1;
      receipt.receiverBootId = context.receiverBootId;
      receipt.workerGeneration = context.workerGeneration;
      receipt.updatedAt = claimedAt;
      stream.updatedAt = claimedAt;
      durableWriteSync(path, stream);
      return { receipt: clone(receipt), dispatch: dispatchFromReceipt(receipt) };
    });
  }

  async claimHead(candidateDispatchId: string, context: {
    receiverBootId: string;
    workerGeneration: number;
    fencedAttempt?: number;
  }): Promise<CandidateTurnClaim> {
    if (!nonEmpty(candidateDispatchId) || !nonEmpty(context.receiverBootId)
      || !Number.isSafeInteger(context.workerGeneration) || context.workerGeneration < 1) {
      throw new Error('Candidate turn dispatch identity gap');
    }
    const path = streamPath(this.dataDir, candidateDispatchId);
    return withFileLock(path, async () => {
      const stream = readStream(this.dataDir, candidateDispatchId);
      const receipt = stream?.turns.find(turn => turn.status !== 'completed' && turn.status !== 'failed');
      if (!stream || !receipt) return { kind: 'empty' as const };
      if (receipt.status === 'submitted') return { kind: 'submitted' as const, receipt: clone(receipt) };
      if (receipt.dispatchAttempt > 0) {
        const sameClaim = receipt.receiverBootId === context.receiverBootId
          && receipt.workerGeneration === context.workerGeneration;
        const fenced = context.fencedAttempt === receipt.dispatchAttempt;
        if (sameClaim || !fenced) return { kind: 'in_flight' as const, receipt: clone(receipt) };
      }
      const now = new Date().toISOString();
      receipt.dispatchAttempt += 1;
      receipt.receiverBootId = context.receiverBootId;
      receipt.workerGeneration = context.workerGeneration;
      receipt.updatedAt = now;
      stream.updatedAt = now;
      await durableWrite(path, stream);
      return {
        kind: 'dispatch' as const,
        dispatch: dispatchFromReceipt(receipt),
        receipt: clone(receipt),
      };
    });
  }

  async markSubmitted(input: {
    candidateDispatchId: string;
    turnId: string;
    dispatchAttempt: number;
    workerGeneration: number;
    evidence: CandidateSubmitEvidence;
  }): Promise<CandidateTurnReceipt> {
    if (!['cli_transcript', 'native_rpc'].includes(input.evidence?.kind)
      || !nonEmpty(input.evidence.nativeSessionId)
      || !nonEmpty(input.evidence.transcriptRef)) {
      throw new Error('Candidate submit confirmation must come from a durable transcript or native RPC receipt');
    }
    return this.transition(input.candidateDispatchId, input.turnId, async (stream, receipt, path) => {
      if (receipt.status === 'submitted') return clone(receipt);
      if (receipt.status !== 'accepted') throw new Error('Candidate submitted transition is invalid');
      this.assertAttempt(receipt, input);
      const now = new Date().toISOString();
      receipt.status = 'submitted';
      receipt.nativeSessionId = input.evidence.nativeSessionId;
      receipt.transitions.push({
        status: 'submitted', occurredAt: now,
        dispatchAttempt: input.dispatchAttempt, workerGeneration: input.workerGeneration,
        evidence: clone(input.evidence),
      });
      receipt.updatedAt = now;
      stream.updatedAt = now;
      await durableWrite(path, stream);
      return clone(receipt);
    });
  }

  async markTerminal(input: {
    candidateDispatchId: string;
    turnId: string;
    dispatchAttempt: number;
    workerGeneration: number;
    status: 'completed' | 'failed';
    evidence: CandidateTerminalEvidence;
  }): Promise<CandidateTurnReceipt> {
    if (!['cli_transcript_terminal', 'runtime_terminal'].includes(input.evidence?.kind)
      || !nonEmpty(input.evidence.nativeSessionId)
      || !nonEmpty(input.evidence.transcriptRef)
      || (input.status === 'completed' && !nonEmpty(input.evidence.output))) {
      throw new Error('Candidate terminal requires durable runtime evidence');
    }
    return this.transition(input.candidateDispatchId, input.turnId, async (stream, receipt, path) => {
      if (receipt.status === input.status) return clone(receipt);
      this.assertAttempt(receipt, input);
      const failedBeforeSubmission = receipt.status === 'accepted' && input.status === 'failed';
      if (receipt.status === 'accepted' && input.status === 'completed') {
        // A transcript terminal is stronger than a separate submit IPC and can
        // close the crash window where the worker observed both records before
        // the daemon persisted turn_submitted. Persist the intermediate edge
        // separately so recovery never observes accepted → completed.
        const submittedAt = new Date().toISOString();
        receipt.status = 'submitted';
        receipt.nativeSessionId = input.evidence.nativeSessionId;
        receipt.transitions.push({
          status: 'submitted', occurredAt: submittedAt,
          dispatchAttempt: input.dispatchAttempt, workerGeneration: input.workerGeneration,
          evidence: {
            kind: 'cli_transcript',
            nativeSessionId: input.evidence.nativeSessionId,
            transcriptRef: input.evidence.transcriptRef,
          },
        });
        receipt.updatedAt = submittedAt;
        stream.updatedAt = submittedAt;
        await durableWrite(path, stream);
      }
      if (receipt.status !== 'submitted' && !failedBeforeSubmission) {
        throw new Error('Candidate terminal has no submitted receipt');
      }
      if (receipt.nativeSessionId && receipt.nativeSessionId !== input.evidence.nativeSessionId) {
        throw new Error('Candidate native Session identity conflict');
      }
      const now = new Date().toISOString();
      receipt.status = input.status;
      receipt.nativeSessionId ??= input.evidence.nativeSessionId;
      receipt.transitions.push({
        status: input.status, occurredAt: now,
        dispatchAttempt: input.dispatchAttempt, workerGeneration: input.workerGeneration,
        evidence: clone(input.evidence),
      });
      receipt.updatedAt = now;
      stream.updatedAt = now;
      await durableWrite(path, stream);
      return clone(receipt);
    });
  }

  async beginControlPlaneDelivery(input: {
    candidateDispatchId: string;
    turnId: string;
    transitionCount: number;
    nextAttemptAt: string;
  }): Promise<CandidateTurnReceipt> {
    if (!Number.isSafeInteger(input.transitionCount) || input.transitionCount < 1
      || !nonEmpty(input.nextAttemptAt) || Number.isNaN(Date.parse(input.nextAttemptAt))) {
      throw new Error('Candidate control-plane delivery identity gap');
    }
    return this.transition(input.candidateDispatchId, input.turnId, async (stream, receipt, path) => {
      if (input.transitionCount > receipt.transitions.length) {
        throw new Error('Candidate control-plane delivery exceeds durable history');
      }
      const now = new Date().toISOString();
      const previous = receipt.controlPlaneDelivery;
      receipt.controlPlaneDelivery = {
        acknowledgedTransitions: previous?.acknowledgedTransitions ?? 0,
        attempts: (previous?.attempts ?? 0) + 1,
        nextAttemptAt: input.nextAttemptAt,
        updatedAt: now,
      };
      receipt.updatedAt = now;
      stream.updatedAt = now;
      await durableWrite(path, stream);
      return clone(receipt);
    });
  }

  async markControlPlaneDelivered(input: {
    candidateDispatchId: string;
    turnId: string;
    transitionCount: number;
  }): Promise<CandidateTurnReceipt> {
    return this.transition(input.candidateDispatchId, input.turnId, async (stream, receipt, path) => {
      if (!Number.isSafeInteger(input.transitionCount) || input.transitionCount < 1
        || input.transitionCount > receipt.transitions.length) {
        throw new Error('Candidate control-plane acknowledgement is invalid');
      }
      const now = new Date().toISOString();
      const previous = receipt.controlPlaneDelivery;
      receipt.controlPlaneDelivery = {
        acknowledgedTransitions: Math.max(
          previous?.acknowledgedTransitions ?? 0,
          input.transitionCount,
        ),
        attempts: previous?.attempts ?? 1,
        updatedAt: now,
      };
      receipt.updatedAt = now;
      stream.updatedAt = now;
      await durableWrite(path, stream);
      return clone(receipt);
    });
  }

  async markControlPlaneRejected(input: {
    candidateDispatchId: string;
    turnId: string;
    transitionCount: number;
    error: string;
  }): Promise<CandidateTurnReceipt> {
    return this.transition(input.candidateDispatchId, input.turnId, async (stream, receipt, path) => {
      if (!Number.isSafeInteger(input.transitionCount) || input.transitionCount < 1
        || input.transitionCount > receipt.transitions.length
        || !receipt.controlPlaneDelivery) {
        throw new Error('Candidate control-plane rejection is invalid');
      }
      const now = new Date().toISOString();
      receipt.controlPlaneDelivery = {
        acknowledgedTransitions: receipt.controlPlaneDelivery.acknowledgedTransitions,
        terminalRejectedTransitions: input.transitionCount,
        attempts: receipt.controlPlaneDelivery.attempts,
        terminalRejection: input.error.slice(0, 500),
        updatedAt: now,
      };
      receipt.updatedAt = now;
      stream.updatedAt = now;
      await durableWrite(path, stream);
      return clone(receipt);
    });
  }

  async markControlPlaneDeliveryFailed(input: {
    candidateDispatchId: string;
    turnId: string;
    error: string;
  }): Promise<CandidateTurnReceipt> {
    return this.transition(input.candidateDispatchId, input.turnId, async (stream, receipt, path) => {
      if (!receipt.controlPlaneDelivery) {
        throw new Error('Candidate control-plane delivery attempt is missing');
      }
      const now = new Date().toISOString();
      receipt.controlPlaneDelivery.lastError = input.error.slice(0, 500);
      receipt.controlPlaneDelivery.updatedAt = now;
      receipt.updatedAt = now;
      stream.updatedAt = now;
      await durableWrite(path, stream);
      return clone(receipt);
    });
  }

  async claimOutputDelivery(input: {
    candidateDispatchId: string;
    turnId: string;
    dispatchAttempt: number;
    workerGeneration: number;
    uuid: string;
  }): Promise<CandidateOutputClaim> {
    if (!nonEmpty(input.uuid)) throw new Error('Candidate output UUID is required');
    return this.transition(input.candidateDispatchId, input.turnId, async (stream, receipt, path) => {
      this.assertAttempt(receipt, input);
      const existing = receipt.outputDelivery;
      if (existing) {
        if (existing.uuid !== input.uuid
          || existing.dispatchAttempt !== input.dispatchAttempt
          || existing.workerGeneration !== input.workerGeneration) {
          throw new Error('Candidate output delivery identity conflict');
        }
        if (existing.status === 'delivered' && existing.messageId) {
          return { kind: 'already_delivered' as const, uuid: existing.uuid, messageId: existing.messageId };
        }
        return { kind: 'ambiguous' as const, uuid: existing.uuid };
      }
      const now = new Date().toISOString();
      receipt.outputDelivery = {
        status: 'dispatching',
        uuid: input.uuid,
        dispatchAttempt: input.dispatchAttempt,
        workerGeneration: input.workerGeneration,
        updatedAt: now,
      };
      receipt.updatedAt = now;
      stream.updatedAt = now;
      await durableWrite(path, stream);
      return { kind: 'send' as const, uuid: input.uuid };
    });
  }

  async markOutputDelivered(input: {
    candidateDispatchId: string;
    turnId: string;
    dispatchAttempt: number;
    workerGeneration: number;
    uuid: string;
    messageId: string;
    output: string;
  }): Promise<CandidateTurnReceipt> {
    if (!nonEmpty(input.uuid) || !nonEmpty(input.messageId) || !nonEmpty(input.output)) {
      throw new Error('Candidate output delivery receipt is incomplete');
    }
    return this.transition(input.candidateDispatchId, input.turnId, async (stream, receipt, path) => {
      this.assertAttempt(receipt, input);
      const existing = receipt.outputDelivery;
      if (!existing || existing.uuid !== input.uuid
        || existing.dispatchAttempt !== input.dispatchAttempt
        || existing.workerGeneration !== input.workerGeneration) {
        throw new Error('Candidate output delivery identity conflict');
      }
      if (existing.status === 'delivered') {
        if (existing.messageId !== input.messageId || existing.output !== input.output) {
          throw new Error('Candidate output message identity conflict');
        }
        return clone(receipt);
      }
      const now = new Date().toISOString();
      receipt.outputDelivery = {
        ...existing,
        status: 'delivered',
        messageId: input.messageId,
        output: input.output,
        updatedAt: now,
      };
      receipt.updatedAt = now;
      stream.updatedAt = now;
      await durableWrite(path, stream);
      return clone(receipt);
    });
  }

  recoveryPlan(candidateDispatchId: string, receiverBootId: string):
    | { kind: 'none' }
    | { kind: 'dispatch'; turnId: string }
    | { kind: 'fence_then_replay'; turnId: string; dispatchAttempt: number; workerGeneration: number }
    | { kind: 'reconcile_transcript'; turnId: string; dispatchAttempt: number; workerGeneration: number } {
    const receipt = readStream(this.dataDir, candidateDispatchId)?.turns
      .find(turn => turn.status !== 'completed' && turn.status !== 'failed');
    if (!receipt) return { kind: 'none' };
    if (receipt.status === 'submitted') {
      return {
        kind: 'reconcile_transcript', turnId: receipt.turnId,
        dispatchAttempt: receipt.dispatchAttempt, workerGeneration: receipt.workerGeneration,
      };
    }
    if (receipt.dispatchAttempt > 0) {
      return {
        kind: 'fence_then_replay', turnId: receipt.turnId,
        dispatchAttempt: receipt.dispatchAttempt, workerGeneration: receipt.workerGeneration,
      };
    }
    return { kind: 'dispatch', turnId: receipt.turnId };
  }

  get(candidateDispatchId: string, turnId: string): CandidateTurnReceipt | undefined {
    const receipt = readStream(this.dataDir, candidateDispatchId)?.turns.find(turn => turn.turnId === turnId);
    return receipt ? clone(receipt) : undefined;
  }

  list(candidateDispatchId: string): CandidateTurnReceipt[] {
    return clone(readStream(this.dataDir, candidateDispatchId)?.turns ?? []);
  }

  listHeads(): CandidateTurnReceipt[] {
    const dir = join(this.dataDir, RECEIPT_DIR);
    if (!existsSync(dir)) return [];
    const heads: CandidateTurnReceipt[] = [];
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.json')) continue;
      try {
        const stream = JSON.parse(readFileSync(join(dir, name), 'utf8')) as CandidateTurnStream;
        if (stream.schemaVersion !== 1 || !Array.isArray(stream.turns)) continue;
        const head = stream.turns.find(turn => turn.status !== 'completed' && turn.status !== 'failed');
        if (head) heads.push(clone(head));
      } catch {
        // Corrupt state is not recovery authority. The launch/turn callback
        // surfaces the file error when that exact stream is touched.
      }
    }
    return heads.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  listReceipts(): CandidateTurnReceipt[] {
    const dir = join(this.dataDir, RECEIPT_DIR);
    if (!existsSync(dir)) return [];
    const receipts: CandidateTurnReceipt[] = [];
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.json')) continue;
      try {
        const stream = JSON.parse(readFileSync(join(dir, name), 'utf8')) as CandidateTurnStream;
        if (stream.schemaVersion === 1 && Array.isArray(stream.turns)) {
          receipts.push(...stream.turns.map(clone));
        }
      } catch { /* fail closed for this corrupt stream */ }
    }
    return receipts.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  private assertAttempt(receipt: CandidateTurnReceipt, input: {
    dispatchAttempt: number;
    workerGeneration: number;
  }): void {
    if (receipt.dispatchAttempt !== input.dispatchAttempt
      || receipt.workerGeneration !== input.workerGeneration) {
      throw new Error('Candidate turn callback belongs to a stale dispatch attempt');
    }
  }

  private transition<T>(candidateDispatchId: string, turnId: string, mutate: (
    stream: CandidateTurnStream,
    receipt: CandidateTurnReceipt,
    path: string,
  ) => Promise<T>): Promise<T> {
    const path = streamPath(this.dataDir, candidateDispatchId);
    return withFileLock(path, async () => {
      const stream = readStream(this.dataDir, candidateDispatchId);
      const receipt = stream?.turns.find(turn => turn.turnId === turnId);
      if (!stream || !receipt) throw new Error('Candidate turn receipt not found');
      return mutate(stream, receipt, path);
    });
  }
}
