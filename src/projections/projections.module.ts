import { Module } from '@nestjs/common';
import { ProjectionRepository } from './projection.repository';

/**
 * Data access for the per-patient projections.
 * Written by the worker when it commits an event, read by the API.
 */
@Module({
  providers: [ProjectionRepository],
  exports: [ProjectionRepository],
})
export class ProjectionsModule {}
