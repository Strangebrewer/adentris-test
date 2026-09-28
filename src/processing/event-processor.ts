import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG, AppConfig } from '../config/app-config';
import { ClaimedEvent, ProcessingResult } from '../raw-events/raw-event.model';
import { RawEventRepository } from '../raw-events/raw-event.repository';
import { CommitOutcome, CommitService } from './commit.service';
import { ExternalService } from './external-service';

/** Takes one claimed event through the external call and the commit. */
@Injectable()
export class EventProcessor {
  constructor(
    private readonly external: ExternalService,
    private readonly commits: CommitService,
    private readonly rawEvents: RawEventRepository,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async process(event: ClaimedEvent): Promise<CommitOutcome> {
    // A retry after a crash may already have the result, so the slow call isn't repeated.
    let result = event.processingResult;
    if (result === null) {
      result = await this.callExternal(event);
      if (!(await this.rawEvents.cacheResult(event, result))) return 'claim-lost';
    }
    return this.commits.commit({ ...event, processingResult: result });
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
}
