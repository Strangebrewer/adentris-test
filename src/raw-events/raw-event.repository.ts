import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Collection, Db, MongoServerError } from 'mongodb';
import { DUPLICATE_KEY, MONGO_DB } from '../mongo/mongo.module';
import {
  ClaimedEvent,
  ClaimResult,
  ProcessedEvent,
  ProcessingResult,
  RAW_EVENTS_COLLECTION,
  RawEvent,
} from './raw-event.model';

type Claim = Pick<ClaimedEvent, '_id' | 'claimToken'>;

const FAILED_BY_PATIENT_INDEX = 'failed_by_patient';

export interface QueueStats {
  /** Events not yet `done` or `failed`. */
  depth: number;
  /** How long the event that's been claimable longest has been waiting. Null if none are. */
  oldestClaimableAgeMs: number | null;
  /** Events some worker is working on right now. */
  inFlight: number;
  /**
   * Processed but not yet committed: mostly events waiting on an earlier event for their
   * patient, plus commits waiting to be retried after an error.
   */
  awaitingCommit: number;
  failed: number;
}

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
    // Only failed events are in this one, so it stays tiny however large the log grows.
    await this.collection.createIndex(
      { patientId: 1, ts: 1 },
      { name: FAILED_BY_PATIENT_INDEX, partialFilterExpression: { status: 'failed' } },
    );
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
   *
   * Every clean hand-back clears the token, so a token still on the event means the previous
   * claim's lease ran out: the worker crashed or took too long. That counts as a failed attempt,
   * and at `maxAttempts` the event is marked `failed` instead of being handed out again.
   * Otherwise an event that crashes every worker that picks it up would be retried forever.
   */
  async claimNext(leaseMs: number, maxAttempts: number): Promise<ClaimResult | null> {
    const now = new Date();
    const leaseRanOut = { $ne: ['$claimToken', null] };
    const exhausted = { $gte: ['$attempts', maxAttempts] };

    const event = await this.collection.findOneAndUpdate(
      { claimableAt: { $lte: now } },
      [
        { $set: { attempts: { $add: ['$attempts', { $cond: [leaseRanOut, 1, 0] }] } } },
        {
          $set: {
            status: { $cond: [exhausted, 'failed', 'processing'] },
            claimableAt: { $cond: [exhausted, null, new Date(now.getTime() + leaseMs)] },
            claimToken: { $cond: [exhausted, null, randomUUID()] },
            lastError: {
              $cond: [
                leaseRanOut,
                'The lease ran out before the worker finished: it crashed or took too long',
                '$lastError',
              ],
            },
          },
        },
      ],
      { sort: { claimableAt: 1 }, returnDocument: 'after' },
    );

    if (!event) return null;
    return event.status === 'failed'
      ? { kind: 'failed', event }
      : { kind: 'claimed', event: event as ClaimedEvent };
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
   * Records a failed attempt and hands the event back, to be retried from `retryAt`.
   * Returns false if the claim was taken over.
   */
  retryLater(claim: Claim, attempts: number, error: string, retryAt: Date): Promise<boolean> {
    return this.updateIfStillClaimed(claim, {
      status: 'pending',
      claimableAt: retryAt,
      claimToken: null,
      attempts,
      lastError: error,
    });
  }

  /**
   * Records the last allowed attempt as failed. The event is never claimed again, and it keeps
   * blocking the patient's later events. Returns false if the claim was taken over.
   */
  markFailed(claim: Claim, attempts: number, error: string): Promise<boolean> {
    return this.updateIfStillClaimed(claim, {
      status: 'failed',
      claimableAt: null,
      claimToken: null,
      attempts,
      lastError: error,
    });
  }

  /** The queue's numbers for `GET /health`. They cover every worker, since they come from Mongo. */
  async getQueueStats(): Promise<QueueStats> {
    const now = new Date();
    const [depth, oldest, inFlight, awaitingCommit, failed] = await Promise.all([
      this.collection.countDocuments({ claimableAt: { $ne: null } }),
      this.collection.findOne(
        { claimableAt: { $lte: now } },
        { sort: { claimableAt: 1 }, projection: { claimableAt: 1 } },
      ),
      this.collection.countDocuments({ claimableAt: { $gt: now }, status: 'processing' }),
      this.collection.countDocuments({
        claimableAt: { $ne: null },
        processingResult: { $ne: null },
      }),
      this.collection.countDocuments({ status: 'failed' }, { hint: FAILED_BY_PATIENT_INDEX }),
    ]);
    return {
      depth,
      oldestClaimableAgeMs: oldest?.claimableAt
        ? now.getTime() - oldest.claimableAt.getTime()
        : null,
      inFlight,
      awaitingCommit,
      failed,
    };
  }

  /** The patient's earliest `failed` event, which everything after it is waiting on. */
  findFirstFailed(patientId: string): Promise<Pick<RawEvent, '_id' | 'ts'> | null> {
    return this.collection
      .find({ patientId, status: 'failed' }, { projection: { _id: 1, ts: 1 } })
      .hint(FAILED_BY_PATIENT_INDEX)
      .sort({ ts: 1, _id: 1 })
      .limit(1)
      .next();
  }

  /**
   * Whether the patient has an earlier event that isn't `done` yet. That includes `failed`
   * events, so a failed event holds up everything after it.
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
   * That includes events that aren't `done` yet, but not `failed` ones: a failed event can
   * have a result if its call succeeded and its commit didn't.
   */
  findProcessedBetween(
    patientId: string,
    after: Date | null,
    upTo: Date,
  ): Promise<Pick<ProcessedEvent, '_id' | 'processingResult'>[]> {
    const ts = after ? { $gt: after, $lte: upTo } : { $lte: upTo };
    return this.collection
      .find(
        { patientId, ts, processingResult: { $ne: null }, status: { $ne: 'failed' } },
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
