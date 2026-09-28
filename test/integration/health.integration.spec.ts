import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Collection, Db } from 'mongodb';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../../src/app.module';
import { APP_CONFIG } from '../../src/config/app-config';
import { HealthView } from '../../src/health/health.controller';
import { MONGO_DB } from '../../src/mongo/mongo.module';
import { RAW_EVENTS_COLLECTION, RawEvent } from '../../src/raw-events/raw-event.model';
import { rawEvent } from '../support/raw-event';
import { testConfig } from '../support/test-db';

describe('GET /health', () => {
  let app: INestApplication<App>;
  let rawEvents: Collection<RawEvent>;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(APP_CONFIG)
      .useValue(testConfig())
      .compile();
    app = moduleRef.createNestApplication();

    const db = app.get<Db>(MONGO_DB);
    await db.dropDatabase();
    await app.init(); // creates the indexes
    rawEvents = db.collection<RawEvent>(RAW_EVENTS_COLLECTION);
  });

  afterAll(async () => {
    await app?.close();
  });

  it('reports how the queue is doing', async () => {
    const now = Date.now();
    await rawEvents.insertMany([
      rawEvent({ _id: 'waiting-longest', claimableAt: new Date(now - 60_000) }),
      rawEvent({ _id: 'waiting', claimableAt: new Date(now - 1_000) }),
      rawEvent({
        _id: 'in-flight',
        status: 'processing',
        claimToken: 'token',
        claimableAt: new Date(now + 15_000),
      }),
      // Processed, and waiting to be retried after an earlier event is done.
      rawEvent({ _id: 'blocked', claimableAt: new Date(now + 250), processingResult: {} }),
      rawEvent({ _id: 'failed', status: 'failed', claimableAt: null }),
      rawEvent({ _id: 'done', status: 'done', claimableAt: null, processingResult: {} }),
    ]);

    const res = await request(app.getHttpServer()).get('/health');

    expect(res.status).toBe(200);
    const { queue } = res.body as HealthView;
    expect(queue).toMatchObject({ depth: 4, inFlight: 1, awaitingCommit: 1, failed: 1 });
    expect(queue.oldestClaimableAgeMs).toBeGreaterThanOrEqual(60_000);
    expect(queue.oldestClaimableAgeMs).toBeLessThan(65_000);
  });
});
