import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsISO8601, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

export class CreateMessageJobDto {
  @ApiProperty({ example: 'primary' })
  @IsString()
  @IsNotEmpty()
  sessionId!: string;

  @ApiProperty({ example: '120363000000000000@g.us' })
  @IsString()
  @IsNotEmpty()
  recipientId!: string;

  @ApiProperty({ example: 'Hello from WA Studio', maxLength: 4096 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(4096)
  text!: string;

  @ApiPropertyOptional({ example: '2026-08-11T12:00:00.000Z', description: 'Defaults to now' })
  @IsOptional()
  @IsISO8601()
  scheduledAt?: string;

  @ApiPropertyOptional({ default: true, description: 'Live sends also require ALLOW_LIVE_SENDS=true' })
  @IsOptional()
  @IsBoolean()
  dryRun: boolean = true;
}
