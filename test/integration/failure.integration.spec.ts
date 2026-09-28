import { Test, TestingModule } from '@nestjs/testing';
import { Collection, Db } from 'mongodb';
import { APP_CONFIG } from '../../src/config/app-config';
import { AppConfigModule } from '../../src/config/app-config.module';
import { MONGO_DB, MongoModule } from '../../src/mongo/mongo.module';
import { PatientsController } from '../../src/patients/patients.controller';
import { PatientsModule } from '../../src/patients/patients.module';
import { CommitService } from '../../src/processing/commit.service';
import { EventProcessor } from '../../src/processing/event-processor';
import { ExternalService } from '../../src/processing/external-service';
import { ProcessingModule } from '../../src/processing/processing.module';
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
import { RawEventRepository } from '../../src/raw-events/raw-event.repository';
import { claimOne } from '../support/claim';
import { rawEvent } from '../support/raw-event';
import { clearCollections, testConfig } from '../support/test-db';

/** A `ts` that many seconds into 2026. */
const at = (seconds: number) => new Date(Date.UTC(2026, 0, 1) + seconds * 1000);

describe('Failure handling', () => {
  let moduleRef: TestingModule;
  let db: Db;
  let rawEvents: Collection<RawEvent>;
  let projections: Collection<PatientProjection>;
  let repository: RawEventRepository;
  let processor: EventProcessor;
  let commits: CommitService;
  let patients: PatientsController;
  // Stands in for the external call, so each test decides whether it succeeds.
  const external = { process: jest.fn() };

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [AppConfigModule, MongoModule, ProcessingModule, PatientsModule],
    })
      .overrideProvider(APP_CONFIG)
      .useValue(testConfig())
      .overrideProvider(ExternalService)
      .useValue(external)
      .compile();
    // The failures here are on purpose, and their error logs would read like broken tests.
    moduleRef.useLogger(false);

    db = moduleRef.get<Db>(MONGO_DB);
    await db.dropDatabase();
    await moduleRef.init(); // creates the indexes

    rawEvents = db.collection<RawEvent>(RAW_EVENTS_COLLECTION);
    projections = db.collection<PatientProjection>(PATIENT_PROJECTIONS_COLLECTION);
    repository = moduleRef.get(RawEventRepository);
    processor = moduleRef.get(EventProcessor);
    commits = moduleRef.get(CommitService);
    patients = moduleRef.get(PatientsController);
  });

  beforeEach(async () => {
    await clearCollections(db);
    external.process.mockReset();
  });

  afterAll(async () => {
    await moduleRef?.close();
  });

  /** An event as if a worker had claimed it and its external call had finished. */
  const processed = (id: string, seconds: number): ProcessedEvent => ({
    ...rawEvent({ _id: id, ts: at(seconds), status: 'processing' }),
    claimableAt: new Date(Date.now() + 60_000),
    claimToken: `token-${id}`,
    processingResult: { reading: id },
  });

  it('counts an error as a failed attempt, and retries after a backoff', async () => {
    external.process.mockRejectedValue(new Error('upstream unavailable'));
    await rawEvents.insertOne(rawEvent({ _id: 'e1' }));
    const before = Date.now();

    expect(await processor.process(await claimOne(repository))).toBe('retrying');

    const stored = await rawEvents.findOne({ _id: 'e1' });
    expect(stored).toMatchObject({
      status: 'pending',
      attempts: 1,
      lastError: 'upstream unavailable',
      claimToken: null,
    });
    // The first retry waits the backoff base, 1s by default.
    expect(stored!.claimableAt!.getTime()).toBeGreaterThanOrEqual(before + 1_000);
    expect(stored!.claimableAt!.getTime()).toBeLessThan(before + 2_000);
  });

  it('does not count waiting on an earlier event as a failed attempt', async () => {
    external.process.mockResolvedValue({ reading: 'e2' });
    await rawEvents.insertMany([
      // Earlier, and not yet claimable, so it's still unfinished when e2 tries to commit.
      rawEvent({ _id: 'e1', ts: at(1), claimableAt: new Date(Date.now() + 60_000) }),
      rawEvent({ _id: 'e2', ts: at(2) }),
    ]);

    expect(await processor.process(await claimOne(repository))).toBe('blocked');

    expect(await rawEvents.findOne({ _id: 'e2' })).toMatchObject({ attempts: 0 });
  });

  it('marks the event failed at the last attempt, and never claims it again', async () => {
    external.process.mockRejectedValue(new Error('upstream unavailable'));
    await rawEvents.insertOne(rawEvent({ _id: 'e1', attempts: 4 }));

    expect(await processor.process(await claimOne(repository))).toBe('failed');

    expect(await rawEvents.findOne({ _id: 'e1' })).toMatchObject({
      status: 'failed',
      attempts: 5,
      claimableAt: null,
    });
    expect(await repository.claimNext(15_000, 5)).toBeNull();
  });

  it('keeps a failed event blocking later events, and shows it as blockedBy', async () => {
    const e0 = processed('e0', 0);
    await rawEvents.insertOne(e0);
    await commits.commit(e0);
    await rawEvents.insertOne(
      rawEvent({ _id: 'e1', ts: at(1), status: 'failed', claimableAt: null, attempts: 5 }),
    );
    const e2 = processed('e2', 2);
    await rawEvents.insertOne(e2);

    expect(await commits.commit(e2)).toBe('blocked');

    // The state stays at e0, and says what it's waiting on.
    expect(await patients.get('p1')).toEqual({
      patientId: 'p1',
      state: foldAll([e0]),
      watermarkTs: at(0),
      blockedBy: { eventId: 'e1', ts: at(1) },
    });
  });

  it('shows a patient whose first event failed, even though there is no state yet', async () => {
    await rawEvents.insertOne(
      rawEvent({ _id: 'e1', ts: at(1), status: 'failed', claimableAt: null, attempts: 5 }),
    );

    expect(await patients.get('p1')).toEqual({
      patientId: 'p1',
      state: null,
      watermarkTs: null,
      blockedBy: { eventId: 'e1', ts: at(1) },
    });
  });

  // b's call succeeded, so it has a result, but its commit failed. It must stay out of the state.
  it("leaves a failed event out of another event's recompute", async () => {
    const [a, d] = [processed('a', 1), processed('d', 4)];
    await rawEvents.insertMany([a, d]);
    await commits.commit(a);
    await commits.commit(d);
    await rawEvents.insertOne(
      rawEvent({
        _id: 'b',
        ts: at(2),
        status: 'failed',
        claimableAt: null,
        attempts: 5,
        processingResult: { reading: 'b' },
      }),
    );
    const c = processed('c', 1.5);
    await rawEvents.insertOne(c);

    expect(await commits.commit(c)).toBe('committed');

    expect(await projections.findOne({ _id: 'p1' })).toMatchObject({
      state: foldAll([a, c, d]),
    });
  });
});
