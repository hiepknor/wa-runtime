import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

async function main(): Promise<void> {
  const release = process.argv[2]?.trim();
  if (!release || !/^\d+\.\d+\.\d+$/.test(release)) {
    throw new Error('Usage: npm run contract:openwa:import -- <semver> < openapi.json');
  }
  const raw = await readStdin();
  const contract = JSON.parse(raw) as {
    openapi?: unknown;
    info?: { version?: unknown };
    paths?: unknown;
    components?: { schemas?: unknown };
  };
  if (typeof contract.openapi !== 'string'
    || contract.info?.version !== release
    || typeof contract.paths !== 'object' || contract.paths === null
    || typeof contract.components?.schemas !== 'object' || contract.components.schemas === null) {
    throw new Error(`Input is not the OpenWA ${release} OpenAPI artifact`);
  }
  const directory = resolve(process.cwd(), 'contracts', 'openwa', release);
  const destination = resolve(directory, 'openapi.json');
  await mkdir(directory, { recursive: true });
  try {
    const existing = await readFile(destination, 'utf8');
    if (existing !== raw) {
      throw new Error(`Refusing to overwrite a different reviewed OpenWA ${release} artifact`);
    }
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  await writeFile(destination, raw, { flag: 'wx' });
}

void main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
