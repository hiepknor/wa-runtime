import { ArgumentsHost, Catch, type ExceptionFilter, HttpException, HttpStatus } from '@nestjs/common';
import type { Response } from 'express';
import type { RuntimeErrorDto } from '../../contracts/common/runtime-error.dto';
import { runtimeErrorFromHttpException } from '../../core/http/runtime-http-exception.filter';

const participantFields = ['minParticipants', 'maxParticipants'] as const;

@Catch(HttpException)
export class GroupHttpExceptionFilter implements ExceptionFilter {
  catch(exception: HttpException, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const value = exception.getResponse();
    if (typeof value === 'object' && value !== null && 'code' in value) {
      response.status(exception.getStatus()).json(value);
      return;
    }

    const rawMessages = typeof value === 'object' && value !== null && 'message' in value
      ? (value as { message: unknown }).message
      : exception.message;
    const messages = Array.isArray(rawMessages) ? rawMessages.map(String) : [String(rawMessages)];
    const invalidParticipantFields = participantFields.filter(field =>
      messages.some(message => message.includes(field)),
    );
    const fieldErrors: Record<string, string[]> = {};
    for (const message of messages) {
      const field = participantFields.find(candidate => message.includes(candidate))
        ?? message.split(' ')[0]
        ?? 'request';
      (fieldErrors[field] ??= []).push(message);
    }
    const queryInvalid = messages.some(message => /\bquery\b/u.test(message));
    const status = exception.getStatus();
    const specializedCode = invalidParticipantFields.length > 0
        ? 'GROUP_FILTER_PARTICIPANTS_INVALID'
        : queryInvalid
          ? 'GROUP_QUERY_INVALID'
          : status === HttpStatus.NOT_FOUND && messages[0] === 'Group not found'
            ? 'GROUP_NOT_FOUND'
            : null;
    if (!specializedCode) {
      response.status(status).json(runtimeErrorFromHttpException(exception));
      return;
    }
    const body: RuntimeErrorDto = {
      code: specializedCode,
      message: invalidParticipantFields.length > 0
        ? 'Participant count filters are invalid.'
        : (messages[0] ?? exception.message),
      ...(status === HttpStatus.BAD_REQUEST ? { fieldErrors } : {}),
      details: {},
    };
    response.status(status).json(body);
  }
}
