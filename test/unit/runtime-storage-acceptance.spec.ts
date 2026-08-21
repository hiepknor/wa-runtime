import { describe, expect, it } from 'vitest';
import {
  RUNTIME_STORAGE_OBSERVATION_HEADER,
  evaluateRuntimeStorageAcceptance,
  parseRuntimeRetentionObservations,
  parseRuntimeStorageObservations,
} from '../../src/core/observability/runtime-storage-acceptance';

const GIB = 1024 ** 3;
const HOUR_MS = 3_600_000;

const storageFixture = (
  hours: number,
  rootGiB = 150,
  resize?: { atHour: number; targetGiB: number },
): string => {
  const rows = [RUNTIME_STORAGE_OBSERVATION_HEADER.join('|')];
  const start = Date.parse('2026-08-01T00:00:00Z');
  for (let hour = 0; hour <= hours; hour += 1) {
    const timestamp = new Date(start + hour * HOUR_MS).toISOString().replace('.000Z', 'Z');
    const currentRootGiB = resize && hour >= resize.atHour ? resize.targetGiB : rootGiB;
    const rootSize = currentRootGiB * GIB * 0.98;
    const rootUsed = 40 * GIB + hour * 10 * 1024 ** 2;
    const available = rootSize - rootUsed - 2 * GIB;
    const values: Array<string | number> = [
      timestamp, rootSize, rootUsed, available, Math.floor(rootUsed / rootSize * 100),
      20 * GIB + hour * 5 * 1024 ** 2,
    ];
    for (const table of ['webhook', 'runtime', 'inbound', 'contact']) {
      const active = table !== 'runtime';
      values.push(
        GIB + hour * 1024,
        1_000_000,
        1_000,
        100_000 + hour * 1_000,
        active ? 10_000 + hour * 1_050 : 0,
        Math.floor(hour / 24),
      );
    }
    values.push(10, 0, 0, 0, 15);
    rows.push(values.join('|'));
  }
  return `${rows.join('\n')}\n`;
};

const retentionFixture = (hours: number, exhaustedAt: number[] = [], durationMs = 5_000): string => {
  const start = Date.parse('2026-08-01T00:00:00Z');
  return Array.from({ length: hours + 1 }, (_, hour) => JSON.stringify({
    timestamp: new Date(start + hour * HOUR_MS).toISOString(),
    message: 'data.retention.completed',
    details: {
      event: 'data.retention.completed',
      durationMs,
      capacityExhausted: exhaustedAt.includes(hour),
      batches: 1,
      webhookEvents: 1_050,
      runtimeEvents: 0,
      inboundMessages: 1_050,
      contactObservations: 1_050,
    },
  })).join('\n');
};

describe('Runtime storage acceptance', () => {
  it('passes a complete, expanded and healthy seven-day window', () => {
    const report = evaluateRuntimeStorageAcceptance(
      parseRuntimeStorageObservations(storageFixture(7 * 24)),
      parseRuntimeRetentionObservations(retentionFixture(7 * 24)),
    );

    expect(report.status).toBe('PASS');
    expect(report.window.sampleCount).toBe(169);
    expect(report.tables.webhook_events.deleteToInsertRatio).toBeCloseTo(1.05);
    expect(report.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'filesystem_expanded', status: 'PASS' }),
      expect.objectContaining({ name: 'projected_headroom', status: 'PASS' }),
    ]));
  });

  it('stays pending before disk expansion and seven complete days', () => {
    const report = evaluateRuntimeStorageAcceptance(
      parseRuntimeStorageObservations(storageFixture(8, 60)),
      parseRuntimeRetentionObservations(retentionFixture(8)),
    );

    expect(report.status).toBe('PENDING');
    expect(report.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'filesystem_expanded', status: 'PENDING' }),
      expect.objectContaining({ name: 'observation_coverage', status: 'PENDING' }),
    ]));
  });

  it('starts a fresh acceptance window when the filesystem size changes', () => {
    const hours = 8 * 24;
    const report = evaluateRuntimeStorageAcceptance(
      parseRuntimeStorageObservations(storageFixture(hours, 60, { atHour: hours, targetGiB: 150 })),
      parseRuntimeRetentionObservations(retentionFixture(hours)),
    );

    expect(report.status).toBe('PENDING');
    expect(report.window.sampleCount).toBe(1);
    expect(report.window.elapsedDays).toBe(0);
    expect(report.checks).toContainEqual(expect.objectContaining({
      name: 'filesystem_expanded', status: 'PASS',
    }));
  });

  it('fails on two consecutive saturated retention ticks', () => {
    const report = evaluateRuntimeStorageAcceptance(
      parseRuntimeStorageObservations(storageFixture(24)),
      parseRuntimeRetentionObservations(retentionFixture(24, [22, 23])),
      { minimumObservationDays: 1 },
    );

    expect(report.status).toBe('FAIL');
    expect(report.retention.consecutiveCapacityExhaustions).toBe(2);
    expect(report.checks).toContainEqual(expect.objectContaining({
      name: 'retention_capacity', status: 'FAIL',
    }));
  });

  it('does not let recovered incidents outside the latest complete window fail forever', () => {
    const hours = 8 * 24;
    const report = evaluateRuntimeStorageAcceptance(
      parseRuntimeStorageObservations(storageFixture(hours)),
      parseRuntimeRetentionObservations(retentionFixture(hours, [0, 1])),
    );

    expect(report.status).toBe('PASS');
    expect(report.window.elapsedDays).toBe(7);
    expect(report.retention.consecutiveCapacityExhaustions).toBe(0);
  });

  it('rejects an observation schema mismatch instead of silently shifting columns', () => {
    const fixture = storageFixture(1).replace('root_size_bytes', 'root_bytes');
    expect(() => parseRuntimeStorageObservations(fixture)).toThrow(
      'Unexpected Runtime storage observation header',
    );
  });
});
