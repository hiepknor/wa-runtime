import 'reflect-metadata';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { createOpenApiDocument } from '../src/core/openapi';

async function main(): Promise<void> {
  const app = await NestFactory.create(AppModule, { logger: false });
  app.setGlobalPrefix('api/v1');
  const targetDirectory = resolve(process.cwd(), 'contracts/runtime/v1');
  await mkdir(targetDirectory, { recursive: true });
  await writeFile(
    resolve(targetDirectory, 'openapi.json'),
    `${JSON.stringify(createOpenApiDocument(app), null, 2)}\n`,
    'utf8',
  );
  await app.close();
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
