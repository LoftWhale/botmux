import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('card-handler goal IPC fanout auth wiring', () => {
  const source = readFileSync(resolve('src/im/lark/card-handler.ts'), 'utf8');

  it('signs every loopback daemon IPC fanout with the trusted-host HMAC', () => {
    // The daemon IPC server runs with authRequired and neither goal route is on
    // the narrow capability allowlist, so a bare loopback fetch 401s — which
    // silently broke the goal decision + goal cleanup card buttons (the toast
    // claimed "no online supervisor" / "cleaned" while nothing was routed).
    expect(source).not.toContain('fetch(`http://127.0.0.1:');
    expect(source).toContain("fetchDaemonIpc(daemon.ipcPort, '/api/goal/route-parent-reply'");
    expect(source).toContain('/cleanup-local`');
  });
});
