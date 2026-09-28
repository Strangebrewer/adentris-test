import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { setTimeout } from 'node:timers/promises';
import { APP_CONFIG, AppConfig } from '../config/app-config';
import { EventProcessor } from '../processing/event-processor';
import { ClaimedEvent } from '../raw-events/raw-event.model';
import { RawEventRepository } from '../raw-events/raw-event.repository';

/**
 * The claim loop. It keeps up to `QUEUE_CONCURRENCY` events in flight and claims a new one as
 * soon as any of them finishes, rather than waiting for a whole batch. Each event spends most of
 * its time waiting on the external call, so one process can handle many at once.
 */
@Injectable()
export class WorkerService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(WorkerService.name);
  private readonly inFlight = new Set<Promise<void>>();
  private running = false;
  private loop: Promise<void> | null = null;

  constructor(
    private readonly rawEvents: RawEventRepository,
    private readonly processor: EventProcessor,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  onApplicationBootstrap(): void {
    this.running = true;
    this.loop = this.run();
  }

  /** Stops claiming and waits for the events already in flight. */
  async onModuleDestroy(): Promise<void> {
    this.running = false;
    await this.loop;
    await Promise.all(this.inFlight);
  }

  private async run(): Promise<void> {
    const { concurrency, leaseMs, idlePollMs } = this.config.queue;

    while (this.running) {
      if (this.inFlight.size >= concurrency) {
        await Promise.race(this.inFlight);
        continue;
      }

      let event: ClaimedEvent | null;
      try {
        event = await this.rawEvents.claimNext(leaseMs);
      } catch (err) {
        this.logger.error('Failed to claim an event', errorText(err));
        event = null;
      }
      if (!event) {
        await setTimeout(idlePollMs);
        continue;
      }

      const task = this.handle(event).finally(() => this.inFlight.delete(task));
      this.inFlight.add(task);
    }
  }

  /** Never rejects, so one event's failure can't stop the loop. */
  private async handle(event: ClaimedEvent): Promise<void> {
    try {
      const outcome = await this.processor.process(event);
      if (outcome === 'claim-lost') {
        this.logger.warn(`Another worker took over event ${event._id}, so this worker stopped`);
      }
    } catch (err) {
      // The event keeps its claim until the lease runs out, and is then claimed again.
      this.logger.error(`Failed to process event ${event._id}`, errorText(err));
    }
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? (err.stack ?? err.message) : String(err);
}
