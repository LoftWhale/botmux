import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  bytecloudKeychainCandidates,
  readBytecloudKeychainJwt,
} from '../src/adapters/backend/riff-backend.js';

const LEAF = join('bytecloud-auth', 'keychain', 'auth', 'cn', 'default');

describe('bytecloudKeychainCandidates — cross-platform path generation', () => {
  const HOME = '/home/tester';
  // env with no XDG overrides
  const bare = {} as NodeJS.ProcessEnv;

  it('covers the config-dir CLIs under ~/.config (Linux)', () => {
    const c = bytecloudKeychainCandidates(HOME, bare);
    for (const cli of ['kaboo-cli', 'aiden-cli', 'cjadk']) {
      expect(c).toContain(join(HOME, '.config', cli, LEAF));
    }
  });

  it('covers the config-dir CLIs under ~/Library/Application Support (macOS)', () => {
    const c = bytecloudKeychainCandidates(HOME, bare);
    for (const cli of ['kaboo-cli', 'aiden-cli', 'cjadk']) {
      expect(c).toContain(join(HOME, 'Library', 'Application Support', cli, LEAF));
    }
  });

  it('covers the home dot-dir layouts (~/.cjadk, ~/.aipaas)', () => {
    const c = bytecloudKeychainCandidates(HOME, bare);
    expect(c).toContain(join(HOME, '.cjadk', LEAF));
    expect(c).toContain(join(HOME, '.aipaas', LEAF));
  });

  it('covers bytedcli under XDG data dir with the extra data/ segment — the Mac-verified path', () => {
    const c = bytecloudKeychainCandidates(HOME, bare);
    // bytedcli honours ~/.local/share even on macOS (empirically confirmed)
    expect(c).toContain(join(HOME, '.local', 'share', 'bytedcli', 'data', LEAF));
    // and the Application Support fallback is present too (belt-and-suspenders)
    expect(c).toContain(join(HOME, 'Library', 'Application Support', 'bytedcli', 'data', LEAF));
  });

  it('honours $XDG_CONFIG_HOME override, listed before the ~/.config default', () => {
    const env = { XDG_CONFIG_HOME: '/custom/cfg' } as NodeJS.ProcessEnv;
    const c = bytecloudKeychainCandidates(HOME, env);
    const custom = join('/custom/cfg', 'kaboo-cli', LEAF);
    const fallback = join(HOME, '.config', 'kaboo-cli', LEAF);
    expect(c).toContain(custom);
    expect(c).toContain(fallback);
    expect(c.indexOf(custom)).toBeLessThan(c.indexOf(fallback));
  });

  it('honours $XDG_DATA_HOME override for bytedcli, before the ~/.local/share default', () => {
    const env = { XDG_DATA_HOME: '/custom/data' } as NodeJS.ProcessEnv;
    const c = bytecloudKeychainCandidates(HOME, env);
    const custom = join('/custom/data', 'bytedcli', 'data', LEAF);
    const fallback = join(HOME, '.local', 'share', 'bytedcli', 'data', LEAF);
    expect(c).toContain(custom);
    expect(c).toContain(fallback);
    expect(c.indexOf(custom)).toBeLessThan(c.indexOf(fallback));
  });

  it('produces no duplicates even when XDG overrides collide with defaults', () => {
    const env = {
      XDG_CONFIG_HOME: join(HOME, '.config'),
      XDG_DATA_HOME: join(HOME, '.local', 'share'),
    } as NodeJS.ProcessEnv;
    const c = bytecloudKeychainCandidates(HOME, env);
    expect(c.length).toBe(new Set(c).size);
  });

  it('every candidate ends with the keychain leaf (never the metadata credentials.json)', () => {
    const c = bytecloudKeychainCandidates(HOME, bare);
    for (const p of c) expect(p.endsWith(LEAF)).toBe(true);
    expect(c.some((p) => p.includes('credentials.json'))).toBe(false);
  });
});

describe('readBytecloudKeychainJwt — token extraction', () => {
  let home: string;
  const bare = {} as NodeJS.ProcessEnv;

  const writeKeychain = (relRoot: string, body: unknown) => {
    const dir = join(home, relRoot, 'bytecloud-auth', 'keychain', 'auth', 'cn');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'default'), JSON.stringify(body), 'utf-8');
  };

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'riff-keychain-'));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it('returns null when no keychain file exists anywhere', () => {
    expect(readBytecloudKeychainJwt(home, bare)).toBeNull();
  });

  it('reads bytecloud_jwt from kaboo-cli under ~/.config (Linux)', () => {
    writeKeychain(join('.config', 'kaboo-cli'), {
      access_token: 'a', bytecloud_jwt: 'JWT-KABOO', refresh_token: 'r',
    });
    expect(readBytecloudKeychainJwt(home, bare)).toBe('JWT-KABOO');
  });

  it('reads bytecloud_jwt from bytedcli data dir (the Mac-verified layout)', () => {
    writeKeychain(join('.local', 'share', 'bytedcli', 'data'), {
      access_token: 'a', bytecloud_jwt: 'JWT-BYTEDCLI', refresh_token: 'r',
    });
    expect(readBytecloudKeychainJwt(home, bare)).toBe('JWT-BYTEDCLI');
  });

  it('reads bytecloud_jwt from macOS Application Support (config-style CLI)', () => {
    writeKeychain(join('Library', 'Application Support', 'aiden-cli'), {
      bytecloud_jwt: 'JWT-MAC-AIDEN',
    });
    expect(readBytecloudKeychainJwt(home, bare)).toBe('JWT-MAC-AIDEN');
  });

  it('does NOT read the sibling credentials.json (metadata form has no bytecloud_jwt)', () => {
    // Write ONLY the metadata form (auth/cn/credentials.json, no keychain/ segment).
    const dir = join(home, '.config', 'kaboo-cli', 'bytecloud-auth', 'auth', 'cn');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'credentials.json'), JSON.stringify({
      app_id: 'x', expires_at: 123, user: 'u', // note: NO bytecloud_jwt
    }), 'utf-8');
    expect(readBytecloudKeychainJwt(home, bare)).toBeNull();
  });

  it('skips a keychain file whose bytecloud_jwt is empty and keeps scanning', () => {
    // kaboo has an empty token; bytedcli has a real one — later candidate wins.
    writeKeychain(join('.config', 'kaboo-cli'), { bytecloud_jwt: '' });
    writeKeychain(join('.local', 'share', 'bytedcli', 'data'), { bytecloud_jwt: 'JWT-REAL' });
    expect(readBytecloudKeychainJwt(home, bare)).toBe('JWT-REAL');
  });

  it('skips a malformed (non-JSON) keychain file without throwing', () => {
    const dir = join(home, '.config', 'kaboo-cli', 'bytecloud-auth', 'keychain', 'auth', 'cn');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'default'), 'not-json{{{', 'utf-8');
    writeKeychain(join('.cjadk'), { bytecloud_jwt: 'JWT-CJADK' });
    expect(readBytecloudKeychainJwt(home, bare)).toBe('JWT-CJADK');
  });

  it('honours XDG_DATA_HOME when resolving the bytedcli keychain', () => {
    const xdgData = join(home, 'xdg-data');
    const dir = join(xdgData, 'bytedcli', 'data', 'bytecloud-auth', 'keychain', 'auth', 'cn');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'default'), JSON.stringify({ bytecloud_jwt: 'JWT-XDG' }), 'utf-8');
    const env = { XDG_DATA_HOME: xdgData } as NodeJS.ProcessEnv;
    expect(readBytecloudKeychainJwt(home, env)).toBe('JWT-XDG');
  });
});
