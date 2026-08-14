import {
  CandidateTurnDurability,
  type CandidateTurnReceipt,
} from './candidate-turn-durability.js';

type TimerHandle = ReturnType<typeof setTimeout>;

export interface CandidateTurnReceiptReporterDeps {
  dataDir: string;
  deliver: (receipt: CandidateTurnReceipt) => Promise<unknown>;
  schedule?: (callback: () => void, delayMs: number) => TimerHandle;
  retryDelaysMs?: readonly number[];
  now?: () => Date;
  onError?: (error: unknown, receipt: CandidateTurnReceipt) => void;
}

/** Durable, idempotent projection of BotMux turn history into Search RCA.
 * Delivery attempts are serialized and recorded on the turn receipt itself;
 * timers only accelerate replay and are never the recovery authority. */
export class CandidateTurnReceiptReporter {
  private readonly turns: CandidateTurnDurability;
  private readonly deliver: CandidateTurnReceiptReporterDeps['deliver'];
  private readonly scheduleFn: NonNullable<CandidateTurnReceiptReporterDeps['schedule']>;
  private readonly retryDelaysMs: readonly number[];
  private readonly now: () => Date;
  private readonly onError?: CandidateTurnReceiptReporterDeps['onError'];
  private readonly timers = new Map<string, TimerHandle>();
  private tail = Promise.resolve();

  constructor(deps: CandidateTurnReceiptReporterDeps) {
    this.turns = new CandidateTurnDurability({ dataDir: deps.dataDir });
    this.deliver = deps.deliver;
    this.scheduleFn = deps.schedule ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.retryDelaysMs = deps.retryDelaysMs ?? [1_000, 2_000, 5_000, 15_000, 60_000];
    this.now = deps.now ?? (() => new Date());
    this.onError = deps.onError;
  }

  report(receipt: CandidateTurnReceipt): void {
    this.enqueue(receipt.candidateDispatchId, receipt.turnId);
  }

  recoverPending(): void {
    for (const receipt of this.turns.listReceipts()) {
      const settledTransitions = Math.max(
        receipt.controlPlaneDelivery?.acknowledgedTransitions ?? 0,
        receipt.controlPlaneDelivery?.terminalRejectedTransitions ?? 0,
      );
      if (settledTransitions < receipt.transitions.length) {
        this.enqueue(receipt.candidateDispatchId, receipt.turnId);
      }
    }
  }

  async flush(): Promise<void> {
    await this.tail;
  }

  private key(candidateDispatchId: string, turnId: string): string {
    return `${candidateDispatchId}\0${turnId}`;
  }

  private enqueue(candidateDispatchId: string, turnId: string): void {
    this.tail = this.tail
      .catch(() => undefined)
      .then(() => this.attempt(candidateDispatchId, turnId));
  }

  private async attempt(candidateDispatchId: string, turnId: string): Promise<void> {
    const receipt = this.turns.get(candidateDispatchId, turnId);
    if (!receipt) return;
    const transitionCount = receipt.transitions.length;
    const settledTransitions = Math.max(
      receipt.controlPlaneDelivery?.acknowledgedTransitions ?? 0,
      receipt.controlPlaneDelivery?.terminalRejectedTransitions ?? 0,
    );
    if (settledTransitions >= transitionCount) return;
    const attemptNumber = (receipt.controlPlaneDelivery?.attempts ?? 0) + 1;
    const delayMs = this.retryDelaysMs[Math.min(attemptNumber - 1, this.retryDelaysMs.length - 1)] ?? 60_000;
    const nextAttemptAt = new Date(this.now().getTime() + delayMs).toISOString();
    const pending = await this.turns.beginControlPlaneDelivery({
      candidateDispatchId,
      turnId,
      transitionCount,
      nextAttemptAt,
    });
    try {
      const outcome = await this.deliver(pending);
      if (outcome === 'disabled') {
        throw new Error('Candidate turn receipt delivery is disabled');
      }
      await this.turns.markControlPlaneDelivered({ candidateDispatchId, turnId, transitionCount });
      const key = this.key(candidateDispatchId, turnId);
      const timer = this.timers.get(key);
      if (timer) clearTimeout(timer);
      this.timers.delete(key);
    } catch (error) {
      if (error && typeof error === 'object'
        && 'retryable' in error && error.retryable === false) {
        const rejected = await this.turns.markControlPlaneRejected({
          candidateDispatchId,
          turnId,
          transitionCount,
          error: error instanceof Error ? error.message : String(error),
        });
        this.onError?.(error, rejected);
        const key = this.key(candidateDispatchId, turnId);
        const timer = this.timers.get(key);
        if (timer) clearTimeout(timer);
        this.timers.delete(key);
        return;
      }
      const failed = await this.turns.markControlPlaneDeliveryFailed({
        candidateDispatchId,
        turnId,
        error: error instanceof Error ? error.message : String(error),
      });
      this.onError?.(error, failed);
      const key = this.key(candidateDispatchId, turnId);
      if (this.timers.has(key)) return;
      const timer = this.scheduleFn(() => {
        this.timers.delete(key);
        this.enqueue(candidateDispatchId, turnId);
      }, delayMs);
      timer.unref?.();
      this.timers.set(key, timer);
    }
  }
}
