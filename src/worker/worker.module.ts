import { Module } from '@nestjs/common';
import { ProcessingModule } from '../processing/processing.module';
import { RawEventsModule } from '../raw-events/raw-events.module';
import { WorkerService } from './worker.service';

@Module({
  imports: [RawEventsModule, ProcessingModule],
  providers: [WorkerService],
})
export class WorkerModule {}
