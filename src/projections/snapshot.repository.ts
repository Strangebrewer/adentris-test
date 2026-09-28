import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { Collection, Db } from 'mongodb';
import { MONGO_DB } from '../mongo/mongo.module';
import { PATIENT_SNAPSHOTS_COLLECTION, PatientSnapshot } from './patient-snapshot.model';

@Injectable()
export class SnapshotRepository implements OnModuleInit {
  private readonly collection: Collection<PatientSnapshot>;

  constructor(@Inject(MONGO_DB) db: Db) {
    this.collection = db.collection<PatientSnapshot>(PATIENT_SNAPSHOTS_COLLECTION);
  }

  async onModuleInit(): Promise<void> {
    await this.collection.createIndex({ patientId: 1, gen: 1, ts: 1 });
  }

  async insert(snapshot: PatientSnapshot): Promise<void> {
    await this.collection.insertOne(snapshot);
  }

  /**
   * The latest snapshot of generation `gen` taken strictly before `ts`.
   * Strictly: a snapshot at exactly `ts` may hold events that sort after one arriving at that
   * same `ts`, so starting from it would fold the new event out of `(ts, _id)` order.
   */
  findNearestBefore(patientId: string, gen: number, ts: Date): Promise<PatientSnapshot | null> {
    return this.collection.findOne(
      { patientId, gen, ts: { $lt: ts } },
      { sort: { ts: -1 }, projection: { _id: 0 } },
    );
  }

  /**
   * After a recompute for a late event at `lateTs`, moves the snapshots before `lateTs` into the
   * new generation, since the late event doesn't change them. Everything left in older
   * generations can never be used again, so it's deleted.
   */
  async carryForward(patientId: string, fromGen: number, lateTs: Date): Promise<void> {
    const toGen = fromGen + 1;
    await this.collection.updateMany(
      { patientId, gen: fromGen, ts: { $lt: lateTs } },
      { $set: { gen: toGen } },
    );
    await this.collection.deleteMany({ patientId, gen: { $lt: toGen } });
  }
}
