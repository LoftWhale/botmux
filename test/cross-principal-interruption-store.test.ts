import { describe, expect, it } from 'vitest';
import {
  continueCrossPrincipalOwnerWait,
  crossPrincipalDroppedMessageDigest,
  crossPrincipalInterruptionId,
  crossPrincipalOwnerWaitDisposition,
  markCrossPrincipalSuggestionWaiting,
  stageCrossPrincipalInterruptionRecord,
} from '../src/core/cross-principal-interruption-store.js';
import type { Session, TrustedCaller } from '../src/types.js';

const owner: TrustedCaller = {
  requestUserOpenId: 'ou_a',
  requestUserUnionId: 'on_a',
  requestLarkAppId: 'app_test',
  senderType: 'user',
};
const proposer: TrustedCaller = {
  requestUserOpenId: 'ou_b',
  requestUserUnionId: 'on_b',
  requestLarkAppId: 'app_test',
  senderType: 'user',
};

function session(): Session {
  return {
    sessionId: 'sid_source',
    rootMessageId: 'om_root',
    chatId: 'oc_chat',
    title: 'source',
    status: 'active',
    createdAt: '2026-09-09T00:00:00.000Z',
    chatType: 'group',
  };
}

describe('cross-principal interruption durable identity', () => {
  it('uses source session + turn only, independent of delivery generation or attempt', () => {
    expect(crossPrincipalInterruptionId('sid_source', 'om_turn'))
      .toBe(crossPrincipalInterruptionId('sid_source', 'om_turn'));
    expect(crossPrincipalInterruptionId('sid_other', 'om_turn'))
      .not.toBe(crossPrincipalInterruptionId('sid_source', 'om_turn'));
  });

  it('merges duplicate pre-admission rejects into one record and one executable message', () => {
    const source = session();
    const args = {
      session: source,
      ownerTurnId: 'om_a',
      owner,
      proposer,
      message: {
        turnId: 'om_b',
        text: 'B input',
        userPrompt: 'B input',
        createdAt: '2026-09-09T00:01:00.000Z',
      },
    };

    const first = stageCrossPrincipalInterruptionRecord(args);
    const duplicateAfterWorkerRestart = stageCrossPrincipalInterruptionRecord({
      ...args,
    });

    expect(first.inserted).toBe(true);
    expect(duplicateAfterWorkerRestart.inserted).toBe(false);
    expect(duplicateAfterWorkerRestart.record).toBe(first.record);
    expect(source.crossPrincipalInterruptions).toHaveLength(1);
    expect(source.crossPrincipalInterruptions?.[0]?.messages).toHaveLength(1);
    expect(source.crossPrincipalInterruptions?.[0]?.messages[0]?.turnId).toBe('om_b');
  });

  it('never defaults bot proposers to suggestion and does not start a pre-card deadline', () => {
    const source = session();
    const botProposer: TrustedCaller = { ...proposer, senderType: 'bot' };
    const { record } = stageCrossPrincipalInterruptionRecord({
      session: source,
      ownerTurnId: 'om_a',
      owner,
      proposer: botProposer,
      message: {
        turnId: 'om_bot',
        text: 'review finding',
        userPrompt: 'review finding',
        createdAt: '2026-09-09T00:01:00.000Z',
      },
    });

    expect(record.phase).toBe('awaiting_classification');
    expect(record.classificationDeadlineAt).toBeUndefined();
    expect(record.ownerDeadlineAt).toBeUndefined();
  });

  it('keeps owner-turn waiting separate from the later confirmation timeout', () => {
    const source = session();
    const { record } = stageCrossPrincipalInterruptionRecord({
      session: source,
      ownerTurnId: 'om_a',
      owner,
      proposer,
      message: {
        turnId: 'om_b_wait',
        text: 'suggestion',
        userPrompt: 'suggestion',
        createdAt: '2026-09-09T00:01:00.000Z',
      },
    });

    markCrossPrincipalSuggestionWaiting(record, 1_000, 10_000);
    expect(record.phase).toBe('awaiting_owner');
    expect(record.ownerWaitDeadlineAt).toBe(11_000);
    expect(record.ownerDeadlineAt).toBeUndefined();
    expect(crossPrincipalOwnerWaitDisposition(record, true, 10_999, 10_000)).toBe('waiting');
    expect(crossPrincipalOwnerWaitDisposition(record, true, 11_000, 10_000)).toBe('proposer_decision');
    expect(crossPrincipalOwnerWaitDisposition(record, false, 11_000, 10_000)).toBe('owner_ready');

    continueCrossPrincipalOwnerWait(record, 20_000, 10_000);
    expect(record.ownerWaitDeadlineAt).toBe(30_000);
    expect(record.waitDecisionRound).toBe(1);
  });
});

describe('dropped cross-principal message digest', () => {
  function staged(texts: string[]) {
    const source = session();
    let record = stageCrossPrincipalInterruptionRecord({
      session: source,
      ownerTurnId: 'om_a',
      owner,
      proposer,
      message: {
        turnId: 'om_b_1',
        text: texts[0] ?? '',
        userPrompt: texts[0] ?? '',
        createdAt: '2026-09-09T00:01:00.000Z',
      },
    }).record;
    for (let i = 1; i < texts.length; i += 1) {
      record = stageCrossPrincipalInterruptionRecord({
        session: source,
        ownerTurnId: 'om_a',
        owner,
        proposer,
        message: {
          turnId: `om_b_${i + 1}`,
          text: texts[i]!,
          userPrompt: texts[i]!,
          createdAt: '2026-09-09T00:01:00.000Z',
        },
      }).record;
    }
    return record;
  }

  it('names the message by the turn the proposer already knows', () => {
    const digest = crossPrincipalDroppedMessageDigest(staged(['the input']));
    expect(digest).toEqual({ turnId: 'om_b_1', excerpt: 'the input' });
  });

  it('collapses newlines so the excerpt stays on one line of the notice', () => {
    const digest = crossPrincipalDroppedMessageDigest(staged(['line one\n\n  line two']));
    expect(digest?.excerpt).toBe('line one line two');
  });

  it('truncates only past the limit, so short messages are quoted whole', () => {
    const long = 'x'.repeat(61);
    const atLimit = 'y'.repeat(60);
    expect(crossPrincipalDroppedMessageDigest(staged([long]))?.excerpt).toBe(`${'x'.repeat(60)}…`);
    expect(crossPrincipalDroppedMessageDigest(staged([atLimit]))?.excerpt).toBe(atLimit);
  });

  it('returns undefined when the record carries no message, so the notice is left unchanged', () => {
    const record = staged(['only one']);
    record.messages = [];
    expect(crossPrincipalDroppedMessageDigest(record)).toBeUndefined();
  });
});
