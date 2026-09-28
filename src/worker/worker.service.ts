import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { once } from 'node:events';
import { setTimeout } from 'node:timers/promises';
import { APP_CONFIG, AppConfig } from '../config/app-config';
import { errorFields } from '../logging/error-fields';
import { EventProcessor } from '../processing/event-processor';
import { ClaimedEvent, ClaimResult } from '../raw-events/raw-event.model';
import { RawEventRepository } from '../raw-events/raw-event.repository';

/**
 * The claim loop. It keeps up to `QUEUE_CONCURRENCY` events in flight and claims a new one as
 * soon as any of them finishes, rather than waiting for a whole batch. Each event spends most of
 * its time waiting on the external call, so one process can handle many at once.
 */
@Injectable()
export class WorkerService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(WorkerService.name);
  /** Each running task, with the event it's working on. */
  private readonly inFlight = new Map<Promise<void>, ClaimedEvent>();
  /** Aborted when shutdown starts: no more claims. */
  private readonly stopClaiming = new AbortController();
  /** Aborted when the shutdown deadline passes: in-flight external calls are cut short. */
  private readonly abandonInFlight = new AbortController();
  private loop: Promise<void> | null = null;

  constructor(
    private readonly rawEvents: RawEventRepository,
    private readonly processor: EventProcessor,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  onApplicationBootstrap(): void {
    this.loop = this.run();
  }

  /**
   * Runs on SIGTERM or SIGINT, and whenever the app is closed. A deliberate shutdown shouldn't
   * leave events waiting out their leases, so it stops claiming at once, gives in-flight events
   * up to `WORKER_SHUTDOWN_TIMEOUT_MS` to finish, and hands the rest straight back to the queue.
   */
  async onModuleDestroy(): Promise<void> {
    this.stopClaiming.abort();
    await this.loop;

    const tasks = [...this.inFlight.keys()];
    const deadline = setTimeout(this.config.worker.shutdownTimeoutMs, 'timed-out', { ref: false });
    if ((await Promise.race([Promise.all(tasks), deadline])) !== 'timed-out') return;

    // Releasing clears each claim's token, so it doesn't count as a failed attempt,
    // and anything these tasks still try to write is refused.
    const unfinished = [...this.inFlight.values()];
    await Promise.allSettled(unfinished.map((event) => this.rawEvents.release(event, new Date())));
    this.logger.warn({
      message: 'Handed unfinished events back to the queue on shutdown',
      eventIds: unfinished.map((event) => event._id),
    });

    // Cut the external calls short, so nothing is still running once the Mongo client closes.
    this.abandonInFlight.abort();
    await Promise.all(this.inFlight.keys());
  }

  private async run(): Promise<void> {
    const { concurrency, leaseMs, idlePollMs, maxAttempts } = this.config.queue;
    const { signal } = this.stopClaiming;
    const stopped = once(signal, 'abort');

    while (!signal.aborted) {
      if (this.inFlight.size >= concurrency) {
        await Promise.race([...this.inFlight.keys(), stopped]);
        continue;
      }

      let claim: ClaimResult | null;
      try {
        claim = await this.rawEvents.claimNext(leaseMs, maxAttempts);
      } catch (err) {
        this.logger.error({ message: 'Failed to claim an event', ...errorFields(err) });
        claim = null;
      }
      if (!claim) {
        // Shutdown cuts the wait short, which rejects it.
        await setTimeout(idlePollMs, undefined, { signal }).catch(() => undefined);
        continue;
      }
      if (claim.kind === 'failed') {
        const { _id, patientId, attempts, lastError } = claim.event;
        this.logger.error({ eventId: _id, patientId, outcome: 'failed', attempts, lastError });
        continue;
      }

      const event = claim.event;
      const task = this.handle(event).finally(() => this.inFlight.delete(task));
      this.inFlight.set(task, event);
    }
  }

  /** Never rejects, so one event's failure can't stop the loop. */
  private async handle(event: ClaimedEvent): Promise<void> {
    try {
      await this.processor.process(event, this.abandonInFlight.signal);
    } catch (err) {
      // Even recording the failure failed. The event keeps its claim until the lease runs out,
      // and the next claim counts the attempt.
      this.logger.error({
        message: 'Failed to process an event',
        eventId: event._id,
        ...errorFields(err),
      });
    }
  }
}
