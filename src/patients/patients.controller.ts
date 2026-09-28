import { Controller, Get, NotFoundException, Param } from '@nestjs/common';
import { PatientState } from '../projections/fold';
import { ProjectionRepository } from '../projections/projection.repository';

export interface PatientView {
  patientId: string;
  state: PatientState;
  /** The latest event time the state includes. */
  watermarkTs: Date;
}

@Controller('patients')
export class PatientsController {
  constructor(private readonly projections: ProjectionRepository) {}

  /** The patient's state, folded from their events in `ts` order. */
  @Get(':patientId')
  async get(@Param('patientId') patientId: string): Promise<PatientView> {
    const projection = await this.projections.find(patientId);
    if (!projection) throw new NotFoundException(`No state for patient ${patientId}`);

    return { patientId, state: projection.state, watermarkTs: projection.watermarkTs };
  }
}
