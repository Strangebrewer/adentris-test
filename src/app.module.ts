import { Module, ValidationPipe } from '@nestjs/common';
import { APP_PIPE } from '@nestjs/core';
import { AppConfigModule } from './config/app-config.module';
import { EventsModule } from './events/events.module';
import { MongoModule } from './mongo/mongo.module';

/** Root module for the API process (`main.ts`). */
@Module({
  imports: [AppConfigModule, MongoModule, EventsModule],
  providers: [{ provide: APP_PIPE, useValue: new ValidationPipe() }],
})
export class AppModule {}
