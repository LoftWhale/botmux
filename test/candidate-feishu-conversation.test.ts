import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  replyMessage: vi.fn(async () => 'om_candidate_answer'),
  sendMessage: vi.fn(async () => 'om_unexpected_top_level'),
  getChatMode: vi.fn(async () => 'topic' as 'group' | 'topic' | 'p2p'),
  addReaction: vi.fn(async () => 'reaction-1'),
  notifyCandidateAccepted: vi.fn(),
}));

vi.mock('@larksuiteoapi/node-sdk', () => {
  class FakeClient { constructor(public opts: Record<string, unknown>) {} }
  return { Client: FakeClient };
});

vi.mock('../src/im/lark/client.js', async () => {
  const actual = await vi.importActual<any>('../src/im/lark/client.js');
  return {
    ...actual,
    replyMessage: mocks.replyMessage,
    sendMessage: mocks.sendMessage,
    getChatMode: mocks.getChatMode,
    addReaction: mocks.addReaction,
  };
});

vi.mock('../src/services/rca-shadow-notifier.js', () => ({
  notifyRcaCandidateAccepted: mocks.notifyCandidateAccepted,
  rcaShadowTokenFromEnv: () => '',
}));

import { registerBot } from '../src/bot-registry.js';
import { config } from '../src/config.js';
import {
  __testOnly_activeSessions as activeSessions,
  __testOnly_handleNewTopic as handleNewTopic,
  __testOnly_handleThreadReply as handleThreadReply,
  __testOnly_sessionReply as sessionReply,
} from '../src/daemon.js';
import { sessionKey, type DaemonSession } from '../src/core/types.js';
import {
  resolveCandidateFeishuConversation,
} from '../src/core/candidate-feishu-conversation.js';
import {
  candidateRcaLaunchReceiptPath,
  type CandidateRcaLaunchReceipt,
} from '../src/services/candidate-rca-launch.js';
import { RcaShadowMirror } from '../src/services/rca-shadow-mirror.js';
import * as sessionStore from '../src/services/session-store.js';

const APP = 'cli_candidate_conversation';
const CHAT = 'oc_candidate_shadow';
const ROOT = 'om_candidate_root';
const DISPATCH = 'cand_same_conversation';
const BOTMUX_COMMIT = 'b'.repeat(40);
const BOTMUX_ARTIFACT_SHA256 = '6'.repeat(64);
let dataDir: string;

async function seedCandidateSession(): Promise<DaemonSession> {
  const session = sessionStore.createSession(CHAT, ROOT, 'Candidate RCA', 'group', 'thread');
  session.larkAppId = APP;
  session.cliId = 'coco';
  session.candidateRuntimeContract = {
    botmuxCommit: BOTMUX_COMMIT,
    botmuxArtifactSha256: BOTMUX_ARTIFACT_SHA256,
  } as never;
  sessionStore.updateSession(session);
  const worker = { killed: false, send: vi.fn() };
  const ds = {
    session,
    worker,
    workerPort: null,
    workerToken: null,
    larkAppId: APP,
    chatId: CHAT,
    chatType: 'group',
    scope: 'thread',
    spawnedAt: Date.now(),
    cliVersion: 'candidate-a',
    lastMessageAt: Date.now(),
    hasHistory: true,
    workingDir: dataDir,
  } as unknown as DaemonSession;
  activeSessions.set(sessionKey(ROOT, APP), ds);

  const now = new Date().toISOString();
  const receipt: CandidateRcaLaunchReceipt = {
    schemaVersion: 1,
    incidentKey: 'argos:conversation-alarm',
    candidateDispatchId: DISPATCH,
    feishuUuid: DISPATCH,
    larkAppId: APP,
    chatId: CHAT,
    topicMessage: 'Candidate Shadow',
    launchContext: {
      botmuxCommit: BOTMUX_COMMIT,
      botmuxArtifactSha256: BOTMUX_ARTIFACT_SHA256,
    } as never,
    status: 'launched',
    rootMessageId: ROOT,
    botmuxSessionId: session.sessionId,
    createdAt: now,
    updatedAt: now,
  };
  const receiptPath = candidateRcaLaunchReceiptPath(dataDir, DISPATCH);
  await mkdir(dirname(receiptPath), { recursive: true });
  await writeFile(receiptPath, `${JSON.stringify(receipt)}\n`, { mode: 0o600 });
  return ds;
}

function inboundEvent(rootMessageId = ROOT) {
  return {
    sender: { sender_type: 'user', sender_id: { open_id: 'ou_operator' } },
    message: {
      message_id: 'om_user_followup',
      root_id: rootMessageId,
      thread_id: rootMessageId,
      chat_id: CHAT,
      chat_type: 'group',
      message_type: 'text',
      content: JSON.stringify({ text: '继续核查这条报警' }),
    },
  };
}

beforeEach(async () => {
  vi.clearAllMocks();
  activeSessions.clear();
  dataDir = await mkdtemp(`${tmpdir()}/botmux-candidate-conversation-`);
  config.session.dataDir = dataDir;
  sessionStore.init(APP);
  registerBot({
    larkAppId: APP,
    larkAppSecret: 'secret',
    cliId: 'coco',
    allowedUsers: [],
    disableStreamingCard: false,
  });
});

describe('Candidate Feishu single conversation', () => {
  it('requires the exact durable root and active BotMux Session instead of guessing', async () => {
    const ds = await seedCandidateSession();

    expect(resolveCandidateFeishuConversation({
      dataDir,
      larkAppId: APP,
      chatId: CHAT,
      activeSessions,
    })).toMatchObject({ kind: 'identity_gap' });
    expect(resolveCandidateFeishuConversation({
      dataDir,
      larkAppId: APP,
      chatId: CHAT,
      rootMessageId: 'om_other_topic',
      activeSessions,
    })).toMatchObject({ kind: 'identity_gap' });
    expect(resolveCandidateFeishuConversation({
      dataDir,
      larkAppId: APP,
      chatId: CHAT,
      rootMessageId: ROOT,
      activeSessions,
    })).toEqual({
      kind: 'candidate',
      incidentKey: 'argos:conversation-alarm',
      candidateDispatchId: DISPATCH,
      rootMessageId: ROOT,
      botmuxSessionId: ds.session.sessionId,
    });
  });

  it('drives the real thread handler into the launched Session without creating another one', async () => {
    const ds = await seedCandidateSession();
    const event = inboundEvent();

    await handleThreadReply(event, {
      larkAppId: APP,
      chatId: CHAT,
      chatType: 'group',
      messageId: event.message.message_id,
      scope: 'thread',
      anchor: ROOT,
    });

    expect(activeSessions.size).toBe(1);
    expect(ds.worker?.send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'message',
      turnId: 'om_user_followup',
    }));
    expect(ds.session.quoteTargetId).toBe('om_user_followup');
    expect(activeSessions.get(sessionKey(ROOT, APP))?.session.sessionId)
      .toBe(ds.session.sessionId);
  });

  it('fails closed at the production handlers for a missing or foreign Candidate root', async () => {
    const ds = await seedCandidateSession();
    const workerSend = ds.worker?.send as ReturnType<typeof vi.fn>;
    const topLevel: any = inboundEvent();
    delete topLevel.message.root_id;
    delete topLevel.message.thread_id;

    await handleNewTopic(topLevel, {
      larkAppId: APP,
      chatId: CHAT,
      chatType: 'group',
      messageId: topLevel.message.message_id,
      scope: 'thread',
      anchor: topLevel.message.message_id,
    });
    await handleThreadReply(inboundEvent('om_foreign_root'), {
      larkAppId: APP,
      chatId: CHAT,
      chatType: 'group',
      messageId: 'om_user_followup',
      scope: 'thread',
      anchor: 'om_foreign_root',
    });

    expect(activeSessions.size).toBe(1);
    expect(activeSessions.get(sessionKey(ROOT, APP))?.session.sessionId)
      .toBe(ds.session.sessionId);
    expect(workerSend).not.toHaveBeenCalled();
  });

  it('returns Candidate output to the inbound root with chat/root/turn receipt attribution', async () => {
    const ds = await seedCandidateSession();

    const replyId = await sessionReply(ROOT, 'candidate answer', 'text', APP, 'om_user_followup');

    expect(replyId).toBe('om_candidate_answer');
    expect(mocks.replyMessage).toHaveBeenCalledWith(
      APP,
      ROOT,
      'candidate answer',
      'text',
      true,
      undefined,
      {
        sessionId: ds.session.sessionId,
        scope: 'thread',
        anchor: ROOT,
        chatId: CHAT,
        rootId: ROOT,
        turnId: 'om_user_followup',
      },
    );
    expect(mocks.sendMessage).not.toHaveBeenCalled();
  });

  it('does not start the retired Search RCA status notifier after mirror acceptance', async () => {
    const mirror = new RcaShadowMirror({
      url: 'http://127.0.0.1:9999',
      token: 'mirror-token',
      botAppIds: [APP],
      timeoutMs: 1000,
      maxInFlight: 1,
      maxQueued: 1,
    }, {
      fetchImpl: vi.fn(async () => new Response(JSON.stringify({ eventId: 'event-1' }), {
        status: 202,
        headers: { 'content-type': 'application/json' },
      })),
      captureSnapshot: vi.fn(async () => ({
        schemaVersion: '1',
        capturedAt: new Date().toISOString(),
        captureStatus: 'complete',
        warnings: [],
        timeline: [],
      })),
    });

    expect(mirror.submit({
      larkAppId: APP,
      sessionId: 'online-session',
      turnId: 'online-turn',
      turnKind: 'first_turn',
      chatId: 'oc_original_alarm',
      topicId: 'om_original_alarm',
      preparedInput: 'alarm context',
    })).toBe('queued');
    await mirror.onIdle();

    expect(mocks.notifyCandidateAccepted).not.toHaveBeenCalled();
  });
});
