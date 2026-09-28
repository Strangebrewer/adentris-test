import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Collection, Db, MongoServerError } from 'mongodb';
import { MONGO_DB } from '../mongo/mongo.module';
import { ClaimedEvent, RAW_EVENTS_COLLECTION, RawEvent } from './raw-event.model';

const DUPLICATE_KEY = 11000;

@Injectable()
export class RawEventRepository implements OnModuleInit {
  private readonly collection: Collection<RawEvent>;

  constructor(@Inject(MONGO_DB) db: Db) {
    this.collection = db.collection<RawEvent>(RAW_EVENTS_COLLECTION);
  }

  async onModuleInit(): Promise<void> {
    // The claim query filters and sorts on `claimableAt` only, so this index serves it completely.
    await this.collection.createIndex({ claimableAt: 1 });
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
}
