/**
 * Cliente para la API v2 de Webshare.io
 * Documentación: https://proxy.webshare.io/docs/
 */

export type WebshareProxy = {
  id: string;
  username: string;
  password: string;
  proxy_address: string;
  ports: { http: number; socks5: number };
  valid: boolean;
  country_code: string | null;
};

type WebshareListResponse = {
  count: number;
  next: string | null;
  results: WebshareProxy[];
};

const WEBSHARE_BASE = "https://proxy.webshare.io/api/v2";

/** Obtiene TODOS los proxies de la cuenta Webshare (pagina automáticamente). */
export async function fetchWebshareProxies(apiKey: string): Promise<WebshareProxy[]> {
  const all: WebshareProxy[] = [];
  let url: string | null = `${WEBSHARE_BASE}/proxy/list/?mode=direct&page_size=100`;

  while (url) {
    const res = await fetch(url, {
      headers: { Authorization: `Token ${apiKey}` },
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      if (res.status === 401 || res.status === 403) {
        throw new Error("webshare_invalid_api_key");
      }
      throw new Error(`webshare_api_error:${res.status}:${body.slice(0, 200)}`);
    }

    const data = (await res.json()) as WebshareListResponse;
    all.push(...data.results);
    url = data.next ?? null;
  }

  return all;
}
