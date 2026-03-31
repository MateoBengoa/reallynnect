import { NextRequest, NextResponse } from "next/server";

/**
 * Proxy al backend Fastify (`/api/*`). Complementa `rewrites` en next.config.
 * Usamos catch-all obligatorio `[...path]` (más fiable que `[[...path]]` en algunos entornos).
 */
const backendBase = (process.env.API_PROXY_TARGET ?? "http://127.0.0.1:3001").replace(/\/$/, "");

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function buildTarget(pathSegments: string[], search: string): string {
  const sub = pathSegments.length ? pathSegments.join("/") : "";
  return `${backendBase}/api/${sub}${search}`;
}

async function forward(req: NextRequest, pathSegments: string[]): Promise<NextResponse> {
  const u = new URL(req.url);
  const target = buildTarget(pathSegments, u.search);

  const headers = new Headers();
  const auth = req.headers.get("authorization");
  if (auth) headers.set("authorization", auth);
  const ct = req.headers.get("content-type");
  if (ct) headers.set("content-type", ct);

  const method = req.method;
  const body = method === "GET" || method === "HEAD" ? undefined : await req.arrayBuffer();

  const longApifyPath = pathSegments.join("/") === "leads/apify-import";
  const proxyTimeoutMs =
    method === "POST" && longApifyPath ? 55 * 60 * 1000 : 120_000;
  const ac = new AbortController();
  const timeoutId = setTimeout(() => ac.abort(), proxyTimeoutMs);

  let res: Response;
  try {
    res = await fetch(target, {
      method,
      headers,
      body,
      cache: "no-store",
      signal: ac.signal,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const timedOut = msg.includes("abort") || msg.includes("Abort");
    return NextResponse.json(
      {
        error: timedOut ? "Tiempo de espera del proxy agotado" : "Backend no disponible",
        hint: timedOut
          ? "Apify puede tardar mucho; reduce totalResults o sube el timeout en app/api/[...path]/route.ts."
          : "Arranca el API en 3001 (npm run dev -w backend). Comprueba API_PROXY_TARGET.",
        target,
        detail: msg,
      },
      { status: 502 }
    );
  } finally {
    clearTimeout(timeoutId);
  }

  const out = new NextResponse(res.body, { status: res.status });
  const outCt = res.headers.get("content-type");
  if (outCt) out.headers.set("content-type", outCt);
  return out;
}

type RouteCtx = { params: Promise<{ path: string[] }> };

export async function GET(req: NextRequest, ctx: RouteCtx) {
  const { path } = await ctx.params;
  return forward(req, path ?? []);
}

export async function POST(req: NextRequest, ctx: RouteCtx) {
  const { path } = await ctx.params;
  return forward(req, path ?? []);
}

export async function PUT(req: NextRequest, ctx: RouteCtx) {
  const { path } = await ctx.params;
  return forward(req, path ?? []);
}

export async function PATCH(req: NextRequest, ctx: RouteCtx) {
  const { path } = await ctx.params;
  return forward(req, path ?? []);
}

export async function DELETE(req: NextRequest, ctx: RouteCtx) {
  const { path } = await ctx.params;
  return forward(req, path ?? []);
}

export async function HEAD(req: NextRequest, ctx: RouteCtx) {
  const { path } = await ctx.params;
  return forward(req, path ?? []);
}

export async function OPTIONS(req: NextRequest, ctx: RouteCtx) {
  const { path } = await ctx.params;
  return forward(req, path ?? []);
}
