import { Module } from '@nestjs/common';
import { RawEventRepository } from './raw-event.repository';

/**
 * Data access for the raw event log.
 * Shared by the API (ingest, lookups) and the worker (claim, commit).
 */
@Module({
  providers: [RawEventRepository],
  exports: [RawEventRepository],
})
export class RawEventsModule {}
