import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { withFileLockSync } from '../utils/file-lock.js';

export type GoalStartMutationState = 'attempting' | 'chat-created' | 'terminal';

export interface GoalStartMutationRecord {
  version: 1;
  clientMutationId: string;
  requestHash: string;
  ownerBootId: string;
  supervisorLarkAppId: string;
  state: GoalStartMutationState;
  chatId?: string;
  shareLink?: string;
  status?: number;
  response?: unknown;
  createdAt: string;
  updatedAt: string;
}

export type ClaimGoalStartMutationResult =
  | { kind: 'claimed'; record: GoalStartMutationRecord }
  | { kind: 'replay'; record: GoalStartMutationRecord; status: number; response: unknown }
  | { kind: 'conflict'; record: GoalStartMutationRecord }
  | { kind: 'in-progress'; record: GoalStartMutationRecord }
  | { kind: 'resume'; record: GoalStartMutationRecord }
  | { kind: 'outcome-unknown'; record: GoalStartMutationRecord };

interface GoalStartMutationFile {
  records: GoalStartMutationRecord[];
}

function storePath(dataDir: string): string {
  return join(dataDir, 'verified-delivery', 'goal-start-mutations.json');
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || isNonEmptyString(value);
}

function isTerminalResponse(value: unknown): value is { ok: boolean } {
  return !!value
    && typeof value === 'object'
    && !Array.isArray(value)
    && typeof (value as { ok?: unknown }).ok === 'boolean';
}

function isGoalStartMutationRecord(value: unknown): value is GoalStartMutationRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Partial<GoalStartMutationRecord>;
  if (record.version !== 1
    || !isNonEmptyString(record.clientMutationId)
    || typeof record.requestHash !== 'string'
    || !/^[a-f0-9]{64}$/.test(record.requestHash)
    || !isNonEmptyString(record.ownerBootId)
    || !isNonEmptyString(record.supervisorLarkAppId)
    || !['attempting', 'chat-created', 'terminal'].includes(record.state ?? '')
    || !isOptionalString(record.chatId)
    || !isOptionalString(record.shareLink)
    || !isNonEmptyString(record.createdAt)
    || !Number.isFinite(Date.parse(record.createdAt))
    || !isNonEmptyString(record.updatedAt)
    || !Number.isFinite(Date.parse(record.updatedAt))) {
    return false;
  }
  if (record.shareLink !== undefined && record.chatId === undefined) return false;
  if (record.state === 'attempting') {
    return record.chatId === undefined
      && record.shareLink === undefined
      && record.status === undefined
      && record.response === undefined;
  }
  if (record.state === 'chat-created') {
    return record.chatId !== undefined
      && record.status === undefined
      && record.response === undefined;
  }
  if (!Number.isInteger(record.status)
    || record.status! < 100
    || record.status! > 599
    || !isTerminalResponse(record.response)) {
    return false;
  }
  return record.response.ok
    ? record.status! >= 200 && record.status! < 300
    : record.status! >= 400;
}

function load(path: string): GoalStartMutationFile {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return { records: [] };
    throw new Error('goal_start_mutation_store_corrupt');
  }
  try {
    const parsed = JSON.parse(raw) as Partial<GoalStartMutationFile> | null;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('file_not_object');
    if (!Array.isArray(parsed.records)) throw new Error('records_not_array');
    const records = parsed.records as unknown[];
    if (!records.every(isGoalStartMutationRecord)) throw new Error('record_invalid');
    const ids = new Set(records.map(record => record.clientMutationId));
    if (ids.size !== records.length) throw new Error('duplicate_client_mutation_id');
    return { records };
  } catch {
    // A corrupt idempotency ledger cannot authorize another external create.
    throw new Error('goal_start_mutation_store_corrupt');
  }
}

function save(path: string, records: GoalStartMutationRecord[]): void {
  mkdirSync(dirname(path), { recursive: true });
  atomicWriteFileSync(path, JSON.stringify({ records }, null, 2) + '\n', {
    durable: true,
    followTargetSymlink: false,
  });
}

function mutate<T>(dataDir: string, fn: (records: GoalStartMutationRecord[]) => T): T {
  const path = storePath(dataDir);
  mkdirSync(join(dataDir, 'verified-delivery'), { recursive: true });
  return withFileLockSync(path, () => fn(load(path).records));
}

export function goalStartRequestHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function claimGoalStartMutation(input: {
  dataDir: string;
  clientMutationId: string;
  requestHash: string;
  ownerBootId: string;
  supervisorLarkAppId: string;
  now?: number;
}): ClaimGoalStartMutationResult {
  return mutate(input.dataDir, (records) => {
    const existing = records.find(record => record.clientMutationId === input.clientMutationId);
    if (existing) {
      if (existing.requestHash !== input.requestHash) return { kind: 'conflict', record: existing };
      if (existing.state === 'terminal' && existing.status !== undefined) {
        return { kind: 'replay', record: existing, status: existing.status, response: existing.response };
      }
      if (existing.state === 'chat-created' && existing.chatId) return { kind: 'resume', record: existing };
      if (existing.ownerBootId === input.ownerBootId) return { kind: 'in-progress', record: existing };
      return { kind: 'outcome-unknown', record: existing };
    }
    const now = new Date(input.now ?? Date.now()).toISOString();
    const record: GoalStartMutationRecord = {
      version: 1,
      clientMutationId: input.clientMutationId,
      requestHash: input.requestHash,
      ownerBootId: input.ownerBootId,
      supervisorLarkAppId: input.supervisorLarkAppId,
      state: 'attempting',
      createdAt: now,
      updatedAt: now,
    };
    save(storePath(input.dataDir), [...records, record]);
    return { kind: 'claimed', record };
  });
}

export function checkpointGoalStartChat(input: {
  dataDir: string;
  clientMutationId: string;
  requestHash: string;
  chatId: string;
  shareLink?: string;
  now?: number;
}): GoalStartMutationRecord {
  return mutate(input.dataDir, (records) => {
    const index = records.findIndex(record => record.clientMutationId === input.clientMutationId);
    const previous = records[index];
    if (!previous || previous.requestHash !== input.requestHash) throw new Error('goal_start_mutation_not_owned');
    if (previous.chatId && previous.chatId !== input.chatId) throw new Error('goal_start_chat_conflict');
    const record: GoalStartMutationRecord = {
      ...previous,
      state: previous.state === 'terminal' ? 'terminal' : 'chat-created',
      chatId: input.chatId,
      shareLink: input.shareLink ?? previous.shareLink,
      updatedAt: new Date(input.now ?? Date.now()).toISOString(),
    };
    const next = [...records];
    next[index] = record;
    save(storePath(input.dataDir), next);
    return record;
  });
}

export function finishGoalStartMutation(input: {
  dataDir: string;
  clientMutationId: string;
  requestHash: string;
  status: number;
  response: unknown;
  chatId?: string;
  shareLink?: string;
  now?: number;
}): GoalStartMutationRecord {
  return mutate(input.dataDir, (records) => {
    const index = records.findIndex(record => record.clientMutationId === input.clientMutationId);
    const previous = records[index];
    if (!previous || previous.requestHash !== input.requestHash) throw new Error('goal_start_mutation_not_owned');
    const record: GoalStartMutationRecord = {
      ...previous,
      state: 'terminal',
      chatId: input.chatId ?? previous.chatId,
      shareLink: input.shareLink ?? previous.shareLink,
      status: input.status,
      response: input.response,
      updatedAt: new Date(input.now ?? Date.now()).toISOString(),
    };
    const next = [...records];
    next[index] = record;
    save(storePath(input.dataDir), next);
    return record;
  });
}
