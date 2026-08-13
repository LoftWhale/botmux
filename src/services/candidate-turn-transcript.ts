import { cocoEventsPathForSession, drainCocoEvents } from './coco-transcript.js';
import type { CandidateTurnReceipt } from './candidate-turn-durability.js';

export type CandidateTurnTranscriptReconciliation =
  | { kind: 'not_found' }
  | { kind: 'submitted'; nativeSessionId: string; transcriptRef: string }
  | { kind: 'completed'; nativeSessionId: string; submitTranscriptRef: string; terminalTranscriptRef: string; output: string };

/** CoCo's explicit --session-id is the BotMux Session id for a fresh
 * Candidate spawn. Keep that binding here so worker IPC, restart recovery and
 * transcript lookup cannot disagree when no adapter-discovered id exists. */
export function candidateCocoTranscriptEvidence(input: {
  botmuxSessionId: string;
  cliSessionId?: string;
  transcriptRef?: string;
}): { nativeSessionId: string; transcriptRef: string } {
  const nativeSessionId = input.cliSessionId?.trim() || input.botmuxSessionId.trim();
  if (!nativeSessionId) throw new Error('Candidate CoCo native Session identity gap');
  return {
    nativeSessionId,
    transcriptRef: input.transcriptRef ?? cocoEventsPathForSession(nativeSessionId),
  };
}

function normalize(value: string): string {
  return value.replace(/\r\n/g, '\n').trim();
}

/** Rebuild one Candidate turn from CoCo's durable native transcript. The
 * exact frozen prompt and acceptance time fence repeated text from older
 * turns; PTY/screen state is never consulted. */
export function reconcileCandidateCocoTranscript(
  receipt: CandidateTurnReceipt,
  nativeSessionId: string,
  eventsPath = cocoEventsPathForSession(nativeSessionId),
): CandidateTurnTranscriptReconciliation {
  const events = drainCocoEvents(eventsPath, 0).events;
  const acceptedAtMs = Date.parse(receipt.createdAt);
  const expected = normalize(receipt.prompt);
  const userIndex = events.findIndex(event => event.kind === 'user'
    && normalize(event.text) === expected
    && (!Number.isFinite(acceptedAtMs) || event.timestampMs >= acceptedAtMs - 5_000));
  if (userIndex < 0) return { kind: 'not_found' };
  const user = events[userIndex]!;
  for (let index = userIndex + 1; index < events.length; index += 1) {
    const event = events[index]!;
    if (event.kind === 'user') break;
    if (event.kind === 'assistant_final') {
      return {
        kind: 'completed',
        nativeSessionId,
        submitTranscriptRef: user.uuid,
        terminalTranscriptRef: event.uuid,
        output: event.text,
      };
    }
  }
  return { kind: 'submitted', nativeSessionId, transcriptRef: user.uuid };
}
