export const RAW_EVENTS_COLLECTION = 'rawEvents';

export type RawEventStatus = 'pending' | 'processing' | 'done' | 'failed';

/** What the external call returns for an event. */
export type ProcessingResult = Record<string, unknown>;

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
  /**
   * Where the event is in its lifecycle, for status lookups and monitoring.
   * The queue doesn't use it to decide what to claim. That's what `claimableAt` is for.
   */
  status: RawEventStatus;
  /** When a worker may next claim the event. It's `null` once the event is `done` or `failed`. */
  claimableAt: Date | null;
  /**
   * A new random value on every claim. Later writes by the claiming worker only match while
   * the token is unchanged, so a worker whose claim was taken over can't write anything.
   */
  claimToken: string | null;
  /**
   * The external call's result, cached so the slow call runs once per event.
   * Recomputing a patient's state reuses it instead of calling again.
   */
  processingResult: ProcessingResult | null;
  /**
   * How many attempts at this event have failed: an error, or a claim whose lease ran out before
   * the worker handed it back. Waiting on an earlier event doesn't count.
   */
  attempts: number;
  /** Why the last failed attempt failed. */
  lastError: string | null;
}

/** An event as returned by a claim, which always carries the claiming worker's token. */
export type ClaimedEvent = RawEvent & { claimToken: string };

/**
 * What a claim found: an event to work on, or an event whose lease had run out once too often,
 * which the claim marked `failed` instead of handing out again.
 */
export type ClaimResult =
  { kind: 'claimed'; event: ClaimedEvent } | { kind: 'failed'; event: RawEvent };

/** A claimed event whose external call has finished and whose result is cached. */
export type ProcessedEvent = ClaimedEvent & { processingResult: ProcessingResult };
