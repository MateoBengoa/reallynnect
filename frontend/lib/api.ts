import { getValidAccessToken, supabase } from "./supabase";

const base = () => process.env.NEXT_PUBLIC_API_URL ?? "http://127.0.0.1:3001";

async function fetchWithBearer(path: string, token: string, init: RequestInit): Promise<{ res: Response; text: string }> {
  const headers: Record<string, string> = {
    ...(init.headers as Record<string, string>),
    Authorization: `Bearer ${token}`,
  };
  if (init.body && typeof init.body === "string") {
    headers["Content-Type"] = "application/json";
  }
  const url = `${base()}/api${path}`;
  let res: Response;
  try {
    res = await fetch(url, { ...init, headers });
  } catch (e) {
    const hint =
      "No hay servidor en la API. Arranca el backend: desde la raíz del repo ejecuta «npm run dev» (api+worker+web) o solo «npm run dev -w backend» (puerto 3001).";
    if (e instanceof TypeError && String(e.message).toLowerCase().includes("fetch")) {
      throw new Error(`${hint} URL intentada: ${base()}`);
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
    throw new Error(text || res.statusText);
  }
  return text ? (JSON.parse(text) as T) : ({} as T);
}

/** Descarga binaria (p. ej. PDF vía proxy) con el mismo Bearer que `api`. */
export async function apiDownloadBlob(pathWithQuery: string): Promise<Blob> {
  const run = async (token: string) => {
    const res = await fetch(`${base()}/api${pathWithQuery}`, {
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
