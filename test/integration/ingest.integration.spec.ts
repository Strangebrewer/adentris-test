import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Collection, Db } from 'mongodb';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../../src/app.module';
import { APP_CONFIG } from '../../src/config/app-config';
import { AcceptedEvent } from '../../src/events/events.service';
import { MONGO_DB } from '../../src/mongo/mongo.module';
import { RAW_EVENTS_COLLECTION, RawEvent } from '../../src/raw-events/raw-event.model';
import { clearCollections, testConfig } from '../support/test-db';

describe('POST /events', () => {
  let app: INestApplication<App>;
  let db: Db;
  let rawEvents: Collection<RawEvent>;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(APP_CONFIG)
      .useValue(testConfig())
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();

    db = app.get<Db>(MONGO_DB);
    await db.dropDatabase();
    rawEvents = db.collection<RawEvent>(RAW_EVENTS_COLLECTION);
  });

  beforeEach(() => clearCollections(db));

  afterAll(async () => {
    await app?.close();
  });

  const post = (body: object) => request(app.getHttpServer()).post('/events').send(body);

  it('answers a retry exactly like the original and stores the event once', async () => {
    const first = await post({
      patientId: 'p1',
      type: 'blood-pressure',
      ts: '2026-01-01T00:00:00Z',
      data: { systolic: 120, unit: 'mmHg' },
    });
    const retry = await post({
      data: { unit: 'mmHg', systolic: 120 },
      ts: '2026-01-01T00:00:00Z',
      type: 'blood-pressure',
      patientId: 'p1',
    });

    expect(first.status).toBe(202);
    expect(retry.status).toBe(first.status);
    expect(retry.body).toEqual(first.body);
    expect(await rawEvents.countDocuments()).toBe(1);
  });

  it('stores different representations of the same instant as one event', async () => {
    const representations = [
      '2026-01-01T00:00:00Z',
      '2026-01-01T00:00:00.000Z',
      '2026-01-01T00:00:00+00:00',
      '2026-01-01T02:00:00+02:00',
    ];

    const responses = await Promise.all(
      representations.map((ts) => post({ patientId: 'p1', type: 'blood-pressure', ts, data: {} })),
    );

    const ids = new Set(responses.map((res) => (res.body as AcceptedEvent).id));
    expect(ids.size).toBe(1);
    expect(await rawEvents.find().toArray()).toEqual([
      expect.objectContaining({ ts: new Date('2026-01-01T00:00:00Z') }),
    ]);
  });

  it('rejects a ts beyond the future clock-skew allowance and stores nothing', async () => {
    const ts = new Date(Date.now() + 60 * 60_000).toISOString();
    const res = await post({ patientId: 'p1', type: 'blood-pressure', ts, data: {} });
    expect(res.status).toBe(400);
    expect(await rawEvents.countDocuments()).toBe(0);
  });

  it('rejects a ts without a UTC offset and stores nothing', async () => {
    const ts = '2026-01-01T00:00:00';
    const res = await post({ patientId: 'p1', type: 'blood-pressure', ts, data: {} });
    expect(res.status).toBe(400);
    expect(await rawEvents.countDocuments()).toBe(0);
  });
});
