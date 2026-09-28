import { RawEvent } from '../../src/raw-events/raw-event.model';

/** A claimable raw event for patient `p1`, for inserting directly in tests. */
export function rawEvent(overrides: Partial<RawEvent> & Pick<RawEvent, '_id'>): RawEvent {
  return {
    patientId: 'p1',
    type: 'heart-rate',
    ts: new Date('2026-01-01T00:00:00Z'),
    data: { bpm: 70 },
    receivedAt: new Date(),
    status: 'pending',
    claimableAt: new Date(),
    claimToken: null,
    processingResult: null,
    attempts: 0,
    lastError: null,
    ...overrides,
  };
}
