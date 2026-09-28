import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Collection, Db, MongoServerError } from 'mongodb';
import { DUPLICATE_KEY, MONGO_DB } from '../mongo/mongo.module';
import {
  ClaimedEvent,
  ProcessedEvent,
  ProcessingResult,
  RAW_EVENTS_COLLECTION,
  RawEvent,
} from './raw-event.model';

type Claim = Pick<ClaimedEvent, '_id' | 'claimToken'>;

@Injectable()
export class RawEventRepository implements OnModuleInit {
  private readonly collection: Collection<RawEvent>;

  constructor(@Inject(MONGO_DB) db: Db) {
    this.collection = db.collection<RawEvent>(RAW_EVENTS_COLLECTION);
  }

  async onModuleInit(): Promise<void> {
    // The claim query filters and sorts on `claimableAt` only, so this index serves it completely.
    await this.collection.createIndex({ claimableAt: 1 });
    // Serves the per-patient queries at commit time, which filter and sort by `(ts, _id)`.
    await this.collection.createIndex({ patientId: 1, ts: 1, _id: 1 });
  }

  /**
   * `_id` is the idempotency key, so storing the same event a second time
   * fails with a duplicate-key error. That just means we already have it.
   */
  async insertIfAbsent(event: RawEvent): Promise<void> {
    try {
      await this.collection.insertOne(event);
    } catch (err) {
      if (!(err instanceof MongoServerError && err.code === DUPLICATE_KEY)) throw err;
    }
  }

  findById(id: string): Promise<RawEvent | null> {
    return this.collection.findOne({ _id: id });
  }

  /**
   * Claims the claimable event that has waited longest, or returns null if there is none.
   * The claim is a single atomic update, so two workers can never claim the same event at once.
   * The claim lasts `leaseMs`. If the worker dies, the event becomes claimable again after that.
   */
  async claimNext(leaseMs: number): Promise<ClaimedEvent | null> {
    const now = new Date();
    const claimed = await this.collection.findOneAndUpdate(
      { claimableAt: { $lte: now } },
      {
        $set: {
          status: 'processing',
          claimableAt: new Date(now.getTime() + leaseMs),
          claimToken: randomUUID(),
        },
      },
      { sort: { claimableAt: 1 }, returnDocument: 'after' },
    );
    return claimed as ClaimedEvent | null;
  }

  /** Caches the external call's result. Returns false if the claim was taken over. */
  cacheResult(claim: Claim, result: ProcessingResult): Promise<boolean> {
    return this.updateIfStillClaimed(claim, { processingResult: result });
  }

  /**
   * Hands the event back to the queue, to be claimed again from `claimableAt`.
   * Returns false if the claim was taken over.
   */
  release(claim: Claim, claimableAt: Date): Promise<boolean> {
    return this.updateIfStillClaimed(claim, { status: 'pending', claimableAt, claimToken: null });
  }

  /** Returns false if the claim was taken over. */
  markDone(claim: Claim): Promise<boolean> {
    return this.updateIfStillClaimed(claim, {
      status: 'done',
      claimableAt: null,
      claimToken: null,
    });
  }

  /**
   * Whether the patient has an earlier event that isn't `done` yet.
   * Earlier means by `(ts, _id)`, the order events are folded in.
   */
  async hasUnfinishedBefore({ _id, patientId, ts }: RawEvent): Promise<boolean> {
    const earlier = await this.collection.findOne(
      {
        patientId,
        status: { $ne: 'done' },
        $or: [{ ts: { $lt: ts } }, { ts, _id: { $lt: _id } }],
      },
      { projection: { _id: 1 } },
    );
    return earlier !== null;
  }

  /**
   * The patient's events after `after` (or from the start, if it's null) up to and including
   * `upTo` that have a cached result, in the order they're folded in.
   * That includes events that aren't `done` yet.
   */
  findProcessedBetween(
    patientId: string,
    after: Date | null,
    upTo: Date,
  ): Promise<Pick<ProcessedEvent, '_id' | 'processingResult'>[]> {
    const ts = after ? { $gt: after, $lte: upTo } : { $lte: upTo };
    return this.collection
      .find(
        { patientId, ts, processingResult: { $ne: null } },
        { projection: { _id: 1, processingResult: 1 } },
      )
      .sort({ ts: 1, _id: 1 })
      .toArray() as Promise<Pick<ProcessedEvent, '_id' | 'processingResult'>[]>;
  }

  /**
   * Every write after the claim goes through here. It only matches while the worker's
   * token is still on the event, so a worker whose claim was taken over writes nothing.
   */
  private async updateIfStillClaimed(
    { _id, claimToken }: Claim,
    fields: Partial<RawEvent>,
  ): Promise<boolean> {
    const { matchedCount } = await this.collection.updateOne({ _id, claimToken }, { $set: fields });
    return matchedCount === 1;
  }
}
