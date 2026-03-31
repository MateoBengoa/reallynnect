import { getValidAccessToken, supabase } from "./supabase";

function stripTrailingSlash(s: string): string {
  return s.replace(/\/$/, "");
}

/** Origen Fastify (sin `/api`). Misma semántica que `API_PROXY_TARGET` en `app/api/[...path]/route.ts`. */
function backendOrigin(): string {
  const t = process.env.API_PROXY_TARGET?.trim() ?? "";
  if (t) return stripTrailingSlash(t);
  return "http://127.0.0.1:3001";
}

/**
 * Base URL del backend (sin `/api` final).
 * - `NEXT_PUBLIC_API_URL`: URL absoluta en el cliente (CORS en Fastify con `origin: true`).
 * - Sin ella en el navegador: cadena vacía → peticiones a `/api/*` en el mismo origen; Next las reenvía según `API_PROXY_TARGET`.
 * - En el servidor (SSR, etc.): sin `NEXT_PUBLIC_API_URL` se usa `backendOrigin()` para ir directo al Fastify.
 */
function apiBase(): string {
  const fromEnv = stripTrailingSlash(process.env.NEXT_PUBLIC_API_URL?.trim() ?? "");
  if (fromEnv) return fromEnv;
  if (typeof window !== "undefined") return "";
  return backendOrigin();
}

async function fetchWithBearer(path: string, token: string, init: RequestInit): Promise<{ res: Response; text: string }> {
  const headers: Record<string, string> = {
    ...(init.headers as Record<string, string>),
    Authorization: `Bearer ${token}`,
  };
  if (init.body && typeof init.body === "string") {
    headers["Content-Type"] = "application/json";
  }
  const url = `${apiBase()}/api${path}`;
  let res: Response;
  try {
    res = await fetch(url, { ...init, headers });
  } catch (e) {
    const hint =
      "No hay servidor en la API. Arranca el backend («npm run dev» o «npm run dev -w backend»). Si el API no usa el puerto por defecto, en frontend/.env.local define API_PROXY_TARGET (mismo host:puerto que PORT del backend).";
    if (e instanceof TypeError && String(e.message).toLowerCase().includes("fetch")) {
      throw new Error(`${hint} URL intentada: ${url}`);
    }
    throw e;
  }
  const text = await res.text();
  return { res, text };
}

/** Llama a la API con JWT renovado cuando hace falta y un reintento tras 401. */
export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  let token = await getValidAccessToken();
  if (!token) {
    throw new Error(JSON.stringify({ error: "No hay sesión. Inicia sesión de nuevo." }));
  }
  let { res, text } = await fetchWithBearer(path, token, init);
  if (res.status === 401) {
    await supabase.auth.refreshSession();
    token = await getValidAccessToken();
    if (!token) {
      throw new Error(JSON.stringify({ error: "Sesión caducada. Vuelve a iniciar sesión." }));
    }
    ({ res, text } = await fetchWithBearer(path, token, init));
  }
  if (!res.ok) {
    if (text.trimStart().toLowerCase().startsWith("<!doctype") || text.includes("next-error")) {
      throw new Error(
        JSON.stringify({
          error:
            "Respuesta HTML en lugar de JSON (suele ser 404 de Next). Arranca el backend y revisa API_PROXY_TARGET / NEXT_PUBLIC_API_URL si el puerto no es 3001.",
          status: res.status,
        })
      );
    }
    throw new Error(text || res.statusText);
  }
  return text ? (JSON.parse(text) as T) : ({} as T);
}

/** Descarga binaria (p. ej. PDF vía proxy) con el mismo Bearer que `api`. */
export async function apiDownloadBlob(pathWithQuery: string): Promise<Blob> {
  const run = async (token: string) => {
    const res = await fetch(`${apiBase()}/api${pathWithQuery}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    return res;
  };
  let token = await getValidAccessToken();
  if (!token) {
    throw new Error(JSON.stringify({ error: "No hay sesión. Inicia sesión de nuevo." }));
  }
  let res = await run(token);
  if (res.status === 401) {
    await supabase.auth.refreshSession();
    token = await getValidAccessToken();
    if (!token) {
      throw new Error(JSON.stringify({ error: "Sesión caducada. Vuelve a iniciar sesión." }));
    }
    res = await run(token);
  }
  if (!res.ok) {
    const t = await res.text();
    throw new Error(t || res.statusText);
  }
  return res.blob();
}
