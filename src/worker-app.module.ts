import { Module } from '@nestjs/common';
import { AppConfigModule } from './config/app-config.module';
import { MongoModule } from './mongo/mongo.module';

/**
 * Root module for the worker process (`worker.main.ts`).
 * The worker runs separately from the API,
 * so you can add throughput by starting more worker processes.
 */
@Module({
  imports: [AppConfigModule, MongoModule],
})
export class WorkerAppModule {}
