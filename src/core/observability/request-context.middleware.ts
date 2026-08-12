import { randomUUID } from 'node:crypto';
import { Injectable, Logger, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { withCorrelationContext } from './correlation-context';

const requestId = (value: string | string[] | undefined): string => {
  const supplied = Array.isArray(value) ? value[0] : value;
  return supplied && /^[A-Za-z0-9._-]{1,100}$/.test(supplied) ? supplied : randomUUID();
};

@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
  private readonly logger = new Logger(RequestContextMiddleware.name);

  use(request: Request, response: Response, next: NextFunction): void {
    const id = requestId(request.headers['x-request-id']);
    response.setHeader('x-request-id', id);
    withCorrelationContext({ requestId: id }, () => {
      const started = performance.now();
      let written = false;
      const writeCompletion = (outcome: 'finished' | 'closed') => {
        if (written) return;
        written = true;
        this.logger.log({
          event: 'http.request.completed',
          method: request.method,
          path: request.route?.path ?? request.path,
          statusCode: response.statusCode,
          outcome,
          durationMs: Math.round((performance.now() - started) * 100) / 100,
        });
      };
      response.once('finish', () => writeCompletion('finished'));
      response.once('close', () => writeCompletion('closed'));
      next();
    });
  }
}
