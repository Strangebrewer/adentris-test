import { Inject, Injectable } from '@nestjs/common';
import { setTimeout } from 'node:timers/promises';
import { APP_CONFIG, AppConfig } from '../config/app-config';
import { ProcessingResult, RawEvent } from '../raw-events/raw-event.model';

/**
 * Stands in for the slow external service each event is sent to.
 * Per the brief, only its timing is real, so it just waits and returns the event's data.
 */
@Injectable()
export class ExternalService {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  /** Stops waiting and rejects as soon as `signal` aborts. */
  async process(event: RawEvent, signal: AbortSignal): Promise<ProcessingResult> {
    await setTimeout(this.config.processing.simulatedCallMs, undefined, { signal });
    return { [event.type]: event.data };
  }
}
