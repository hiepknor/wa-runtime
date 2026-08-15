import {
  ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Response } from 'express';
import type { RuntimeErrorDto } from '../../contracts/common/runtime-error.dto';

const statusCode = (status: number): string => ({
  [HttpStatus.BAD_REQUEST]: 'VALIDATION_ERROR',
  [HttpStatus.UNAUTHORIZED]: 'UNAUTHORIZED',
  [HttpStatus.FORBIDDEN]: 'FORBIDDEN',
  [HttpStatus.NOT_FOUND]: 'RESOURCE_NOT_FOUND',
  [HttpStatus.CONFLICT]: 'CONFLICT',
  [HttpStatus.UNPROCESSABLE_ENTITY]: 'UNPROCESSABLE_ENTITY',
  [HttpStatus.TOO_MANY_REQUESTS]: 'RATE_LIMITED',
  [HttpStatus.SERVICE_UNAVAILABLE]: 'SERVICE_UNAVAILABLE',
} as Record<number, string>)[status] ?? `HTTP_${status}`;

const messagesFrom = (exception: HttpException): string[] => {
  const value = exception.getResponse();
  const raw = typeof value === 'object' && value !== null && 'message' in value
    ? (value as { message: unknown }).message
    : exception.message;
  return (Array.isArray(raw) ? raw : [raw]).map(String);
};

const validationField = (message: string): string => {
  const forbidden = /^property\s+([^\s]+)\s/u.exec(message);
  if (forbidden?.[1]) return forbidden[1];
  const field = /^([^\s]+)\s/u.exec(message)?.[1];
  return field && /^[A-Za-z][A-Za-z0-9_.-]*$/u.test(field) ? field : 'request';
};

export function runtimeErrorFromHttpException(exception: HttpException): RuntimeErrorDto {
  const value = exception.getResponse();
  if (typeof value === 'object' && value !== null && 'code' in value) {
    return value as RuntimeErrorDto;
  }

  const status = exception.getStatus();
  const messages = messagesFrom(exception);
  const fieldErrors: Record<string, string[]> = {};
  if (status === HttpStatus.BAD_REQUEST) {
    for (const message of messages) {
      const field = validationField(message);
      (fieldErrors[field] ??= []).push(message);
    }
  }
  return {
    code: statusCode(status),
    message: messages[0] ?? exception.message,
    ...(status === HttpStatus.BAD_REQUEST ? { fieldErrors } : {}),
    details: {},
  };
}

export function runtimeErrorFromException(exception: unknown): {
  status: number;
  body: RuntimeErrorDto;
} {
  if (exception instanceof HttpException) {
    return { status: exception.getStatus(), body: runtimeErrorFromHttpException(exception) };
  }
  return {
    status: HttpStatus.INTERNAL_SERVER_ERROR,
    body: { code: 'INTERNAL_ERROR', message: 'Internal server error', details: {} },
  };
}

@Catch()
export class RuntimeHttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(RuntimeHttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const normalized = runtimeErrorFromException(exception);
    if (!(exception instanceof HttpException)) {
      this.logger.error({ event: 'http.unhandled_exception', error: exception });
    }
    host.switchToHttp().getResponse<Response>()
      .status(normalized.status)
      .json(normalized.body);
  }
}
