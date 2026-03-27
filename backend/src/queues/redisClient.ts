import { Redis } from "ioredis";

/** Cliente real o marcador cuando la cola vive solo en RAM (sin Redis). */
export const MEMORY_QUEUE = Object.freeze({ _kind: "memory" as const });
export type RedisClient = Redis | typeof MEMORY_QUEUE;

export function isMemoryRedis(r: RedisClient): r is typeof MEMORY_QUEUE {
  return r === MEMORY_QUEUE;
}

function useMemoryQueueEnv(): boolean {
  const flag = (process.env.USE_IN_MEMORY_QUEUE ?? "").toLowerCase();
  if (flag === "true" || flag === "1" || flag === "yes") return true;
  const url = (process.env.REDIS_URL ?? "").trim().toLowerCase();
  return url === "memory" || url === "none";
}

/** Para `/health` y diagnósticos: cola compartida (Redis) vs RAM por proceso. */
export function getQueueMode(): "memory" | "redis" {
  return useMemoryQueueEnv() ? "memory" : "redis";
}

let client: Redis | null = null;
let loggedMemoryMode = false;

let lastRedisErrorLog = 0;

export function getRedis(): RedisClient {
  if (useMemoryQueueEnv()) {
    if (!loggedMemoryMode) {
      loggedMemoryMode = true;
      console.log(
        "[queue] Cola en memoria (sin Redis). Activa Redis y quita USE_IN_MEMORY_QUEUE / REDIS_URL=memory para producción."
      );
    }
    return MEMORY_QUEUE;
  }

  if (!client) {
    const url = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";
    client = new Redis(url, {
      maxRetriesPerRequest: null,
      retryStrategy(times) {
        return Math.min(times * 200, 3000);
      },
    });
    client.on("error", (err) => {
      const now = Date.now();
      if (now - lastRedisErrorLog > 12_000) {
        lastRedisErrorLog = now;
        console.error(
          "[redis] No hay conexión a",
          url.replace(/:[^:@/]+@/, ":****@"),
          "→",
          err.message,
          "| Arranca Redis (puerto 6379) o ajusta REDIS_URL en backend/.env. En Windows: Docker `docker run -d -p 6379:6379 redis:7-alpine` o Redis en WSL. Sin Redis: USE_IN_MEMORY_QUEUE=true en backend/.env."
        );
      }
    });
  }
  return client;
}

export const BROWSER_SLOT_KEY = "browser:active_count";
export const MAX_BROWSERS = 4;
export const TASKS_DUE_ZSET = "automation_tasks:due";

const acquireScript = `
local c = tonumber(redis.call('GET', KEYS[1]) or '0')
local max = tonumber(ARGV[1])
if c >= max then return 0 end
redis.call('INCR', KEYS[1])
return 1
`;

const releaseScript = `
local c = tonumber(redis.call('GET', KEYS[1]) or '0')
if c <= 0 then return 0 end
redis.call('DECR', KEYS[1])
return 1
`;

// --- Estado en memoria (proceso único; no persiste ni comparte entre instancias) ---

const dueZset = new Map<string, number>();
const memKv = new Map<string, { val: string; expMs?: number }>();
const schedLocks = new Map<string, number>();
let memBrowserCount = 0;
let memBrowserChain: Promise<void> = Promise.resolve();

/** Si el worker se mató con slots adquiridos, el contador en RAM queda mal; reiniciar al arrancar. */
export function resetMemoryBrowserSlotCounter(): void {
  memBrowserCount = 0;
}

function memSweepExpiredKv() {
  const now = Date.now();
  for (const [k, e] of memKv) {
    if (e.expMs !== undefined && now > e.expMs) memKv.delete(k);
  }
}

function memGet(key: string): string | null {
  memSweepExpiredKv();
  const e = memKv.get(key);
  if (!e) return null;
  if (e.expMs !== undefined && Date.now() > e.expMs) {
    memKv.delete(key);
    return null;
  }
  return e.val;
}

function runMemBrowserExclusive<T>(fn: () => Promise<T>): Promise<T> {
  const p = memBrowserChain.then(() => fn());
  memBrowserChain = p.then(() => {}).catch(() => {});
  return p;
}

export async function trySchedulerLock(redis: RedisClient, key: string, ttlSec: number): Promise<boolean> {
  if (isMemoryRedis(redis)) {
    const now = Date.now();
    const exp = schedLocks.get(key);
    if (exp !== undefined && exp > now) return false;
    schedLocks.set(key, now + ttlSec * 1000);
    return true;
  }
  const r = await redis.set(key, "1", "EX", ttlSec, "NX");
  return r === "OK";
}

export async function acquireBrowserSlot(redis: RedisClient): Promise<boolean> {
  if (isMemoryRedis(redis)) {
    return runMemBrowserExclusive(async () => {
      if (memBrowserCount >= MAX_BROWSERS) return false;
      memBrowserCount++;
      return true;
    });
  }
  const r = (await redis.eval(acquireScript, 1, BROWSER_SLOT_KEY, String(MAX_BROWSERS))) as number;
  return r === 1;
}

export async function releaseBrowserSlot(redis: RedisClient): Promise<void> {
  if (isMemoryRedis(redis)) {
    await runMemBrowserExclusive(async () => {
      if (memBrowserCount > 0) memBrowserCount--;
    });
    return;
  }
  await redis.eval(releaseScript, 1, BROWSER_SLOT_KEY);
}

export async function enqueueTaskDue(redis: RedisClient, taskId: string, scheduledAtMs: number): Promise<void> {
  if (isMemoryRedis(redis)) {
    dueZset.set(taskId, scheduledAtMs);
    return;
  }
  await redis.zadd(TASKS_DUE_ZSET, scheduledAtMs, taskId);
}

export async function popDueTaskIds(redis: RedisClient, nowMs: number, limit: number): Promise<string[]> {
  if (isMemoryRedis(redis)) {
    return [...dueZset.entries()]
      .filter(([, score]) => score <= nowMs)
      .sort((a, b) => a[1] - b[1])
      .slice(0, limit)
      .map(([id]) => id);
  }
  const ids = await redis.zrangebyscore(TASKS_DUE_ZSET, 0, nowMs, "LIMIT", 0, limit);
  return ids;
}

export async function removeTaskFromDue(redis: RedisClient, taskId: string): Promise<number> {
  if (isMemoryRedis(redis)) {
    return dueZset.delete(taskId) ? 1 : 0;
  }
  return redis.zrem(TASKS_DUE_ZSET, taskId);
}

function utcDayKey(d = new Date()): string {
  return d.toISOString().slice(0, 10);
}

export type LimitKind = "visit" | "connect" | "message";

const LIMITS: Record<LimitKind, { min: number; max: number }> = {
  visit: { min: 100, max: 100 },
  connect: { min: 20, max: 40 },
  message: { min: 40, max: 80 },
};

function hashToInt(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

/** Deterministic cap per account+day so checks stay consistent. */
export function dailyCap(accountId: string, kind: LimitKind): number {
  const { min, max } = LIMITS[kind];
  const h = hashToInt(`${accountId}:${kind}:${utcDayKey()}`);
  return min + (h % (max - min + 1));
}

export async function incrementDailyCount(
  redis: RedisClient,
  accountId: string,
  kind: LimitKind
): Promise<{ count: number; cap: number }> {
  const day = utcDayKey();
  const key = `limit:${kind}:${accountId}:${day}`;
  const cap = dailyCap(accountId, kind);

  if (isMemoryRedis(redis)) {
    const existing = memKv.get(key);
    const now = Date.now();
    if (existing && (existing.expMs === undefined || now <= existing.expMs)) {
      const count = parseInt(existing.val, 10) + 1;
      memKv.set(key, { val: String(count), expMs: existing.expMs });
      return { count, cap };
    }
    const end = new Date();
    end.setUTCHours(23, 59, 59, 999);
    const expMs = end.getTime();
    memKv.set(key, { val: "1", expMs });
    return { count: 1, cap };
  }

  const count = await redis.incr(key);
  if (count === 1) {
    const end = new Date();
    end.setUTCHours(23, 59, 59, 999);
    const ttl = Math.max(1, Math.ceil((end.getTime() - Date.now()) / 1000));
    await redis.expire(key, ttl);
  }
  return { count, cap };
}

export async function getDailyCount(redis: RedisClient, accountId: string, kind: LimitKind): Promise<number> {
  const day = utcDayKey();
  const key = `limit:${kind}:${accountId}:${day}`;
  if (isMemoryRedis(redis)) {
    const v = memGet(key);
    return v ? parseInt(v, 10) : 0;
  }
  const v = await redis.get(key);
  return v ? parseInt(v, 10) : 0;
}

export async function checkUnderDailyCap(
  redis: RedisClient,
  accountId: string,
  kind: LimitKind
): Promise<{ ok: boolean; count: number; cap: number }> {
  const count = await getDailyCount(redis, accountId, kind);
  const cap = dailyCap(accountId, kind);
  return { ok: count < cap, count, cap };
}
