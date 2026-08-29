/**
 * Inbound-webhook idempotency: collapse an at-least-once upstream's DUPLICATE
 * delivery of the SAME event into a single dispatched turn.
 *
 * WHY THIS IS NOT `idempotency-store.ts`. The repo already has a hardened
 * at-most-once dispatch lease (reserved→attempting, file-locked CAS, boot
 * reconcile) keyed on `options.idempotencyKey`. It cannot be reused here: its
 * scope lock (trigger-types.ts) rejects any target carrying a `chatId`, and
 * EVERY real webhook shape has one (fixed group, dynamic group, or a just-created
 * new-group). Widening that lock is explicitly deferred to its own PR by the
 * comment there, and doing it casually would put the webhook edge inside a
 * machine whose invariants are tuned for a different guarantee. So this module
 * solves the strictly weaker, strictly local problem: "have I already accepted
 * this exact event id?" — at the trusted webhook edge, before any dispatch.
 *
 * GUARANTEE (deliberately weaker than the daemon lease — read this before
 * relying on it). This is a best-effort in-process dedup window, the same
 * strength as the neighbouring HMAC `replayNonces` guard: it collapses the
 * retry storms that actually happen (an upstream re-POSTing seconds to minutes
 * later, e.g. the 33.5s gap in the report that prompted this) and is LOST on
 * dashboard restart. It is not durable at-most-once across a crash. It is
 * deliberately not a file-locked store: the webhook edge is a latency-sensitive
 * hot path (the same reporter asked, in the same thread, for webhook latency to
 * be reduced), and a per-request lock+fsync would tax every honest delivery to
 * defend against a rarer duplicate. Single dashboard process serves /webhook
 * (fleet-runtime resolveDashboardSpec), so one Map covers all inbound traffic.
 *
 * FAIL-OPEN ON AMBIGUITY (opposite of the daemon lease, on purpose). Same key +
 * same body ⇒ provably the same event ⇒ suppress. Same key + DIFFERENT body ⇒
 * the upstream's key is not a reliable unique id (its bug), so we DISPATCH and
 * only record the collision. Dropping a real event (a production alert) is worse
 * than running a duplicate turn — the cost of a duplicate here is "one extra
 * review session", by the reporter's own assessment. The daemon lease answers
 * 409 in this case because it guards money-like at-most-once semantics; this
 * edge guards "never lose an event", so the two must diverge.
 */
import { createHash } from 'node:crypto';

/** How long a delivered key is remembered. Covers realistic upstream retry
 *  ladders (seconds → a few minutes) without letting the map grow forever. */
export const WEBHOOK_IDEMPOTENCY_TTL_MS = 10 * 60 * 1000;

/** Hard cap on remembered keys. A single connector under an alert storm must not
 *  be able to grow this without bound; the oldest entries are dropped first
 *  (insertion-ordered Map ⇒ oldest-first iteration). */
export const WEBHOOK_IDEMPOTENCY_MAX_ENTRIES = 10_000;

/** Upper bound on an accepted key. Mirrors `options.idempotencyKey`'s 200-char
 *  limit so the two contracts can't disagree about what is a usable key. */
export const WEBHOOK_IDEMPOTENCY_MAX_KEY_LENGTH = 200;

interface Entry {
  /** sha256 of the raw request body — binds the key to the event it named. */
  bodyHash: string;
  /** triggerId of the FIRST accepted delivery, echoed to later duplicates so the
   *  caller can reconcile a suppressed retry against the turn that really ran.
   *  Absent while the first delivery is still in flight (see `inFlight`). */
  triggerId?: string;
  /** True between "accepted for dispatch" and "dispatch returned". A concurrent
   *  duplicate arriving in this window must be suppressed too: the very condition
   *  that makes an upstream retry — a slow/timed-out first request — is also the
   *  condition under which the two deliveries OVERLAP, so a
   *  commit-only-after-dispatch design would let exactly the intended case
   *  through. Empirically verified: without this, two simultaneous duplicates
   *  both dispatched. */
  inFlight: boolean;
  expiresAt: number;
}

export type WebhookIdempotencyDecision =
  /** No key presented, or the feature is off for this connector — behave exactly
   *  as before this feature existed. */
  | { kind: 'disabled' }
  /** First time this key is seen: RESERVED for this request. The caller must
   *  dispatch and then call `settle` exactly once (success → keep the reservation
   *  as a dedup record; failure → release it so the sender's retry still works). */
  | { kind: 'first'; key: string }
  /** Same key, same body: a duplicate delivery (already dispatched, or still in
   *  flight). Caller must NOT dispatch. `firstTriggerId` is absent while the
   *  original is still running. */
  | { kind: 'duplicate'; key: string; firstTriggerId?: string }
  /** Same key, different body: the key is not a reliable id. Caller DISPATCHES
   *  anyway (fail-open) — `kind` exists so the caller can log the anomaly. */
  | { kind: 'conflict'; key: string };

/** Per-connector windows, so two connectors can never collide on a key string
 *  (each upstream mints ids in its own namespace). */
const windows = new Map<string, Map<string, Entry>>();

export function hashWebhookBody(rawBody: Buffer): string {
  return createHash('sha256').update(rawBody).digest('hex');
}

/** Drop expired entries, then enforce the size cap oldest-first. Called on the
 *  request path, so it stays O(expired + overflow) rather than O(all): a Map
 *  iterates in insertion order and TTL is uniform, so every expired entry is a
 *  prefix — we can stop at the first live one instead of scanning the tail.
 *  (The sibling `claimNonce` full-scans on every call; not copying that.)
 *
 *  An `inFlight` reservation is never evicted: dropping it would let a concurrent
 *  duplicate through, and its owner is about to settle it anyway. */
function evict(win: Map<string, Entry>, now: number): void {
  for (const [key, entry] of win) {
    if (entry.expiresAt > now) break;
    if (entry.inFlight) continue;
    win.delete(key);
  }
  let overflow = win.size - WEBHOOK_IDEMPOTENCY_MAX_ENTRIES;
  if (overflow <= 0) return;
  for (const [key, entry] of win) {
    if (entry.inFlight) continue;
    win.delete(key);
    if (--overflow <= 0) break;
  }
}

/**
 * Classify an inbound delivery and, for a `first` verdict, RESERVE the key for
 * this request in the same step.
 *
 * Reserving here (rather than after dispatch) is what makes a CONCURRENT
 * duplicate collapse: an upstream retries precisely because the first request was
 * slow or timed out, which is also when the two deliveries overlap. Node runs this
 * function to completion without interleaving, so check-and-reserve is atomic with
 * respect to other in-flight requests.
 *
 * The reservation is provisional: the caller MUST call `settleWebhookIdempotency`,
 * which either keeps it (dispatch succeeded) or releases it (dispatch failed, so
 * the sender's retry must still be able to run the event).
 */
export function inspectWebhookIdempotency(
  connectorId: string,
  key: string | undefined,
  rawBody: Buffer,
  now: number = Date.now(),
): WebhookIdempotencyDecision {
  const trimmed = key?.trim();
  if (!trimmed || trimmed.length > WEBHOOK_IDEMPOTENCY_MAX_KEY_LENGTH) return { kind: 'disabled' };
  let win = windows.get(connectorId);
  if (!win) {
    win = new Map<string, Entry>();
    windows.set(connectorId, win);
  }
  evict(win, now);
  const existing = win.get(trimmed);
  const bodyHash = hashWebhookBody(rawBody);
  if (existing) {
    if (existing.bodyHash !== bodyHash) return { kind: 'conflict', key: trimmed };
    return { kind: 'duplicate', key: trimmed, ...(existing.triggerId ? { firstTriggerId: existing.triggerId } : {}) };
  }
  win.set(trimmed, { bodyHash, inFlight: true, expiresAt: now + WEBHOOK_IDEMPOTENCY_TTL_MS });
  return { kind: 'first', key: trimmed };
}

/**
 * Resolve a reservation made by `inspectWebhookIdempotency`.
 *
 * `triggerId` present ⇒ the dispatch succeeded; the record is kept (with the id
 * to echo to later duplicates) for the rest of the TTL.
 *
 * `triggerId` undefined ⇒ the dispatch FAILED; the reservation is released so a
 * retry of the same event can run. Never remembering a failure is deliberate: the
 * event did not happen, and an at-least-once sender's retry is the recovery path.
 */
export function settleWebhookIdempotency(
  connectorId: string,
  key: string,
  triggerId: string | undefined,
  now: number = Date.now(),
): void {
  const win = windows.get(connectorId);
  const entry = win?.get(key);
  if (!win || !entry || !entry.inFlight) return;
  if (!triggerId) {
    win.delete(key);
    return;
  }
  entry.inFlight = false;
  entry.triggerId = triggerId;
  entry.expiresAt = now + WEBHOOK_IDEMPOTENCY_TTL_MS;
}

/** Test-only: drop all remembered keys (module state is process-global). */
export function __testOnly_resetWebhookIdempotency(): void {
  windows.clear();
}
