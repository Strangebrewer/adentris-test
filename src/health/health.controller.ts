import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { QueueStats, RawEventRepository } from '../raw-events/raw-event.repository';

export interface HealthView {
  status: 'ok';
  queue: QueueStats;
}

@Controller('health')
export class HealthController {
  constructor(private readonly rawEvents: RawEventRepository) {}

  /** The numbers that show whether the queue is keeping up. 503 if Mongo can't be reached. */
  @Get()
  async get(): Promise<HealthView> {
    try {
      return { status: 'ok', queue: await this.rawEvents.getQueueStats() };
    } catch (err) {
      throw new ServiceUnavailableException('Mongo is unreachable', { cause: err });
    }
  }
}
