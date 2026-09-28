import { FoldableEvent, foldAll } from './fold';

describe('foldAll', () => {
  // Both events write the same key with the same value, so `latest` can't tell the orders apart.
  it('gives a different state for a different order, even when latest is the same', () => {
    const a: FoldableEvent = { _id: 'a', processingResult: { heartRate: 70 } };
    const b: FoldableEvent = { _id: 'b', processingResult: { heartRate: 70 } };

    const inOrder = foldAll([a, b]);
    const reversed = foldAll([b, a]);

    expect(reversed.latest).toEqual(inOrder.latest);
    expect(reversed).not.toEqual(inOrder);
  });
});
