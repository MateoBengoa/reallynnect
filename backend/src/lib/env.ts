import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const here = path.dirname(fileURLToPath(import.meta.url));
// dist/lib/ → dist/ → backend/
const backendRoot = path.resolve(here, "..", "..");
// backend/ → repo root
const repoRoot = path.resolve(backendRoot, "..");

// Candidatos en orden de prioridad
const candidates = [
  path.join(backendRoot, ".env"),  // backend/.env  (preferido)
  path.join(repoRoot, ".env"),     // /root/app/.env (repo root)
  path.join(process.cwd(), ".env"),// cwd (fallback)
];

let loaded = false;
for (const p of candidates) {
  if (fs.existsSync(p)) {
    dotenv.config({ path: p, override: false });
    loaded = true;
    console.log(`[env] Cargando variables desde ${p}`);
    break;
  }
}
if (!loaded) {
  console.warn("[env] No se encontró .env en:", candidates.join(", "));
}
