import { ArgumentsHost, Catch, type ExceptionFilter, HttpException, HttpStatus } from '@nestjs/common';
import type { Response } from 'express';
import type { RuntimeErrorDto } from '../../contracts/common/runtime-error.dto';

@Catch(HttpException)
export class CampaignHttpExceptionFilter implements ExceptionFilter {
  catch(exception: HttpException, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const status = exception.getStatus();
    const value = exception.getResponse();
    if (typeof value === 'object' && value !== null && 'code' in value) {
      response.status(status).json(value);
      return;
    }

    const rawMessages = typeof value === 'object' && value !== null && 'message' in value
      ? (value as { message: unknown }).message
      : exception.message;
    const messages = Array.isArray(rawMessages) ? rawMessages.map(String) : [String(rawMessages)];
    const fieldErrors: Record<string, string[]> = {};
    for (const message of messages) {
      const field = message.split(' ')[0] || 'request';
      (fieldErrors[field] ??= []).push(message);
    }
    const body: RuntimeErrorDto = {
      code: status === HttpStatus.BAD_REQUEST ? 'VALIDATION_ERROR' : `HTTP_${status}`,
      message: messages[0] ?? exception.message,
      ...(status === HttpStatus.BAD_REQUEST ? { fieldErrors } : {}),
    };
    response.status(status).json(body);
  }
}
