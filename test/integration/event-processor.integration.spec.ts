import { Test } from '@nestjs/testing';
import { Db } from 'mongodb';
import { APP_CONFIG } from '../../src/config/app-config';
import { AppConfigModule } from '../../src/config/app-config.module';
import { MONGO_DB, MongoModule } from '../../src/mongo/mongo.module';
import { CommitService } from '../../src/processing/commit.service';
import { EventProcessor } from '../../src/processing/event-processor';
import { ProcessingModule } from '../../src/processing/processing.module';
import { foldAll } from '../../src/projections/fold';
import {
  PATIENT_PROJECTIONS_COLLECTION,
  PatientProjection,
} from '../../src/projections/patient-projection.model';
import {
  ClaimedEvent,
  RAW_EVENTS_COLLECTION,
  RawEvent,
} from '../../src/raw-events/raw-event.model';
import { RawEventRepository } from '../../src/raw-events/raw-event.repository';
import { rawEvent } from '../support/raw-event';
import { clearCollections, testConfig } from '../support/test-db';

const LEASE_MS = 15_000;

async function setUp(config: Record<string, string>) {
  const moduleRef = await Test.createTestingModule({
    imports: [AppConfigModule, MongoModule, ProcessingModule],
  })
    .overrideProvider(APP_CONFIG)
    .useValue(testConfig(config))
    .compile();

  const db = moduleRef.get<Db>(MONGO_DB);
  await db.dropDatabase();
  await moduleRef.init(); // creates the indexes

  return {
    moduleRef,
    db,
    rawEvents: db.collection<RawEvent>(RAW_EVENTS_COLLECTION),
    projections: db.collection<PatientProjection>(PATIENT_PROJECTIONS_COLLECTION),
    repository: moduleRef.get(RawEventRepository),
    processor: moduleRef.get(EventProcessor),
    commits: moduleRef.get(CommitService),
  };
}

describe('EventProcessor when a claim is taken over', () => {
  let ctx: Awaited<ReturnType<typeof setUp>>;

  beforeAll(async () => {
    ctx = await setUp({ PROCESSING_SIMULATED_CALL_MS: '0' });
  });

  beforeEach(() => clearCollections(ctx.db));

  afterAll(async () => {
    await ctx?.moduleRef.close();
  });

  const claim = async (): Promise<ClaimedEvent> => (await ctx.repository.claimNext(LEASE_MS))!;

  /** Pretends e1's lease ran out while its worker was stalled, so another worker can claim it. */
  async function expireLease(): Promise<void> {
    const past = new Date(Date.now() - 1);
    await ctx.rawEvents.updateOne({ _id: 'e1' }, { $set: { claimableAt: past } });
  }

  it('lets the worker that lost the claim write nothing', async () => {
    await ctx.rawEvents.insertOne(rawEvent({ _id: 'e1' }));
    const first = await claim();
    await expireLease();
    const second = await claim();

    expect(await ctx.processor.process(second)).toBe('committed');
    // The first worker carries on as if it still held the claim.
    expect(await ctx.processor.process(first)).toBe('claim-lost');
    expect(await ctx.repository.release(first, new Date())).toBe(false);
    expect(await ctx.repository.markDone(first)).toBe(false);

    const stored = await ctx.rawEvents.findOne({ _id: 'e1' });
    expect(await ctx.projections.findOne({ _id: 'p1' })).toMatchObject({
      state: foldAll([{ _id: 'e1', processingResult: stored!.processingResult! }]),
    });
  });

  it('folds the event once when both workers reach the commit', async () => {
    await ctx.rawEvents.insertOne(rawEvent({ _id: 'e1' }));
    const result = { 'heart-rate': { bpm: 70 } };
    const first = await claim();
    // The first worker cached its result before its lease ran out.
    await ctx.repository.cacheResult(first, result);
    await expireLease();
    const second = await claim();

    expect(await ctx.commits.commit({ ...first, processingResult: result })).toBe('claim-lost');
    expect(await ctx.processor.process(second)).toBe('committed');

    expect(await ctx.projections.findOne({ _id: 'p1' })).toMatchObject({
      state: foldAll([{ _id: 'e1', processingResult: result }]),
    });
  });
});

describe('EventProcessor when the external call is too slow', () => {
  let ctx: Awaited<ReturnType<typeof setUp>>;

  beforeAll(async () => {
    ctx = await setUp({ PROCESSING_SIMULATED_CALL_MS: '2000', PROCESSING_CALL_TIMEOUT_MS: '50' });
  });

  afterAll(async () => {
    await ctx?.moduleRef.close();
  });

  it('abandons the call at the timeout and stores nothing', async () => {
    await ctx.rawEvents.insertOne(rawEvent({ _id: 'e1' }));
    const claimed = await ctx.repository.claimNext(LEASE_MS);

    await expect(ctx.processor.process(claimed!)).rejects.toThrow(
      'External call timed out after 50ms',
    );

    // Left as it was, for the lease to run out and the event to be claimed again.
    expect(await ctx.rawEvents.findOne({ _id: 'e1' })).toMatchObject({
      status: 'processing',
      processingResult: null,
    });
    expect(await ctx.projections.countDocuments()).toBe(0);
  });
});
