import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { APP_CONFIG, AppConfig } from '../config/app-config';
import { RawEventStatus } from '../raw-events/raw-event.model';
import { RawEventRepository } from '../raw-events/raw-event.repository';
import { CreateEventDto } from './create-event.dto';
import { idempotencyKey } from './idempotency-key';

export interface AcceptedEvent {
  id: string;
}

export interface EventStatusView {
  id: string;
  patientId: string;
  type: string;
  ts: Date;
  receivedAt: Date;
  status: RawEventStatus;
}

@Injectable()
export class EventsService {
  constructor(
    private readonly rawEvents: RawEventRepository,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /**
   * Stores the event so a worker can process it later.
   * The response is the same whether the event is new or a duplicate,
   * so a retrying sender can't tell the difference.
   */
  async accept(dto: CreateEventDto): Promise<AcceptedEvent> {
    const ts = this.parseTs(dto.ts);
    const id = idempotencyKey({ patientId: dto.patientId, type: dto.type, ts, data: dto.data });
    const now = new Date();

    await this.rawEvents.insertIfAbsent({
      _id: id,
      patientId: dto.patientId,
      type: dto.type,
      ts,
      data: dto.data,
      receivedAt: now,
      status: 'pending',
      claimableAt: now,
      claimToken: null,
    });
    return { id };
  }

  async getStatus(id: string): Promise<EventStatusView> {
    const event = await this.rawEvents.findById(id);
    if (!event) throw new NotFoundException(`No event with id ${id}`);

    const { _id, patientId, type, ts, receivedAt, status } = event;
    return { id: _id, patientId, type, ts, receivedAt, status };
  }

  private parseTs(raw: string): Date {
    const ts = new Date(raw);
    // Some valid RFC 3339 values can't be represented as a Date,
    // such as a leap second (`23:59:60`).
    if (Number.isNaN(ts.getTime())) {
      throw new BadRequestException(`ts is not a representable instant: ${raw}`);
    }
    // Backdated events are valid, so there's no limit in the past.
    // A ts far in the future would make every later event for this patient look late,
    // and each of them would force a full recompute of the patient's state.
    if (ts.getTime() > Date.now() + this.config.ingest.maxFutureSkewMs) {
      throw new BadRequestException(`ts is too far in the future: ${raw}`);
    }
    return ts;
  }
}
