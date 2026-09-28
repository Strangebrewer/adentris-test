import { Test, TestingModule } from '@nestjs/testing';
import { Db } from 'mongodb';
import { APP_CONFIG } from '../../src/config/app-config';
import { AppConfigModule } from '../../src/config/app-config.module';
import { MONGO_DB, MongoModule } from '../../src/mongo/mongo.module';
import { testConfig } from '../support/test-db';

describe('MongoModule', () => {
  let moduleRef: TestingModule;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({ imports: [AppConfigModule, MongoModule] })
      .overrideProvider(APP_CONFIG)
      .useValue(testConfig())
      .compile();
  });

  afterAll(async () => {
    await moduleRef?.close();
  });

  // A 202 promises the sender the event won't be lost.
  // Without journaling, a Mongo crash just after the 202 could lose it without anyone noticing.
  it('only acknowledges writes once they are journaled', () => {
    const collection = moduleRef.get<Db>(MONGO_DB).collection('writeConcernProbe');

    expect(collection.writeConcern).toMatchObject({ w: 'majority', journal: true });
  });
});
