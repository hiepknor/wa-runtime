import { ArgumentsHost, Catch, type ExceptionFilter, HttpException, HttpStatus } from '@nestjs/common';
import type { Response } from 'express';
import type { RuntimeErrorDto } from '../../contracts/common/runtime-error.dto';
import { runtimeErrorFromHttpException } from '../../core/http/runtime-http-exception.filter';

@Catch(HttpException)
export class GroupListHttpExceptionFilter implements ExceptionFilter {
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
      const field = ['sessionId', 'name', 'description', 'groupIds', 'query', 'limit', 'offset']
        .find(candidate => message.includes(candidate)) ?? 'request';
      (fieldErrors[field] ??= []).push(message);
    }
    const queryInvalid = status === HttpStatus.BAD_REQUEST && messages.some(message => message.includes('query'));
    const groupIdsInvalid = status === HttpStatus.BAD_REQUEST
      && messages.some(message => message.includes('groupIds'));
    const sessionInvalid = status === HttpStatus.BAD_REQUEST
      && messages.some(message => message.includes('sessionId'));
    const nameInvalid = status === HttpStatus.BAD_REQUEST
      && messages.some(message => message.includes('name'));
    const specializedCode = queryInvalid
        ? 'GROUP_LIST_QUERY_INVALID'
        : groupIdsInvalid
          ? 'GROUP_LIST_GROUP_INVALID'
          : sessionInvalid
            ? 'GROUP_LIST_SESSION_INVALID'
            : nameInvalid
              ? 'GROUP_LIST_NAME_INVALID'
              : null;
    if (!specializedCode) {
      response.status(status).json(runtimeErrorFromHttpException(exception));
      return;
    }
    const body: RuntimeErrorDto = {
      code: specializedCode,
      message: messages[0] ?? exception.message,
      ...(status === HttpStatus.BAD_REQUEST ? { fieldErrors } : {}),
      details: {},
    };
    response.status(status).json(body);
  }
}
