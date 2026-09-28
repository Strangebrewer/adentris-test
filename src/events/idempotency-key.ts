import { createHash } from 'node:crypto';
import stableStringify from 'fast-json-stable-stringify';

export interface EventContent {
  patientId: string;
  type: string;
  ts: Date;
  data: Record<string, unknown>;
}

/**
 * Builds the event's idempotency key by hashing its content.
 * Senders don't give us an event id and may retry,
 * so the same event must always produce the same key.
 * The JSON keys are sorted before hashing, so their order doesn't matter.
 * `ts` is hashed as a normalised ISO string, so `…00Z` and `…00.000Z` count as the same event.
 */
export function idempotencyKey({ patientId, type, ts, data }: EventContent): string {
  const canonical = stableStringify({ patientId, type, ts: ts.toISOString(), data });
  return createHash('sha256').update(canonical).digest('hex');
}
