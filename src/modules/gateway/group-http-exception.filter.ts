import { ArgumentsHost, BadRequestException, Catch, type ExceptionFilter } from '@nestjs/common';
import type { Response } from 'express';
import type { RuntimeErrorDto } from '../../contracts/common/runtime-error.dto';

const participantFields = ['minParticipants', 'maxParticipants'] as const;

@Catch(BadRequestException)
export class GroupHttpExceptionFilter implements ExceptionFilter {
  catch(exception: BadRequestException, host: ArgumentsHost): void {
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
    const body: RuntimeErrorDto = {
      code: invalidParticipantFields.length > 0
        ? 'GROUP_FILTER_PARTICIPANTS_INVALID'
        : 'VALIDATION_ERROR',
      message: invalidParticipantFields.length > 0
        ? 'Participant count filters are invalid.'
        : (messages[0] ?? exception.message),
      fieldErrors,
      details: {},
    };
    response.status(exception.getStatus()).json(body);
  }
}
