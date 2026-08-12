import IORedis from 'ioredis';
import { runtimeHeartbeatKey, type RuntimeProcessName } from '../src/core/queue/runtime-heartbeat';

async function main(): Promise<void> {
  const processName = process.argv[2] as RuntimeProcessName | undefined;
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl || !processName || !['worker', 'scheduler'].includes(processName)) {
    process.exitCode = 1;
    return;
  }
  const redis = new IORedis(redisUrl, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    connectTimeout: 2_000,
    commandTimeout: 2_000,
  });
  try {
    await redis.connect();
    const heartbeat = await redis.get(runtimeHeartbeatKey(processName));
    process.exitCode = heartbeat ? 0 : 1;
  } catch {
    process.exitCode = 1;
  } finally {
    redis.disconnect();
  }
}

void main();
