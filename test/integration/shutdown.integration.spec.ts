import { Test, TestingModule } from '@nestjs/testing';
import { Collection, MongoClient } from 'mongodb';
import { APP_CONFIG } from '../../src/config/app-config';
import { RAW_EVENTS_COLLECTION, RawEvent } from '../../src/raw-events/raw-event.model';
import { WorkerAppModule } from '../../src/worker-app.module';
import { rawEvent } from '../support/raw-event';
import { testConfig } from '../support/test-db';
import { waitFor } from '../support/wait-for';

describe('Worker shutdown', () => {
  // A client of the test's own, since the worker closes its client when it shuts down.
  let client: MongoClient;
  let rawEvents: Collection<RawEvent>;

  beforeAll(async () => {
    const { uri, dbName } = testConfig().mongo;
    client = await MongoClient.connect(uri);
    const db = client.db(dbName);
    await db.dropDatabase();
    rawEvents = db.collection<RawEvent>(RAW_EVENTS_COLLECTION);
  });

  beforeEach(() => rawEvents.deleteMany({}));

  afterAll(async () => {
    await client?.close();
  });

  /** Starts a worker, and returns once it has claimed event e1. */
  async function startWorker(config: Record<string, string>): Promise<TestingModule> {
    await rawEvents.insertOne(rawEvent({ _id: 'e1' }));
    const moduleRef = await Test.createTestingModule({ imports: [WorkerAppModule] })
      .overrideProvider(APP_CONFIG)
      .useValue(testConfig({ QUEUE_IDLE_POLL_MS: '10', ...config }))
      .compile();
    moduleRef.useLogger(false);
    await moduleRef.init(); // starts the claim loop

    await waitFor(
      async () => (await rawEvents.findOne({ _id: 'e1' }))?.status === 'processing',
      'the worker to claim e1',
    );
    return moduleRef;
  }

  it('lets an in-flight event finish if it can within the shutdown timeout', async () => {
    const worker = await startWorker({
      PROCESSING_SIMULATED_CALL_MS: '200',
      WORKER_SHUTDOWN_TIMEOUT_MS: '5000',
    });

    await worker.close(); // what SIGTERM and SIGINT trigger

    expect(await rawEvents.findOne({ _id: 'e1' })).toMatchObject({ status: 'done' });
  });

  // Otherwise every redeploy would leave in-flight events waiting out a full lease.
  it('hands an unfinished event straight back at the shutdown deadline', async () => {
    const worker = await startWorker({
      PROCESSING_SIMULATED_CALL_MS: '60000',
      WORKER_SHUTDOWN_TIMEOUT_MS: '100',
    });
    const closing = Date.now();

    await worker.close();

    expect(Date.now() - closing).toBeLessThan(2_000); // it didn't wait for the call
    const stored = await rawEvents.findOne({ _id: 'e1' });
    // Not counted as a failed attempt: shutting down isn't the event's fault.
    expect(stored).toMatchObject({ status: 'pending', claimToken: null, attempts: 0 });
    expect(stored!.claimableAt!.getTime()).toBeLessThanOrEqual(Date.now());
  });
});
