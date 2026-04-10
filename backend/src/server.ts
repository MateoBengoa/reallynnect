import "./lib/env.js";
import Fastify from "fastify";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import { verifySupabaseJwt } from "./lib/auth.js";
import { getSupabaseAdmin } from "./lib/supabase.js";
import { getQueueMode, getRedis, type RedisClient } from "./queues/redisClient.js";
import { registerApiRoutes } from "./routes/api.js";
import {
  prepareWorkerRuntime,
  shouldEmbedTaskWorkerInApi,
  startPeriodicTaskProcessing,
} from "./workers/workerLoop.js";

declare module "fastify" {
  interface FastifyRequest {
    userId?: string;
  }
}

declare module "fastify" {
  interface FastifyInstance {
    sb: ReturnType<typeof getSupabaseAdmin>;
    redis: RedisClient;
  }
}

async function buildServer() {
  const app = Fastify({ logger: true });

  // Permite body vacío con Content-Type: application/json (devuelve {} en lugar de error)
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => {
    if (!body || (body as string).trim() === "") { done(null, {}); return; }
    try { done(null, JSON.parse(body as string)); }
    catch (e) { done(e as Error, undefined); }
  });

  await app.register(cors, {
    origin: true,
    allowedHeaders: ["Authorization", "Content-Type", "Accept"],
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  });
  await app.register(multipart, { limits: { fileSize: 8 * 1024 * 1024 } });

  const sb = getSupabaseAdmin();
  const redis = getRedis();

  app.get("/health", async () => ({
    ok: true,
    queue: getQueueMode(),
    time: new Date().toISOString(),
  }));

  await app.register(
    async (api) => {
      api.decorate("sb", sb);
      // ioredis tiene `.get`; Fastify confunde decorate con la forma getter/setter.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      api.decorate("redis", redis as any);
      api.addHook("preHandler", async (request, reply) => {
        // CORS preflight: sin Authorization; @fastify/cors responde pero este hook corría antes y devolvía 401 sin cabeceras CORS.
        if (request.method === "OPTIONS") return;
        const auth = request.headers.authorization;
        if (!auth?.startsWith("Bearer ")) {
          return reply.status(401).send({ error: "Unauthorized" });
        }
        const token = auth.slice(7);
        try {
          const u = await verifySupabaseJwt(token);
          request.userId = u.sub;
        } catch {
          return reply.status(401).send({ error: "Invalid token" });
        }
      });
      await registerApiRoutes(api);
    },
    { prefix: "/api" }
  );

  return app;
}

const port = Number(process.env.PORT ?? 3001);
const host = process.env.HOST ?? "0.0.0.0";

buildServer()
  .then(async (app) => {
    await app.listen({ port, host });
    console.log(`API http://${host}:${port}`);
    if (shouldEmbedTaskWorkerInApi()) {
      const sb = getSupabaseAdmin();
      const redis = getRedis();
      console.log(
        "[api] Cola de tareas embebida en este proceso (verify_session, campañas, inbox…). Pon EMBED_TASK_WORKER=false si usas worker dedicado."
      );
      await prepareWorkerRuntime(sb, redis);
      startPeriodicTaskProcessing(sb, redis, "[api+worker]");
    }
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
