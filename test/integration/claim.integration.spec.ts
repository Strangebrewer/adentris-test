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
const MAX_ATTEMPTS = 5;

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

  const claimNext = () => repository.claimNext(LEASE_MS, MAX_ATTEMPTS);

  /** Pretends e1's lease ran out, as if the worker holding it had died. */
  async function expireLease(): Promise<void> {
    const past = new Date(Date.now() - 1);
    await rawEvents.updateOne({ _id: 'e1' }, { $set: { claimableAt: past } });
  }

  it('gives each claimable event to exactly one of many concurrent claimers', async () => {
    const claimable = Array.from({ length: 20 }, (_, i) => rawEvent({ _id: `claimable-${i}` }));
    await rawEvents.insertMany([
      ...claimable,
      rawEvent({ _id: 'done', status: 'done', claimableAt: null }),
      rawEvent({ _id: 'not-yet', claimableAt: new Date(Date.now() + 60_000) }),
    ]);

    const claims = await Promise.all(Array.from({ length: 30 }, claimNext));

    const claimedIds = claims.filter((claim) => claim !== null).map((claim) => claim.event._id);
    expect(claimedIds.sort()).toEqual(claimable.map((event) => event._id).sort());
  });

  it('does not give a claimed event out again until its lease runs out', async () => {
    await rawEvents.insertOne(rawEvent({ _id: 'e1' }));

    const first = await claimNext();
    expect(first?.event._id).toBe('e1');
    expect(await claimNext()).toBeNull();

    await expireLease();
    const second = await claimNext();

    expect(second?.event._id).toBe('e1');
    expect(second?.event.claimToken).not.toBe(first?.event.claimToken);
  });

  it('counts a lease that ran out as a failed attempt', async () => {
    await rawEvents.insertOne(rawEvent({ _id: 'e1' }));

    expect((await claimNext())?.event.attempts).toBe(0);
    await expireLease();

    expect(await claimNext()).toMatchObject({ kind: 'claimed', event: { attempts: 1 } });
  });

  // An event that crashes every worker that picks it up would otherwise be retried forever.
  it('marks an event failed instead of handing it out when its lease has run out too often', async () => {
    await rawEvents.insertOne(rawEvent({ _id: 'e1', attempts: MAX_ATTEMPTS - 1 }));
    await claimNext();
    await expireLease();

    expect(await claimNext()).toMatchObject({
      kind: 'failed',
      event: { status: 'failed', attempts: MAX_ATTEMPTS, claimableAt: null, claimToken: null },
    });
    expect(await claimNext()).toBeNull();
  });
});
