import { Module } from '@nestjs/common';
import { ProjectionsModule } from '../projections/projections.module';
import { RawEventsModule } from '../raw-events/raw-events.module';
import { PatientsController } from './patients.controller';

@Module({
  imports: [ProjectionsModule, RawEventsModule],
  controllers: [PatientsController],
})
export class PatientsModule {}
