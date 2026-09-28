import { Inject, Injectable, Logger } from '@nestjs/common';
import { APP_CONFIG, AppConfig } from '../config/app-config';
import { errorFields } from '../logging/error-fields';
import { ClaimedEvent, ProcessingResult } from '../raw-events/raw-event.model';
import { RawEventRepository } from '../raw-events/raw-event.repository';
import { CommitOutcome, CommitService } from './commit.service';
import { ExternalService } from './external-service';

/**
 * Everything `CommitOutcome` covers, plus what can happen when an attempt is cut short:
 * - `retrying`: it failed with an error, and the event was handed back to be tried again after a
 *   backoff.
 * - `failed`: it failed with an error, and that was the last allowed attempt, so the event won't be
 *   tried again.
 * - `released-on-shutdown`: the worker shut down before the external call finished, and had
 *   already handed the event back to the queue. Not a failure.
 */
export type ProcessOutcome = CommitOutcome | 'retrying' | 'failed' | 'released-on-shutdown';

/** Takes one claimed event through the external call and the commit. */
@Injectable()
export class EventProcessor {
  private readonly logger = new Logger(EventProcessor.name);

  constructor(
    private readonly external: ExternalService,
    private readonly commits: CommitService,
    private readonly rawEvents: RawEventRepository,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /**
   * Logs one structured line per attempt, whatever the outcome.
   * `abandon` lets the worker cut the external call short when it's shutting down.
   */
  async process(event: ClaimedEvent, abandon?: AbortSignal): Promise<ProcessOutcome> {
    const started = Date.now();
    const { outcome, error } = await this.attempt(event, abandon);

    const entry = {
      eventId: event._id,
      patientId: event.patientId,
      outcome,
      attempt: event.attempts + 1,
      durationMs: Date.now() - started,
      ...(error !== undefined && errorFields(error)),
    };
    if (outcome === 'failed') this.logger.error(entry);
    else if (outcome === 'retrying' || outcome === 'claim-lost') this.logger.warn(entry);
    else this.logger.log(entry);

    return outcome;
  }

  private async attempt(
    event: ClaimedEvent,
    abandon?: AbortSignal,
  ): Promise<{ outcome: ProcessOutcome; error?: unknown }> {
    try {
      // A retry after a crash may already have the result, so the slow call isn't repeated.
      let result = event.processingResult;
      if (result === null) {
        result = await this.callExternal(event, abandon);
        if (!(await this.rawEvents.cacheResult(event, result))) return { outcome: 'claim-lost' };
      }
      return { outcome: await this.commits.commit({ ...event, processingResult: result }) };
    } catch (err) {
      // The worker aborted the call while shutting down, after handing the event back,
      // so there's nothing to record.
      if (abandon?.aborted) return { outcome: 'released-on-shutdown' };
      return { outcome: await this.recordFailure(event, err), error: err };
    }
  }

  /**
   * The call is abandoned before the lease runs out, so a slow call ends as an error
   * rather than letting another worker take over the event while this worker still waits on it.
   */
  private async callExternal(
    event: ClaimedEvent,
    abandon?: AbortSignal,
  ): Promise<ProcessingResult> {
    const { callTimeoutMs } = this.config.processing;
    const timeout = AbortSignal.timeout(callTimeoutMs);
    const signal = abandon ? AbortSignal.any([timeout, abandon]) : timeout;
    try {
      return await this.external.process(event, signal);
    } catch (err) {
      if (timeout.aborted) {
        throw new Error(`External call timed out after ${callTimeoutMs}ms`, { cause: err });
      }
      throw err;
    }
  }

  /**
   * If this write fails too (Mongo unreachable, say), the error reaches the worker loop instead.
   * The event then keeps its claim until the lease runs out, and the next claim counts the attempt.
   */
  private async recordFailure(event: ClaimedEvent, err: unknown): Promise<ProcessOutcome> {
    const { maxAttempts, retryBackoffBaseMs } = this.config.queue;
    const attempts = event.attempts + 1;
    const error = err instanceof Error ? err.message : String(err);

    if (attempts >= maxAttempts) {
      return (await this.rawEvents.markFailed(event, attempts, error)) ? 'failed' : 'claim-lost';
    }

    // 1s, 2s, 4s, 8s... with the default base.
    const retryAt = new Date(Date.now() + retryBackoffBaseMs * 2 ** (attempts - 1));
    return (await this.rawEvents.retryLater(event, attempts, error, retryAt))
      ? 'retrying'
      : 'claim-lost';
  }
}
