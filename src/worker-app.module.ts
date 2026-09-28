import { Module } from '@nestjs/common';

/**
 * Root module for the worker process (`worker.main.ts`).
 * The worker runs separately from the API,
 * so you can add throughput by starting more worker processes.
 */
@Module({})
export class WorkerAppModule {}
