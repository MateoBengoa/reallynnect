const base = () => process.env.NEXT_PUBLIC_API_URL ?? "http://127.0.0.1:3001";

export async function api<T>(path: string, token: string, init: RequestInit = {}): Promise<T> {
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
  if (!res.ok) {
    throw new Error(text || res.statusText);
  }
  return text ? (JSON.parse(text) as T) : ({} as T);
}
