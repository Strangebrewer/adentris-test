import { ConsoleLogger, Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { APP_CONFIG, AppConfig } from './config/app-config';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { logger: new ConsoleLogger({ json: true }) });
  // On SIGTERM or SIGINT, stop taking connections and let in-flight requests finish
  // before the Mongo client closes.
  app.enableShutdownHooks();

  const { port } = app.get<AppConfig>(APP_CONFIG);
  await app.listen(port);
  Logger.log(`API listening on port ${port}`, 'Bootstrap');
}

bootstrap().catch((err: unknown) => {
  Logger.error('Failed to start API', err instanceof Error ? err.stack : String(err), 'Bootstrap');
  process.exit(1);
});
