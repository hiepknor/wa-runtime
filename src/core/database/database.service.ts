import { Inject, Injectable, OnApplicationShutdown } from '@nestjs/common';
import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import { runtimeConfig, type RuntimeConfig } from '../config/runtime-config';
import { RUNTIME_CONFIG } from '../config/runtime-config.module';

@Injectable()
export class DatabaseService implements OnApplicationShutdown {
  readonly pool: Pool;

  constructor(@Inject(RUNTIME_CONFIG) config: RuntimeConfig = runtimeConfig()) {
    this.pool = new Pool({ connectionString: config.DATABASE_URL, max: 10 });
  }

  query<T extends QueryResultRow>(text: string, values: unknown[] = []) {
    return this.pool.query<T>(text, values);
  }

  async transaction<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await operation(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }
}
