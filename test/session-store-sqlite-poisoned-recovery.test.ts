import { describe, expect, it } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSyncBunTsEvalWithRepoImports } from './helpers/ts-runner.js';

/**
 * Recovery of a session store POISONED by the pre-fix WAL import (see
 * session-store-sqlite-bun-import.test.ts for the bug that produced them).
 *
 * WHY THESE RUN UNDER A REAL BUN CHILD. The poisoned shape only exists on Bun:
 * `db.close()` there skips the WAL checkpoint while a prepared statement is
 * still alive, so the rows stay in `<db>.tmp-wal` and `renameSync` publishes a
 * bare 4096-byte header. vitest's test body ALWAYS executes under Node (even
 * via `bun x vitest`), where all four close shapes checkpoint correctly — so an
 * in-process assertion here would be structurally incapable of reproducing the
 * fixture, and would pass against a completely broken implementation. Every
 * case below therefore builds the fixture and exercises production `load()`
 * inside a spawned Bun process that reports its own runtime back.
 *
 * The fixture kills itself with SIGKILL on purpose: Bun settles the WAL along
 * still-open fds at clean exit, which would repair the store before the test
 * could observe it.
 */

function pinnedBunVersion(): string {
  const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as {
    packageManager?: string;
  };
  const match = /^bun@(.+)$/.exec(pkg.packageManager ?? '');
  if (!match) throw new Error(`packageManager is not pinned to Bun: ${pkg.packageManager}`);
  return match[1];
}

const SESSION_ROWS = 40;

function frozenJsonRows(): Record<string, unknown> {
  const rows: Record<string, unknown> = {};
  for (let i = 0; i < SESSION_ROWS; i++) {
    rows[`s${i}`] = {
      sessionId: `s${i}`,
      chatId: 'oc_chat',
      rootMessageId: `om_s${i}`,
      title: `t${i}`,
      status: 'active',
      createdAt: '2026-01-01T00:00:00.000Z',
      scope: 'topic',
    };
  }
  return rows;
}

/**
 * Reproduce the poisoned store the way the pre-fix import produced it: build
 * `<db>.tmp` in WAL mode, close WITHOUT finalizing the insert statement, publish
 * with `renameSync`, then SIGKILL before Bun can settle the WAL.
 *
 * The schema is harvested from a store PRODUCTION code just created, so this
 * fixture cannot drift away from SESSIONS_SCHEMA_SQL.
 */
const POISON_FIXTURE_SOURCE = String.raw`
  const { Database } = require('bun:sqlite');
  const { mkdirSync, existsSync, renameSync, statSync } = require('node:fs');
  const { join } = require('node:path');
  const [dataDir, appId, repoRoot] = process.argv.slice(2);

  const probeDir = join(dataDir, '__schema_probe');
  mkdirSync(probeDir, { recursive: true });
  process.env.SESSION_DATA_DIR = probeDir;
  const store = await import(join(repoRoot, 'src', 'services', 'session-store.ts'));
  store.init('probe');
  store.listSessions();
  const probeDb = join(probeDir, 'session-stores', 'probe', 'sessions.db');
  const probe = new Database(probeDb, { readonly: true });
  const ddl = probe.prepare("SELECT sql FROM sqlite_master WHERE sql IS NOT NULL").all().map(r => r.sql + ';');
  probe.close();
  if (!ddl.some(s => /CREATE TABLE\s+sessions/i.test(s))) {
    throw new Error('failed to harvest the production sessions schema: ' + JSON.stringify(ddl));
  }

  const storeDir = join(dataDir, 'session-stores', appId);
  mkdirSync(storeDir, { recursive: true });
  const dbFp = join(storeDir, 'sessions.db');
  const tmpFp = dbFp + '.tmp';
  const tmp = new Database(tmpFp);
  tmp.exec('PRAGMA busy_timeout = 3000;');
  tmp.exec('PRAGMA journal_mode = WAL;');
  tmp.exec('PRAGMA synchronous = NORMAL;');
  for (const stmt of ddl) tmp.exec(stmt);
  tmp.exec('BEGIN');
  const insert = tmp.prepare('INSERT OR REPLACE INTO sessions (session_id, status, row) VALUES (?, ?, ?)');
  for (let i = 0; i < ${SESSION_ROWS}; i++) {
    insert.run('s' + i, 'active', JSON.stringify({ sessionId: 's' + i, chatId: 'oc_chat',
      rootMessageId: 'om_s' + i, title: 't' + i, status: 'active',
      createdAt: '2026-01-01T00:00:00.000Z', scope: 'topic' }));
  }
  tmp.exec('COMMIT');
  // Deliberately NOT insert.finalize(): that live statement is what makes Bun
  // skip the checkpoint, stranding every row in <db>.tmp-wal.
  tmp.close();
  renameSync(tmpFp, dbFp);

  const size = (p) => existsSync(p) ? statSync(p).size : null;
  console.log('FIXTURE ' + JSON.stringify({
    runtime: typeof Bun === 'undefined' ? 'node' : 'bun',
    bunVersion: typeof Bun === 'undefined' ? null : Bun.version,
    db: size(dbFp),
    tmpWal: size(dbFp + '.tmp-wal'),
  }));
  process.kill(process.pid, 'SIGKILL');
`;

/**
 * What the OLD code did on every start after the poisoning: open the poisoned
 * store — `CREATE TABLE IF NOT EXISTS` hands it a usable EMPTY table — and write
 * brand-new sessions into the store's own `-wal`.
 *
 * This must run in a SEPARATE process from the poisoning: the publishing process
 * still holds fds on the pre-rename inode, and reopening the same path there
 * fails with `disk I/O error` instead of reproducing the real timeline.
 */
const LIVE_WRITE_SOURCE = String.raw`
  const { Database } = require('bun:sqlite');
  const { join } = require('node:path');
  const [dataDir, appId, rowsJson] = process.argv.slice(2);
  const rows = JSON.parse(rowsJson);
  const dbFp = join(dataDir, 'session-stores', appId, 'sessions.db');
  const db = new Database(dbFp);
  db.exec('PRAGMA busy_timeout = 3000;');
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA synchronous = NORMAL;');
  db.exec("CREATE TABLE IF NOT EXISTS sessions (session_id TEXT PRIMARY KEY, status TEXT NOT NULL, row TEXT NOT NULL, chat_id TEXT GENERATED ALWAYS AS (json_extract(row, '$.chatId')) VIRTUAL, root_message_id TEXT GENERATED ALWAYS AS (json_extract(row, '$.rootMessageId')) VIRTUAL, scope TEXT GENERATED ALWAYS AS (json_extract(row, '$.scope')) VIRTUAL);");
  const seenBefore = db.prepare('SELECT count(*) c FROM sessions').get().c;
  const ins = db.prepare('INSERT OR REPLACE INTO sessions (session_id, status, row) VALUES (?, ?, ?)');
  for (const row of rows) {
    ins.run(row.id, 'active', JSON.stringify({ sessionId: row.id, chatId: 'oc_chat',
      rootMessageId: 'om_' + row.id, title: row.title, status: 'active',
      createdAt: '2026-02-02T00:00:00.000Z', scope: 'topic' }));
  }
  const written = db.prepare('SELECT count(*) c FROM sessions').get().c;
  db.close();
  console.log('LIVEWRITE ' + JSON.stringify({
    runtime: typeof Bun === 'undefined' ? 'node' : 'bun',
    seenBefore,
    written,
  }));
`;

/** Load the store through production code and report what it exposes. */
const LOAD_PROBE_SOURCE = String.raw`
  const { join } = require('node:path');
  const [repoRoot, appId, ownerMode] = process.argv.slice(2);
  const store = await import(join(repoRoot, 'src', 'services', 'session-store.ts'));
  const out = {
    runtime: typeof Bun === 'undefined' ? 'node' : 'bun',
    bunVersion: typeof Bun === 'undefined' ? null : Bun.version,
  };
  store.init(appId, ownerMode === 'worker' ? { owner: false } : {});
  try { out.visible = store.listSessions().length; }
  catch (err) { out.visible = 'THREW:' + err.name; }
  try { out.strict = store.listSessionsStrict().length; }
  catch (err) { out.strict = 'THREW:' + err.name; }
  out.ids = store.listSessions().map(s => s.sessionId).sort();
  out.titles = Object.fromEntries(store.listSessions().map(s => [s.sessionId, s.title]));
  console.log('PROBE ' + JSON.stringify(out));
`;

type FixtureReport = { runtime: string; bunVersion: string | null; db: number | null; tmpWal: number | null };
type ProbeReport = {
  runtime: string;
  bunVersion: string | null;
  visible: number | string;
  strict: number | string;
  ids: string[];
  titles: Record<string, string>;
};

function runBunChild(source: string, env: Record<string, string>): {
  stdout: string;
  stderr: string;
  status: number | null;
} {
  const child = spawnSyncBunTsEvalWithRepoImports(source, {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  if (child.error) throw child.error;
  return {
    stdout: String(child.stdout ?? ''),
    stderr: String(child.stderr ?? ''),
    status: child.status,
  };
}

function parseTagged<T>(stdout: string, stderr: string, tag: string): T {
  const line = stdout.split('\n').findLast(l => l.trim().startsWith(`${tag} `));
  expect(line, `Bun child produced no ${tag} line.\nstdout:\n${stdout}\nstderr:\n${stderr}`).toBeTruthy();
  return JSON.parse(line!.slice(line!.indexOf('{'))) as T;
}

describe('recovering a session store poisoned by a crashed SQLite import', () => {
  function withDirs(fn: (dataDir: string, home: string) => void): void {
    const dataDir = mkdtempSync(join(tmpdir(), 'sqlite-poison-'));
    const home = mkdtempSync(join(tmpdir(), 'sqlite-poison-home-'));
    try {
      fn(dataDir, home);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  }

  /** Build the poisoned fixture and assert it really is the broken shape. */
  function poison(
    dataDir: string,
    home: string,
    opts: { liveRows?: { id: string; title: string }[] } = {},
  ): FixtureReport {
    const env = { HOME: home, SESSION_DATA_DIR: dataDir };
    const source = POISON_FIXTURE_SOURCE.replace(
      'process.argv.slice(2)',
      JSON.stringify([dataDir, 'appA', process.cwd()]),
    );
    const child = runBunChild(source, env);
    const report = parseTagged<FixtureReport>(child.stdout, child.stderr, 'FIXTURE');
    // The fixture must have run under Bun on the pinned version, or it proves
    // nothing about the Bun-only defect.
    expect(report.runtime).toBe('bun');
    expect(report.bunVersion).toBe(pinnedBunVersion());
    // Positive proof the fixture is the poisoned shape and not a healthy store:
    // a bare header plus an orphaned WAL holding everything.
    expect(report.db).toBe(4096);
    expect(report.tmpWal).toBeGreaterThan(4096);
    expect(readdirSync(join(dataDir, 'session-stores', 'appA')).filter(n => n.includes('.tmp')).sort())
      .toEqual(['sessions.db.tmp-shm', 'sessions.db.tmp-wal']);

    if (opts.liveRows?.length) {
      // Separate process on purpose — see LIVE_WRITE_SOURCE.
      const liveSource = LIVE_WRITE_SOURCE.replace(
        'process.argv.slice(2)',
        JSON.stringify([dataDir, 'appA', JSON.stringify(opts.liveRows)]),
      );
      const liveChild = runBunChild(liveSource, env);
      expect(liveChild.status, `live-write step failed:\n${liveChild.stderr}`).toBe(0);
      const liveReport = parseTagged<{ runtime: string; seenBefore: number; written: number }>(
        liveChild.stdout, liveChild.stderr, 'LIVEWRITE',
      );
      expect(liveReport.runtime).toBe('bun');
      // Proof the poisoned store really did serve an EMPTY table to the writer:
      // it saw none of the stranded rows, and afterwards holds only the fresh ones.
      expect(liveReport.seenBefore).toBe(0);
      expect(liveReport.written).toBe(opts.liveRows.length);
      // ...and the orphan still holds the real data.
      expect(readdirSync(join(dataDir, 'session-stores', 'appA')).filter(n => n.includes('.tmp')).sort())
        .toEqual(['sessions.db.tmp-shm', 'sessions.db.tmp-wal']);
    }
    return report;
  }

  function load(dataDir: string, home: string, ownerMode: 'owner' | 'worker' = 'owner'): ProbeReport {
    const source = LOAD_PROBE_SOURCE.replace(
      'process.argv.slice(2)',
      JSON.stringify([process.cwd(), 'appA', ownerMode]),
    );
    const child = runBunChild(source, { HOME: home, SESSION_DATA_DIR: dataDir });
    expect(child.status, `probe failed:\n${child.stderr}`).toBe(0);
    const report = parseTagged<ProbeReport>(child.stdout, child.stderr, 'PROBE');
    expect(report.runtime).toBe('bun');
    expect(report.bunVersion).toBe(pinnedBunVersion());
    return report;
  }

  it('rescues the stranded rows instead of reporting a healthy empty store', () => {
    withDirs((dataDir, home) => {
      poison(dataDir, home);
      writeFileSync(join(dataDir, 'sessions-appA.json'), JSON.stringify(frozenJsonRows()));

      const after = load(dataDir, home);
      // Before the fix this store loaded 0 rows and listSessionsStrict() did
      // NOT throw — a silent, self-certifying total loss of every session.
      expect(after.visible).toBe(SESSION_ROWS);
      expect(after.strict).toBe(SESSION_ROWS);
      // The orphans are consumed, so the store stops testing as poisoned.
      expect(readdirSync(join(dataDir, 'session-stores', 'appA')).filter(n => n.includes('.tmp'))).toEqual([]);

      // Recovery is idempotent: a second start neither loses nor duplicates.
      const again = load(dataDir, home);
      expect(again.visible).toBe(SESSION_ROWS);
      expect(again.strict).toBe(SESSION_ROWS);
    });
  });

  it('keeps rows written into the poisoned store while rescuing the stranded ones', () => {
    withDirs((dataDir, home) => {
      // The realistic production state: old code opened the poisoned store on
      // every start and accumulated brand-new sessions in its own -wal. One of
      // them deliberately REUSES a stranded session id with different content,
      // which is the only shape that can tell the merge policy apart.
      poison(dataDir, home, {
        liveRows: [
          { id: 'NEW0', title: 'live 0' },
          { id: 'NEW1', title: 'live 1' },
          { id: 's0', title: 'live edit of a stranded id' },
        ],
      });
      writeFileSync(join(dataDir, 'sessions-appA.json'), JSON.stringify(frozenJsonRows()));

      const after = load(dataDir, home);
      // Renaming <db>.tmp-wal onto <db>-wal (the "let SQLite self-heal"
      // approach) is REPLACE, not merge: measured, it drops the live rows AND
      // fails to replay the stranded ones. Both sets must survive.
      expect(after.visible).toBe(SESSION_ROWS + 2);
      expect(after.strict).toBe(SESSION_ROWS + 2);
      expect(after.ids.filter(id => id.startsWith('NEW'))).toEqual(['NEW0', 'NEW1']);
      expect(after.ids.filter(id => /^s\d+$/.test(id))).toHaveLength(SESSION_ROWS);
      // The live row wins on a colliding id: recovery may only ADD what was
      // stranded, never overwrite state written after the poisoning.
      expect(after.titles.s0).toBe('live edit of a stranded id');
      // ...while a non-colliding stranded row is restored from the orphan.
      expect(after.titles.s1).toBe('t1');
    });
  });

  it('rescues the rows from the frozen snapshot when the orphan is damaged', () => {
    withDirs((dataDir, home) => {
      poison(dataDir, home);
      // The orphan replays as "schema, zero rows" with NO error — so if the
      // frozen snapshot were not also merged, recovery would delete the orphan
      // and certify an empty store.
      truncateSync(join(dataDir, 'session-stores', 'appA', 'sessions.db.tmp-wal'), 20_000);
      writeFileSync(join(dataDir, 'sessions-appA.json'), JSON.stringify(frozenJsonRows()));

      const after = load(dataDir, home);
      expect(after.visible).toBe(SESSION_ROWS);
      expect(after.strict).toBe(SESSION_ROWS);
      expect(after.titles.s0).toBe('t0');
    });
  });

  it('rescues rows the orphan holds but the frozen snapshot never had', () => {
    withDirs((dataDir, home) => {
      poison(dataDir, home);
      // The frozen snapshot is NOT always a superset in practice: the import
      // reads it, but the file can later be edited, trimmed, or partially
      // restored from a backup. Here it is missing one session the orphan
      // holds, so only the orphan can supply it — the case that proves the
      // orphaned WAL is actually being replayed rather than ignored.
      const trimmed = frozenJsonRows();
      delete trimmed.s7;
      writeFileSync(join(dataDir, 'sessions-appA.json'), JSON.stringify(trimmed));

      const after = load(dataDir, home);
      expect(after.visible).toBe(SESSION_ROWS);
      expect(after.strict).toBe(SESSION_ROWS);
      expect(after.ids).toContain('s7');
      expect(after.titles.s7).toBe('t7');
    });
  });

  it('fails closed when a damaged orphan leaves the contents unattested', () => {
    withDirs((dataDir, home) => {
      poison(dataDir, home);
      // A truncated orphan replays as "schema, zero rows" WITHOUT an error, and
      // no frozen snapshot exists to attest the store — indistinguishable from
      // a legitimately empty store, so it must not be certified as one.
      truncateSync(join(dataDir, 'session-stores', 'appA', 'sessions.db.tmp-wal'), 20_000);

      const after = load(dataDir, home);
      expect(after.strict).toBe('THREW:SessionStoreUnavailableError');
      // The orphans stay on disk so the rows remain manually rescuable.
      expect(readdirSync(join(dataDir, 'session-stores', 'appA')).filter(n => n.includes('.tmp')).length)
        .toBeGreaterThan(0);
    });
  });

  it('refuses to recover a poisoned store from a non-owning process', () => {
    withDirs((dataDir, home) => {
      poison(dataDir, home);
      writeFileSync(join(dataDir, 'sessions-appA.json'), JSON.stringify(frozenJsonRows()));

      // A worker must not repair a store its still-running daemon owns; it also
      // must not serve the truncated view as if it were the whole store.
      const worker = load(dataDir, home, 'worker');
      expect(worker.strict).toBe('THREW:SessionStoreUnavailableError');
      expect(readdirSync(join(dataDir, 'session-stores', 'appA')).filter(n => n.includes('.tmp')).length)
        .toBeGreaterThan(0);

      // The owning daemon still repairs it afterwards.
      const owner = load(dataDir, home, 'owner');
      expect(owner.strict).toBe(SESSION_ROWS);
    });
  });

  it('leaves a healthy store untouched', () => {
    withDirs((dataDir, home) => {
      mkdirSync(dataDir, { recursive: true });
      writeFileSync(join(dataDir, 'sessions-appA.json'), JSON.stringify(frozenJsonRows()));

      // Normal first start: imports, and no recovery path may interfere.
      const first = load(dataDir, home);
      expect(first.visible).toBe(SESSION_ROWS);
      expect(first.strict).toBe(SESSION_ROWS);
      const second = load(dataDir, home);
      expect(second.strict).toBe(SESSION_ROWS);
      expect(readdirSync(join(dataDir, 'session-stores', 'appA')).filter(n => n.includes('.tmp'))).toEqual([]);
    });
  });
});
