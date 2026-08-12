import { afterEach, describe, expect, it, vi } from 'vitest';
import { correlationContext, withCorrelationContext } from '../../src/core/observability/correlation-context';
import { JsonLogger } from '../../src/core/observability/json-logger';

describe('observability context and logging', () => {
  afterEach(() => vi.restoreAllMocks());

  it('keeps nested correlation fields across asynchronous work', async () => {
    await withCorrelationContext({ requestId: 'request-1' }, async () => {
      await Promise.resolve();
      expect(correlationContext()).toEqual({ requestId: 'request-1' });
      withCorrelationContext({ messageJobId: 'job-1' }, () => {
        expect(correlationContext()).toEqual({ requestId: 'request-1', messageJobId: 'job-1' });
      });
      expect(correlationContext()).toEqual({ requestId: 'request-1' });
    });
    expect(correlationContext()).toEqual({});
  });

  it('writes JSON correlation fields and redacts sensitive structured values', () => {
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const logger = new JsonLogger('worker');

    withCorrelationContext({ messageJobId: 'job-1' }, () => {
      logger.error({ event: 'send.failed', apiKey: 'secret', nested: { body: 'private' } });
    });

    const entry = JSON.parse(String(write.mock.calls[0]?.[0])) as Record<string, unknown>;
    expect(entry).toMatchObject({
      level: 'error', service: 'wa-runtime', process: 'worker', messageJobId: 'job-1', message: 'send.failed',
      details: { event: 'send.failed', apiKey: '[redacted]', nested: { body: '[redacted]' } },
    });
  });

  it('keeps stack out of the context field and preserves nested error stacks', () => {
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const logger = new JsonLogger('worker');
    const error = new Error('queue unavailable');

    logger.error('plain failure', error.stack);
    logger.error({ event: 'structured.failure', error });

    const plain = JSON.parse(String(write.mock.calls[0]?.[0])) as Record<string, unknown>;
    const structured = JSON.parse(String(write.mock.calls[1]?.[0])) as Record<string, unknown>;
    expect(plain.context).toBeUndefined();
    expect(plain.stack).toContain('queue unavailable');
    expect(structured.stack).toContain('queue unavailable');
  });
});
