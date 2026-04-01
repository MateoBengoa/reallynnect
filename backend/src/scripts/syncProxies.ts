/**
 * Script de administración: sincroniza proxies de Webshare.io al pool global de la app
 * y los asigna automáticamente a todas las cuentas LinkedIn sin proxy.
 *
 * Uso desde la VPS:
 *   cd ~/app/backend
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

console.log("Sincronizando proxies Webshare → pool de la app…");

// userId = null → proxies pertenecen a la app, no a ningún usuario en particular
const result = await syncWebshareProxies(sb, null, WEBSHARE_API_KEY);
console.log(`  ${result.inserted} nuevos, ${result.updated} actualizados (${result.total} en Webshare)`);

// Asignar proxies libres a todas las cuentas LinkedIn sin proxy
const { data: users } = await sb
  .from("linkedin_accounts")
  .select("user_id")
  .is("proxy_id", null)
  .not("user_id", "is", null);

const userIds = [...new Set((users ?? []).map((r) => r.user_id as string))];

if (userIds.length === 0) {
  console.log("No hay cuentas sin proxy. Todo asignado.");
  process.exit(0);
}

console.log(`\nAsignando proxies a ${userIds.length} usuario(s)…`);
let totalAssigned = 0;

for (const userId of userIds) {
  const assigned = await autoAssignProxiesToAccounts(sb, userId);
  if (assigned > 0) {
    console.log(`  usuario ${userId.slice(0, 8)}… → ${assigned} cuenta(s) asignadas`);
    totalAssigned += assigned;
  }
}

console.log(`\nTotal asignados: ${totalAssigned}`);
process.exit(0);
