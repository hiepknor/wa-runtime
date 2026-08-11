import 'reflect-metadata';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { runtimeConfig } from './config/runtime-config';

async function bootstrap(): Promise<void> {
  const config = runtimeConfig();
  const app = await NestFactory.create(AppModule, { rawBody: true });
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
    const document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder()
        .setTitle('Automation Runtime API')
        .setDescription('Stable API contract consumed by WA Studio')
        .setVersion('0.1.0')
        .addApiKey({ type: 'apiKey', in: 'header', name: 'X-Runtime-Key' }, 'runtime-key')
        .build(),
    );
    SwaggerModule.setup('api/v1/docs', app, document, { jsonDocumentUrl: 'api/v1/openapi.json' });
  }

  await app.listen(config.PORT, '0.0.0.0');
}

bootstrap().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
