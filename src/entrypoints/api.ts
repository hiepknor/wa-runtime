import 'reflect-metadata';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { SwaggerModule } from '@nestjs/swagger';
import { ApiAppModule } from '../app/api-app.module';
import { runtimeConfig } from '../core/config/runtime-config';
import { createOpenApiDocument } from '../core/openapi';
import { JsonLogger } from '../core/observability/json-logger';

async function bootstrap(): Promise<void> {
  const config = runtimeConfig();
  const app = await NestFactory.create(ApiAppModule, { rawBody: true, logger: new JsonLogger('api') });
  app.setGlobalPrefix('api/v1');
  app.enableShutdownHooks();
  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true,
    }),
  );

  if (config.enableRuntimeDocs) {
    const document = createOpenApiDocument(app);
    SwaggerModule.setup('api/v1/docs', app, document, { jsonDocumentUrl: 'api/v1/openapi.json' });
  }

  await app.listen(config.PORT, '0.0.0.0');
}

bootstrap().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
