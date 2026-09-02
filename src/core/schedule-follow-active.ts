// src/core/schedule-follow-active.ts
//
// `botmux schedule add --follow-active`: a schedule that fires into the topic
// where a human most recently spoke, resolved at fire time.
//
// Three rules, each fixed by a real failure mode of the alternative:
//   1. "Most recently active" is judged by HUMAN input (Session.lastHumanMessageAt),
//      never by lastMessageAt. A sentinel that fires every 30 minutes keeps its
//      own topic "active" forever, so a bot-inclusive clock makes the schedule
//      follow itself.
//   2. The lookup spans every bot's session store. Where the person is, is a
//      property of the person, not of the bot the task belongs to.
//   3. When nothing resolves, keep the LAST landing point (task.rootMessageId,
//      which starts as the creation topic) and never open a new topic — a fire
//      that cannot find people must not manufacture a place nobody reads.
import * as sessionStore from '../services/session-store.js';
import * as scheduleStore from '../services/schedule-store.js';
import { logger } from '../utils/logger.js';
import type { ScheduledTask, Session } from '../types.js';

export type FollowActiveCandidate = Pick<Session, 'chatId' | 'rootMessageId' | 'scope' | 'lastHumanMessageAt'>;

/**
 * Pure selection: among thread-scope sessions of `chatId`, the root with the
 * newest human activity. Sessions without any human activity are ignored (a
 * topic only ever written by bots is not "where the person is"). Ties keep
 * the first candidate seen. Returns undefined when nothing qualifies.
 */
export function pickMostRecentHumanTopic(
  chatId: string,
  candidates: Iterable<FollowActiveCandidate>,
): string | undefined {
  let bestRoot: string | undefined;
  let bestAt = -Infinity;
  for (const s of candidates) {
    if (s.chatId !== chatId) continue;
    if (s.scope === 'chat') continue;
    if (!s.rootMessageId || s.rootMessageId === chatId) continue;
    if (!s.lastHumanMessageAt) continue;
    const at = Date.parse(s.lastHumanMessageAt);
    if (!Number.isFinite(at)) continue;
    if (at > bestAt) {
      bestAt = at;
      bestRoot = s.rootMessageId;
    }
  }
  return bestRoot;
}

export interface FollowActiveResolution {
  rootMessageId: string | undefined;
  /** 'active': a human-active topic was found. 'retained': fell back to the
   *  task's last landing point (its creation topic until the first fire). */
  source: 'active' | 'retained';
}

export type ListFollowActiveCandidates = (chatId: string) => Iterable<FollowActiveCandidate>;

/** Resolve where a follow-active task should land right now. Never throws. */
export function resolveFollowActiveRoot(
  task: Pick<ScheduledTask, 'chatId' | 'rootMessageId'>,
  listCandidates: ListFollowActiveCandidates = sessionStore.findActiveThreadSessionsByChat,
): FollowActiveResolution {
  let picked: string | undefined;
  try {
    picked = pickMostRecentHumanTopic(task.chatId, listCandidates(task.chatId));
  } catch (err) {
    logger.warn(`[scheduler] follow-active lookup failed for chat ${task.chatId}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (picked) return { rootMessageId: picked, source: 'active' };
  return { rootMessageId: task.rootMessageId, source: 'retained' };
}

export type PersistFollowActiveLanding = (id: string, rootMessageId: string, appId?: string) => void;

const persistViaStore: PersistFollowActiveLanding = (id, rootMessageId, appId) => {
  scheduleStore.updateTask(id, { rootMessageId }, appId);
};

/**
 * Fire-time hook. Returns the task to execute: unchanged unless it is a
 * follow-active topic task whose resolved landing point differs from the
 * retained one — then the copy carries the new rootMessageId, and the new
 * landing point is persisted so the next fallback starts from where this
 * fire actually landed. Tasks parked at top level / new-topic are left alone
 * even if the flag is still set.
 */
export function applyFollowActive(
  task: ScheduledTask,
  deps: { listCandidates?: ListFollowActiveCandidates; persist?: PersistFollowActiveLanding } = {},
): ScheduledTask {
  if (task.followActive !== true) return task;
  if (task.executionPosition !== undefined && task.executionPosition !== 'topic') return task;
  const resolved = resolveFollowActiveRoot(task, deps.listCandidates);
  if (!resolved.rootMessageId || resolved.rootMessageId === task.rootMessageId) return task;
  const persist = deps.persist ?? persistViaStore;
  try {
    persist(task.id, resolved.rootMessageId, task.larkAppId);
  } catch (err) {
    logger.warn(`[scheduler] follow-active: could not persist landing point for task ${task.id}: ${err instanceof Error ? err.message : String(err)}`);
  }
  logger.info(`[scheduler] Task "${task.name}" (${task.id}) follow-active → ${resolved.rootMessageId} (was ${task.rootMessageId ?? 'none'})`);
  return { ...task, rootMessageId: resolved.rootMessageId, scope: 'thread' };
}
