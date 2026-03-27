/**
 * Prueba local de sendConnectionRequest (necesita sesión real).
 *
 * Uso (PowerShell):
 *   $env:LI_AT="tu_cookie_li_at"
 *   $env:HEADLESS="false"
 *   npm run connect-smoke -w automation
 *
 * Por defecto perfil: https://www.linkedin.com/in/pedrovaleradigital/
 * Otro lead: $env:PROFILE_URL="https://www.linkedin.com/in/otro/"
 */

const {
  createContext,
  injectLiAt,
  closeSession,
  ensureLinkedInFeedSession,
  sendConnectionRequest,
} = require("./dist/index.js");

async function main() {
  const liAt = (process.env.LI_AT || "").trim();
  const profileUrl =
    (process.env.PROFILE_URL || "").trim() ||
    "https://www.linkedin.com/in/pedrovaleradigital/";

  if (!liAt) {
    console.error("Falta LI_AT (cookie de sesión). No puedo probar contra LinkedIn sin ella.");
    process.exit(1);
  }

  process.env.LINKEDIN_FAST_AUTOMATION = "true";

  const headless = process.env.HEADLESS !== "false";
  const { browser, page } = await createContext({ headless });

  try {
    await injectLiAt(page, liAt);
    const warm = await ensureLinkedInFeedSession(page);
    console.log("Sesión feed:", warm);
    if (!warm.ok) {
      process.exit(1);
    }

    const r = await sendConnectionRequest(page, profileUrl);
    console.log("Conectar:", r);
    console.log("URL final:", page.url());
    process.exit(r.ok && !r.softban ? 0 : 1);
  } finally {
    await closeSession(browser);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
