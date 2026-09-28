import { Module } from '@nestjs/common';
import { ProjectionsModule } from '../projections/projections.module';
import { PatientsController } from './patients.controller';

@Module({
  imports: [ProjectionsModule],
  controllers: [PatientsController],
})
export class PatientsModule {}
