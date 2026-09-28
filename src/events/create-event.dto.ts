import { IsNotEmpty, IsObject, IsRFC3339, IsString } from 'class-validator';

export class CreateEventDto {
  @IsString()
  @IsNotEmpty()
  patientId!: string;

  @IsString()
  @IsNotEmpty()
  type!: string;

  @IsObject()
  data!: Record<string, unknown>;

  /**
   * Must be RFC 3339, which requires a UTC offset such as `Z` or `+02:00`.
   * Without an offset, the timestamp would be read in the server's local time zone.
   * The same event could then show up as different instants on different servers.
   */
  @IsRFC3339()
  ts!: string;
}
