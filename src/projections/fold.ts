import { createHash } from 'node:crypto';
import { ProcessingResult } from '../raw-events/raw-event.model';

/**
 * A patient's derived state. The brief says the processing logic doesn't matter,
 * so this is deliberately trivial. What matters is that it's folded in `ts` order.
 */
export interface PatientState {
  eventCount: number;
  /** Every event's result merged together, with later events overwriting earlier ones. */
  latest: ProcessingResult;
  /**
   * A running hash of the event ids, in the order they were folded.
   * `latest` alone can hide a lost or misordered event when a later event overwrites the
   * same keys. The digest can't: any dropped, repeated or reordered event changes it.
   */
  digest: string;
}

export interface FoldableEvent {
  _id: string;
  processingResult: ProcessingResult;
}

export const EMPTY_STATE: PatientState = { eventCount: 0, latest: {}, digest: '' };

export function foldEvent(state: PatientState, event: FoldableEvent): PatientState {
  return {
    eventCount: state.eventCount + 1,
    latest: { ...state.latest, ...event.processingResult },
    digest: createHash('sha256').update(state.digest).update(event._id).digest('hex'),
  };
}

/** Folds events that are already sorted by `(ts, _id)`. */
export function foldAll(events: FoldableEvent[]): PatientState {
  return events.reduce(foldEvent, EMPTY_STATE);
}
