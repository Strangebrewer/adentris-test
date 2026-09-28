import { Inject, Injectable } from '@nestjs/common';
import { Collection, Db, MongoServerError } from 'mongodb';
import { DUPLICATE_KEY, MONGO_DB } from '../mongo/mongo.module';
import {
  PATIENT_PROJECTIONS_COLLECTION,
  PatientProjection,
  ProjectionFields,
} from './patient-projection.model';

@Injectable()
export class ProjectionRepository {
  private readonly collection: Collection<PatientProjection>;

  constructor(@Inject(MONGO_DB) db: Db) {
    this.collection = db.collection<PatientProjection>(PATIENT_PROJECTIONS_COLLECTION);
  }

  find(patientId: string): Promise<PatientProjection | null> {
    return this.collection.findOne({ _id: patientId });
  }

  /**
   * Writes the projection only if its version is still `expectedVersion`, and bumps the version.
   * `expectedVersion` is null when there was no projection yet, and then the write only lands
   * if there still isn't one. Returns false if another write got there first.
   */
  async writeIfUnchanged(
    patientId: string,
    expectedVersion: number | null,
    fields: ProjectionFields,
  ): Promise<boolean> {
    if (expectedVersion === null) {
      try {
        await this.collection.insertOne({ _id: patientId, ...fields, version: 1 });
        return true;
      } catch (err) {
        if (err instanceof MongoServerError && err.code === DUPLICATE_KEY) return false;
        throw err;
      }
    }

    const { matchedCount } = await this.collection.updateOne(
      { _id: patientId, version: expectedVersion },
      { $set: fields, $inc: { version: 1 } },
    );
    return matchedCount === 1;
  }
}
