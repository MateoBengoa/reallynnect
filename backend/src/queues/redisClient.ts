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
/** Marca de tiempo (ms) del último tick de `processDueTasks`; TTL 120s. Solo con Redis real. */
export const WORKER_HEARTBEAT_KEY = "automation:worker_heartbeat_ms";

export async function touchWorkerHeartbeat(redis: RedisClient): Promise<void> {
  if (isMemoryRedis(redis)) return;
  await (redis as Redis).set(WORKER_HEARTBEAT_KEY, String(Date.now()), "EX", 120);
}

/** `null` si no hay Redis, clave ausente o valor inválido. */
export async function getWorkerHeartbeatTimestampMs(redis: RedisClient): Promise<number | null> {
  if (isMemoryRedis(redis)) return null;
  const v = await (redis as Redis).get(WORKER_HEARTBEAT_KEY);
  if (!v) return null;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
}

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

// ─── Helpers de tiempo ────────────────────────────────────────────────────────

function utcDayKey(d = new Date()): string {
  return d.toISOString().slice(0, 10);
}

function utcHourKey(d = new Date()): string {
  return `${d.toISOString().slice(0, 13)}h`; // "2024-01-15T14h"
}

// ─── Límites diarios y por hora ───────────────────────────────────────────────

export type LimitKind = "visit" | "connect" | "message";

/**
 * Límites diarios conservadores para evitar bloqueos de LinkedIn.
 * LinkedIn sanciona cuentas que superan estos umbrales incluso con navegación humana.
 * - visit:   80-100 max real; usamos 25-40 para cuentas nuevas/sin historial
 * - connect: 15-20 max real; usamos 8-12 (envío de invitaciones es lo más vigilado)
 * - message: 30-40 max real; usamos 15-25
 */
const DAILY_LIMITS: Record<LimitKind, { min: number; max: number }> = {
  visit:   { min: 25, max: 40 },
  connect: { min: 8,  max: 12 },
  message: { min: 15, max: 25 },
};

/**
 * Límites por hora: mantiene el ritmo distribuido a lo largo del día.
 * Evita ráfagas de actividad (ej. 20 visitas en 1 hora es raro en humanos).
 */
const HOURLY_LIMITS: Record<LimitKind, { min: number; max: number }> = {
  visit:   { min: 4, max: 7 },
  connect: { min: 2, max: 3 },
  message: { min: 3, max: 6 },
};

function hashToInt(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

/** Cap diario determinista (varía por cuenta y día para no parecer mecánico). */
export function dailyCap(accountId: string, kind: LimitKind): number {
  const { min, max } = DAILY_LIMITS[kind];
  const h = hashToInt(`${accountId}:${kind}:${utcDayKey()}`);
  return min + (h % (max - min + 1));
}

/** Cap por hora determinista. */
export function hourlyCap(accountId: string, kind: LimitKind): number {
  const { min, max } = HOURLY_LIMITS[kind];
  const h = hashToInt(`${accountId}:${kind}:${utcHourKey()}`);
  return min + (h % (max - min + 1));
}

function resolveCap(accountId: string, kind: LimitKind, capOverride?: number | null): number {
  if (capOverride != null && Number.isFinite(capOverride) && capOverride > 0) {
    return Math.floor(capOverride);
  }
  return dailyCap(accountId, kind);
}

function resolveHourlyCap(accountId: string, kind: LimitKind): number {
  return hourlyCap(accountId, kind);
}

// ─── Contadores diarios ───────────────────────────────────────────────────────

export async function incrementDailyCount(
  redis: RedisClient,
  accountId: string,
  kind: LimitKind,
  capOverride?: number | null
): Promise<{ count: number; cap: number }> {
  const day = utcDayKey();
  const key = `limit:${kind}:${accountId}:${day}`;
  const cap = resolveCap(accountId, kind, capOverride);

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
  kind: LimitKind,
  capOverride?: number | null
): Promise<{ ok: boolean; count: number; cap: number }> {
  const count = await getDailyCount(redis, accountId, kind);
  const cap = resolveCap(accountId, kind, capOverride);
  return { ok: count < cap, count, cap };
}

// ─── Contadores por hora ──────────────────────────────────────────────────────

export async function incrementHourlyCount(
  redis: RedisClient,
  accountId: string,
  kind: LimitKind
): Promise<{ count: number; cap: number }> {
  const hour = utcHourKey();
  const key = `hlimit:${kind}:${accountId}:${hour}`;
  const cap = resolveHourlyCap(accountId, kind);

  if (isMemoryRedis(redis)) {
    const existing = memKv.get(key);
    const now = Date.now();
    if (existing && (existing.expMs === undefined || now <= existing.expMs)) {
      const count = parseInt(existing.val, 10) + 1;
      memKv.set(key, { val: String(count), expMs: existing.expMs });
      return { count, cap };
    }
    const end = new Date();
    end.setMinutes(59, 59, 999);
    memKv.set(key, { val: "1", expMs: end.getTime() });
    return { count: 1, cap };
  }

  const count = await redis.incr(key);
  if (count === 1) await redis.expire(key, 3600);
  return { count, cap };
}

export async function getHourlyCount(redis: RedisClient, accountId: string, kind: LimitKind): Promise<number> {
  const hour = utcHourKey();
  const key = `hlimit:${kind}:${accountId}:${hour}`;
  if (isMemoryRedis(redis)) {
    const v = memGet(key);
    return v ? parseInt(v, 10) : 0;
  }
  const v = await redis.get(key);
  return v ? parseInt(v, 10) : 0;
}

export async function checkUnderHourlyCap(
  redis: RedisClient,
  accountId: string,
  kind: LimitKind
): Promise<{ ok: boolean; count: number; cap: number }> {
  const count = await getHourlyCount(redis, accountId, kind);
  const cap = resolveHourlyCap(accountId, kind);
  return { ok: count < cap, count, cap };
}

// ─── Cooldown entre acciones por cuenta ──────────────────────────────────────

/**
 * Establece un cooldown para la cuenta: no ejecutar otra tarea de automatización
 * hasta que expire el TTL. Simula el tiempo que un humano tarda entre acciones.
 * Default: 3-8 minutos aleatorio, configurable con ACCOUNT_COOLDOWN_MIN_SEC / MAX_SEC.
 */
export async function setAccountCooldown(
  redis: RedisClient,
  accountId: string,
  minSec?: number,
  maxSec?: number
): Promise<number> {
  // Sin ACCOUNT_COOLDOWN_MIN_SEC en .env el cooldown es 0 (desactivado por defecto).
  const envMin = parseInt(process.env.ACCOUNT_COOLDOWN_MIN_SEC ?? "0", 10);
  const envMax = parseInt(process.env.ACCOUNT_COOLDOWN_MAX_SEC ?? "0", 10);
  const lo = Number.isFinite(minSec) ? (minSec as number) : envMin;
  const hi = Number.isFinite(maxSec) ? (maxSec as number) : envMax;
  const ttlSec = Math.max(30, Math.floor(lo + Math.random() * Math.max(0, hi - lo)));

  const key = `cooldown:account:${accountId}`;
  if (isMemoryRedis(redis)) {
    memKv.set(key, { val: "1", expMs: Date.now() + ttlSec * 1000 });
    return ttlSec;
  }
  await redis.set(key, "1", "EX", ttlSec);
  return ttlSec;
}

/**
 * Devuelve los segundos restantes de cooldown (0 = puede ejecutar).
 */
export async function getAccountCooldownSec(redis: RedisClient, accountId: string): Promise<number> {
  const key = `cooldown:account:${accountId}`;
  if (isMemoryRedis(redis)) {
    const e = memKv.get(key);
    if (!e || e.expMs === undefined) return 0;
    const rem = Math.ceil((e.expMs - Date.now()) / 1000);
    return rem > 0 ? rem : 0;
  }
  const ttl = await redis.ttl(key);
  return ttl > 0 ? ttl : 0;
}
