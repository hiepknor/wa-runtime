import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import {
  runtimeErrorFromException,
  runtimeErrorFromHttpException,
} from '../../src/core/http/runtime-http-exception.filter';

describe('Runtime HTTP exception normalization', () => {
  it('preserves feature-owned machine-readable errors', () => {
    const body = {
      code: 'CAMPAIGN_NOT_EDITABLE',
      message: 'Only DRAFT campaigns can be edited',
      details: { status: 'ACTIVE' },
    };

    expect(runtimeErrorFromHttpException(new ConflictException(body))).toBe(body);
  });

  it.each([
    [new ForbiddenException('Session is outside the allowlist'), 'FORBIDDEN'],
    [new NotFoundException('Resource not found'), 'RESOURCE_NOT_FOUND'],
    [new ConflictException('State changed'), 'CONFLICT'],
  ])('maps generic HTTP failures to stable Runtime codes', (exception, code) => {
    expect(runtimeErrorFromHttpException(exception)).toEqual({
      code,
      message: exception.message,
      details: {},
    });
  });

  it('groups class-validator messages by field', () => {
    const exception = new BadRequestException([
      'limit must not be greater than 200',
      'property unexpected should not exist',
    ]);

    expect(runtimeErrorFromHttpException(exception)).toEqual({
      code: 'VALIDATION_ERROR',
      message: 'limit must not be greater than 200',
      fieldErrors: {
        limit: ['limit must not be greater than 200'],
        unexpected: ['property unexpected should not exist'],
      },
      details: {},
    });
  });

  it('does not expose unexpected exception details', () => {
    expect(runtimeErrorFromException(new Error('database password leaked'))).toEqual({
      status: 500,
      body: { code: 'INTERNAL_ERROR', message: 'Internal server error', details: {} },
    });
  });
});
