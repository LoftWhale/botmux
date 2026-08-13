/**
 * Goal chat registry.
 *
 * A goal group is an oncall working group, but it must not inherit oncall's
 * legacy "any group member can talk to every bot" shortcut. The registry is
 * an explicit, cheap truth source for the talk gate: `goal supervise` marks a
 * chat as a goal, and `evaluateTalk` checks the in-memory set.
 */
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.js';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { withFileLockSync } from '../utils/file-lock.js';
import { logger } from '../utils/logger.js';

export interface GoalChatRecord {
  chatId: string;
  title?: string;
  brief?: string;
  larkAppId?: string;
  origin?: 'l1' | 'dashboard';
  parentKind?: 'session' | 'dashboard';
  parentChatId?: string;
  parentRoot?: string;
  parentSessionId?: string;
  workingDir?: string;
  supervisorSessionId?: string;
  supervisorCreatedAt?: string;
  lastReviveAt?: string;
  reviveAttempts?: string[];
  closedAt?: string;
  closedBy?: string;
  closeMutationId?: string;
  closeReason?: string;
  createdAt: string;
  updatedAt: string;
}

interface GoalChatFile {
  goals: GoalChatRecord[];
}

export interface RegisterGoalChatInput {
  title?: string;
  brief?: string;
  now?: number;
  larkAppId?: string;
  origin?: 'l1' | 'dashboard';
  parentKind?: 'session' | 'dashboard';
  parentChatId?: string;
  parentRoot?: string;
  parentSessionId?: string;
  workingDir?: string;
  supervisorSessionId?: string;
  supervisorCreatedAt?: string;
  lastReviveAt?: string;
  reviveAttempts?: string[];
  /** Explicit user-start only: clear a prior cleanup tombstone. */
  reopen?: boolean;
}

export interface CloseGoalChatInput {
  now?: number;
  closedBy?: string;
  clientMutationId?: string;
  reason?: string;
}

export type ClaimGoalReviveResult =
  | { ok: true; record: GoalChatRecord; claimedAt: string }
  | { ok: false; errorCode: string; error: string };

let loadedFrom: string | null = null;
let loadedStatKey = '';
let goalChats = new Map<string, GoalChatRecord>();
let testOverride = false;

function storePath(): string {
  return join(config.session.dataDir, 'verified-delivery', 'goal-chats.json');
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === 'string';
}

function isIsoDate(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && Number.isFinite(Date.parse(value));
}

function isGoalChatRecord(value: unknown): value is GoalChatRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Partial<GoalChatRecord>;
  return typeof record.chatId === 'string'
    && record.chatId.trim().length > 0
    && isIsoDate(record.createdAt)
    && isIsoDate(record.updatedAt)
    && isOptionalString(record.title)
    && isOptionalString(record.brief)
    && isOptionalString(record.larkAppId)
    && (record.origin === undefined || record.origin === 'l1' || record.origin === 'dashboard')
    && (record.parentKind === undefined || record.parentKind === 'session' || record.parentKind === 'dashboard')
    && isOptionalString(record.parentChatId)
    && isOptionalString(record.parentRoot)
    && isOptionalString(record.parentSessionId)
    && isOptionalString(record.workingDir)
    && isOptionalString(record.supervisorSessionId)
    && (record.supervisorCreatedAt === undefined || isIsoDate(record.supervisorCreatedAt))
    && (record.lastReviveAt === undefined || isIsoDate(record.lastReviveAt))
    && (record.reviveAttempts === undefined
      || (Array.isArray(record.reviveAttempts) && record.reviveAttempts.every(isIsoDate)))
    && (record.closedAt === undefined || isIsoDate(record.closedAt))
    && isOptionalString(record.closedBy)
    && isOptionalString(record.closeMutationId)
    && isOptionalString(record.closeReason);
}

function corruptGoalChatStore(error: unknown): Error {
  logger.warn(`[goal-chat-store] registry is corrupt or unreadable: ${error instanceof Error ? error.message : String(error)}`);
  return new Error('goal_chat_store_corrupt');
}

function readFile(path: string): GoalChatFile {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return { goals: [] };
    throw corruptGoalChatStore(error);
  }
  try {
    const parsed = JSON.parse(raw) as Partial<GoalChatFile> | null;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !Array.isArray(parsed.goals)) {
      throw new Error('goals_not_array');
    }
    if (!parsed.goals.every(isGoalChatRecord)) throw new Error('goal_record_invalid');
    const ids = new Set(parsed.goals.map(record => record.chatId));
    if (ids.size !== parsed.goals.length) throw new Error('duplicate_goal_chat_id');
    return { goals: parsed.goals };
  } catch (error) {
    throw corruptGoalChatStore(error);
  }
}

/** Validate the authority registry before starting any external group side effect. */
export function assertGoalChatStoreReadable(dataDir: string = config.session.dataDir): void {
  readFile(join(dataDir, 'verified-delivery', 'goal-chats.json'));
}

function loadIfNeeded(): void {
  if (testOverride) return;
  const path = storePath();
  let statKey = 'missing';
  try {
    if (existsSync(path)) {
      const stat = statSync(path);
      statKey = `${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}:${stat.ino}`;
    }
  } catch {
    statKey = 'unreadable';
  }
  if (loadedFrom === path && loadedStatKey === statKey) return;
  const file = readFile(path);
  goalChats = new Map(file.goals.map((g) => [g.chatId, g]));
  loadedFrom = path;
  loadedStatKey = statKey;
}

function writeFile(next: Map<string, GoalChatRecord>): void {
  const path = storePath();
  mkdirSync(join(config.session.dataDir, 'verified-delivery'), { recursive: true });
  atomicWriteFileSync(path, JSON.stringify({ goals: [...next.values()] }, null, 2) + '\n', {
    durable: true,
    followTargetSymlink: false,
  });
  loadedFrom = null;
  loadIfNeeded();
}

function mutateGoalChats<T>(fn: (current: Map<string, GoalChatRecord>) => { next: Map<string, GoalChatRecord>; result: T }): T {
  if (testOverride) {
    const mutation = fn(new Map(goalChats));
    goalChats = mutation.next;
    return mutation.result;
  }
  const path = storePath();
  mkdirSync(join(config.session.dataDir, 'verified-delivery'), { recursive: true });
  return withFileLockSync(path, () => {
    const current = new Map(readFile(path).goals.map((record) => [record.chatId, record]));
    const mutation = fn(current);
    if (mutation.next !== current) {
      writeFile(mutation.next);
    } else {
      goalChats = current;
      loadedFrom = null;
      loadedStatKey = '';
    }
    return mutation.result;
  });
}

export function registerGoalChat(chatId: string, input: RegisterGoalChatInput = {}): GoalChatRecord {
  testOverride = false;
  const id = chatId.trim();
  if (!id) throw new Error('goal chatId is required');
  return mutateGoalChats((current) => {
    const nowIso = new Date(input.now ?? Date.now()).toISOString();
    const prev = current.get(id);
    const rec: GoalChatRecord = {
      chatId: id,
      title: input.title?.trim() || prev?.title,
      brief: input.brief ?? prev?.brief,
      larkAppId: input.larkAppId ?? prev?.larkAppId,
      origin: input.origin ?? prev?.origin,
      parentKind: input.parentKind ?? prev?.parentKind,
      parentChatId: input.parentChatId ?? prev?.parentChatId,
      parentRoot: input.parentRoot ?? prev?.parentRoot,
      parentSessionId: input.parentSessionId ?? prev?.parentSessionId,
      workingDir: input.workingDir ?? prev?.workingDir,
      supervisorSessionId: input.supervisorSessionId ?? prev?.supervisorSessionId,
      supervisorCreatedAt: input.supervisorCreatedAt ?? prev?.supervisorCreatedAt,
      lastReviveAt: input.lastReviveAt ?? prev?.lastReviveAt,
      reviveAttempts: input.reviveAttempts ?? prev?.reviveAttempts,
      closedAt: input.reopen ? undefined : prev?.closedAt,
      closedBy: input.reopen ? undefined : prev?.closedBy,
      closeMutationId: input.reopen ? undefined : prev?.closeMutationId,
      closeReason: input.reopen ? undefined : prev?.closeReason,
      createdAt: prev?.createdAt ?? nowIso,
      updatedAt: nowIso,
    };
    const next = new Map(current);
    next.set(id, rec);
    return { next, result: rec };
  });
}

export function closeGoalChat(chatId: string | undefined, input: CloseGoalChatInput = {}): GoalChatRecord | undefined {
  const id = chatId?.trim();
  if (!id) return undefined;
  return mutateGoalChats((current) => {
    const prev = current.get(id);
    if (!prev) return { next: current, result: undefined };
    if (prev.closedAt) return { next: current, result: prev };
    const nowIso = new Date(input.now ?? Date.now()).toISOString();
    const rec: GoalChatRecord = {
      ...prev,
      closedAt: nowIso,
      closedBy: input.closedBy?.trim() || prev.closedBy,
      closeMutationId: input.clientMutationId?.trim() || prev.closeMutationId,
      closeReason: input.reason?.trim() || prev.closeReason,
      updatedAt: nowIso,
    };
    const next = new Map(current);
    next.set(id, rec);
    return { next, result: rec };
  });
}

export function claimGoalChatRevive(input: {
  chatId: string;
  larkAppId: string;
  now: number;
  cooldownMs: number;
  windowMs: number;
  maxAttempts: number;
}): ClaimGoalReviveResult {
  const id = input.chatId.trim();
  if (!id) return { ok: false, errorCode: 'goal_not_registered', error: 'goal chat is not registered' };
  return mutateGoalChats<ClaimGoalReviveResult>((current) => {
    const prev = current.get(id);
    if (!prev) {
      return { next: current, result: { ok: false, errorCode: 'goal_not_registered', error: 'goal chat is not registered' } };
    }
    if (prev.closedAt) {
      return { next: current, result: { ok: false, errorCode: 'goal_closed', error: `goal chat was closed at ${prev.closedAt}` } };
    }
    if (prev.larkAppId && prev.larkAppId !== input.larkAppId) {
      return { next: current, result: { ok: false, errorCode: 'not_owner_daemon', error: `goal is owned by ${prev.larkAppId}` } };
    }
    const dashboardManaged = prev.origin === 'dashboard' || prev.parentKind === 'dashboard';
    if (!dashboardManaged && !prev.parentChatId) {
      return { next: current, result: { ok: false, errorCode: 'incomplete_goal_record', error: 'goal registry has no parentChatId' } };
    }
    const recent = (prev.reviveAttempts ?? []).filter((value) => {
      const at = Date.parse(value);
      return Number.isFinite(at) && input.now - at < input.windowMs;
    });
    const lastRevive = prev.lastReviveAt ? Date.parse(prev.lastReviveAt) : undefined;
    if (lastRevive !== undefined && Number.isFinite(lastRevive) && input.now - lastRevive < input.cooldownMs) {
      return {
        next: current,
        result: { ok: false, errorCode: 'revive_cooldown', error: `last revive was ${input.now - lastRevive}ms ago` },
      };
    }
    if (recent.length >= input.maxAttempts) {
      return {
        next: current,
        result: {
          ok: false,
          errorCode: 'revive_budget_exhausted',
          error: `goal supervisor revived ${recent.length} time(s) in ${input.windowMs}ms`,
        },
      };
    }
    const claimedAt = new Date(input.now).toISOString();
    const record: GoalChatRecord = {
      ...prev,
      larkAppId: prev.larkAppId ?? input.larkAppId,
      lastReviveAt: claimedAt,
      reviveAttempts: [...recent, claimedAt],
      updatedAt: claimedAt,
    };
    const next = new Map(current);
    next.set(id, record);
    return { next, result: { ok: true, record, claimedAt } };
  });
}

export function getGoalChat(chatId: string | undefined): GoalChatRecord | undefined {
  if (!chatId) return undefined;
  loadIfNeeded();
  return goalChats.get(chatId);
}

export function isGoalChat(chatId: string | undefined): boolean {
  if (!chatId) return false;
  loadIfNeeded();
  return goalChats.has(chatId);
}

export function listGoalChats(): GoalChatRecord[] {
  loadIfNeeded();
  return [...goalChats.values()];
}

export function _resetGoalChatStoreForTest(records: GoalChatRecord[] = []): void {
  testOverride = true;
  loadedFrom = null;
  loadedStatKey = '';
  goalChats = new Map(records.map((r) => [r.chatId, r]));
}
