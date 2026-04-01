/**
 * Script de administración: sincroniza proxies de Webshare.io y los asigna a cuentas.
 *
 * Uso desde la VPS:
 *   npx tsx src/scripts/syncProxies.ts
 *
 * Variables de entorno requeridas (backend/.env):
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, COOKIE_ENCRYPTION_KEY, WEBSHARE_API_KEY
 */

import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import { syncWebshareProxies, autoAssignProxiesToAccounts } from "../services/proxyAssign.js";

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const WEBSHARE_API_KEY = process.env.WEBSHARE_API_KEY!;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("Faltan SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY en .env");
  process.exit(1);
}

if (!WEBSHARE_API_KEY) {
  console.error("Falta WEBSHARE_API_KEY en .env");
  process.exit(1);
}

const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

// Obtener todos los usuarios con cuentas LinkedIn
const { data: users } = await sb
  .from("linkedin_accounts")
  .select("user_id")
  .not("user_id", "is", null);

const userIds = [...new Set((users ?? []).map((r) => r.user_id as string))];

if (userIds.length === 0) {
  console.log("No hay usuarios con cuentas LinkedIn.");
  process.exit(0);
}

console.log(`Sincronizando proxies para ${userIds.length} usuario(s)…`);

let totalInserted = 0;
let totalUpdated = 0;
let totalAssigned = 0;

for (const userId of userIds) {
  try {
    const result = await syncWebshareProxies(sb, userId, WEBSHARE_API_KEY);
    const assigned = await autoAssignProxiesToAccounts(sb, userId);
    console.log(
      `  usuario ${userId.slice(0, 8)}… → ${result.inserted} nuevos, ${result.updated} actualizados, ${assigned} asignados`
    );
    totalInserted += result.inserted;
    totalUpdated += result.updated;
    totalAssigned += assigned;
  } catch (e) {
    console.error(`  ERROR usuario ${userId.slice(0, 8)}…:`, e instanceof Error ? e.message : e);
  }
}

console.log(`\nTotal: ${totalInserted} insertados, ${totalUpdated} actualizados, ${totalAssigned} asignados.`);
process.exit(0);
