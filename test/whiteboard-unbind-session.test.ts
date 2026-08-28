import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { seedPersistedSessionRows, readPersistedSessionRows } from './helpers/session-store-disk.js';

const ipc = vi.hoisted(() => ({
  daemon: null as { larkAppId: string; ipcPort: number } | null,
  fetchOk: true,
  fetches: [] as Array<{ port: number; path: string; body: unknown }>,
}));

let tempDir: string;

vi.mock('../src/config.js', () => ({
  config: { session: { get dataDir() { return tempDir; } } },
}));

vi.mock('../src/global-config.js', () => ({
  readGlobalConfig: () => ({ whiteboard: { enabled: true } }),
}));

vi.mock('../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));

vi.mock('../src/utils/daemon-discovery.js', () => ({
  findOnlineDaemon: (larkAppId: string) => (
    ipc.daemon?.larkAppId === larkAppId ? ipc.daemon : null
  ),
}));

vi.mock('../src/core/daemon-ipc-auth.js', () => ({
  loadDaemonIpcSecret: () => 'test-secret',
  fetchDaemonIpc: async (port: number, path: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    ipc.fetches.push({ port, path, body });
    return { ok: ipc.fetchOk, json: async () => ({ ok: ipc.fetchOk }) };
  },
}));

import { createWhiteboard, deleteWhiteboard } from '../src/services/whiteboard-store.js';

describe('deleteWhiteboard session unbind', () => {
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'botmux-wb-unbind-'));
    mkdirSync(join(tempDir, 'whiteboards'), { recursive: true });
    ipc.daemon = null;
    ipc.fetchOk = true;
    ipc.fetches = [];
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('writes the row offline when no owning daemon is visible', async () => {
    const board = createWhiteboard({
      id: 'delete_offline',
      title: 't',
      larkAppId: 'app1',
      chatId: 'c1',
    });
    seedPersistedSessionRows(tempDir, 'app1', {
      s1: {
        sessionId: 's1',
        chatId: 'c1',
        rootMessageId: 'r',
        title: 's',
        status: 'active',
        createdAt: new Date().toISOString(),
        larkAppId: 'app1',
        whiteboardId: board.id,
      },
    });

    const result = await deleteWhiteboard(board.id);
    expect(result).toEqual({ ok: true, id: board.id, clearedSessions: 1 });
    expect(ipc.fetches).toEqual([]);
    expect(readPersistedSessionRows(tempDir, 'app1').s1.whiteboardId).toBeUndefined();
  });

  it('clears via owning-daemon IPC and does not write the row behind a live cache', async () => {
    const board = createWhiteboard({
      id: 'delete_ipc',
      title: 't',
      larkAppId: 'app1',
      chatId: 'c1',
    });
    seedPersistedSessionRows(tempDir, 'app1', {
      s1: {
        sessionId: 's1',
        chatId: 'c1',
        rootMessageId: 'r',
        title: 's',
        status: 'active',
        createdAt: new Date().toISOString(),
        larkAppId: 'app1',
        whiteboardId: board.id,
      },
    });
    ipc.daemon = { larkAppId: 'app1', ipcPort: 18765 };

    const result = await deleteWhiteboard(board.id);
    expect(result.clearedSessions).toBe(1);
    expect(ipc.fetches).toEqual([{
      port: 18765,
      path: '/api/sessions/s1/whiteboard',
      body: { whiteboardId: null },
    }]);
    expect(readPersistedSessionRows(tempDir, 'app1').s1.whiteboardId).toBe(board.id);
  });

  it('does not offline-write when a daemon is visible but IPC fails (abortIf)', async () => {
    const board = createWhiteboard({
      id: 'delete_abort',
      title: 't',
      larkAppId: 'app1',
      chatId: 'c1',
    });
    seedPersistedSessionRows(tempDir, 'app1', {
      s1: {
        sessionId: 's1',
        chatId: 'c1',
        rootMessageId: 'r',
        title: 's',
        status: 'active',
        createdAt: new Date().toISOString(),
        larkAppId: 'app1',
        whiteboardId: board.id,
      },
    });
    ipc.daemon = { larkAppId: 'app1', ipcPort: 18765 };
    ipc.fetchOk = false;

    const result = await deleteWhiteboard(board.id);
    expect(result.clearedSessions).toBe(0);
    expect(readPersistedSessionRows(tempDir, 'app1').s1.whiteboardId).toBe(board.id);
  });
});
