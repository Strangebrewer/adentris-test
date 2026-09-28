import { Inject, Injectable } from '@nestjs/common';
import { Collection, Db, MongoServerError } from 'mongodb';
import { MONGO_DB } from '../mongo/mongo.module';
import { RAW_EVENTS_COLLECTION, RawEvent } from './raw-event.model';

const DUPLICATE_KEY = 11000;

@Injectable()
export class RawEventRepository {
  private readonly collection: Collection<RawEvent>;

  constructor(@Inject(MONGO_DB) db: Db) {
    this.collection = db.collection<RawEvent>(RAW_EVENTS_COLLECTION);
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
}
