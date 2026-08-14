import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class RuntimeErrorDto {
  @ApiProperty({ example: 'CAMPAIGN_NOT_FOUND' })
  code!: string;

  @ApiProperty()
  message!: string;

  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: { type: 'array', items: { type: 'string' } },
  })
  fieldErrors?: Record<string, string[]>;

  @ApiPropertyOptional({ type: 'object', additionalProperties: true })
  details?: Record<string, unknown>;
}
