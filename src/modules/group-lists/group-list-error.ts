import { HttpException, type HttpStatus } from '@nestjs/common';

export class GroupListError extends HttpException {
  constructor(
    status: HttpStatus,
    code: string,
    message: string,
    details?: Record<string, unknown>,
    fieldErrors?: Record<string, string[]>,
  ) {
    super({ code, message, ...(fieldErrors ? { fieldErrors } : {}), ...(details ? { details } : {}) }, status);
  }
}
