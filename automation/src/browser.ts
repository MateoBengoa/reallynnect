import { chromium, type Browser, type BrowserContext, type Page } from "playwright";

export type ProxyConfig = {
  server: string;
  username?: string;
  password?: string;
};

export type BrowserSessionOptions = {
  proxy?: ProxyConfig;
  userAgent?: string;
  headless?: boolean;
};

const DEFAULT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const ALLOWED_CHANNELS = new Set(["chrome", "msedge", "chromium", "chrome-beta", "msedge-beta", "msedge-dev"]);

function launchChannelFromEnv(): "chrome" | "msedge" | "chromium" | "chrome-beta" | "msedge-beta" | "msedge-dev" | undefined {
  const c = (process.env.PLAYWRIGHT_CHANNEL ?? "").trim().toLowerCase();
  if (!c || !ALLOWED_CHANNELS.has(c)) return undefined;
  return c as "chrome" | "msedge" | "chromium" | "chrome-beta" | "msedge-beta" | "msedge-dev";
}

function localeFromEnv(): string {
  const l = (process.env.PLAYWRIGHT_LOCALE ?? "").trim();
  return l || "es-ES";
}

export async function createContext(
  options: BrowserSessionOptions = {}
): Promise<{ browser: Browser; context: BrowserContext; page: Page }> {
  const channel = launchChannelFromEnv();
  const slowMoRaw = Number(process.env.PLAYWRIGHT_SLOW_MO ?? 0);
  const slowMo = Number.isFinite(slowMoRaw) && slowMoRaw > 0 ? slowMoRaw : undefined;

  const browser = await chromium.launch({
    headless: options.headless !== false,
    channel,
    slowMo,
    args: [
      "--disable-blink-features=AutomationControlled",
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-infobars",
      "--window-size=1280,800",
    ],
  });

  const context = await browser.newContext({
    userAgent: options.userAgent ?? DEFAULT_UA,
    viewport: { width: 1280, height: 800 },
    locale: localeFromEnv(),
    ...(process.env.PLAYWRIGHT_TIMEZONE?.trim()
      ? { timezoneId: process.env.PLAYWRIGHT_TIMEZONE.trim() }
      : {}),
    proxy: options.proxy,
    ignoreHTTPSErrors: false,
    acceptDownloads: true,
  });

  await context.addInitScript(() => {
    try {
      Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    } catch {
      /* ignore */
    }
  });

  const page = await context.newPage();
  return { browser, context, page };
}

export async function injectLiAt(page: Page, cookieValue: string): Promise<void> {
  const value = cookieValue.trim();
  if (!value) throw new Error("li_at vacío");
  await page.goto("https://www.linkedin.com/", { waitUntil: "domcontentloaded", timeout: 60000 });
  const context = page.context();
  await context.addCookies([
    {
      name: "li_at",
      value,
      domain: ".linkedin.com",
      path: "/",
      secure: true,
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
  await page.reload({ waitUntil: "domcontentloaded", timeout: 60000 });
}

export async function closeSession(browser: Browser): Promise<void> {
  await browser.close().catch(() => {});
}
