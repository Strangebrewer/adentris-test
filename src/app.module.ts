import { Module } from '@nestjs/common';
import { AppConfigModule } from './config/app-config.module';
import { MongoModule } from './mongo/mongo.module';

/** Root module for the API process (`main.ts`). */
@Module({
  imports: [AppConfigModule, MongoModule],
})
export class AppModule {}
