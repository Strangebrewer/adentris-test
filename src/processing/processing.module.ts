import { Module } from '@nestjs/common';
import { ProjectionsModule } from '../projections/projections.module';
import { RawEventsModule } from '../raw-events/raw-events.module';
import { CommitService } from './commit.service';
import { EventProcessor } from './event-processor';
import { ExternalService } from './external-service';

/** Everything that happens to one claimed event: the external call and the commit. */
@Module({
  imports: [RawEventsModule, ProjectionsModule],
  providers: [ExternalService, CommitService, EventProcessor],
  exports: [EventProcessor, CommitService],
})
export class ProcessingModule {}
