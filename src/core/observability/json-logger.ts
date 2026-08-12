import type { LoggerService, LogLevel } from '@nestjs/common';
import { correlationContext } from './correlation-context';

const levels: Record<LogLevel, number> = {
  verbose: 10,
  debug: 20,
  log: 30,
  warn: 40,
  error: 50,
  fatal: 60,
};

const configuredLevel = (): LogLevel => {
  const value = process.env.LOG_LEVEL ?? (process.env.NODE_ENV === 'production' ? 'log' : 'debug');
  return value in levels ? value as LogLevel : 'log';
};

const sensitiveKey = /(authorization|api[-_]?key|secret|token|password|payload|body|text|phone)/i;

const sanitize = (value: unknown, depth = 0): unknown => {
  if (depth > 3) return '[truncated]';
  if (value instanceof Error) return { name: value.name, message: value.message };
  if (Array.isArray(value)) return value.slice(0, 20).map(item => sanitize(item, depth + 1));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [
      key,
      sensitiveKey.test(key) ? '[redacted]' : sanitize(item, depth + 1),
    ]));
  }
  return value;
};

export class JsonLogger implements LoggerService {
  private activeLevels = new Set<LogLevel>();

  constructor(private readonly processName: string) {
    this.setLogLevels((Object.keys(levels) as LogLevel[]).filter(level => levels[level] >= levels[configuredLevel()]));
  }

  setLogLevels(levelsToEnable: LogLevel[]): void {
    this.activeLevels = new Set(levelsToEnable);
  }

  log(message: unknown, ...optionalParams: unknown[]): void { this.write('log', message, optionalParams); }
  fatal(message: unknown, ...optionalParams: unknown[]): void { this.write('fatal', message, optionalParams); }
  error(message: unknown, ...optionalParams: unknown[]): void { this.write('error', message, optionalParams); }
  warn(message: unknown, ...optionalParams: unknown[]): void { this.write('warn', message, optionalParams); }
  debug(message: unknown, ...optionalParams: unknown[]): void { this.write('debug', message, optionalParams); }
  verbose(message: unknown, ...optionalParams: unknown[]): void { this.write('verbose', message, optionalParams); }

  private write(level: LogLevel, message: unknown, optionalParams: unknown[]): void {
    if (!this.activeLevels.has(level)) return;
    const lastOptional = optionalParams.at(-1);
    const stack = optionalParams.find(value => typeof value === 'string' && value.includes('\n'));
    const context = typeof lastOptional === 'string' && lastOptional !== stack ? lastOptional : undefined;
    const error = message instanceof Error ? message : undefined;
    const nestedError = message && typeof message === 'object' && 'error' in message
      && (message as { error?: unknown }).error instanceof Error
      ? (message as { error: Error }).error
      : undefined;
    const structured = message && typeof message === 'object' && !(message instanceof Error)
      ? sanitize(message) as Record<string, unknown>
      : undefined;
    const entry = {
      timestamp: new Date().toISOString(),
      level,
      service: 'wa-runtime',
      process: this.processName,
      ...correlationContext(),
      ...(context ? { context } : {}),
      message: error?.message
        ?? (typeof message === 'string' ? message : String(structured?.message ?? structured?.event ?? message)),
      ...(structured ? { details: structured } : {}),
      ...(error?.stack || nestedError?.stack || stack ? { stack: error?.stack ?? nestedError?.stack ?? stack } : {}),
    };
    const output = JSON.stringify(entry);
    if (levels[level] >= levels.warn) process.stderr.write(`${output}\n`);
    else process.stdout.write(`${output}\n`);
  }
}
