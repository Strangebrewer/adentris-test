import { PatientState } from './fold';

export const PATIENT_PROJECTIONS_COLLECTION = 'patientProjections';

/**
 * A patient's current state, folded from their events in `ts` order.
 * It's a cache: it can be dropped and rebuilt from the raw event log.
 */
export interface PatientProjection {
  /** The patient id. */
  _id: string;
  state: PatientState;
  /**
   * The latest `ts` in the state. An event after it is folded straight onto the state.
   * An event at or before it arrived late, and the state is recomputed to fit it in.
   */
  watermarkTs: Date;
  /**
   * Goes up by one on every write. Each write only lands if the version is still the one
   * it read, so a write computed from an outdated read can't overwrite a newer one.
   */
  version: number;
  /**
   * Goes up by one every time a late event forces a recompute. Snapshots record the generation
   * they were taken in, and a recompute only starts from a snapshot of the current generation.
   * A snapshot taken before a recompute may be missing the late event, so it's never used.
   */
  snapshotGen: number;
  /** How many events have been folded straight onto the state since the last snapshot. */
  forwardSinceSnapshot: number;
}

/** Everything a write sets. The version is handled by the write itself. */
export type ProjectionFields = Omit<PatientProjection, '_id' | 'version'>;
