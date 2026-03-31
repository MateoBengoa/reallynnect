import type { NextConfig } from "next";
import { PHASE_PRODUCTION_BUILD } from "next/constants";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Raíz del monorepo (workspace). Solo aplica en build de producción: en `next dev` forzar
 * `outputFileTracingRoot` puede romper la resolución de `/_next/static/*` en Windows con
 * workspaces donde `node_modules` está en la raíz del repo.
 */
const monorepoRoot = path.join(__dirname, "..");

export default function nextConfig(phase: string): NextConfig {
  return {
    reactStrictMode: true,
    ...(phase === PHASE_PRODUCTION_BUILD ? { outputFileTracingRoot: monorepoRoot } : {}),
    /**
     * El proxy HTTP a Fastify vive en `app/api/[...path]/route.ts`.
     * No duplicar aquí con `rewrites`: en algunos entornos los rewrites pueden interferir
     * con el enrutado interno de `/_next/*` si la config o el orden de reglas no es el esperado.
     */
  };
}
