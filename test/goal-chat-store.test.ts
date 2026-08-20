import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { config } from '../src/config.js';
import {
  _resetGoalChatStoreForTest,
  claimGoalChatRevive,
  closeGoalChat,
  getGoalChat,
  isGoalChat,
  registerGoalChat,
} from '../src/services/goal-chat-store.js';

let dir: string;
let previousDataDir: string;

beforeEach(() => {
  previousDataDir = config.session.dataDir;
  dir = mkdtempSync(join(tmpdir(), 'goal-chat-store-'));
  config.session.dataDir = dir;
  _resetGoalChatStoreForTest();
});

afterEach(() => {
  config.session.dataDir = previousDataDir;
  _resetGoalChatStoreForTest();
  rmSync(dir, { recursive: true, force: true });
});

describe('goal chat store', () => {
  it('preserves cleanup tombstones across ordinary updates and clears them only on explicit reopen', () => {
    registerGoalChat('oc_goal', {
      larkAppId: 'cli_main', parentChatId: 'oc_parent', title: 'Goal', now: 1_000,
    });
    closeGoalChat('oc_goal', { closedBy: 'ou_owner', now: 2_000 });

    registerGoalChat('oc_goal', { supervisorSessionId: 'late-session', now: 3_000 });
    expect(getGoalChat('oc_goal')).toMatchObject({
      closedAt: new Date(2_000).toISOString(),
      closedBy: 'ou_owner',
      supervisorSessionId: 'late-session',
    });

    registerGoalChat('oc_goal', { reopen: true, supervisorSessionId: 'new-session', now: 4_000 });
    expect(getGoalChat('oc_goal')).toMatchObject({ supervisorSessionId: 'new-session' });
    expect(getGoalChat('oc_goal')?.closedAt).toBeUndefined();
    expect(getGoalChat('oc_goal')?.closedBy).toBeUndefined();
  });

  it('claims revive budget before external work so a concurrent attempt sees cooldown', () => {
    registerGoalChat('oc_goal', {
      larkAppId: 'cli_main', parentChatId: 'oc_parent', title: 'Goal', now: 1_000,
    });
    const options = {
      chatId: 'oc_goal', larkAppId: 'cli_main', now: 100_000,
      cooldownMs: 60_000, windowMs: 10 * 60_000, maxAttempts: 2,
    };

    const first = claimGoalChatRevive(options);
    const concurrent = claimGoalChatRevive(options);

    expect(first).toMatchObject({ ok: true, claimedAt: new Date(options.now).toISOString() });
    expect(concurrent).toMatchObject({ ok: false, errorCode: 'revive_cooldown' });
    expect(getGoalChat('oc_goal')?.reviveAttempts).toEqual([new Date(options.now).toISOString()]);

    const second = claimGoalChatRevive({ ...options, now: options.now + options.cooldownMs + 1 });
    const exhausted = claimGoalChatRevive({ ...options, now: options.now + 2 * options.cooldownMs + 2 });
    expect(second).toMatchObject({ ok: true });
    expect(exhausted).toMatchObject({ ok: false, errorCode: 'revive_budget_exhausted' });
  });

  it('allows a dashboard-managed goal to revive without fake L1 coordinates', () => {
    registerGoalChat('oc_dashboard_goal', {
      larkAppId: 'cli_main',
      origin: 'dashboard',
      parentKind: 'dashboard',
      title: 'Desktop goal',
      now: 1_000,
    });

    expect(claimGoalChatRevive({
      chatId: 'oc_dashboard_goal', larkAppId: 'cli_main', now: 100_000,
      cooldownMs: 60_000, windowMs: 10 * 60_000, maxAttempts: 2,
    })).toMatchObject({
      ok: true,
      record: { origin: 'dashboard', parentKind: 'dashboard' },
    });
  });

  it('keeps the first close tombstone stable across repeated close mutations', () => {
    registerGoalChat('oc_dashboard_goal', {
      larkAppId: 'cli_main', origin: 'dashboard', parentKind: 'dashboard', now: 1_000,
    });
    const first = closeGoalChat('oc_dashboard_goal', {
      closedBy: 'dashboard', clientMutationId: 'close-1', reason: 'user stopped goal', now: 2_000,
    });
    const repeated = closeGoalChat('oc_dashboard_goal', {
      closedBy: 'dashboard', clientMutationId: 'close-2', reason: 'duplicate request', now: 3_000,
    });

    expect(first).toMatchObject({
      closedAt: new Date(2_000).toISOString(),
      closeMutationId: 'close-1',
      closeReason: 'user stopped goal',
    });
    expect(repeated).toEqual(first);
    expect(claimGoalChatRevive({
      chatId: 'oc_dashboard_goal', larkAppId: 'cli_main', now: 100_000,
      cooldownMs: 60_000, windowMs: 10 * 60_000, maxAttempts: 2,
    })).toMatchObject({ ok: false, errorCode: 'goal_closed' });
  });

  it('fails closed without overwriting a malformed lifecycle registry', () => {
    const registryDir = join(dir, 'verified-delivery');
    const registryPath = join(registryDir, 'goal-chats.json');
    mkdirSync(registryDir, { recursive: true });
    const malformed = JSON.stringify({ goals: [{ chatId: 'oc_existing', createdAt: 'not-a-date' }] });
    writeFileSync(registryPath, malformed);

    expect(() => registerGoalChat('oc_new', {
      larkAppId: 'cli_main', origin: 'dashboard', parentKind: 'dashboard', now: 1_000,
    })).toThrow('goal_chat_store_corrupt');
    expect(readFileSync(registryPath, 'utf8')).toBe(malformed);
  });

  it('isGoalChat fails open on a corrupt registry so message routing keeps working', () => {
    const registryDir = join(dir, 'verified-delivery');
    mkdirSync(registryDir, { recursive: true });
    writeFileSync(join(registryDir, 'goal-chats.json'), '{not json');
    // Leave the in-memory test override: a writer hitting the corrupt file
    // fails closed and switches the store back to the on-disk registry.
    expect(() => registerGoalChat('oc_new', { larkAppId: 'cli_main', now: 1_000 }))
      .toThrow('goal_chat_store_corrupt');

    // The hot routing path (evaluateTalk oncall quota exemption) must not throw.
    expect(isGoalChat('oc_any')).toBe(false);
    // Lifecycle accessors still fail closed on the same corrupt registry.
    expect(() => getGoalChat('oc_any')).toThrow('goal_chat_store_corrupt');
  });

  it('serializes registry mutations with a stale-recoverable shared lock', () => {
    const registryDir = join(dir, 'verified-delivery');
    mkdirSync(registryDir, { recursive: true });
    const lockPath = join(registryDir, 'goal-chats.json.lock');
    writeFileSync(lockPath, '99999999');
    const staleAt = new Date(Date.now() - 10_000);
    utimesSync(lockPath, staleAt, staleAt);

    registerGoalChat('oc_goal', { larkAppId: 'cli_main', parentChatId: 'oc_parent', now: 1_000 });

    expect(getGoalChat('oc_goal')?.parentChatId).toBe('oc_parent');
    expect(existsSync(lockPath)).toBe(false);
  });
});
