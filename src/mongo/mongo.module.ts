import { Global, Inject, Module, OnApplicationShutdown } from '@nestjs/common';
import { MongoClient } from 'mongodb';
import { APP_CONFIG, AppConfig } from '../config/app-config';

export const MONGO_CLIENT = Symbol('MONGO_CLIENT');
export const MONGO_DB = Symbol('MONGO_DB');

@Global()
@Module({
  providers: [
    {
      provide: MONGO_CLIENT,
      inject: [APP_CONFIG],
      useFactory: async (config: AppConfig): Promise<MongoClient> => {
        const client = new MongoClient(config.mongo.uri, {
          // Only acknowledge a write once it's in Mongo's journal (its on-disk log).
          // Otherwise a Mongo crash just after sending a 202 could lose the event.
          writeConcern: { w: 'majority', journal: true },
        });
        await client.connect();
        return client;
      },
    },
    {
      provide: MONGO_DB,
      inject: [MONGO_CLIENT, APP_CONFIG],
      useFactory: (client: MongoClient, config: AppConfig) => client.db(config.mongo.dbName),
    },
  ],
  exports: [MONGO_CLIENT, MONGO_DB],
})
export class MongoModule implements OnApplicationShutdown {
  constructor(@Inject(MONGO_CLIENT) private readonly client: MongoClient) {}

  async onApplicationShutdown(): Promise<void> {
    await this.client.close();
  }
}
