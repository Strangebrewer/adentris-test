import { ClaimedEvent } from '../../src/raw-events/raw-event.model';
import { RawEventRepository } from '../../src/raw-events/raw-event.repository';

/** Claims the next event, and fails the test unless one is handed out to work on. */
export async function claimOne(repository: RawEventRepository): Promise<ClaimedEvent> {
  const claim = await repository.claimNext(15_000, 5);
  if (claim?.kind !== 'claimed') {
    throw new Error(`Expected to claim an event, got ${JSON.stringify(claim)}`);
  }
  return claim.event;
}
