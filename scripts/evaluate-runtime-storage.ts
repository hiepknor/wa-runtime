import { readFile } from 'node:fs/promises';
import {
  DEFAULT_STORAGE_ACCEPTANCE_OPTIONS,
  evaluateRuntimeStorageAcceptance,
  parseRuntimeRetentionObservations,
  parseRuntimeStorageObservations,
  type StorageAcceptanceOptions,
} from '../src/core/observability/runtime-storage-acceptance';

interface CliOptions {
  observations: string;
  retentionLog: string;
  acceptance: Partial<StorageAcceptanceOptions>;
}

const usage = (): never => {
  throw new Error(
    'Usage: npm run storage:acceptance -- --observations <tsv> --retention-log <jsonl> '
      + '[--minimum-days 7] [--target-disk-gib 150] [--retention-time-budget-ms 240000]',
  );
};

const positiveNumber = (value: string | undefined, option: string): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`Invalid ${option}: ${value ?? ''}`);
  return parsed;
};

export function parseStorageAcceptanceArguments(argv: string[]): CliOptions {
  const result: CliOptions = { observations: '', retentionLog: '', acceptance: {} };
  for (let position = 0; position < argv.length; position += 2) {
    const option = argv[position] ?? usage();
    const value = argv[position + 1] ?? usage();
    if (option === '' || value === '') usage();
    switch (option) {
      case '--observations': result.observations = value; break;
      case '--retention-log': result.retentionLog = value; break;
      case '--minimum-days':
        result.acceptance.minimumObservationDays = positiveNumber(value, option);
        break;
      case '--target-disk-gib':
        result.acceptance.targetDiskGiB = positiveNumber(value, option);
        break;
      case '--retention-time-budget-ms':
        result.acceptance.retentionTimeBudgetMs = positiveNumber(value, option);
        break;
      default: throw new Error(`Unknown option: ${option}`);
    }
  }
  if (!result.observations || !result.retentionLog) usage();
  return result;
}

async function main(): Promise<void> {
  const options = parseStorageAcceptanceArguments(process.argv.slice(2));
  const [storageInput, retentionInput] = await Promise.all([
    readFile(options.observations, 'utf8'),
    readFile(options.retentionLog, 'utf8'),
  ]);
  const report = evaluateRuntimeStorageAcceptance(
    parseRuntimeStorageObservations(storageInput),
    parseRuntimeRetentionObservations(retentionInput),
    { ...DEFAULT_STORAGE_ACCEPTANCE_OPTIONS, ...options.acceptance },
  );
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = report.status === 'PASS' ? 0 : report.status === 'FAIL' ? 1 : 2;
}

if (require.main === module) {
  void main().catch(error => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
