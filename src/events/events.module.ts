import { Module } from '@nestjs/common';
import { RawEventsModule } from '../raw-events/raw-events.module';
import { EventsController } from './events.controller';
import { EventsService } from './events.service';

@Module({
  imports: [RawEventsModule],
  controllers: [EventsController],
  providers: [EventsService],
})
export class EventsModule {}
