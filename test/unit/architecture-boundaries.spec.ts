import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { analyzeArchitecture } from '../../scripts/check-architecture';

const temporaryDirectories: string[] = [];

const fixture = async (files: Record<string, string>): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'wa-runtime-architecture-'));
  temporaryDirectories.push(root);
  const sourceRoot = join(root, 'src');
  for (const [file, source] of Object.entries(files)) {
    const path = join(sourceRoot, file);
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, source);
  }
  return sourceRoot;
};

describe('architecture boundaries', () => {
  afterEach(async () => {
    const { rm } = await import('node:fs/promises');
    await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true })));
  });

  it('accepts the intended inward dependency direction', async () => {
    const root = await fixture({
      'core/database.ts': 'export const database = true;',
      'integrations/openwa/client.ts': "import { database } from '../../core/database'; export { database };",
      'modules/contacts/service.ts': "import '../../integrations/openwa/client';",
      'modules/gateway/service.ts': "import '../../core/database'; import '../../integrations/openwa/client'; import '../../modules/contacts/service';",
      'modules/messages/service.ts': "import '../gateway/service';",
      'modules/campaigns/service.ts': "import '../gateway/service'; import '../messages/service';",
      'modules/orchestration/runner.ts': "import '../campaigns/service';",
      'app/api.ts': "import '../modules/campaigns/service';",
      'entrypoints/api.ts': "import '../app/api'; import '../core/database';",
    });

    expect(analyzeArchitecture(root)).toEqual([]);
  });

  it('rejects infrastructure depending on a feature', async () => {
    const root = await fixture({
      'core/database.ts': "import '../modules/gateway/service';",
      'modules/gateway/service.ts': 'export const gateway = true;',
    });

    expect(analyzeArchitecture(root)).toEqual(expect.arrayContaining([
      expect.objectContaining({ message: 'Forbidden dependency from core to module:gateway' }),
    ]));
  });

  it('detects feature dependency cycles', async () => {
    const root = await fixture({
      'modules/contacts/service.ts': "import '../gateway/service';",
      'modules/gateway/service.ts': "import '../contacts/service';",
    });

    expect(analyzeArchitecture(root)).toEqual(expect.arrayContaining([
      expect.objectContaining({ message: 'Feature dependency cycle: contacts -> gateway -> contacts' }),
    ]));
  });
});
