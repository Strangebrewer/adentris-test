import { Controller, Get, NotFoundException, Param } from '@nestjs/common';
import { PatientState } from '../projections/fold';
import { ProjectionRepository } from '../projections/projection.repository';
import { RawEventRepository } from '../raw-events/raw-event.repository';

export interface PatientView {
  patientId: string;
  /** Null if nothing has been committed for the patient yet. */
  state: PatientState | null;
  /** The latest event time the state includes. */
  watermarkTs: Date | null;
  /**
   * The patient's earliest failed event, if there is one. Every later event is waiting on it,
   * so the state stays where it is until the failed event is fixed and processed.
   */
  blockedBy: { eventId: string; ts: Date } | null;
}

@Controller('patients')
export class PatientsController {
  constructor(
    private readonly projections: ProjectionRepository,
    private readonly rawEvents: RawEventRepository,
  ) {}

  /** The patient's state, folded from their events in `ts` order. */
  @Get(':patientId')
  async get(@Param('patientId') patientId: string): Promise<PatientView> {
    const [projection, failed] = await Promise.all([
      this.projections.find(patientId),
      this.rawEvents.findFirstFailed(patientId),
    ]);
    // A patient whose very first event failed has no state, but is still worth showing.
    if (!projection && !failed) throw new NotFoundException(`No state for patient ${patientId}`);

    return {
      patientId,
      state: projection?.state ?? null,
      watermarkTs: projection?.watermarkTs ?? null,
      blockedBy: failed && { eventId: failed._id, ts: failed.ts },
    };
  }
}
