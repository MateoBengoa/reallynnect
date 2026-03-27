/**
 * Prueba local de sendMessageInMessagingThread (necesita sesión real y un hilo existente).
 *
 * Uso (PowerShell):
 *   $env:LI_AT="tu_cookie_li_at"
 *   $env:HEADLESS="false"
 *   $env:THREAD_URL="https://www.linkedin.com/messaging/thread/XXXX/"
 *   $env:DM_TEXT="Hola desde smoke"
 *   npm run message-smoke -w automation
 */

const {
  createContext,
  injectLiAt,
  closeSession,
  ensureLinkedInFeedSession,
  sendMessageInMessagingThread,
} = require("./dist/index.js");

async function main() {
  const liAt = (process.env.LI_AT || "").trim();
  const threadUrl = (process.env.THREAD_URL || "").trim();
  const text = (process.env.DM_TEXT || "").trim() || "Smoke test message";

  if (!liAt) {
    console.error("Falta LI_AT.");
    process.exit(1);
  }
  if (!threadUrl) {
    console.error("Falta THREAD_URL (URL del hilo en /messaging/thread/...).");
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

    const r = await sendMessageInMessagingThread(page, threadUrl, text);
    console.log("Mensaje hilo:", r);
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
