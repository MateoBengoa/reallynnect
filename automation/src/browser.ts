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

// Realistic Chrome 131 UA for Windows — matches the launch channel
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

/**
 * Stealth init script — runs in every new page context before any page script.
 * Patches the properties that LinkedIn (and other bot detectors) inspect.
 */
function buildStealthScript(locale: string): string {
  const lang = locale.split("-")[0] ?? "es";
  return `
(function () {
  // 1. Hide webdriver flag
  try {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined, configurable: true });
  } catch {}

  // 2. Realistic plugins list (Chrome on Windows has these)
  try {
    const fakePDF = { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' };
    const fakeNACL = { name: 'Native Client', filename: 'internal-nacl-plugin', description: '' };
    const pluginProto = Object.create(Plugin.prototype);
    const pluginsProto = Object.create(PluginArray.prototype);
    Object.defineProperty(pluginsProto, 'length', { get: () => 2 });
    Object.defineProperty(pluginsProto, '0', { get: () => pluginProto });
    Object.defineProperty(pluginsProto, '1', { get: () => pluginProto });
    pluginsProto.item = (i) => i < 2 ? pluginProto : null;
    pluginsProto.namedItem = (n) => null;
    pluginsProto[Symbol.iterator] = function*() { yield pluginProto; yield pluginProto; };
    Object.defineProperty(navigator, 'plugins', { get: () => pluginsProto, configurable: true });
  } catch {}

  // 3. Languages
  try {
    Object.defineProperty(navigator, 'languages', { get: () => ['${lang}', '${locale}', 'en-US', 'en'], configurable: true });
    Object.defineProperty(navigator, 'language', { get: () => '${lang}', configurable: true });
  } catch {}

  // 4. Platform matching Windows UA
  try {
    Object.defineProperty(navigator, 'platform', { get: () => 'Win32', configurable: true });
  } catch {}

  // 5. window.chrome — must exist in real Chrome
  try {
    if (!window.chrome) {
      Object.defineProperty(window, 'chrome', {
        value: {
          app: { isInstalled: false, getDetails: function(){}, getIsInstalled: function(){}, runningState: function(){ return 'cannot_run'; } },
          runtime: { PlatformOs: { MAC:'mac', WIN:'win', ANDROID:'android', CROS:'cros', LINUX:'linux', OPENBSD:'openbsd' }, PlatformArch: { ARM:'arm', X86_32:'x86-32', X86_64:'x86-64' }, PlatformNaclArch: { ARM:'arm', X86_32:'x86-32', X86_64:'x86-64' }, RequestUpdateCheckStatus: { THROTTLED:'throttled', NO_UPDATE:'no_update', UPDATE_AVAILABLE:'update_available' }, OnInstalledReason: { INSTALL:'install', UPDATE:'update', CHROME_UPDATE:'chrome_update', SHARED_MODULE_UPDATE:'shared_module_update' }, OnRestartRequiredReason: { APP_UPDATE:'app_update', OS_UPDATE:'os_update', PERIODIC:'periodic' } },
          loadTimes: function(){},
          csi: function(){ return { startE: Date.now(), onloadT: Date.now(), pageT: Date.now() - 1000, tran: 15 }; },
        },
        configurable: true,
        writable: true,
      });
    }
  } catch {}

  // 6. Notification permission — headless returns 'denied' which is suspicious
  try {
    const origQuery = window.navigator.permissions.query;
    window.navigator.permissions.query = (parameters) => {
      if (parameters.name === 'notifications') {
        return Promise.resolve({ state: Notification.permission, name: 'notifications', onchange: null, addEventListener: ()=>{}, removeEventListener: ()=>{}, dispatchEvent: ()=>false });
      }
      return origQuery(parameters);
    };
  } catch {}

  // 7. Hide automation-related chrome.runtime messages
  try {
    const desc = Object.getOwnPropertyDescriptor(navigator, 'userAgent');
    if (desc && desc.get) {
      const realUA = desc.get.call(navigator);
      if (realUA.includes('HeadlessChrome')) {
        Object.defineProperty(navigator, 'userAgent', { get: () => realUA.replace('HeadlessChrome', 'Chrome'), configurable: true });
      }
    }
  } catch {}

  // 8. Realistic screen / window
  try {
    if (screen.width === 0 || screen.height === 0) {
      Object.defineProperty(screen, 'width',       { get: () => 1280, configurable: true });
      Object.defineProperty(screen, 'height',      { get: () => 800,  configurable: true });
      Object.defineProperty(screen, 'availWidth',  { get: () => 1280, configurable: true });
      Object.defineProperty(screen, 'availHeight', { get: () => 760,  configurable: true });
      Object.defineProperty(screen, 'colorDepth',  { get: () => 24,   configurable: true });
      Object.defineProperty(screen, 'pixelDepth',  { get: () => 24,   configurable: true });
    }
  } catch {}

  // 9. Hide Playwright-specific stack traces in error messages
  try {
    const origErr = Error;
    // Don't wrap Error — too risky. Just ensure stack property doesn't expose __playwright
    const origPrepare = Error.prepareStackTrace;
    if (origPrepare) {
      Error.prepareStackTrace = function(err, stack) {
        const result = origPrepare(err, stack);
        if (typeof result === 'string') return result.replace(/__playwright|playwright-core/g, '__pn');
        return result;
      };
    }
  } catch {}
})();
`;
}

export async function createContext(
  options: BrowserSessionOptions = {}
): Promise<{ browser: Browser; context: BrowserContext; page: Page }> {
  const channel = launchChannelFromEnv();
  const slowMoRaw = Number(process.env.PLAYWRIGHT_SLOW_MO ?? 0);
  const slowMo = Number.isFinite(slowMoRaw) && slowMoRaw > 0 ? slowMoRaw : undefined;
  const locale = localeFromEnv();

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
      // Additional stealth flags
      "--disable-features=IsolateOrigins,site-per-process",
      "--disable-web-security",
      "--allow-running-insecure-content",
      "--disable-background-networking",
      "--disable-client-side-phishing-detection",
      "--disable-sync",
      "--metrics-recording-only",
      "--no-first-run",
      "--password-store=basic",
      "--use-mock-keychain",
      "--lang=es-ES",
    ],
  });

  const context = await browser.newContext({
    userAgent: options.userAgent ?? DEFAULT_UA,
    viewport: { width: 1280, height: 800 },
    screen: { width: 1280, height: 800 },
    locale,
    ...(process.env.PLAYWRIGHT_TIMEZONE?.trim()
      ? { timezoneId: process.env.PLAYWRIGHT_TIMEZONE.trim() }
      : {}),
    proxy: options.proxy,
    ignoreHTTPSErrors: false,
    acceptDownloads: true,
    // Realistic extra HTTP headers
    extraHTTPHeaders: {
      "Accept-Language": `${locale},${locale.split("-")[0] ?? "es"};q=0.9,en-US;q=0.8,en;q=0.7`,
      "Accept-Encoding": "gzip, deflate, br",
      "sec-ch-ua": '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
      "sec-ch-ua-mobile": "?0",
      "sec-ch-ua-platform": '"Windows"',
    },
  });

  await context.addInitScript(buildStealthScript(locale));

  const page = await context.newPage();
  return { browser, context, page };
}

/**
 * Inject the li_at session cookie WITHOUT a prior unauthenticated navigation.
 * We set the cookie directly, then navigate once to feed to establish the session.
 * This avoids the "cold open → login page redirect" fingerprint.
 */
export async function injectLiAt(page: Page, cookieValue: string): Promise<void> {
  const value = cookieValue.trim();
  if (!value) throw new Error("li_at vacío");

  // Set cookie before any navigation so LinkedIn never sees an unauthenticated visit
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

  // Navigate directly to feed (authenticated).
  // Usamos "load" con timeout generoso; si LinkedIn va lento pero la cookie está
  // inyectada la sesión sigue siendo válida aunque el timeout se dispare.
  let lastNavErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await page.goto("https://www.linkedin.com/feed/", { waitUntil: "domcontentloaded", timeout: 90000 });
      lastNavErr = null;
      break;
    } catch (e) {
      lastNavErr = e;
      const url = page.url();
      if (url.includes("linkedin.com")) {
        // Cookie inyectada; LinkedIn cargó aunque lanzó timeout
        lastNavErr = null;
        break;
      }
      // about:blank o URL no-linkedin → reintento solo en primer intento
      if (attempt === 0) {
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
  }
  if (lastNavErr !== null) {
    const url = page.url();
    const reason = lastNavErr instanceof Error ? lastNavErr.message : String(lastNavErr);
    throw new Error(`injectLiAt: navegación fallida — URL actual: ${url} — ${reason}`);
  }
}

export async function closeSession(browser: Browser): Promise<void> {
  await browser.close().catch(() => {});
}
