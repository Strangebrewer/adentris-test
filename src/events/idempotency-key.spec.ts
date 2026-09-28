import { EventContent, idempotencyKey } from './idempotency-key';

const event: EventContent = {
  patientId: 'p1',
  type: 'blood-pressure',
  ts: new Date('2026-01-01T00:00:00Z'),
  data: { systolic: 120, device: { id: 'cuff-7', unit: 'mmHg' } },
};

describe('idempotencyKey', () => {
  it('ignores key order at every level of data', () => {
    const reordered = { ...event, data: { device: { unit: 'mmHg', id: 'cuff-7' }, systolic: 120 } };

    expect(idempotencyKey(reordered)).toBe(idempotencyKey(event));
  });

  // A field left out of the hash would silently merge distinct events into one,
  // so changing any single field must change the key.
  it('distinguishes events differing only in patientId', () => {
    const other = { ...event, patientId: 'p2' };
    expect(idempotencyKey(other)).not.toBe(idempotencyKey(event));
  });

  it('distinguishes events differing only in type', () => {
    const other = { ...event, type: 'heart-rate' };
    expect(idempotencyKey(other)).not.toBe(idempotencyKey(event));
  });

  it('distinguishes events differing only in ts, even by one millisecond', () => {
    const other = { ...event, ts: new Date('2026-01-01T00:00:00.001Z') };
    expect(idempotencyKey(other)).not.toBe(idempotencyKey(event));
  });

  it('distinguishes events differing only in data', () => {
    const other = { ...event, data: { systolic: 121, device: { id: 'cuff-7', unit: 'mmHg' } } };
    expect(idempotencyKey(other)).not.toBe(idempotencyKey(event));
  });
});
