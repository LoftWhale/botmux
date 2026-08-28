import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  setIpcAuthSecret,
  startIpcServer,
  type IpcServerHandle,
} from '../src/core/dashboard-ipc-server.js';
import { daemonIpcAuthHeaders } from '../src/core/daemon-ipc-auth.js';
import * as workerPool from '../src/core/worker-pool.js';
import * as sessionStore from '../src/services/session-store.js';

const HOST_SECRET = 'test-ipc-whiteboard-host-secret';
let handle: IpcServerHandle | null = null;

afterEach(async () => {
  if (handle) await handle.close();
  handle = null;
  setIpcAuthSecret(null);
  vi.restoreAllMocks();
});

async function postWhiteboard(sessionId: string, body: unknown): Promise<Response> {
  if (!handle) {
    setIpcAuthSecret(HOST_SECRET);
    handle = await startIpcServer({ port: 0, host: '127.0.0.1', authRequired: true });
  }
  const path = `/api/sessions/${sessionId}/whiteboard`;
  return fetch(`http://127.0.0.1:${handle.port}${path}`, {
    method: 'POST',
    headers: daemonIpcAuthHeaders({
      secret: HOST_SECRET,
      port: handle.port,
      method: 'POST',
      path,
      headers: { 'content-type': 'application/json' },
    }),
    body: JSON.stringify(body),
  });
}

function mockOwnedSession(session: Record<string, unknown>): void {
  vi.spyOn(workerPool, 'findActiveBySessionId').mockReturnValue({
    session,
    larkAppId: session.larkAppId,
  } as any);
}

describe('POST /api/sessions/:sessionId/whiteboard', () => {
  it('binds a non-empty whiteboard id onto the owned session', async () => {
    const session = { sessionId: 's-wb', larkAppId: 'app-1', whiteboardId: undefined as string | undefined };
    mockOwnedSession(session);
    const update = vi.spyOn(sessionStore, 'updateSession').mockImplementation(() => undefined);

    const res = await postWhiteboard('s-wb', { whiteboardId: 'wb_live' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, whiteboardId: 'wb_live' });
    expect(session.whiteboardId).toBe('wb_live');
    expect(update).toHaveBeenCalledOnce();
  });

  it('clears the binding when whiteboardId is null', async () => {
    const session = { sessionId: 's-wb-clear', larkAppId: 'app-1', whiteboardId: 'wb_gone' as string | undefined };
    mockOwnedSession(session);
    const update = vi.spyOn(sessionStore, 'updateSession').mockImplementation(() => undefined);

    const res = await postWhiteboard('s-wb-clear', { whiteboardId: null });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, whiteboardId: null });
    expect(session.whiteboardId).toBeUndefined();
    expect(update).toHaveBeenCalledOnce();
  });

  it('rejects an empty string (unbind is null, not "")', async () => {
    const session = { sessionId: 's-wb-empty', larkAppId: 'app-1', whiteboardId: 'wb_keep' };
    mockOwnedSession(session);
    const update = vi.spyOn(sessionStore, 'updateSession').mockImplementation(() => undefined);

    const res = await postWhiteboard('s-wb-empty', { whiteboardId: '' });
    expect(res.status).toBe(400);
    expect(session.whiteboardId).toBe('wb_keep');
    expect(update).not.toHaveBeenCalled();
  });
});
