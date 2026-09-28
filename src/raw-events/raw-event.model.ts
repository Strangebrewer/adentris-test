export const RAW_EVENTS_COLLECTION = 'rawEvents';

export type RawEventStatus = 'pending' | 'processing' | 'done' | 'failed';

/**
 * One accepted event. This collection is the source of truth,
 * so an event's content never changes after it's stored.
 */
export interface RawEvent {
  /** The idempotency key — see `events/idempotency-key.ts`. */
  _id: string;
  patientId: string;
  type: string;
  ts: Date;
  data: Record<string, unknown>;
  receivedAt: Date;
  /** Where the event is in its lifecycle, for status lookups and monitoring. */
  status: RawEventStatus;
}
