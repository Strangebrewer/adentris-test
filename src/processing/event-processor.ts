import { Inject, Injectable, Logger } from '@nestjs/common';
import { APP_CONFIG, AppConfig } from '../config/app-config';
import { ClaimedEvent, ProcessingResult } from '../raw-events/raw-event.model';
import { RawEventRepository } from '../raw-events/raw-event.repository';
import { CommitOutcome, CommitService } from './commit.service';
import { ExternalService } from './external-service';

/**
 * Everything `CommitOutcome` covers, plus what can happen when an attempt fails with an error:
 * - `retrying`: the event was handed back, to be tried again after a backoff.
 * - `failed`: that was the last allowed attempt, so the event won't be tried again.
 */
export type ProcessOutcome = CommitOutcome | 'retrying' | 'failed';

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

  async process(event: ClaimedEvent): Promise<ProcessOutcome> {
    try {
      // A retry after a crash may already have the result, so the slow call isn't repeated.
      let result = event.processingResult;
      if (result === null) {
        result = await this.callExternal(event);
        if (!(await this.rawEvents.cacheResult(event, result))) return 'claim-lost';
      }
      return await this.commits.commit({ ...event, processingResult: result });
    } catch (err) {
      return this.recordFailure(event, err);
    }
  }

  /**
   * The call is abandoned before the lease runs out, so a slow call ends as an error
   * rather than letting another worker take over the event while this worker still waits on it.
   */
  private async callExternal(event: ClaimedEvent): Promise<ProcessingResult> {
    const { callTimeoutMs } = this.config.processing;
    const signal = AbortSignal.timeout(callTimeoutMs);
    try {
      return await this.external.process(event, signal);
    } catch (err) {
      if (signal.aborted) {
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
    const stack = err instanceof Error ? err.stack : undefined;

    if (attempts >= maxAttempts) {
      if (!(await this.rawEvents.markFailed(event, attempts, error))) return 'claim-lost';
      this.logger.error(`Event ${event._id} failed after ${attempts} attempts`, stack);
      return 'failed';
    }

    // 1s, 2s, 4s, 8s... with the default base.
    const backoffMs = retryBackoffBaseMs * 2 ** (attempts - 1);
    const retryAt = new Date(Date.now() + backoffMs);
    if (!(await this.rawEvents.retryLater(event, attempts, error, retryAt))) return 'claim-lost';
    this.logger.warn(
      `Attempt ${attempts} of ${maxAttempts} at event ${event._id} failed, retrying in ${backoffMs}ms: ${error}`,
    );
    return 'retrying';
  }
}
