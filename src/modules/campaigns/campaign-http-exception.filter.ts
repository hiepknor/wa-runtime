import { ArgumentsHost, Catch, type ExceptionFilter, HttpException, HttpStatus } from '@nestjs/common';
import type { Response } from 'express';
import type { RuntimeErrorDto } from '../../contracts/common/runtime-error.dto';
import { runtimeErrorFromHttpException } from '../../core/http/runtime-http-exception.filter';

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
    const campaignValidation = this.campaignValidationError(messages);
    if (status === HttpStatus.BAD_REQUEST && campaignValidation) {
      response.status(status).json({
        code: campaignValidation.code,
        message: messages[0] ?? exception.message,
        fieldErrors: { [campaignValidation.field]: messages },
        details: {},
      } satisfies RuntimeErrorDto);
      return;
    }
    response.status(status).json(runtimeErrorFromHttpException(exception));
  }

  private campaignValidationError(messages: string[]): { code: string; field: string } | null {
    if (messages.some(message => /\bexpectedTargetsRevision\b/u.test(message))) {
      return { code: 'CAMPAIGN_TARGETS_REVISION_INVALID', field: 'expectedTargetsRevision' };
    }
    if (messages.some(message => /\bexpectedRevision\b/u.test(message))) {
      return { code: 'CAMPAIGN_REVISION_INVALID', field: 'expectedRevision' };
    }
    if (messages.some(message => /\bstatus\b/u.test(message))) {
      return { code: 'CAMPAIGN_FILTER_STATUS_INVALID', field: 'status' };
    }
    if (messages.some(message => /\bscheduleType\b/u.test(message))) {
      return { code: 'CAMPAIGN_FILTER_SCHEDULE_TYPE_INVALID', field: 'scheduleType' };
    }
    if (messages.some(message => /\bquery\b/u.test(message))) {
      return { code: 'CAMPAIGN_QUERY_INVALID', field: 'query' };
    }
    return null;
  }
}
