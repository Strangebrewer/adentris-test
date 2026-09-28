import { PatientState } from './fold';

export const PATIENT_SNAPSHOTS_COLLECTION = 'patientSnapshots';

/**
 * A copy of a patient's state at one point in their history, so a late event can be fitted in
 * by replaying from here rather than from the start. Like the projection, it's a cache.
 */
export interface PatientSnapshot {
  patientId: string;
  /** The `ts` of the last event folded into `state`. */
  ts: Date;
  /** The projection's `snapshotGen` when `state` was built. See `PatientProjection.snapshotGen`. */
  gen: number;
  state: PatientState;
}
