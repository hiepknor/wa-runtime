const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const GIB = 1024 ** 3;

export const RUNTIME_STORAGE_OBSERVATION_HEADER = [
  'observed_at_utc',
  'root_size_bytes',
  'root_used_bytes',
  'root_available_bytes',
  'root_used_percent',
  'database_bytes',
  'webhook_events_bytes',
  'webhook_events_live_rows',
  'webhook_events_dead_rows',
  'webhook_events_inserted_total',
  'webhook_events_deleted_total',
  'webhook_events_autovacuum_total',
  'runtime_events_bytes',
  'runtime_events_live_rows',
  'runtime_events_dead_rows',
  'runtime_events_inserted_total',
  'runtime_events_deleted_total',
  'runtime_events_autovacuum_total',
  'inbound_messages_bytes',
  'inbound_messages_live_rows',
  'inbound_messages_dead_rows',
  'inbound_messages_inserted_total',
  'inbound_messages_deleted_total',
  'inbound_messages_autovacuum_total',
  'contact_observations_bytes',
  'contact_observations_live_rows',
  'contact_observations_dead_rows',
  'contact_observations_inserted_total',
  'contact_observations_deleted_total',
  'contact_observations_autovacuum_total',
  'contact_intent_pending_rows',
  'contact_intent_processing_rows',
  'contact_intent_retry_rows',
  'contact_intent_dead_rows',
  'contact_intent_oldest_active_seconds',
] as const;

export const RETAINED_TABLES = [
  'webhook_events',
  'runtime_events',
  'inbound_messages',
  'contact_observations',
] as const;

export type RetainedTable = typeof RETAINED_TABLES[number];
export type StorageAcceptanceStatus = 'PASS' | 'PENDING' | 'FAIL';

interface TableObservation {
  bytes: number;
  liveRows: number;
  deadRows: number;
  insertedTotal: number;
  deletedTotal: number;
  autovacuumTotal: number;
}

export interface RuntimeStorageObservation {
  observedAtMs: number;
  rootSizeBytes: number;
  rootUsedBytes: number;
  rootAvailableBytes: number;
  rootUsedPercent: number;
  databaseBytes: number;
  tables: Record<RetainedTable, TableObservation>;
  contactIntents: {
    pendingRows: number;
    processingRows: number;
    retryRows: number;
    deadRows: number;
    oldestActiveSeconds: number;
  };
}

export interface RuntimeRetentionObservation {
  timestampMs: number;
  durationMs: number;
  capacityExhausted: boolean;
  batches: number;
  deleted: Record<RetainedTable, number>;
}

export interface StorageAcceptanceOptions {
  minimumObservationDays: number;
  expectedIntervalMs: number;
  minimumCoverageRatio: number;
  maximumSampleGapMs: number;
  targetDiskGiB: number;
  filesystemSizeTolerance: number;
  minimumHeadroomDays: number;
  retentionTimeBudgetMs: number;
  maximumIntentAgeSeconds: number;
  minimumDeleteToInsertRatio: number;
}

export interface StorageAcceptanceCheck {
  name: string;
  status: StorageAcceptanceStatus;
  evidence: string;
}

export interface TableAcceptanceMetrics {
  insertedRows: number;
  deletedRows: number;
  counterResets: number;
  deleteToInsertRatio: number | null;
  averageInsertRowsPerHour: number;
  peakDeleteRowsPerHour: number;
  autovacuumRuns: number;
  latestDeadRows: number;
  latestAutovacuumTriggerRows: number;
  retentionActivated: boolean;
}

export interface RuntimeStorageAcceptanceReport {
  status: StorageAcceptanceStatus;
  window: {
    startedAt: string;
    endedAt: string;
    elapsedDays: number;
    sampleCount: number;
    expectedSampleCount: number;
    maximumGapHours: number;
    rootSizeGiB: number;
  };
  growth: {
    rootUsedBytesPerDay: number;
    databaseBytesPerDay: number;
    projectedConsumptionBytesPerDay: number;
    projectedHeadroomDays: number | null;
  };
  retention: {
    sampleCount: number;
    p95DurationMs: number | null;
    consecutiveCapacityExhaustions: number;
  };
  tables: Record<RetainedTable, TableAcceptanceMetrics>;
  checks: StorageAcceptanceCheck[];
}

export const DEFAULT_STORAGE_ACCEPTANCE_OPTIONS: StorageAcceptanceOptions = {
  minimumObservationDays: 7,
  expectedIntervalMs: HOUR_MS,
  minimumCoverageRatio: 0.8,
  maximumSampleGapMs: 3 * HOUR_MS,
  targetDiskGiB: 150,
  filesystemSizeTolerance: 0.95,
  minimumHeadroomDays: 30,
  retentionTimeBudgetMs: 240_000,
  maximumIntentAgeSeconds: 300,
  minimumDeleteToInsertRatio: 0.9,
};

const numeric = (value: string | undefined, field: string, row: number): number => {
  if (value === undefined || value.trim() === '') {
    throw new Error(`Missing ${field} in storage observation row ${row}`);
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`Invalid ${field} in storage observation row ${row}: ${value}`);
  }
  return parsed;
};

export function parseRuntimeStorageObservations(input: string): RuntimeStorageObservation[] {
  const lines = input.split(/\r?\n/u).filter(line => line.trim() !== '');
  if (lines.length < 2) throw new Error('Storage observation file has no data rows');
  const header = lines[0]?.split('|') ?? [];
  if (header.join('|') !== RUNTIME_STORAGE_OBSERVATION_HEADER.join('|')) {
    throw new Error('Unexpected Runtime storage observation header');
  }
  const index = new Map(header.map((field, position) => [field, position]));
  const value = (fields: string[], field: string, row: number): number =>
    numeric(fields[index.get(field) ?? -1], field, row);
  const table = (fields: string[], name: RetainedTable, row: number): TableObservation => ({
    bytes: value(fields, `${name}_bytes`, row),
    liveRows: value(fields, `${name}_live_rows`, row),
    deadRows: value(fields, `${name}_dead_rows`, row),
    insertedTotal: value(fields, `${name}_inserted_total`, row),
    deletedTotal: value(fields, `${name}_deleted_total`, row),
    autovacuumTotal: value(fields, `${name}_autovacuum_total`, row),
  });

  const observations = lines.slice(1).map((line, offset) => {
    const row = offset + 2;
    const fields = line.split('|');
    if (fields.length !== header.length) {
      throw new Error(`Unexpected field count in storage observation row ${row}: ${fields.length}`);
    }
    const observedAtMs = Date.parse(fields[0] ?? '');
    if (!Number.isFinite(observedAtMs)) {
      throw new Error(`Invalid observed_at_utc in storage observation row ${row}`);
    }
    const rootUsedPercent = value(fields, 'root_used_percent', row);
    if (rootUsedPercent > 100) {
      throw new Error(`Invalid root_used_percent in storage observation row ${row}: ${rootUsedPercent}`);
    }
    return {
      observedAtMs,
      rootSizeBytes: value(fields, 'root_size_bytes', row),
      rootUsedBytes: value(fields, 'root_used_bytes', row),
      rootAvailableBytes: value(fields, 'root_available_bytes', row),
      rootUsedPercent,
      databaseBytes: value(fields, 'database_bytes', row),
      tables: Object.fromEntries(RETAINED_TABLES.map(name => [name, table(fields, name, row)])) as
        Record<RetainedTable, TableObservation>,
      contactIntents: {
        pendingRows: value(fields, 'contact_intent_pending_rows', row),
        processingRows: value(fields, 'contact_intent_processing_rows', row),
        retryRows: value(fields, 'contact_intent_retry_rows', row),
        deadRows: value(fields, 'contact_intent_dead_rows', row),
        oldestActiveSeconds: value(fields, 'contact_intent_oldest_active_seconds', row),
      },
    };
  });
  observations.forEach((observation, position) => {
    const previous = observations[position - 1];
    if (previous && observation.observedAtMs <= previous.observedAtMs) {
      throw new Error(`Storage observations are not strictly chronological at row ${position + 2}`);
    }
  });
  return observations;
}

const retentionNumber = (value: unknown, field: string, row: number): number => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`Invalid ${field} in retention observation row ${row}`);
  }
  return value;
};

export function parseRuntimeRetentionObservations(input: string): RuntimeRetentionObservation[] {
  const lines = input.split(/\r?\n/u).filter(line => line.trim() !== '');
  const observations = lines.map((line, offset) => {
    const row = offset + 1;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      throw new Error(`Invalid JSON in retention observation row ${row}`);
    }
    if (!entry || typeof entry !== 'object') throw new Error(`Invalid retention observation row ${row}`);
    const record = entry as Record<string, unknown>;
    const details = record.details;
    if (!details || typeof details !== 'object') {
      throw new Error(`Missing details in retention observation row ${row}`);
    }
    const data = details as Record<string, unknown>;
    if (data.event !== 'data.retention.completed') {
      throw new Error(`Unexpected event in retention observation row ${row}`);
    }
    const timestampMs = Date.parse(String(record.timestamp ?? ''));
    if (!Number.isFinite(timestampMs)) throw new Error(`Invalid timestamp in retention observation row ${row}`);
    if (typeof data.capacityExhausted !== 'boolean') {
      throw new Error(`Invalid capacityExhausted in retention observation row ${row}`);
    }
    return {
      timestampMs,
      durationMs: retentionNumber(data.durationMs, 'durationMs', row),
      capacityExhausted: data.capacityExhausted,
      batches: retentionNumber(data.batches, 'batches', row),
      deleted: {
        webhook_events: retentionNumber(data.webhookEvents, 'webhookEvents', row),
        runtime_events: retentionNumber(data.runtimeEvents, 'runtimeEvents', row),
        inbound_messages: retentionNumber(data.inboundMessages, 'inboundMessages', row),
        contact_observations: retentionNumber(data.contactObservations ?? 0, 'contactObservations', row),
      },
    };
  });
  return observations.sort((left, right) => left.timestampMs - right.timestampMs);
}

const percentile = (values: number[], probability: number): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(probability * sorted.length) - 1)] ?? null;
};

const medianSlopePerDay = (
  observations: RuntimeStorageObservation[],
  selector: (observation: RuntimeStorageObservation) => number,
): number => {
  const slopes: number[] = [];
  for (let left = 0; left < observations.length; left += 1) {
    for (let right = left + 1; right < observations.length; right += 1) {
      const first = observations[left];
      const second = observations[right];
      if (!first || !second) continue;
      slopes.push((selector(second) - selector(first)) * DAY_MS / (second.observedAtMs - first.observedAtMs));
    }
  }
  return percentile(slopes, 0.5) ?? 0;
};

const counterDeltas = (
  observations: RuntimeStorageObservation[],
  selector: (observation: RuntimeStorageObservation) => number,
): { total: number; resets: number; peakPerHour: number } => {
  let total = 0;
  let resets = 0;
  let peakPerHour = 0;
  for (let position = 1; position < observations.length; position += 1) {
    const previous = observations[position - 1];
    const current = observations[position];
    if (!previous || !current) continue;
    const previousValue = selector(previous);
    const currentValue = selector(current);
    const delta = currentValue >= previousValue ? currentValue - previousValue : currentValue;
    if (currentValue < previousValue) resets += 1;
    total += delta;
    const elapsedHours = (current.observedAtMs - previous.observedAtMs) / HOUR_MS;
    if (elapsedHours > 0) peakPerHour = Math.max(peakPerHour, delta / elapsedHours);
  }
  return { total, resets, peakPerHour };
};

const maximumConsecutiveExhaustions = (observations: RuntimeRetentionObservation[]): number => {
  let current = 0;
  let maximum = 0;
  for (const observation of observations) {
    current = observation.capacityExhausted ? current + 1 : 0;
    maximum = Math.max(maximum, current);
  }
  return maximum;
};

const format = (value: number, digits = 2): string => value.toFixed(digits);

export function evaluateRuntimeStorageAcceptance(
  allObservations: RuntimeStorageObservation[],
  allRetentionObservations: RuntimeRetentionObservation[],
  overrides: Partial<StorageAcceptanceOptions> = {},
): RuntimeStorageAcceptanceReport {
  if (allObservations.length < 2) throw new Error('At least two storage observations are required');
  const options = { ...DEFAULT_STORAGE_ACCEPTANCE_OPTIONS, ...overrides };
  const last = allObservations.at(-1)!;
  let windowStart = 0;
  for (let position = allObservations.length - 1; position > 0; position -= 1) {
    if (allObservations[position - 1]?.rootSizeBytes !== last.rootSizeBytes) {
      windowStart = position;
      break;
    }
  }
  const postResizeObservations = allObservations.slice(windowStart);
  const desiredWindowStartMs = last.observedAtMs - options.minimumObservationDays * DAY_MS;
  let recentWindowStart = -1;
  for (let position = 0; position < postResizeObservations.length; position += 1) {
    if (postResizeObservations[position]!.observedAtMs <= desiredWindowStartMs) {
      recentWindowStart = position;
    } else {
      break;
    }
  }
  const observations = recentWindowStart >= 0
    ? postResizeObservations.slice(recentWindowStart)
    : postResizeObservations;
  const first = observations[0]!;
  const elapsedMs = last.observedAtMs - first.observedAtMs;
  const elapsedDays = elapsedMs / DAY_MS;
  const expectedSampleCount = Math.floor(elapsedMs / options.expectedIntervalMs) + 1;
  let maximumGapMs = 0;
  for (let position = 1; position < observations.length; position += 1) {
    maximumGapMs = Math.max(
      maximumGapMs,
      observations[position]!.observedAtMs - observations[position - 1]!.observedAtMs,
    );
  }
  const retention = allRetentionObservations.filter(item =>
    item.timestampMs >= first.observedAtMs && item.timestampMs <= last.observedAtMs,
  );
  const coverageComplete = elapsedDays >= options.minimumObservationDays;
  const sampleCoverage = observations.length / Math.max(1, expectedSampleCount);
  const p95DurationMs = percentile(retention.map(item => item.durationMs), 0.95);
  const consecutiveCapacityExhaustions = maximumConsecutiveExhaustions(retention);
  const rootGrowth = medianSlopePerDay(observations, item => item.rootUsedBytes);
  const databaseGrowth = medianSlopePerDay(observations, item => item.databaseBytes);
  const projectedConsumption = Math.max(0, rootGrowth, databaseGrowth);
  const projectedHeadroomDays = projectedConsumption > 0
    ? last.rootAvailableBytes / projectedConsumption
    : null;

  const tables = Object.fromEntries(RETAINED_TABLES.map(name => {
    const inserted = counterDeltas(observations, item => item.tables[name].insertedTotal);
    const deleted = counterDeltas(observations, item => item.tables[name].deletedTotal);
    const vacuum = counterDeltas(observations, item => item.tables[name].autovacuumTotal);
    const retentionDeleted = retention.reduce((total, item) => total + item.deleted[name], 0);
    const averageInsertRowsPerHour = elapsedMs > 0 ? inserted.total / (elapsedMs / HOUR_MS) : 0;
    const latest = last.tables[name];
    return [name, {
      insertedRows: inserted.total,
      deletedRows: deleted.total,
      counterResets: inserted.resets + deleted.resets + vacuum.resets,
      deleteToInsertRatio: inserted.total > 0 ? deleted.total / inserted.total : null,
      averageInsertRowsPerHour,
      peakDeleteRowsPerHour: deleted.peakPerHour,
      autovacuumRuns: vacuum.total,
      latestDeadRows: latest.deadRows,
      latestAutovacuumTriggerRows: 10_000 + Math.floor(latest.liveRows * 0.05),
      retentionActivated: retentionDeleted > 0,
    } satisfies TableAcceptanceMetrics];
  })) as Record<RetainedTable, TableAcceptanceMetrics>;

  const checks: StorageAcceptanceCheck[] = [];
  const requiredFilesystemBytes = options.targetDiskGiB * GIB * options.filesystemSizeTolerance;
  checks.push({
    name: 'filesystem_expanded',
    status: last.rootSizeBytes >= requiredFilesystemBytes ? 'PASS' : 'PENDING',
    evidence: `root filesystem ${format(last.rootSizeBytes / GIB)} GiB; target disk ${options.targetDiskGiB} GiB`,
  });
  checks.push({
    name: 'filesystem_utilization',
    status: last.rootSizeBytes < requiredFilesystemBytes
      ? 'PENDING'
      : last.rootUsedPercent < 80 ? 'PASS' : 'FAIL',
    evidence: `${last.rootUsedPercent}% used; warning/escalation/critical thresholds 70/80/90%`,
  });
  checks.push({
    name: 'observation_coverage',
    status: !coverageComplete
      ? 'PENDING'
      : sampleCoverage >= options.minimumCoverageRatio && maximumGapMs <= options.maximumSampleGapMs
        ? 'PASS'
        : 'FAIL',
    evidence: `${format(elapsedDays, 3)} days, ${observations.length}/${expectedSampleCount} samples (${format(sampleCoverage * 100, 1)}%), maximum gap ${format(maximumGapMs / HOUR_MS)} hours`,
  });
  const retentionHasCoverage = retention.length >= Math.ceil(expectedSampleCount * options.minimumCoverageRatio);
  checks.push({
    name: 'retention_capacity',
    status: !coverageComplete
      ? 'PENDING'
      : retentionHasCoverage && consecutiveCapacityExhaustions < 2
        && p95DurationMs !== null && p95DurationMs < options.retentionTimeBudgetMs * 0.25
        ? 'PASS'
        : 'FAIL',
    evidence: `${retention.length} ticks, p95 ${p95DurationMs ?? 'n/a'} ms, maximum consecutive capacity exhaustion ${consecutiveCapacityExhaustions}`,
  });

  for (const name of RETAINED_TABLES) {
    const metrics = tables[name];
    if (!metrics.retentionActivated) {
      checks.push({ name: `${name}_delete_throughput`, status: coverageComplete ? 'PASS' : 'PENDING', evidence: 'cutoff not active in observation window' });
      continue;
    }
    const ratioPass = metrics.deleteToInsertRatio === null
      || metrics.deleteToInsertRatio >= options.minimumDeleteToInsertRatio;
    const burstPass = metrics.peakDeleteRowsPerHour > metrics.averageInsertRowsPerHour;
    checks.push({
      name: `${name}_delete_throughput`,
      status: !coverageComplete ? 'PENDING' : ratioPass && burstPass ? 'PASS' : 'FAIL',
      evidence: `deleted/inserted ${metrics.deleteToInsertRatio === null ? 'n/a' : format(metrics.deleteToInsertRatio, 3)}, peak delete ${format(metrics.peakDeleteRowsPerHour)} rows/h, average insert ${format(metrics.averageInsertRowsPerHour)} rows/h`,
    });
  }

  const maximumIntentAge = Math.max(...observations.map(item => item.contactIntents.oldestActiveSeconds));
  const latestIntent = last.contactIntents;
  checks.push({
    name: 'contact_intent_health',
    status: !coverageComplete
      ? 'PENDING'
      : maximumIntentAge <= options.maximumIntentAgeSeconds && latestIntent.deadRows === 0
        ? 'PASS'
        : 'FAIL',
    evidence: `maximum active age ${maximumIntentAge}s, latest retry ${latestIntent.retryRows}, dead ${latestIntent.deadRows}`,
  });

  const unhealthyVacuum = RETAINED_TABLES.filter(name => observations.slice(-2).every(item => {
    const table = item.tables[name];
    const trigger = 10_000 + Math.floor(table.liveRows * 0.05);
    return table.deadRows > trigger * 2;
  }));
  checks.push({
    name: 'autovacuum_health',
    status: !coverageComplete ? 'PENDING' : unhealthyVacuum.length === 0 ? 'PASS' : 'FAIL',
    evidence: unhealthyVacuum.length === 0
      ? 'no retained table stayed above twice its trigger for the latest two samples'
      : `unhealthy tables: ${unhealthyVacuum.join(', ')}`,
  });
  checks.push({
    name: 'projected_headroom',
    status: !coverageComplete || last.rootSizeBytes < requiredFilesystemBytes
      ? 'PENDING'
      : projectedHeadroomDays === null || projectedHeadroomDays >= options.minimumHeadroomDays
        ? 'PASS'
        : 'FAIL',
    evidence: `consumption ${format(projectedConsumption / GIB, 3)} GiB/day; headroom ${projectedHeadroomDays === null ? 'unbounded' : `${format(projectedHeadroomDays, 1)} days`}`,
  });

  const status: StorageAcceptanceStatus = checks.some(check => check.status === 'FAIL')
    ? 'FAIL'
    : checks.some(check => check.status === 'PENDING')
      ? 'PENDING'
      : 'PASS';
  return {
    status,
    window: {
      startedAt: new Date(first.observedAtMs).toISOString(),
      endedAt: new Date(last.observedAtMs).toISOString(),
      elapsedDays,
      sampleCount: observations.length,
      expectedSampleCount,
      maximumGapHours: maximumGapMs / HOUR_MS,
      rootSizeGiB: last.rootSizeBytes / GIB,
    },
    growth: {
      rootUsedBytesPerDay: rootGrowth,
      databaseBytesPerDay: databaseGrowth,
      projectedConsumptionBytesPerDay: projectedConsumption,
      projectedHeadroomDays,
    },
    retention: { sampleCount: retention.length, p95DurationMs, consecutiveCapacityExhaustions },
    tables,
    checks,
  };
}
