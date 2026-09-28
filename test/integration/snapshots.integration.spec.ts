import { Test, TestingModule } from '@nestjs/testing';
import { Collection, Db } from 'mongodb';
import { APP_CONFIG } from '../../src/config/app-config';
import { AppConfigModule } from '../../src/config/app-config.module';
import { MONGO_DB, MongoModule } from '../../src/mongo/mongo.module';
import { CommitService } from '../../src/processing/commit.service';
import { ProcessingModule } from '../../src/processing/processing.module';
import { foldAll } from '../../src/projections/fold';
import {
  PATIENT_PROJECTIONS_COLLECTION,
  PatientProjection,
} from '../../src/projections/patient-projection.model';
import {
  PATIENT_SNAPSHOTS_COLLECTION,
  PatientSnapshot,
} from '../../src/projections/patient-snapshot.model';
import { SnapshotRepository } from '../../src/projections/snapshot.repository';
import {
  ProcessedEvent,
  RAW_EVENTS_COLLECTION,
  RawEvent,
} from '../../src/raw-events/raw-event.model';
import { rawEvent } from '../support/raw-event';
import { clearCollections, testConfig } from '../support/test-db';

/** A `ts` that many seconds into 2026. Fractions give a late event a place between two others. */
const at = (seconds: number) => new Date(Date.UTC(2026, 0, 1) + seconds * 1000);

describe('Snapshots', () => {
  let moduleRef: TestingModule;
  let db: Db;
  let rawEvents: Collection<RawEvent>;
  let projections: Collection<PatientProjection>;
  let snapshots: Collection<PatientSnapshot>;
  let commits: CommitService;
  let snapshotRepository: SnapshotRepository;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [AppConfigModule, MongoModule, ProcessingModule],
    })
      .overrideProvider(APP_CONFIG)
      .useValue(testConfig({ SNAPSHOT_INTERVAL_EVENTS: '2' }))
      .compile();

    db = moduleRef.get<Db>(MONGO_DB);
    await db.dropDatabase();
    await moduleRef.init(); // creates the indexes

    rawEvents = db.collection<RawEvent>(RAW_EVENTS_COLLECTION);
    projections = db.collection<PatientProjection>(PATIENT_PROJECTIONS_COLLECTION);
    snapshots = db.collection<PatientSnapshot>(PATIENT_SNAPSHOTS_COLLECTION);
    commits = moduleRef.get(CommitService);
    snapshotRepository = moduleRef.get(SnapshotRepository);
  });

  beforeEach(() => clearCollections(db));

  afterAll(async () => {
    await moduleRef?.close();
  });

  /** Inserts an event as if a worker had claimed it and its external call had finished. */
  async function processed(id: string, seconds: number): Promise<ProcessedEvent> {
    const event: ProcessedEvent = {
      ...rawEvent({ _id: id, ts: at(seconds), status: 'processing' }),
      claimableAt: new Date(Date.now() + 60_000),
      claimToken: `token-${id}`,
      processingResult: { reading: id },
    };
    await rawEvents.insertOne(event);
    return event;
  }

  /** Commits events with a whole number of seconds as their `ts`, in the order given. */
  async function commitInOrder(...seconds: number[]): Promise<void> {
    for (const s of seconds) {
      expect(await commits.commit(await processed(`e${s}`, s))).toBe('committed');
    }
  }

  /** Commits a late event, and returns the `ts` of the snapshot its recompute started from. */
  async function commitLate(id: string, seconds: number): Promise<Date | null> {
    const event = await processed(id, seconds);
    const lookup = jest.spyOn(snapshotRepository, 'findNearestBefore');
    expect(await commits.commit(event)).toBe('committed');
    const startedFrom = await (lookup.mock.results[0].value as Promise<PatientSnapshot | null>);
    lookup.mockRestore();
    return startedFrom?.ts ?? null;
  }

  /** The state a replay of every event from the very start gives. */
  async function fullReplay() {
    const all = await rawEvents.find().sort({ ts: 1, _id: 1 }).toArray();
    return foldAll(all as ProcessedEvent[]);
  }

  it('fits a late event in from the nearest snapshot, matching a full replay', async () => {
    await commitInOrder(1, 2, 3, 4, 5); // snapshots at 2 and 4

    expect(await commitLate('late', 3.5)).toEqual(at(2));

    expect(await projections.findOne({ _id: 'p1' })).toMatchObject({ state: await fullReplay() });
    // The snapshot at 4 is missing the late event, so only the one at 2 is still usable.
    expect(await snapshots.find({}, { projection: { _id: 0, ts: 1, gen: 1 } }).toArray()).toEqual([
      { ts: at(2), gen: 1 },
    ]);
  });

  // Without invalidation, the second recompute would start from the snapshot at 4,
  // which was taken before the first late event arrived, and drop it.
  it('keeps both of two successive late events either side of a snapshot', async () => {
    await commitInOrder(1, 2, 3, 4, 5, 6); // snapshots at 2, 4 and 6
    expect(await commitLate('late-1', 3.5)).toEqual(at(2));
    await commitInOrder(7, 8); // a new snapshot at 8

    expect(await commitLate('late-2', 5.5)).toEqual(at(2));

    expect(await projections.findOne({ _id: 'p1' })).toMatchObject({ state: await fullReplay() });
  });

  // A snapshot at exactly the late event's ts may hold events that sort after it at that ts.
  it('fits in a late event at exactly a snapshot ts in (ts, _id) order', async () => {
    await commitInOrder(1, 2, 3, 4); // snapshots at 2 and 4; "e2" is the last event in the first
    const tied = await processed('e1-tied', 2); // same ts as e2, and "e1-tied" sorts before "e2"

    expect(await commits.commit(tied)).toBe('committed');

    expect(await projections.findOne({ _id: 'p1' })).toMatchObject({ state: await fullReplay() });
  });

  // The race this guards against: a commit writes the projection, a late event recomputes it,
  // and only then does the first commit save its snapshot, built from the state before the late
  // event. It can't be produced on demand, so the snapshot is written directly instead.
  it('never starts from a snapshot built before the latest recompute', async () => {
    await commitInOrder(1, 2, 3, 4);
    await commitLate('late', 3.5);
    const before = await rawEvents.find({ _id: { $in: ['e1', 'e2', 'e3', 'e4'] } }).toArray();
    await snapshots.insertOne({
      patientId: 'p1',
      ts: at(4),
      gen: 0,
      state: foldAll(before as ProcessedEvent[]),
    });
    await commitInOrder(5);

    expect(await commitLate('late-2', 4.5)).toEqual(at(2));

    expect(await projections.findOne({ _id: 'p1' })).toMatchObject({ state: await fullReplay() });
  });
});
