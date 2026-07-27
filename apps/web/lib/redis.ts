import Redis from 'ioredis';

const globalForRedis = globalThis as unknown as { redis?: Redis };

export const redis =
  globalForRedis.redis ??
  new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
    // 連不上時不要無限重試堵住事件迴圈；readyz 會回報 503，
    // 由 Caddy 把流量導去其他實例。
    maxRetriesPerRequest: 2,
    enableOfflineQueue: false,
    retryStrategy: (times) => Math.min(times * 200, 3000),
    lazyConnect: false,
  });

redis.on('error', (e) => {
  // 不要在這裡 throw。ioredis 的 error 事件在斷線期間會連續觸發，
  // throw 會讓整個行程掛掉，而斷線本身是可恢復的。
  if (process.env.LOG_LEVEL === 'debug') console.error('[redis]', e.message);
});

if (process.env.NODE_ENV !== 'production') globalForRedis.redis = redis;
