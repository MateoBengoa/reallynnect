import { createRemoteJWKSet, jwtVerify } from "jose";

let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;

function getJwks() {
  const url = process.env.SUPABASE_URL;
  if (!url) throw new Error("SUPABASE_URL missing");
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(`${url.replace(/\/$/, "")}/auth/v1/.well-known/jwks.json`));
  }
  return jwks;
}

export type AuthUser = { sub: string; email?: string };

export async function verifySupabaseJwt(token: string): Promise<AuthUser> {
  const issuer = `${process.env.SUPABASE_URL?.replace(/\/$/, "")}/auth/v1`;
  let payload: Awaited<ReturnType<typeof jwtVerify>>["payload"];
  try {
    ({ payload } = await jwtVerify(token, getJwks(), {
      issuer,
      audience: "authenticated",
    }));
  } catch {
    ({ payload } = await jwtVerify(token, getJwks(), { issuer }));
  }
  const sub = payload.sub;
  if (!sub) throw new Error("Invalid token");
  return { sub, email: typeof payload.email === "string" ? payload.email : undefined };
}
