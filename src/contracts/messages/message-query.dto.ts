import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, IsUUID } from 'class-validator';
import { PaginationQueryDto } from '../common/pagination.dto';

export class MessageQueryDto extends PaginationQueryDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  sessionId!: string;

  @ApiPropertyOptional({ example: '120363000000000000@g.us' })
  @IsOptional()
  @IsString()
  groupId?: string;
}
