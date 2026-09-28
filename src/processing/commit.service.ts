import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG, AppConfig } from '../config/app-config';
import { EMPTY_STATE, foldAll, foldEvent } from '../projections/fold';
import { ProjectionRepository } from '../projections/projection.repository';
import { ProcessedEvent } from '../raw-events/raw-event.model';
import { RawEventRepository } from '../raw-events/raw-event.repository';

/**
 * - `committed`: the event is in the patient's state and marked `done`.
 * - `blocked`: an earlier event for the patient isn't done yet, so the event was handed back
 *   to the queue to try again shortly.
 * - `claim-lost`: another worker took the event over, so this worker has to stop.
 */
export type CommitOutcome = 'committed' | 'blocked' | 'claim-lost';

/** Fits a processed event into its patient's state, in `ts` order. */
@Injectable()
export class CommitService {
  constructor(
    private readonly rawEvents: RawEventRepository,
    private readonly projections: ProjectionRepository,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /**
   * The event is only marked `done` after the projected (derived) patient state includes it.
   * If the worker dies in between, the event is claimed again and committed again,
   * which leaves the state the same (see `applyToProjection`).
   */
  async commit(event: ProcessedEvent): Promise<CommitOutcome> {
    if (await this.rawEvents.hasUnfinishedBefore(event)) {
      // Hand the claim back now rather than holding it until the lease runs out.
      const retryAt = new Date(Date.now() + this.config.queue.blockedRetryDelayMs);
      return (await this.rawEvents.release(event, retryAt)) ? 'blocked' : 'claim-lost';
    }

    await this.applyToProjection(event);
    return (await this.rawEvents.markDone(event)) ? 'committed' : 'claim-lost';
  }

  /**
   * Each pass reads the projection, works out the new state and writes it only if no other
   * write for this patient landed in between. If one did, it starts over from a fresh read.
   * A lost write means another commit succeeded, so the loop always finishes.
   */
  private async applyToProjection(event: ProcessedEvent): Promise<void> {
    while (true) {
      const current = await this.projections.find(event.patientId);

      // Strictly after the watermark, not at or after it. If a worker wrote this event into the
      // state and then died before marking it done, the retry finds `ts` equal to the watermark
      // and recomputes below instead of adding the event a second time. That relies on the state
      // and the watermark being written together in a single update.
      if (!current || event.ts.getTime() > current.watermarkTs.getTime()) {
        const state = foldEvent(current?.state ?? EMPTY_STATE, event);
        const written = await this.projections.writeIfUnchanged(
          event.patientId,
          current?.version ?? null,
          state,
          event.ts,
        );
        if (written) return;
        continue;
      }

      // The event arrived late, so the state is recomputed from the start of the patient's
      // history with the event in its place. This folds every event that has a cached result,
      // including ones not yet marked done. An event can be in the state before it's marked
      // done, and folding only done events would drop it. Snapshots will shorten this later.
      const events = await this.rawEvents.findProcessedUpTo(event.patientId, current.watermarkTs);
      const written = await this.projections.writeIfUnchanged(
        event.patientId,
        current.version,
        foldAll(events),
        current.watermarkTs,
      );
      if (written) return;
    }
  }
}
