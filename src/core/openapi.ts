import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { INestApplication } from '@nestjs/common';

export function createOpenApiDocument(app: INestApplication) {
  return SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle('WA Runtime API')
      .setDescription('Stable, versioned API contract consumed by WA Studio')
      .setVersion('1.0.0')
      .addApiKey({ type: 'apiKey', in: 'header', name: 'X-Runtime-Key' }, 'runtime-key')
      .build(),
  );
}
