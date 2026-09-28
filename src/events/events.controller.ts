import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { CreateEventDto } from './create-event.dto';
import { AcceptedEvent, EventsService, EventStatusView } from './events.service';

@Controller('events')
export class EventsController {
  constructor(private readonly events: EventsService) {}

  /** Returns 202 Accepted: the event is stored and can be processed by a worker later. */
  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  accept(@Body() dto: CreateEventDto): Promise<AcceptedEvent> {
    return this.events.accept(dto);
  }

  @Get(':id')
  getStatus(@Param('id') id: string): Promise<EventStatusView> {
    return this.events.getStatus(id);
  }
}
