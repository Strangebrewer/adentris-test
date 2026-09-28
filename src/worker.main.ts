import { ConsoleLogger, Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { WorkerAppModule } from './worker-app.module';

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(WorkerAppModule, {
    logger: new ConsoleLogger({ json: true }),
  });
  // On SIGTERM or SIGINT, run the worker's shutdown (see `WorkerService.onModuleDestroy`)
  // before the Mongo client closes.
  app.enableShutdownHooks();
  Logger.log('Worker started', 'Bootstrap');
}

bootstrap().catch((err: unknown) => {
  Logger.error(
    'Failed to start worker',
    err instanceof Error ? err.stack : String(err),
    'Bootstrap',
  );
  process.exit(1);
});
