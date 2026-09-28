import { Test, TestingModule } from '@nestjs/testing';
import { Collection, Db } from 'mongodb';
import { APP_CONFIG } from '../../src/config/app-config';
import { AppConfigModule } from '../../src/config/app-config.module';
import { MONGO_DB, MongoModule } from '../../src/mongo/mongo.module';
import { RAW_EVENTS_COLLECTION, RawEvent } from '../../src/raw-events/raw-event.model';
import { RawEventRepository } from '../../src/raw-events/raw-event.repository';
import { RawEventsModule } from '../../src/raw-events/raw-events.module';
import { rawEvent } from '../support/raw-event';
import { clearCollections, testConfig } from '../support/test-db';

const LEASE_MS = 15_000;

describe('RawEventRepository.claimNext', () => {
  let moduleRef: TestingModule;
  let db: Db;
  let rawEvents: Collection<RawEvent>;
  let repository: RawEventRepository;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [AppConfigModule, MongoModule, RawEventsModule],
    })
      .overrideProvider(APP_CONFIG)
      .useValue(testConfig())
      .compile();

    db = moduleRef.get<Db>(MONGO_DB);
    await db.dropDatabase();
    await moduleRef.init(); // creates the indexes

    rawEvents = db.collection<RawEvent>(RAW_EVENTS_COLLECTION);
    repository = moduleRef.get(RawEventRepository);
  });

  beforeEach(() => clearCollections(db));

  afterAll(async () => {
    await moduleRef?.close();
  });

  it('gives each claimable event to exactly one of many concurrent claimers', async () => {
    const claimable = Array.from({ length: 20 }, (_, i) => rawEvent({ _id: `claimable-${i}` }));
    await rawEvents.insertMany([
      ...claimable,
      rawEvent({ _id: 'done', status: 'done', claimableAt: null }),
      rawEvent({ _id: 'not-yet', claimableAt: new Date(Date.now() + 60_000) }),
    ]);

    const claims = await Promise.all(
      Array.from({ length: 30 }, () => repository.claimNext(LEASE_MS)),
    );

    const claimedIds = claims.filter((claim) => claim !== null).map((claim) => claim._id);
    expect(claimedIds.sort()).toEqual(claimable.map((event) => event._id).sort());
  });

  it('does not give a claimed event out again until its lease runs out', async () => {
    await rawEvents.insertOne(rawEvent({ _id: 'e1' }));

    const first = await repository.claimNext(LEASE_MS);
    expect(first?._id).toBe('e1');
    expect(await repository.claimNext(LEASE_MS)).toBeNull();

    // Pretend the lease ran out, as if the worker holding it had died.
    await rawEvents.updateOne({ _id: 'e1' }, { $set: { claimableAt: new Date(Date.now() - 1) } });
    const second = await repository.claimNext(LEASE_MS);

    expect(second?._id).toBe('e1');
    expect(second?.claimToken).not.toBe(first?.claimToken);
  });
});
