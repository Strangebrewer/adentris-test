import { Test, TestingModule } from '@nestjs/testing';
import { Collection, Db } from 'mongodb';
import { APP_CONFIG } from '../../src/config/app-config';
import { EventsModule } from '../../src/events/events.module';
import { EventsService } from '../../src/events/events.service';
import { MONGO_DB } from '../../src/mongo/mongo.module';
import { foldAll } from '../../src/projections/fold';
import {
  PATIENT_PROJECTIONS_COLLECTION,
  PatientProjection,
} from '../../src/projections/patient-projection.model';
import {
  ProcessedEvent,
  RAW_EVENTS_COLLECTION,
  RawEvent,
} from '../../src/raw-events/raw-event.model';
import { WorkerAppModule } from '../../src/worker-app.module';
import { testConfig } from '../support/test-db';
import { waitFor } from '../support/wait-for';

const heartRate = (second: number) => ({
  patientId: 'p1',
  type: 'heart-rate',
  ts: `2026-01-01T00:00:0${second}Z`,
  data: { bpm: 60 + second },
});

describe('Worker', () => {
  let moduleRef: TestingModule;
  let db: Db;
  let rawEvents: Collection<RawEvent>;
  let projections: Collection<PatientProjection>;
  let events: EventsService;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({ imports: [WorkerAppModule, EventsModule] })
      .overrideProvider(APP_CONFIG)
      .useValue(
        testConfig({
          PROCESSING_SIMULATED_CALL_MS: '50',
          QUEUE_IDLE_POLL_MS: '10',
          QUEUE_BLOCKED_RETRY_DELAY_MS: '10',
          SNAPSHOT_INTERVAL_EVENTS: '2',
        }),
      )
      .compile();

    db = moduleRef.get<Db>(MONGO_DB);
    await db.dropDatabase();
    await moduleRef.init(); // creates the indexes and starts the claim loop

    rawEvents = db.collection<RawEvent>(RAW_EVENTS_COLLECTION);
    projections = db.collection<PatientProjection>(PATIENT_PROJECTIONS_COLLECTION);
    events = moduleRef.get(EventsService);
  });

  afterAll(async () => {
    await moduleRef?.close();
  });

  const waitUntilAllDone = () =>
    waitFor(
      async () => (await rawEvents.countDocuments({ status: { $ne: 'done' } })) === 0,
      'every event to be done',
    );

  /** The state the stored events should fold to, taken in `(ts, _id)` order. */
  async function expectedState() {
    const stored = await rawEvents.find().sort({ ts: 1, _id: 1 }).toArray();
    return foldAll(stored as ProcessedEvent[]);
  }

  it('folds a scrambled burst, a duplicate and a late arrival in ts order', async () => {
    const burst = [3, 1, 5, 2, 6].map(heartRate);
    await Promise.all([...burst, heartRate(3)].map((event) => events.accept(event)));
    await waitUntilAllDone();

    // Earlier than events that have already been committed.
    await events.accept(heartRate(4));
    await waitUntilAllDone();

    const projection = await projections.findOne({ _id: 'p1' });
    expect(projection).toMatchObject({
      state: await expectedState(),
      watermarkTs: new Date(heartRate(6).ts),
    });
    expect(projection?.state.eventCount).toBe(6);
    expect(projection?.state.latest).toEqual({ 'heart-rate': { bpm: 66 } });
  }, 10_000);
});
