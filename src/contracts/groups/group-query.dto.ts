import { ApiProperty } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';
import { PaginationQueryDto } from '../common/pagination.dto';

export class GroupQueryDto extends PaginationQueryDto {
  @ApiProperty({ format: 'uuid', description: 'Gateway session owning the read model' })
  @IsUUID()
  sessionId!: string;
}

export class GroupIdentityQueryDto {
  @ApiProperty({ format: 'uuid', description: 'Gateway session owning the group' })
  @IsUUID()
  sessionId!: string;
}
