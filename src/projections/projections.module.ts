import { Module } from '@nestjs/common';
import { ProjectionRepository } from './projection.repository';
import { SnapshotRepository } from './snapshot.repository';

/**
 * Data access for the per-patient projections and their snapshots.
 * Written by the worker when it commits an event, read by the API.
 */
@Module({
  providers: [ProjectionRepository, SnapshotRepository],
  exports: [ProjectionRepository, SnapshotRepository],
})
export class ProjectionsModule {}
