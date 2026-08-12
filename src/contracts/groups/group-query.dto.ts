import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsOptional, IsString, IsUUID } from 'class-validator';
import { PaginationQueryDto } from '../common/pagination.dto';

export class GroupQueryDto extends PaginationQueryDto {
  @ApiProperty({ format: 'uuid', description: 'Gateway session owning the read model' })
  @IsUUID()
  sessionId!: string;
}

export class GroupMemberQueryDto extends GroupQueryDto {
  @ApiPropertyOptional({
    description: 'Case-insensitive literal substring search across display name, phone number, and participant ID',
  })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => typeof value === 'string' ? value.trim() : value)
  @IsString()
  query?: string;
}

export class GroupIdentityQueryDto {
  @ApiProperty({ format: 'uuid', description: 'Gateway session owning the group' })
  @IsUUID()
  sessionId!: string;
}
