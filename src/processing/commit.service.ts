import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG, AppConfig } from '../config/app-config';
import { EMPTY_STATE, foldAll, foldEvent } from '../projections/fold';
import { PatientProjection } from '../projections/patient-projection.model';
import { ProjectionRepository } from '../projections/projection.repository';
import { SnapshotRepository } from '../projections/snapshot.repository';
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
    private readonly snapshots: SnapshotRepository,
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
      // and recomputes instead of adding the event a second time. That relies on the state
      // and the watermark being written together in a single update.
      const written =
        !current || event.ts.getTime() > current.watermarkTs.getTime()
          ? await this.foldForward(event, current)
          : await this.refold(event, current);
      if (written) return;
    }
  }

  /** The common case: the event is newer than everything in the state, so it goes on the end. */
  private async foldForward(
    event: ProcessedEvent,
    current: PatientProjection | null,
  ): Promise<boolean> {
    const state = foldEvent(current?.state ?? EMPTY_STATE, event);
    const snapshotGen = current?.snapshotGen ?? 0;
    const sinceSnapshot = (current?.forwardSinceSnapshot ?? 0) + 1;
    const takeSnapshot = sinceSnapshot >= this.config.snapshot.intervalEvents;

    const written = await this.projections.writeIfUnchanged(
      event.patientId,
      current?.version ?? null,
      {
        state,
        watermarkTs: event.ts,
        snapshotGen,
        forwardSinceSnapshot: takeSnapshot ? 0 : sinceSnapshot,
      },
    );
    // The count is reset in the same write. If the worker dies before saving the snapshot,
    // that snapshot is skipped, and replays start from the one before it instead.
    if (written && takeSnapshot) {
      await this.snapshots.insert({
        patientId: event.patientId,
        ts: event.ts,
        gen: snapshotGen,
        state,
      });
    }
    return written;
  }

  /**
   * The event arrived late, so the state is rebuilt with the event in its place, from the latest
   * usable snapshot before it (or from the start if there isn't one). This folds every event that
   * has a cached result, including ones not yet marked done. An event can be in the state before
   * it's marked done, and folding only done events would drop it.
   */
  private async refold(event: ProcessedEvent, current: PatientProjection): Promise<boolean> {
    const { patientId } = event;
    const snapshot = await this.snapshots.findNearestBefore(
      patientId,
      current.snapshotGen,
      event.ts,
    );
    const events = await this.rawEvents.findProcessedBetween(
      patientId,
      snapshot?.ts ?? null,
      current.watermarkTs,
    );

    const written = await this.projections.writeIfUnchanged(patientId, current.version, {
      state: foldAll(events, snapshot?.state),
      watermarkTs: current.watermarkTs,
      snapshotGen: current.snapshotGen + 1,
      forwardSinceSnapshot: current.forwardSinceSnapshot,
    });
    // Only once the write has landed. Before that, a recompute that goes on to lose the race
    // could move snapshots into a generation that the winning recompute defines differently.
    if (written) await this.snapshots.carryForward(patientId, current.snapshotGen, event.ts);
    return written;
  }
}
