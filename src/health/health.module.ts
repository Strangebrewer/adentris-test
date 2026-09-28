import { Module } from '@nestjs/common';
import { RawEventsModule } from '../raw-events/raw-events.module';
import { HealthController } from './health.controller';

@Module({
  imports: [RawEventsModule],
  controllers: [HealthController],
})
export class HealthModule {}
