import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsInt, Min } from 'class-validator';

const integerQueryValue = ({ value }: { value: unknown }): unknown => {
  if (typeof value !== 'string' || !/^\d+$/u.test(value)) return value;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : value;
};

export class DeleteCampaignQueryDto {
  @ApiProperty({
    type: 'integer', minimum: 1,
    description: 'Campaign content revision observed before deletion. A stale value returns HTTP 409.',
  })
  @Transform(integerQueryValue)
  @IsInt()
  @Min(1)
  expectedRevision!: number;

  @ApiProperty({
    type: 'integer', minimum: 0,
    description: 'Campaign target-set revision observed before deletion. A stale value returns HTTP 409.',
  })
  @Transform(integerQueryValue)
  @IsInt()
  @Min(0)
  expectedTargetsRevision!: number;
}
