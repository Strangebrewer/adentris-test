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
import { ProjectionRepository } from '../../src/projections/projection.repository';
import {
  ProcessedEvent,
  RAW_EVENTS_COLLECTION,
  RawEvent,
} from '../../src/raw-events/raw-event.model';
import { rawEvent } from '../support/raw-event';
import { clearCollections, testConfig } from '../support/test-db';

const TS = {
  a: '2026-01-01T00:00:01Z',
  b: '2026-01-01T00:00:02Z',
  c: '2026-01-01T00:00:02Z', // same ts as b, so b and c are ordered by _id
  d: '2026-01-01T00:00:03Z',
};
type Id = keyof typeof TS;

/** Every order the given items can arrive in. */
function orders<T>(items: T[]): T[][] {
  if (items.length <= 1) return [items];
  return items.flatMap((item, i) =>
    orders([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [item, ...rest]),
  );
}

describe('CommitService', () => {
  let moduleRef: TestingModule;
  let db: Db;
  let rawEvents: Collection<RawEvent>;
  let projections: Collection<PatientProjection>;
  let commits: CommitService;
  let projectionRepository: ProjectionRepository;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [AppConfigModule, MongoModule, ProcessingModule],
    })
      .overrideProvider(APP_CONFIG)
      .useValue(testConfig())
      .compile();

    db = moduleRef.get<Db>(MONGO_DB);
    await db.dropDatabase();
    await moduleRef.init(); // creates the indexes

    rawEvents = db.collection<RawEvent>(RAW_EVENTS_COLLECTION);
    projections = db.collection<PatientProjection>(PATIENT_PROJECTIONS_COLLECTION);
    commits = moduleRef.get(CommitService);
    projectionRepository = moduleRef.get(ProjectionRepository);
  });

  beforeEach(() => clearCollections(db));

  afterAll(async () => {
    await moduleRef?.close();
  });

  /** Inserts an event as if a worker had claimed it and its external call had finished. */
  async function processed(id: Id): Promise<ProcessedEvent> {
    const event: ProcessedEvent = {
      ...rawEvent({ _id: id, ts: new Date(TS[id]), status: 'processing' }),
      claimableAt: new Date(Date.now() + 60_000),
      claimToken: `token-${id}`,
      processingResult: { reading: id },
    };
    await rawEvents.insertOne(event);
    return event;
  }

  /** Sets the projection directly, as a commit would have written it. */
  async function setProjection(events: ProcessedEvent[], watermark: Id): Promise<void> {
    await projections.updateOne(
      { _id: 'p1' },
      {
        $set: { state: foldAll(events), watermarkTs: new Date(TS[watermark]) },
        $inc: { version: 1 },
      },
      { upsert: true },
    );
  }

  it.each(orders<Id>(['a', 'b', 'c', 'd']).map((order) => [order.join(', '), order]))(
    'gives the ts-ordered state when events arrive in the order %s',
    async (_name, order) => {
      const events = new Map<Id, ProcessedEvent>();
      for (const id of order) {
        const event = await processed(id);
        events.set(id, event);
        expect(await commits.commit(event)).toBe('committed');
      }

      const inTsOrder = (['a', 'b', 'c', 'd'] as const).map((id) => events.get(id)!);
      expect(await projections.findOne({ _id: 'p1' })).toMatchObject({
        state: foldAll(inTsOrder),
        watermarkTs: new Date(TS.d),
      });
    },
  );

  it('hands an event back to the queue while an earlier event is unfinished', async () => {
    await processed('a');
    const b = await processed('b');

    const before = Date.now();
    expect(await commits.commit(b)).toBe('blocked');

    // Released at once with a short delay, not held until its lease runs out.
    const stored = await rawEvents.findOne({ _id: 'b' });
    expect(stored).toMatchObject({ status: 'pending', claimToken: null });
    expect(stored!.claimableAt!.getTime()).toBeGreaterThanOrEqual(before);
    expect(stored!.claimableAt!.getTime()).toBeLessThan(before + 5_000);
    expect(await projections.countDocuments()).toBe(0);
  });

  // If the forward check were "at or after the watermark", the retry would add b a second time.
  it('adds an event once when its state write landed but the worker died before marking it done', async () => {
    const a = await processed('a');
    await commits.commit(a);
    const b = await processed('b');
    await setProjection([a, b], 'b');

    expect(await commits.commit(b)).toBe('committed');

    expect(await projections.findOne({ _id: 'p1' })).toMatchObject({ state: foldAll([a, b]) });
    expect(await rawEvents.findOne({ _id: 'b' })).toMatchObject({ status: 'done' });
  });

  // Folding only events marked done would drop d here.
  it('keeps an event that is in the state but not yet done when a late event is fitted in', async () => {
    const a = await processed('a');
    await commits.commit(a);
    const d = await processed('d');
    await setProjection([a, d], 'd');
    const b = await processed('b');

    expect(await commits.commit(b)).toBe('committed');

    expect(await projections.findOne({ _id: 'p1' })).toMatchObject({
      state: foldAll([a, b, d]),
      watermarkTs: new Date(TS.d),
    });
  });

  it('rejects creating a projection that another write has already created', async () => {
    const [a, b] = [await processed('a'), await processed('b')];

    expect(await projectionRepository.writeIfUnchanged('p1', null, foldAll([a]), a.ts)).toBe(true);
    expect(await projectionRepository.writeIfUnchanged('p1', null, foldAll([b]), b.ts)).toBe(false);

    expect(await projections.findOne({ _id: 'p1' })).toMatchObject({ state: foldAll([a]) });
  });

  it('rejects a projection write based on an outdated version', async () => {
    const [a, b, d] = [await processed('a'), await processed('b'), await processed('d')];
    await projectionRepository.writeIfUnchanged('p1', null, foldAll([a]), a.ts);
    await projectionRepository.writeIfUnchanged('p1', 1, foldAll([a, b]), b.ts);

    expect(await projectionRepository.writeIfUnchanged('p1', 1, foldAll([a, d]), d.ts)).toBe(false);

    expect(await projections.findOne({ _id: 'p1' })).toMatchObject({
      state: foldAll([a, b]),
      version: 2,
    });
  });
});
