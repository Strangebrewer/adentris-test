import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { WorkerAppModule } from './worker-app.module';

async function bootstrap() {
  await NestFactory.createApplicationContext(WorkerAppModule);
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
