/**
 * `botmux history --limit N` in a thread session must return the thread's
 * TAIL (the newest N, chronologically), not its head.
 *
 * Why this exists: an agent reading its own history to answer "what was just
 * decided" has no way to tell WHICH END of the thread it received — both ends
 * come back as N real, time-ordered messages. The only quantity that separates
 * the two worlds is the endpoint, and nothing in the output names it. A wrong
 * endpoint therefore does not look like an error; it looks like a short thread.
 *
 * The invariant is already written down for the sibling container: see
 * `listChatMessages` — "We page in Desc order so a long-running chat returns
 * its TAIL, not its head — that's the context the caller wants." The thread
 * container is the same command (`botmux history`) serving the same caller, so
 * it owes the same window.
 *
 * The sharper half is INSIDE `listThreadMessages`: it has two branches — the
 * `container_id_type=thread` fast path and the chat-scan fallback used when
 * `resolveThreadId` cannot resolve a thread id. Which branch runs depends only
 * on whether one Lark call succeeded, so the two must return the same window
 * for the same input. The last case below pins exactly that.
 *
 * Run:  bun run vitest run test/history-thread-window.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const hoisted = vi.hoisted(() => {
  const state = {
    /** Whether message.get resolves a thread_id (fast path) or not (fallback). */
    threadIdResolvable: true,
    /** Every message in the synthetic thread, oldest -> newest. */
    thread: [] as any[],
    /** Requested sort_type per messages.list call, for the pagination assertions. */
    listCalls: [] as Array<{ container: string; sort: string; pageSize: number }>,
  };

  const ROOT = 'om_root';

  class MockClient {
    async request({ url, params }: { url: string; params?: any }) {
      // message.get — used by resolveThreadId
      if (/\/open-apis\/im\/v1\/messages\/[^/]+$/.test(url)) {
        return {
          code: 0,
          data: { items: [{ message_id: ROOT, thread_id: state.threadIdResolvable ? 'omt_x' : undefined }] },
        };
      }
      // messages.list — thread container or chat container
      if (url === '/open-apis/im/v1/messages') {
        const sort = params?.sort_type ?? 'ByCreateTimeAsc';
        const pageSize = Number(params?.page_size ?? 50);
        state.listCalls.push({ container: params?.container_id_type, sort, pageSize });
        const ordered = sort === 'ByCreateTimeDesc'
          ? [...state.thread].reverse()
          : [...state.thread];
        const offset = params?.page_token ? Number(params.page_token) : 0;
        const items = ordered.slice(offset, offset + pageSize);
        const next = offset + pageSize;
        return {
          code: 0,
          data: {
            items,
            page_token: next < ordered.length ? String(next) : undefined,
          },
        };
      }
      throw new Error(`unexpected url in mock: ${url}`);
    }
  }

  return { state, MockClient, ROOT };
});
const { state, MockClient, ROOT } = hoisted;

vi.mock('../src/config.js', () => ({
  config: { session: { get dataDir() { return '/tmp/botmux-test'; } } },
}));
vi.mock('../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../src/utils/user-token.js', () => ({ resolveUserToken: vi.fn() }));
vi.mock('../src/bot-registry.js', () => ({
  loadBotConfigs: vi.fn(() => []),
  getBotClient: vi.fn(() => new MockClient()),
}));
vi.mock('@larksuiteoapi/node-sdk', () => ({ LoggerLevel: { error: 4 }, Client: MockClient }));

/** Build a thread of `n` messages, oldest -> newest, ids m01..mNN. */
function buildThread(n: number) {
  state.thread = Array.from({ length: n }, (_, i) => ({
    message_id: `m${String(i + 1).padStart(2, '0')}`,
    root_id: ROOT,
    create_time: String(1_700_000_000_000 + i * 1000),
  }));
}
const ids = (msgs: any[]) => msgs.map(m => m.message_id);

describe('botmux history — thread window endpoint', () => {
  beforeEach(() => {
    state.listCalls = [];
    state.threadIdResolvable = true;
    buildThread(12);
  });

  it('fast path (container_id_type=thread) returns the newest N, chronologically', async () => {
    const { listThreadMessages } = await import('../src/im/lark/client.js');
    const out = await listThreadMessages('cli_x', 'oc_x', ROOT, 3);
    // The tail — NOT m01,m02,m03.
    expect(ids(out)).toEqual(['m10', 'm11', 'm12']);
  });

  it('fallback path (chat scan filtered by root_id) returns the same newest N', async () => {
    state.threadIdResolvable = false;
    const { listThreadMessages } = await import('../src/im/lark/client.js');
    const out = await listThreadMessages('cli_x', 'oc_x', ROOT, 3);
    expect(ids(out)).toEqual(['m10', 'm11', 'm12']);
  });

  it('both branches return the same window for the same input', async () => {
    const { listThreadMessages } = await import('../src/im/lark/client.js');
    state.threadIdResolvable = true;
    const fast = ids(await listThreadMessages('cli_x', 'oc_x', ROOT, 5));
    state.threadIdResolvable = false;
    const fallback = ids(await listThreadMessages('cli_x', 'oc_x', ROOT, 5));
    // Which branch runs depends only on whether one Lark call succeeded.
    // If these ever disagree, the caller silently gets a different window
    // depending on the health of an unrelated request.
    expect(fast).toEqual(fallback);
  });

  it('a limit at or above the thread length returns the whole thread', async () => {
    const { listThreadMessages } = await import('../src/im/lark/client.js');
    const out = await listThreadMessages('cli_x', 'oc_x', ROOT, 50);
    expect(ids(out)).toEqual(ids(state.thread));
  });

  it('pageSize <= 0 still means unlimited for internal callers', async () => {
    const { listThreadMessages } = await import('../src/im/lark/client.js');
    const out = await listThreadMessages('cli_x', 'oc_x', ROOT, 0);
    expect(ids(out)).toEqual(ids(state.thread));
  });
});
