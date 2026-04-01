import type { Locator, Page } from "playwright";
import { detectSoftban } from "./softban.js";
import { humanScroll, lightMouseJitter, randomDelay } from "./humanize.js";
import { normalizeLinkedInProfileUrl } from "./linkedinUrls.js";

export type ActionResult = { ok: boolean; softban?: boolean; error?: string };

async function guardSoftban(page: Page): Promise<ActionResult | null> {
  const s = await detectSoftban(page);
  if (s === "suspected") return { ok: false, softban: true };
  return null;
}

export async function openFeed(page: Page): Promise<ActionResult> {
  const fast = process.env.LINKEDIN_FAST_AUTOMATION === "true";
  await randomDelay(fast ? 800 : 15000, fast ? 2500 : 45000);
  await page.goto("https://www.linkedin.com/feed/", { waitUntil: "domcontentloaded", timeout: 90000 });
  await lightMouseJitter(page);
  const u = page.url().toLowerCase();
  if (u.includes("/login") || u.includes("/checkpoint") || u.includes("/challenge")) {
    return { ok: false, error: "linkedin_login_or_challenge" };
  }
  await humanScroll(page, 30000);
  const g = await guardSoftban(page);
  if (g) return g;
  return { ok: true };
}

/**
 * Tras inyectar `li_at`, confirma sesión en el feed antes de visitar perfiles (campañas).
 * Evita ir directo al perfil con cookie fría y recibir muro de login.
 */
export async function ensureLinkedInFeedSession(page: Page): Promise<ActionResult> {
  const fast = process.env.LINKEDIN_FAST_AUTOMATION === "true";
  await page.goto("https://www.linkedin.com/feed/", { waitUntil: "domcontentloaded", timeout: 90000 });
  await lightMouseJitter(page);
  await randomDelay(fast ? 600 : 4000, fast ? 1800 : 14000);
  const g = await guardSoftban(page);
  if (g) return g;
  const u = page.url().toLowerCase();
  if (u.includes("/login") || u.includes("/checkpoint") || u.includes("/challenge")) {
    return { ok: false, error: "linkedin_login_or_challenge" };
  }
  return { ok: true };
}

export type VisitProfileOptions = {
  /** Sin scroll largo: deja visibles los botones del top card (Seguir, Conectar…). */
  light?: boolean;
};

export async function visitProfile(page: Page, profileUrl: string, options?: VisitProfileOptions): Promise<ActionResult> {
  const url = normalizeLinkedInProfileUrl(profileUrl);
  if (!url || !url.includes("linkedin.com")) {
    return { ok: false, error: "invalid_profile_url" };
  }
  const fast = process.env.LINKEDIN_FAST_AUTOMATION === "true";
  const light = options?.light === true;
  await randomDelay(fast ? 800 : 15000, light ? 1200 : fast ? 2500 : 35000);
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90000 });
  await lightMouseJitter(page);
  if (navigatedToFeedOrActivity(page.url())) {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90000 });
    await lightMouseJitter(page);
  }
  if (light) {
    await page.evaluate(() => window.scrollTo({ top: 0, left: 0, behavior: "instant" }));
    await randomDelay(fast ? 500 : 2000, fast ? 1200 : 4500);
  } else {
    await humanScroll(page, fast ? 4000 : 8000 + Math.random() * 12000);
  }
  const g = await guardSoftban(page);
  if (g) return g;
  return { ok: true };
}

async function scrollProfileTopCardIntoView(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.scrollTo({ top: 0, left: 0, behavior: "instant" });
  });
  await randomDelay(400, 900);
}

/** Barra Conectar / Mensaje / ··· del top card (no otros ··· dentro de main). */
function profileTopActionBar(page: Page): Locator {
  return page.locator("main [class*='pvs-profile-actions']").first();
}

function profileTopActionBarFallback(page: Page): Locator {
  return page.locator("main .pv-top-card--list").first();
}

/** Contenedores alternativos: LinkedIn cambia clases; sin esto no encontramos ··· y falla Conectar solo en menú. */
function profileTopActionBarWide(page: Page): Locator {
  return page
    .locator(
      "main [class*='pvs-profile-actions'], main [class*='ProfileActions'], main [class*='top-card'] [class*='actions'], main [data-view-name*='profile-top-card']"
    )
    .first();
}

/**
 * Clic en el ··· del header del perfil por posición (mitad superior del viewport), sin depender de pvs-profile-actions.
 */
async function clickProfileHeaderOverflowByGeometry(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const main = document.querySelector("main");
    if (!main) return false;
    const vh = window.innerHeight;
    const maxY = vh * 0.5;
    const hits: { el: HTMLButtonElement; top: number }[] = [];
    for (const b of main.querySelectorAll("button")) {
      const el = b as HTMLButtonElement;
      if (!el.querySelector("svg#overflow-web-ios-small")) continue;
      if (!el.offsetParent) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2 || r.bottom < 0 || r.top > maxY) continue;
      hits.push({ el, top: r.top });
    }
    hits.sort((a, b) => a.top - b.top);
    if (hits.length === 0) return false;
    const chosen = hits[0]!.el;
    chosen.scrollIntoView({ block: "nearest", inline: "nearest" });
    chosen.click();
    return true;
  });
}

/** Navegación errónea típica al pulsar un enlace de actividad en lugar de Conectar del top card. */
function navigatedToFeedOrActivity(url: string): boolean {
  const u = url.toLowerCase();
  if (/custom-invite|invite-send/i.test(u)) return false;
  return /\/feed\/update\//i.test(u) || /linkedin\.com\/feed\/?(\?|#|$)/i.test(u);
}

export async function ensureProfilePageLoaded(page: Page, profileUrl: string): Promise<void> {
  const norm = normalizeLinkedInProfileUrl(profileUrl);
  let vanity = "";
  let path = "";
  try {
    const p = new URL(norm).pathname;
    path = p.toLowerCase().replace(/\/$/, "") || "";
    const m = p.match(/\/in\/([^/]+)/i);
    vanity = (m?.[1] ?? "").toLowerCase();
  } catch {
    return;
  }
  const u = page.url().toLowerCase();
  const onProfile = vanity ? u.includes(`/in/${vanity}`) : path.length > 1 && u.includes(path);
  if (onProfile) return;
  await page.goto(norm, { waitUntil: "domcontentloaded", timeout: 90000 });
  await lightMouseJitter(page);
  await randomDelay(400, 1100);
}

/** ¿El CTA principal ya es “Siguiendo” / “Following”? */
async function pageShowsFollowingState(page: Page): Promise<boolean> {
  const inMain = page.locator("main");
  const followingBtn = inMain
    .getByRole("button", { name: /Siguiendo|Following|Dejar de seguir|Unfollow/i })
    .first();
  if (await followingBtn.isVisible({ timeout: 2000 }).catch(() => false)) return true;
  const aria = inMain.locator(
    'button[aria-label*="Siguiendo"], button[aria-label*="Following"], button[aria-label*="Unfollow"], button[aria-label*="Dejar de seguir"]'
  );
  return aria.first().isVisible({ timeout: 1500 }).catch(() => false);
}

async function confirmFollowDialogIfAny(page: Page): Promise<void> {
  const dlg = page.locator('[role="dialog"]').filter({ hasText: /seguir|follow/i });
  if (await dlg.first().isVisible({ timeout: 2000 }).catch(() => false)) {
    const go = dlg
      .first()
      .getByRole("button", { name: /Seguir(?!iendo)|Follow(?!ing)/i });
    await go.first().click({ timeout: 5000 }).catch(() => {});
    await randomDelay(400, 900);
  }
}

/**
 * Abre el menú «···» del top card (Seguir suele estar aquí si no hay botón principal).
 * Importante: nunca usar `button:has(svg#overflow-web-ios-small)` en todo `main` — hay más ··· en posts y el scroll lleva abajo y falla el clic.
 */
async function openProfileOverflowMenu(page: Page): Promise<boolean> {
  await scrollProfileTopCardIntoView(page);
  await randomDelay(250, 600);

  const tryClickInBar = async (bar: Locator): Promise<boolean> => {
    if (!(await bar.isVisible({ timeout: 1800 }).catch(() => false))) return false;

    const candidates: Locator[] = [
      bar.locator("button:has(svg#overflow-web-ios-small)"),
      bar.getByRole("button", { name: /más acciones|more actions|other actions/i }),
      bar.getByRole("button", { name: /^Más$/i }),
      bar.getByRole("button", { name: /^More$/i }),
      bar.locator(
        [
          'button[aria-label*="Más opciones" i]',
          'button[aria-label*="More options" i]',
          'button[aria-label*="Show more" i]',
          'button[aria-label*="más opciones" i]',
          'button[aria-label*="ver más" i]',
          'button[aria-label*="see more" i]',
          'button[aria-label*="overflow" i]',
          'button[aria-label*="Acciones" i]',
          'button[aria-label*="Actions" i]',
          'button[aria-label*="Otros" i]',
          'button[aria-label*="Other" i]',
        ].join(", ")
      ),
      bar.locator("button.artdeco-dropdown__trigger").last(),
    ];

    for (const loc of candidates) {
      const n = await loc.count().catch(() => 0);
      for (let i = 0; i < Math.min(n, 4); i++) {
        const el = loc.nth(i);
        if (await el.isVisible({ timeout: 900 }).catch(() => false)) {
          await el
            .evaluate((node) =>
              (node as HTMLElement).scrollIntoView({ block: "nearest", inline: "nearest" })
            )
            .catch(() => {});
          await randomDelay(80, 200);
          await el.click({ timeout: 5000 }).catch(() => {});
          await randomDelay(700, 1400);
          return true;
        }
      }
    }
    return false;
  };

  if (await tryClickInBar(profileTopActionBar(page))) return true;
  if (await tryClickInBar(profileTopActionBarFallback(page))) return true;
  if (await tryClickInBar(profileTopActionBarWide(page))) return true;

  const inMain = page.locator("main");
  const loose: Locator[] = [
    inMain.getByRole("button", { name: /más acciones|more actions|other actions/i }),
    inMain.getByRole("button", { name: /^Más$/i }),
    inMain.getByRole("button", { name: /^More$/i }),
    page.getByRole("button", { name: /más acciones|more actions/i }),
    inMain.locator(
      [
        'button[aria-label*="Más opciones" i]',
        'button[aria-label*="More options" i]',
        'button[aria-label*="Show more" i]',
        'button[aria-label*="más opciones" i]',
        'button[aria-label*="ver más" i]',
        'button[aria-label*="see more" i]',
        'button[aria-label*="overflow" i]',
      ].join(", ")
    ),
  ];
  for (const loc of loose) {
    const n = await loc.count().catch(() => 0);
    for (let i = 0; i < Math.min(n, 2); i++) {
      const el = loc.nth(i);
      if (await el.isVisible({ timeout: 700 }).catch(() => false)) {
        const inTop = await el
          .evaluate((node) => {
            const h = node as HTMLElement;
            if (
              h.closest(
                "[class*='pvs-profile-actions'], .pv-top-card--list, [class*='profile-actions'], [class*='top-card'], [data-view-name*='profile-top-card']"
              )
            ) {
              return true;
            }
            const r = h.getBoundingClientRect();
            return r.top >= -12 && r.top < window.innerHeight * 0.5 && r.width > 2;
          })
          .catch(() => false);
        if (!inTop) continue;
        await el
          .evaluate((node) =>
            (node as HTMLElement).scrollIntoView({ block: "nearest", inline: "nearest" })
          )
          .catch(() => {});
        await el.click({ timeout: 5000 }).catch(() => {});
        await randomDelay(700, 1400);
        return true;
      }
    }
  }

  const opened = await page.evaluate(() => {
    const main = document.querySelector("main");
    if (!main) return false;
    const scope =
      main.querySelector("[class*='pvs-profile-actions']") ||
      main.querySelector(".pv-top-card--list") ||
      main.querySelector("[class*='profile-actions']") ||
      main.querySelector("[class*='ProfileActions']") ||
      main.querySelector("[class*='top-card']") ||
      main.querySelector("[data-view-name*='profile-top-card']");
    const searchRoots: Element[] = [];
    if (scope) searchRoots.push(scope);
    else searchRoots.push(main);
    const buttons = searchRoots[0]!.querySelectorAll("button");
    for (const b of buttons) {
      const el = b as HTMLButtonElement;
      if (el.offsetParent === null) continue;
      if (el.querySelector("svg#overflow-web-ios-small")) {
        el.scrollIntoView({ block: "nearest", inline: "nearest" });
        el.click();
        return true;
      }
    }
    for (const b of buttons) {
      const el = b as HTMLButtonElement;
      if (el.offsetParent === null) continue;
      const lb = (el.getAttribute("aria-label") || "").toLowerCase();
      if (
        /más opciones|more options|overflow|other actions|más acciones|ver más|see more|acciones|dropdown/i.test(lb) &&
        !/conectar|connect|mensaje|message|enviar/i.test(lb)
      ) {
        el.scrollIntoView({ block: "nearest", inline: "nearest" });
        el.click();
        return true;
      }
    }
    for (const b of buttons) {
      const el = b as HTMLButtonElement;
      if (el.offsetParent === null) continue;
      if (el.classList.contains("artdeco-dropdown__trigger")) {
        const row = el.closest(
          "[class*='pvs-profile-actions'], [class*='profile-actions'], .pv-top-card--list, [class*='top-card'], [data-view-name*='profile-top-card'], li"
        );
        if (row) {
          el.scrollIntoView({ block: "nearest", inline: "nearest" });
          el.click();
          return true;
        }
      }
    }
    return false;
  });
  if (opened) {
    await randomDelay(700, 1400);
    return true;
  }
  const geoOpened = await clickProfileHeaderOverflowByGeometry(page);
  if (geoOpened) await randomDelay(700, 1400);
  return geoOpened;
}

/** Clic en Seguir/Follow dentro del dropdown ya abierto (suele estar en portal fuera de main). */
async function clickFollowInOverflowDropdown(page: Page): Promise<boolean> {
  const tryClick = async (loc: ReturnType<Page["locator"]>): Promise<boolean> => {
    const el = loc.first();
    if (await el.isVisible({ timeout: 2500 }).catch(() => false)) {
      await el.click({ timeout: 6000 }).catch(() => {});
      return true;
    }
    return false;
  };

  const scoped = [
    page.locator('[role="menu"]'),
    page.locator(".artdeco-dropdown__content-inner"),
    page.locator('[class*="dropdown__content-inner"]'),
    page.locator('[data-view-name*="overflow" i]'),
  ];

  for (const root of scoped) {
    if (await tryClick(root.getByRole("menuitem", { name: /Seguir(?!iendo)|Follow(?!ing)/i }))) return true;
    if (await tryClick(root.locator("button, div[role='button'], a").filter({ hasText: /^Seguir$/ }))) return true;
    if (await tryClick(root.locator("button, div[role='button'], a").filter({ hasText: /^Follow$/ }))) return true;
  }

  const anyMenuitem = page.getByRole("menuitem", { name: /Seguir(?!iendo)|Follow(?!ing)/i });
  const mc = await anyMenuitem.count().catch(() => 0);
  for (let i = 0; i < Math.min(mc, 8); i++) {
    const m = anyMenuitem.nth(i);
    if (await m.isVisible({ timeout: 1500 }).catch(() => false)) {
      await m.click({ timeout: 6000 }).catch(() => {});
      return true;
    }
  }

  return page.evaluate(() => {
    const roots = document.querySelectorAll(
      '[role="menu"], .artdeco-dropdown__content-inner, [class*="dropdown__content-inner"]'
    );
    for (const root of roots) {
      const r = root as HTMLElement;
      if (r.offsetParent === null && !r.closest(".artdeco-dropdown__content--is-open")) continue;
      const items = r.querySelectorAll('[role="menuitem"], button, div[role="button"], a[role="menuitem"]');
      for (const node of items) {
        const el = node as HTMLElement;
        if (el.offsetParent === null) continue;
        const t = (el.textContent || "").replace(/\s+/g, " ").trim();
        const lb = (el.getAttribute("aria-label") || "").toLowerCase();
        const hay = `${t} ${lb}`;
        if (/siguiendo|following|unfollow|dejar de seguir/i.test(hay)) continue;
        if (/^seguir$/i.test(t) || /^follow$/i.test(t)) {
          el.click();
          return true;
        }
        if (/\bseguir\b/i.test(lb) && !/siguiendo/i.test(lb)) {
          el.click();
          return true;
        }
        if (/\bfollow\b/i.test(lb) && !/following/i.test(lb)) {
          el.click();
          return true;
        }
      }
    }
    return false;
  });
}

/** Clic en Seguir / Follow (“Seguir a Nombre”, menú, span.artdeco-button__text). */
async function clickFollowRobust(page: Page): Promise<boolean> {
  const tryPlaywrightClick = async (loc: ReturnType<Page["locator"]>): Promise<boolean> => {
    const el = loc.first();
    if (!(await el.isVisible({ timeout: 3500 }).catch(() => false))) return false;
    await el.scrollIntoViewIfNeeded().catch(() => {});
    await randomDelay(200, 500);
    try {
      await el.click({ timeout: 6000 });
      return true;
    } catch {
      try {
        await el.click({ timeout: 6000, force: true });
        return true;
      } catch {
        return false;
      }
    }
  };

  const inMain = page.locator("main");

  // LinkedIn (UI reciente): icono + en SVG id="add-small" y texto "Seguir" en spans con clases hash (sin artdeco-button__text).
  const followByAddIcon = inMain.locator("button").filter({ has: page.locator("svg#add-small") });
  if (await tryPlaywrightClick(followByAddIcon)) return true;

  const followByAddIconLink = inMain.locator("a[role='button'], a.artdeco-button").filter({ has: page.locator("svg#add-small") });
  if (await tryPlaywrightClick(followByAddIconLink)) return true;

  const followBtnHasSeguirSpan = inMain
    .locator("button")
    .filter({ has: page.locator("span", { hasText: /^Seguir$/ }) })
    .filter({ hasNotText: /Siguiendo/i });
  if (await tryPlaywrightClick(followBtnHasSeguirSpan.first())) return true;

  const seguirLeaves = inMain.getByText("Seguir", { exact: true });
  const seguirCount = await seguirLeaves.count().catch(() => 0);
  for (let i = 0; i < Math.min(seguirCount, 8); i++) {
    const ancBtn = seguirLeaves.nth(i).locator("xpath=ancestor::button[1]");
    if (await tryPlaywrightClick(ancBtn)) return true;
    const ancRole = seguirLeaves.nth(i).locator("xpath=ancestor::*[@role='button'][1]");
    if (await tryPlaywrightClick(ancRole)) return true;
  }

  const roleCandidates = [
    inMain.getByRole("button", { name: /Seguir(?!iendo)/i }),
    inMain.getByRole("button", { name: /Follow(?!ing)/i }),
    inMain.getByRole("link", { name: /Seguir(?!iendo)/i }),
    inMain.getByRole("link", { name: /Follow(?!ing)/i }),
    inMain.getByRole("button", { name: /^\+?\s*Seguir$/i }),
    inMain.getByRole("button", { name: /^\+?\s*Follow$/i }),
    inMain.getByRole("button", { name: /^Seguir$/i }),
    inMain.getByRole("button", { name: /^Follow$/i }),
    page.getByRole("button", { name: /Seguir(?!iendo)/i }),
    page.getByRole("button", { name: /Follow(?!ing)/i }),
  ];

  for (const loc of roleCandidates) {
    if (await tryPlaywrightClick(loc)) return true;
  }

  const menuItems = [
    page.getByRole("menuitem", { name: /Seguir(?!iendo)/i }),
    page.getByRole("menuitem", { name: /Follow(?!ing)/i }),
    page.locator('[role="menu"] button').filter({ hasText: /^\+?\s*Seguir\s*$/i }),
    page.locator('[role="menu"] button').filter({ hasText: /^\+?\s*Follow\s*$/i }),
  ];
  for (const loc of menuItems) {
    if (await tryPlaywrightClick(loc)) return true;
  }

  const filterBtn = inMain
    .locator("button")
    .filter({ hasText: /^\+?\s*Seguir\s*$/i })
    .or(inMain.locator("button").filter({ hasText: /^Seguir\s*$/i }))
    .or(inMain.locator("button").filter({ hasText: /^\+?\s*Follow\s*$/i }))
    .or(inMain.locator("button").filter({ hasText: /^Follow\s*$/i }));
  if (await tryPlaywrightClick(filterBtn)) return true;

  const ariaSeguir = inMain.locator(
    'button[aria-label*="Seguir"]:not([aria-label*="Siguiendo"]):not([aria-label*="Dejar de seguir"])'
  );
  const ariaFollow = inMain.locator(
    'button[aria-label*="Follow"]:not([aria-label*="Following"]):not([aria-label*="Unfollow"])'
  );
  if (await tryPlaywrightClick(ariaSeguir)) return true;
  if (await tryPlaywrightClick(ariaFollow)) return true;

  const seguirSpan = inMain.locator("span.artdeco-button__text", { hasText: /^\+?\s*Seguir\s*$/i }).or(
    inMain.locator("span.artdeco-button__text", { hasText: /^Seguir$/i })
  );
  const followSpan = inMain
    .locator("span.artdeco-button__text", { hasText: /^\+?\s*Follow\s*$/i })
    .or(inMain.locator("span.artdeco-button__text", { hasText: /^Follow$/i }));
  for (const span of [seguirSpan, followSpan]) {
    const parentBtn = span.locator("xpath=ancestor::button[1]");
    if (await tryPlaywrightClick(parentBtn)) return true;
    const parentA = span.locator("xpath=ancestor::a[1]");
    if (await tryPlaywrightClick(parentA)) return true;
  }

  const clicked = await page.evaluate(() => {
    const root = document.querySelector("main") ?? document.body;
    const addSvg = root.querySelector("svg#add-small");
    if (addSvg) {
      let el: HTMLElement | null = addSvg as unknown as HTMLElement;
      for (let d = 0; d < 16 && el; d++) {
        if (el.tagName === "BUTTON" || el.getAttribute("role") === "button") {
          (el as HTMLButtonElement).click();
          return true;
        }
        el = el.parentElement;
      }
    }
    const nodes = root.querySelectorAll("button, a[role='button'], a.artdeco-button, a.artdeco-button--secondary");
    for (const node of nodes) {
      const el = node as HTMLElement;
      if (el.offsetParent === null) continue;
      const text = (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
      const label = (el.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim();
      const hay = `${text} ${label}`.toLowerCase();
      if (/siguiendo|following|dejar de seguir|unfollow|pendiente|pending|requested|solicitud enviada/.test(hay)) continue;
      if (/^(conectar|connect|mensaje|message)$/i.test(text) || (/^más$/i.test(text) && !/seguir/i.test(label))) {
        continue;
      }
      if (/^\+?\s*seguir(\s|$)/i.test(text) || /^seguir(\s|$)/i.test(text)) {
        el.click();
        return true;
      }
      if (/^\+?\s*follow(\s|$)/i.test(text) || /^follow(\s|$)/i.test(text)) {
        el.click();
        return true;
      }
      if (/\bseguir\b/i.test(label) && !/siguiendo|dejar de seguir/i.test(label)) {
        el.click();
        return true;
      }
      if (/\bfollow\b/i.test(label) && !/following|unfollow/i.test(label)) {
        el.click();
        return true;
      }
    }
    return false;
  });
  return clicked;
}

/** Clic en Seguir / Follow en el perfil (personas; no empresas). */
export async function followProfile(page: Page, profileUrl: string): Promise<ActionResult> {
  const r = await visitProfile(page, profileUrl, { light: true });
  if (!r.ok || r.softban) return r;

  await scrollProfileTopCardIntoView(page);
  await page.waitForSelector("main h1, main [class*='profile'], main .pv-text-details__left-panel", { timeout: 25000 }).catch(() => {});
  await randomDelay(600, 1400);

  if (await pageShowsFollowingState(page)) {
    return { ok: true };
  }

  let clicked = await clickFollowRobust(page);
  await confirmFollowDialogIfAny(page);

  if (!clicked) {
    const openedOverflow = await openProfileOverflowMenu(page);
    if (openedOverflow) {
      clicked = await clickFollowInOverflowDropdown(page);
      await confirmFollowDialogIfAny(page);
    }
    if (!clicked) {
      clicked = await clickFollowRobust(page);
      await confirmFollowDialogIfAny(page);
    }
  }

  if (!clicked) {
    const more = page.getByRole("button", { name: /more|más/i }).first();
    if (await more.isVisible({ timeout: 2500 }).catch(() => false)) {
      await more.click().catch(() => {});
      await randomDelay(600, 1200);
      clicked = await clickFollowInOverflowDropdown(page);
      if (!clicked) clicked = await clickFollowRobust(page);
      await confirmFollowDialogIfAny(page);
    }
  }

  if (!clicked) {
    const g = await guardSoftban(page);
    if (g) return g;
    return { ok: false, error: "follow_button_missing" };
  }

  await randomDelay(2200, 4800);
  await confirmFollowDialogIfAny(page);

  if (await pageShowsFollowingState(page)) {
    const g = await guardSoftban(page);
    if (g) return g;
    return { ok: true };
  }

  await scrollProfileTopCardIntoView(page);
  let retry = await clickFollowRobust(page);
  if (!retry) {
    const opened = await openProfileOverflowMenu(page);
    if (opened) retry = await clickFollowInOverflowDropdown(page);
  }
  await confirmFollowDialogIfAny(page);
  if (retry) {
    await randomDelay(2200, 4500);
  }

  if (await pageShowsFollowingState(page)) {
    const g = await guardSoftban(page);
    if (g) return g;
    return { ok: true };
  }

  return { ok: false, error: "follow_not_confirmed" };
}

/** Primer match visible (evita `.first()` oculto en plantillas / duplicados). */
async function tryClickNthVisible(loc: Locator, max?: number): Promise<boolean> {
  const cap = max ?? 16;
  const n = await loc.count().catch(() => 0);
  for (let i = 0; i < Math.min(n, cap); i++) {
    const el = loc.nth(i);
    if (!(await el.isVisible({ timeout: 1800 }).catch(() => false))) continue;
    await el.scrollIntoViewIfNeeded().catch(() => {});
    await randomDelay(120, 350);
    try {
      await el.click({ timeout: 7000 });
      return true;
    } catch {
      try {
        await el.click({ timeout: 7000, force: true });
        return true;
      } catch {
        /* siguiente */
      }
    }
  }
  return false;
}

/**
 * Conectar solo dentro del dropdown ya abierto (··· o «Más»).
 * LinkedIn a veces muestra «Conectar» como fila con icono + texto sin href útil hasta el clic, o con distinto contenedor.
 */
async function clickConnectInOpenDropdown(page: Page): Promise<boolean> {
  await randomDelay(650, 1300);

  await page
    .waitForFunction(
      () => {
        const panelSel = [
          ".artdeco-dropdown__content--is-open",
          '[class*="dropdown__content--is-open"]',
          ".artdeco-dropdown__content-inner",
          '[class*="artdeco-dropdown__content-inner"]',
        ].join(", ");
        for (const panel of document.querySelectorAll(panelSel)) {
          const p = panel as HTMLElement;
          const pr = p.getBoundingClientRect();
          const pst = window.getComputedStyle(p);
          if (pr.height < 12 || pr.width < 40) continue;
          if (pst.visibility === "hidden" || pst.display === "none") continue;
          const op = parseFloat(pst.opacity);
          if (Number.isFinite(op) && op < 0.08) continue;

          for (const el of p.querySelectorAll(
            'a[href*="custom-invite"], a[href*="preload/custom-invite"], [role="menuitem"]'
          )) {
            const h = el as HTMLElement;
            const r = h.getBoundingClientRect();
            if (r.width < 3 || r.height < 3) continue;
            const st = window.getComputedStyle(h);
            if (st.visibility === "hidden" || st.display === "none") continue;
            const href = (el.getAttribute("href") || "").toLowerCase();
            if (href.includes("custom-invite")) return true;
            if (el.getAttribute("role") === "menuitem") {
              const t = (el.textContent || "").replace(/\s+/g, " ").trim();
              if (/^conectar$/i.test(t) || /^connect$/i.test(t)) return true;
              if (el.querySelector("svg#connect-small")) return true;
            }
          }
        }
        return false;
      },
      { timeout: 16000 }
    )
    .catch(() => {});

  const openPanel = page.locator(
    '.artdeco-dropdown__content--is-open, [class*="dropdown__content--is-open"], .artdeco-dropdown__content-inner, [class*="artdeco-dropdown__content-inner"]'
  );

  const scopedMenuItems = (inner: Locator): Locator[] => [
    inner.getByRole("menuitem", { name: /^Conectar$/ }),
    inner.getByRole("menuitem", { name: /^Connect$/ }),
    inner.locator('[role="menuitem"]').filter({ hasText: /^Conectar$/ }),
    inner.locator('[role="menuitem"]').filter({ hasText: /^Connect$/ }),
    inner.locator('[role="menuitem"]').filter({ has: page.locator("svg#connect-small") }),
  ];

  for (let pi = 0; pi < Math.min(await openPanel.count(), 6); pi++) {
    const panel = openPanel.nth(pi);
    if (!(await panel.isVisible({ timeout: 600 }).catch(() => false))) continue;
    for (const group of scopedMenuItems(panel)) {
      if (await tryClickNthVisible(group, 12)) return true;
    }
  }

  const menuLocators: Locator[] = [
    page.getByRole("menuitem", { name: /^Conectar$/ }),
    page.getByRole("menuitem", { name: /^Connect$/ }),
    page.locator('[role="menuitem"]').filter({ hasText: /^Conectar$/ }),
    page.locator('[role="menuitem"]').filter({ hasText: /^Connect$/ }),
    page.locator('a[role="menuitem"][href*="custom-invite"]'),
    page.locator('a[role="menuitem"][href*="preload/custom-invite"]'),
    page.locator('.artdeco-dropdown__content--is-open a[href*="custom-invite"]'),
    page.locator('[class*="dropdown__content--is-open"] a[href*="custom-invite"]'),
    page.locator('.artdeco-dropdown__content-inner a[href*="custom-invite"]'),
    page.locator('[role="menuitem"]').filter({ has: page.locator("svg#connect-small") }),
  ];
  for (const group of menuLocators) {
    if (await tryClickNthVisible(group, 24)) return true;
  }

  if (
    await tryClickNthVisible(
      page.getByRole("menuitem", {
        name: /invita.*a conectar|invite.*to connect|\bconectar\b|\bconnect\b/i,
      }),
      24
    )
  ) {
    return true;
  }

  return page.evaluate(() => {
    const visibleEnough = (h: HTMLElement) => {
      const r = h.getBoundingClientRect();
      const st = window.getComputedStyle(h);
      if (r.width < 3 || r.height < 3) return false;
      if (st.visibility === "hidden" || st.display === "none") return false;
      const op = parseFloat(st.opacity);
      if (Number.isFinite(op) && op < 0.08) return false;
      return true;
    };

    const inMenuPanel = (el: HTMLElement) =>
      !!el.closest(
        '[role="menu"], .artdeco-dropdown__content--is-open, [class*="dropdown__content"], .artdeco-dropdown__content-inner, [class*="artdeco-dropdown__content-inner"]'
      );

    const rowLooksLikeConnect = (el: HTMLElement): boolean => {
      const href = (el.getAttribute("href") || "").toLowerCase();
      if (href.includes("custom-invite")) return true;
      const hasIcon = !!el.querySelector("svg#connect-small");
      const text = (el.textContent || "").replace(/\s+/g, " ").trim();
      const al = (el.getAttribute("aria-label") || "").toLowerCase();
      const hay = `${text} ${al}`;
      if (/pendiente|pending|requested|invitación enviada|invitation sent/i.test(hay)) return false;
      if (hasIcon && (/^conectar$/i.test(text) || /^connect$/i.test(text) || /conectar|connect|invita|invite/.test(hay)))
        return true;
      if (/^conectar$/i.test(text) || /^connect$/i.test(text)) return true;
      return false;
    };

    const clickEl = (el: HTMLElement): void => {
      el.scrollIntoView({ block: "nearest", inline: "nearest" });
      (el as HTMLElement).click();
    };

    const panels = document.querySelectorAll(
      '.artdeco-dropdown__content--is-open, [class*="dropdown__content--is-open"], .artdeco-dropdown__content-inner, [class*="artdeco-dropdown__content-inner"]'
    );
    for (const panel of panels) {
      const p = panel as HTMLElement;
      if (!visibleEnough(p)) continue;

      for (const item of p.querySelectorAll('[role="menuitem"]')) {
        const el = item as HTMLElement;
        if (!visibleEnough(el) || !inMenuPanel(el)) continue;
        if (!rowLooksLikeConnect(el)) continue;
        clickEl(el);
        return true;
      }

      for (const a of p.querySelectorAll('a[href*="custom-invite"], a[href*="preload/custom-invite"]')) {
        const el = a as HTMLElement;
        if (!visibleEnough(el)) continue;
        clickEl(el);
        return true;
      }

      for (const svg of p.querySelectorAll("svg#connect-small")) {
        const row =
          (svg as HTMLElement).closest('[role="menuitem"]') ?? (svg as HTMLElement).closest("a");
        if (!row || !visibleEnough(row as HTMLElement)) continue;
        const t = ((row as HTMLElement).textContent || "").replace(/\s+/g, " ").trim();
        const al = ((row as HTMLElement).getAttribute("aria-label") || "").toLowerCase();
        const okText = /^conectar$/i.test(t) || /^connect$/i.test(t);
        const okAria =
          /invita.*a conectar|invite.*to connect|\bconectar\b|\bconnect\b/i.test(`${t} ${al}`);
        if (!okText && !okAria) continue;
        clickEl(row as HTMLElement);
        return true;
      }
    }

    return false;
  });
}

/**
 * UI reciente: Conectar es un <a href=".../preload/custom-invite/..."> con svg#connect-small,
 * no un button. En el menú «···» es <a role="menuitem" href="...custom-invite...">.
 */
async function clickConnectRobust(page: Page): Promise<boolean> {
  const tryInTopCard = async (root: Locator): Promise<boolean> => {
    if (!(await root.isVisible({ timeout: 900 }).catch(() => false))) return false;
    if (await tryClickNthVisible(root.locator('a[href*="custom-invite"], a[href*="preload/custom-invite"]'))) {
      return true;
    }
    if (
      await tryClickNthVisible(root.locator("a").filter({ has: page.locator("svg#connect-small") }))
    ) {
      return true;
    }
    if (
      await tryClickNthVisible(
        root.getByRole("link", {
          name: /invita.*a conectar|invite.*to connect|\bconectar\b|\bconnect\b/i,
        })
      )
    ) {
      return true;
    }
    if (await tryClickNthVisible(root.getByRole("button", { name: /conectar|connect/i }))) {
      return true;
    }
    return false;
  };

  if (await tryInTopCard(profileTopActionBar(page))) return true;
  if (await tryInTopCard(profileTopActionBarFallback(page))) return true;

  // LinkedIn minifies class names — fallback: search the entire main without relying on class selectors.
  const mainLoc = page.locator("main");
  if (
    await tryClickNthVisible(
      mainLoc
        .locator('a[href*="custom-invite"]')
        .filter({ hasNot: page.locator('[aria-label*="pendiente" i], [aria-label*="pending" i], [aria-label*="retirar" i], [aria-label*="withdraw" i]') })
    )
  ) return true;
  if (
    await tryClickNthVisible(
      mainLoc
        .locator(
          'button[aria-label*="conectar" i], button[aria-label*="connect" i], button[aria-label*="invita" i]'
        )
        .filter({ hasNot: page.locator('[aria-label*="pendiente" i], [aria-label*="pending" i], [aria-label*="retirar" i], [aria-label*="withdraw" i]') })
    )
  ) return true;

  const panels = page.locator(
    '.artdeco-dropdown__content--is-open, [class*="dropdown__content--is-open"], .artdeco-dropdown__content-inner'
  );
  const pn = await panels.count();
  for (let i = 0; i < Math.min(pn, 8); i++) {
    const panel = panels.nth(i);
    if (!(await panel.isVisible({ timeout: 500 }).catch(() => false))) continue;
    if (await tryClickNthVisible(panel.locator('a[href*="custom-invite"]'))) return true;
    if (
      await tryClickNthVisible(
        panel.locator('[role="menuitem"]').filter({ has: page.locator("svg#connect-small") })
      )
    ) {
      return true;
    }
    if (await tryClickNthVisible(panel.getByRole("menuitem", { name: /^Conectar$|^Connect$/i }))) {
      return true;
    }
  }

  return page.evaluate(() => {
    const hrefHasInvite = (a: HTMLAnchorElement) =>
      (a.getAttribute("href") || "").toLowerCase().includes("custom-invite");

    const scopes: Element[] = [];
    const bar = document.querySelector("main [class*='pvs-profile-actions']");
    const list = document.querySelector("main .pv-top-card--list");
    if (bar) scopes.push(bar);
    if (list) scopes.push(list);
    for (const op of document.querySelectorAll(
      '.artdeco-dropdown__content--is-open, [class*="dropdown__content--is-open"]'
    )) {
      scopes.push(op);
    }
    // LinkedIn minifies class names — if no named containers found, search all of main.
    if (scopes.length === 0) {
      const m = document.querySelector("main");
      if (m) scopes.push(m);
    }
    if (scopes.length === 0) return false;

    for (const scope of scopes) {
      for (const a of scope.querySelectorAll(
        'a[href*="custom-invite"], a[href*="preload/custom-invite"]'
      )) {
        const el = a as HTMLElement;
        if (el.offsetParent === null) continue;
        const hay = (el.getAttribute("aria-label") || "").toLowerCase();
        if (/pendiente|pending|requested|retirar|withdraw/.test(hay)) continue;
        el.scrollIntoView({ block: "nearest", inline: "nearest" });
        el.click();
        return true;
      }
      for (const svg of scope.querySelectorAll("a svg#connect-small")) {
        const el = svg.closest("a") as HTMLAnchorElement | null;
        if (!el || el.offsetParent === null) continue;
        const hay = `${el.getAttribute("aria-label") || ""} ${el.textContent || ""}`.toLowerCase();
        if (/pendiente|pending|requested|retirar|withdraw/.test(hay)) continue;
        if (/conectar|connect|invita|invite/.test(hay) || hrefHasInvite(el)) {
          el.scrollIntoView({ block: "nearest", inline: "nearest" });
          el.click();
          return true;
        }
      }
      // Button-based connect (LinkedIn minified UI: <button aria-label="Invita a X a conectar">)
      for (const btn of scope.querySelectorAll("button")) {
        const el = btn as HTMLElement;
        if (el.offsetParent === null) continue;
        const al = (el.getAttribute("aria-label") || "").toLowerCase();
        if (/pendiente|pending|requested|retirar|withdraw/.test(al)) continue;
        if (/conectar|connect|invita.*conectar|invite.*connect/.test(al)) {
          el.scrollIntoView({ block: "nearest", inline: "nearest" });
          el.click();
          return true;
        }
      }
      for (const mi of scope.querySelectorAll('a[role="menuitem"]')) {
        const el = mi as HTMLElement;
        if (el.offsetParent === null || !el.querySelector("svg#connect-small")) continue;
        const t = (el.textContent || "").replace(/\s+/g, " ").trim();
        if (!/^conectar$/i.test(t) && !/^connect$/i.test(t)) continue;
        el.click();
        return true;
      }
    }
    return false;
  });
}

/**
 * Tras el clic en Conectar: LinkedIn abre modal o navega a `/preload/custom-invite`.
 * Antes se devolvía ok aunque no apareciera la UI de envío (perfil “quieto” sin conectar).
 */
async function completeLinkedInInviteAfterConnectClick(
  page: Page,
  note?: string
): Promise<{ ok: boolean; error?: string }> {
  const inviteUrlRe = /custom-invite|invite-send|mynetwork\/invite|\/invite\//i;

  const hasInviteSurface = async (): Promise<boolean> => {
    if (inviteUrlRe.test(page.url())) return true;
    if (await page.locator('[role="dialog"]').first().isVisible({ timeout: 700 }).catch(() => false)) {
      return true;
    }
    const modals = page.locator(".artdeco-modal, [data-test-modal-container]");
    const n = await modals.count().catch(() => 0);
    for (let i = 0; i < Math.min(n, 5); i++) {
      if (!(await modals.nth(i).isVisible({ timeout: 400 }).catch(() => false))) continue;
      const txt = (await modals.nth(i).innerText().catch(() => "")) || "";
      if (/invitación|invitation|nota|note|añadir|add a note|conectar|connect/i.test(txt)) return true;
    }
    return false;
  };

  const showsPendingOnProfile = async (): Promise<boolean> => {
    const inMain = page.locator("main");
    if (
      await inMain
        .getByRole("button", {
          name: /retirar invitación|withdraw invitation|pendiente|pending/i,
        })
        .first()
        .isVisible({ timeout: 700 })
        .catch(() => false)
    ) {
      return true;
    }
    if (
      await inMain
        .getByText(/invitación enviada|invitation sent|solicitud enviada|invitation pending/i)
        .first()
        .isVisible({ timeout: 700 })
        .catch(() => false)
    ) {
      return true;
    }
    return page.evaluate(() => {
      const m = document.querySelector("main");
      if (!m) return false;
      const t = (m.innerText || "").toLowerCase();
      return /pendiente|pending|invitación enviada|invitation sent|withdraw invitation|retirar invitación/.test(
        t
      );
    });
  };

  const deadline = Date.now() + 24000;
  let sawInvite = false;
  while (Date.now() < deadline) {
    if (await showsPendingOnProfile()) return { ok: true };
    if (await hasInviteSurface()) {
      sawInvite = true;
      break;
    }
    await randomDelay(350, 650);
  }

  if (!sawInvite) {
    if (await showsPendingOnProfile()) return { ok: true };
    return { ok: false, error: "connect_invite_flow_not_opened" };
  }

  await randomDelay(500, 1200);
  await page.waitForLoadState("domcontentloaded").catch(() => {});

  if (note) {
    const addNote = page
      .getByRole("button", {
        name: /add a note|añadir una nota|agregar nota|añadir nota|add note/i,
      })
      .first();
    if (await addNote.isVisible({ timeout: 7000 }).catch(() => false)) {
      await addNote.click({ timeout: 5000 }).catch(() => {});
      await randomDelay(400, 900);
      const field = page.locator("textarea, div[contenteditable='true']").first();
      await field.click({ timeout: 3000 }).catch(() => {});
      await field.fill(note.slice(0, 300)).catch(() => {});
    }
  }

  const trySendClick = async (): Promise<boolean> => {
    const preferSendWithoutNote = !note || !String(note).trim();

    const tryClickLoc = async (loc: Locator): Promise<boolean> => {
      const el = loc.first();
      if (!(await el.isVisible({ timeout: 2200 }).catch(() => false))) return false;
      await el.click({ timeout: 10000 }).catch(() => {});
      return true;
    };

    if (preferSendWithoutNote) {
      const globalNoNote = [
        page.getByRole("button", { name: /^Enviar sin nota$/i }),
        page.getByRole("button", { name: /^Send without a note$/i }),
        page.getByRole("button", { name: /enviar sin nota|send without a note|send without note/i }),
        page.locator("button").filter({ hasText: /^Enviar sin nota$/i }),
        page.locator("button").filter({ hasText: /^Send without a note$/i }),
      ];
      for (const loc of globalNoNote) {
        if (await tryClickLoc(loc)) return true;
      }
    }

    const scopes: Locator[] = [];
    const dlg = page.locator('[role="dialog"]');
    if (await dlg.first().isVisible({ timeout: 2500 }).catch(() => false)) {
      scopes.push(dlg.first());
    }

    const modalShells = page.locator(
      ".artdeco-modal, .artdeco-modal--layer, [data-test-modal-container], [class*='artdeco-modal__layer']"
    );
    const mn = await modalShells.count().catch(() => 0);
    for (let i = 0; i < Math.min(mn, 8); i++) {
      const shell = modalShells.nth(i);
      if (!(await shell.isVisible({ timeout: 500 }).catch(() => false))) continue;
      const txt = ((await shell.innerText().catch(() => "")) || "").toLowerCase();
      if (
        /invitación|invitation|añadir.*nota|add a note|personaliza tu invitación|personalize your invitation/i.test(
          txt
        )
      ) {
        scopes.push(shell);
      }
    }

    if (inviteUrlRe.test(page.url())) {
      scopes.push(page.locator("main").first());
    }

    const namePatternsNoNote: RegExp[] = [
      /^Enviar sin nota$/i,
      /^Send without a note$/i,
      /enviar sin nota|send without a note|send without note/i,
    ];
    const namePatternsSend = [
      /^Enviar$/i,
      /^Send$/i,
      /^Invitar$/i,
      /enviar invitación|send invitation|enviar solicitud|send now|enviar ahora/i,
    ];

    for (const scope of scopes) {
      const patterns = preferSendWithoutNote
        ? [...namePatternsNoNote, ...namePatternsSend]
        : namePatternsSend;
      for (const pat of patterns) {
        const el = scope.getByRole("button", { name: pat }).first();
        if (await tryClickLoc(el)) return true;
      }
    }

    return page.evaluate((sendWithoutOnly: boolean) => {
      const modalTextLooksLikeInvite = (el: Element): boolean => {
        const t = ((el as HTMLElement).innerText || "").toLowerCase();
        return /invitación|invitation|añadir.*nota|add a note|personaliza tu invitación|personalize your invitation/.test(
          t
        );
      };

      const roots: Element[] = [];
      for (const sel of [
        '[role="dialog"]',
        ".artdeco-modal",
        ".artdeco-modal--layer",
        "[data-test-modal-container]",
      ]) {
        for (const el of document.querySelectorAll(sel)) {
          const h = el as HTMLElement;
          if (!h.offsetParent) continue;
          if (modalTextLooksLikeInvite(el)) roots.push(el);
        }
      }
      if (roots.length === 0) {
        const d = document.querySelector('[role="dialog"]');
        if (d && (d as HTMLElement).offsetParent) roots.push(d);
      }
      if (roots.length === 0) roots.push(document.body);

      const tryButtonsIn = (root: Element): boolean => {
        const nodes = root.querySelectorAll("button, [role='button'], a[role='button']");
        const primary: HTMLElement[] = [];
        const fallback: HTMLElement[] = [];
        for (const b of nodes) {
          const el = b as HTMLElement;
          if (!el.offsetParent) continue;
          const t = (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
          const al = (el.getAttribute("aria-label") || "").toLowerCase();
          const hay = `${t} ${al}`;
          if (/cancel|cancelar|descartar|dismiss|omitir|atrás|back|guardar borrador|save draft/i.test(hay)) {
            continue;
          }
          if (sendWithoutOnly && /^enviar sin nota$/i.test(t)) {
            primary.push(el);
            continue;
          }
          if (sendWithoutOnly && /send without a note|send without note/i.test(hay)) {
            primary.push(el);
            continue;
          }
          if (
            /^enviar$/i.test(t) ||
            /^send$/i.test(t) ||
            /^invitar$/i.test(t) ||
            /enviar invitación|send invitation|enviar sin nota|send without/i.test(hay)
          ) {
            fallback.push(el);
          }
        }
        const pick = primary[0] ?? fallback[0];
        if (pick) {
          pick.scrollIntoView({ block: "nearest", inline: "nearest" });
          pick.click();
          return true;
        }
        return false;
      };

      for (const r of roots) {
        if (tryButtonsIn(r)) return true;
      }
      return false;
    }, preferSendWithoutNote);
  };

  const sent = await trySendClick();
  if (!sent) return { ok: false, error: "connect_send_button_missing" };

  await randomDelay(2000, 5000);
  return { ok: true };
}

export async function sendConnectionRequest(
  page: Page,
  profileUrl: string,
  note?: string
): Promise<ActionResult> {
  await visitProfile(page, profileUrl, { light: true });
  await ensureProfilePageLoaded(page, profileUrl);
  await scrollProfileTopCardIntoView(page);
  await randomDelay(500, 1200);
  const g = await guardSoftban(page);
  if (g) return g;

  let clicked = await clickConnectRobust(page);

  if (!clicked) {
    const opened = await openProfileOverflowMenu(page);
    if (opened) {
      clicked = await clickConnectInOpenDropdown(page);
      if (!clicked) clicked = await clickConnectRobust(page);
    }
  }

  if (!clicked) {
    const bar = profileTopActionBar(page);
    const bar2 = profileTopActionBarFallback(page);
    const barW = profileTopActionBarWide(page);
    let more = bar.getByRole("button", { name: /^Más$|^More$|more|más/i }).first();
    if (!(await more.isVisible({ timeout: 600 }).catch(() => false))) {
      more = bar2.getByRole("button", { name: /^Más$|^More$|more|más/i }).first();
    }
    if (!(await more.isVisible({ timeout: 600 }).catch(() => false))) {
      more = barW.getByRole("button", { name: /^Más$|^More$|more|más/i }).first();
    }
    if (await more.isVisible({ timeout: 4000 }).catch(() => false)) {
      await more
        .evaluate((node) =>
          (node as HTMLElement).scrollIntoView({ block: "nearest", inline: "nearest" })
        )
        .catch(() => {});
      await more.click({ timeout: 5000 }).catch(() => {});
      clicked = await clickConnectInOpenDropdown(page);
      if (!clicked) clicked = await clickConnectRobust(page);
    }
  }

  if (!clicked) {
    const g2 = await guardSoftban(page);
    if (g2) return g2;
    return { ok: false, error: "connect_button_missing" };
  }

  await randomDelay(500, 1100);
  if (navigatedToFeedOrActivity(page.url())) {
    await visitProfile(page, profileUrl, { light: true });
    await ensureProfilePageLoaded(page, profileUrl);
    await scrollProfileTopCardIntoView(page);
    const gx = await guardSoftban(page);
    if (gx) return gx;
    return { ok: false, error: "connect_wrong_click_opened_feed" };
  }

  await randomDelay(200, 500);
  const done = await completeLinkedInInviteAfterConnectClick(page, note);
  if (!done.ok) {
    const g3 = await guardSoftban(page);
    if (g3) return g3;
    return { ok: false, error: done.error ?? "connect_invite_failed" };
  }

  await randomDelay(1500, 3500);
  const g4 = await guardSoftban(page);
  if (g4) return g4;
  return { ok: true };
}

export type SendMessageToProfileOptions = {
  /** Tras `visit_profile`: ya estamos en el lead; evita otro goto. */
  skipProfileVisit?: boolean;
};

async function clickProfileMessageButton(page: Page): Promise<boolean> {
  const roots = [profileTopActionBar(page), profileTopActionBarFallback(page), profileTopActionBarWide(page)];
  const patterns = [
    /^(Message|Mensaje|Enviar mensaje)$/i,
    /message|mensaje|enviar mensaje|inmail/i,
  ];
  for (const root of roots) {
    if (!(await root.isVisible({ timeout: 600 }).catch(() => false))) continue;
    for (const pat of patterns) {
      const b = root.getByRole("button", { name: pat }).first();
      if (await b.isVisible({ timeout: 1200 }).catch(() => false)) {
        await b.scrollIntoViewIfNeeded().catch(() => {});
        await b.click({ timeout: 6000 }).catch(() => {});
        return true;
      }
      const l = root.getByRole("link", { name: pat }).first();
      if (await l.isVisible({ timeout: 800 }).catch(() => false)) {
        await l.click({ timeout: 6000 }).catch(() => {});
        return true;
      }
    }
  }

  const inMain = page.locator("main");
  for (const pat of patterns) {
    const b = inMain.getByRole("button", { name: pat }).first();
    if (await b.isVisible({ timeout: 1500 }).catch(() => false)) {
      await b.scrollIntoViewIfNeeded().catch(() => {});
      await b.click({ timeout: 6000 }).catch(() => {});
      return true;
    }
  }

  const opened = await openProfileOverflowMenu(page);
  if (opened) {
    const mi = page.getByRole("menuitem", { name: /message|mensaje|enviar mensaje|inmail/i }).first();
    if (await mi.isVisible({ timeout: 4000 }).catch(() => false)) {
      await mi.click({ timeout: 6000 }).catch(() => {});
      return true;
    }
  }
  return false;
}

async function openMessagingComposeFromProfile(
  page: Page,
  profileUrl: string,
  skipProfileVisit?: boolean
): Promise<ActionResult | null> {
  if (!skipProfileVisit) {
    await visitProfile(page, profileUrl, { light: true });
    await ensureProfilePageLoaded(page, profileUrl);
  } else {
    await ensureProfilePageLoaded(page, profileUrl);
  }
  await scrollProfileTopCardIntoView(page);
  await randomDelay(500, 1200);
  const g = await guardSoftban(page);
  if (g) return g;
  if (!(await clickProfileMessageButton(page))) {
    const g2 = await guardSoftban(page);
    if (g2) return g2;
    return { ok: false, error: "message_button_missing" };
  }
  await randomDelay(2000, 5000);
  return null;
}

export async function sendMessageToProfile(
  page: Page,
  profileUrl: string,
  text: string,
  options?: SendMessageToProfileOptions
): Promise<ActionResult> {
  const openErr = await openMessagingComposeFromProfile(page, profileUrl, options?.skipProfileVisit);
  if (openErr) return openErr;

  const box = page.locator(".msg-form__contenteditable, div[role='textbox']").first();
  await box.waitFor({ state: "visible", timeout: 20000 }).catch(() => {});
  await box.click({ timeout: 10000 }).catch(() => {});
  await box.fill(text.slice(0, 8000));
  await randomDelay(800, 2000);
  const send = page.getByRole("button", {
    name: /^send$|^enviar$|^enviar ahora$/i,
  }).first();
  if (await send.isVisible({ timeout: 6000 }).catch(() => false)) {
    await send.click({ timeout: 8000 }).catch(() => {});
  } else {
    await page.keyboard.press("Enter").catch(() => {});
  }
  await randomDelay(3000, 6000);
  const g2 = await guardSoftban(page);
  if (g2) return g2;
  return { ok: true };
}

/** Igual que `sendMessageToProfile` pero asume que el paso anterior ya abrió el perfil (ahorra navegación). */
export async function sendMessageToOpenProfile(
  page: Page,
  profileUrl: string,
  text: string
): Promise<ActionResult> {
  return sendMessageToProfile(page, profileUrl, text, { skipProfileVisit: true });
}

/** URL de hilo o solo el id (segmento de `/messaging/thread/...`). */
export function normalizeMessagingThreadInput(raw: string | null | undefined): { threadUrl: string; conversationId: string } {
  const t = String(raw ?? "").trim();
  if (!t) return { threadUrl: "", conversationId: "" };
  if (/^https?:\/\//i.test(t)) {
    const noQuery = t.split("?")[0] ?? t;
    const m = noQuery.match(/\/messaging\/thread\/([^/?#]+)/i);
    const id = m?.[1] ? decodeURIComponent(m[1]) : noQuery;
    const base = noQuery.match(/^(https?:\/\/[^/]+\/messaging\/thread\/[^/?#]+)/i)?.[1];
    const threadUrl = base
      ? base.endsWith("/")
        ? base
        : `${base}/`
      : noQuery.endsWith("/")
        ? noQuery
        : `${noQuery}/`;
    return { threadUrl, conversationId: id };
  }
  const id = t.replace(/\s/g, "");
  return {
    threadUrl: `https://www.linkedin.com/messaging/thread/${encodeURIComponent(id)}/`,
    conversationId: id,
  };
}

/**
 * Abre un hilo existente en /messaging/thread/… y envía texto (respuesta inbox / reply_dm).
 */
export async function sendMessageInMessagingThread(page: Page, threadIdOrUrl: string, text: string): Promise<ActionResult> {
  const { threadUrl, conversationId } = normalizeMessagingThreadInput(threadIdOrUrl);
  if (!threadUrl || !conversationId) {
    return { ok: false, error: "invalid_thread_reference" };
  }
  await page.goto(threadUrl, { waitUntil: "domcontentloaded", timeout: 90000 });
  await randomDelay(900, 2000);
  const g = await guardSoftban(page);
  if (g) return g;

  const box = page.locator(".msg-form__contenteditable, div[role='textbox']").first();
  await box.waitFor({ state: "visible", timeout: 25000 }).catch(() => {});
  await box.click({ timeout: 10000 }).catch(() => {});
  await box.fill(text.slice(0, 8000));
  await randomDelay(600, 1500);
  const send = page.getByRole("button", {
    name: /^send$|^enviar$|^enviar ahora$/i,
  }).first();
  if (await send.isVisible({ timeout: 8000 }).catch(() => false)) {
    await send.click({ timeout: 10000 }).catch(() => {});
  } else {
    await page.keyboard.press("Enter").catch(() => {});
  }
  await randomDelay(2500, 5000);
  const g2 = await guardSoftban(page);
  if (g2) return g2;
  return { ok: true };
}

/**
 * Sube un audio al hilo de mensajes (ruta local accesible por el worker).
 * Requiere UI de adjuntos compatible; si no hay `input[type=file]`, falla con `voice_note_file_input_missing`.
 */
export async function sendVoiceNoteToProfile(
  page: Page,
  profileUrl: string,
  audioFilePath: string,
  options?: SendMessageToProfileOptions
): Promise<ActionResult> {
  const openErr = await openMessagingComposeFromProfile(page, profileUrl, options?.skipProfileVisit);
  if (openErr) return openErr;

  const inputs = page.locator('input[type="file"]');
  const n = await inputs.count();
  let attached = false;
  for (let i = 0; i < n; i++) {
    const inp = inputs.nth(i);
    const acc = ((await inp.getAttribute("accept")) || "").toLowerCase();
    if (acc === "" || /audio|video|\*|mpeg|mp4|webm|ogg|wav|m4a/.test(acc)) {
      try {
        await inp.setInputFiles(audioFilePath);
        attached = true;
        break;
      } catch {
        /* siguiente input */
      }
    }
  }
  if (!attached) {
    const g = await guardSoftban(page);
    if (g) return g;
    return { ok: false, error: "voice_note_file_input_missing" };
  }
  await randomDelay(3000, 9000);
  const send = page.getByRole("button", { name: /^send$|^enviar$|^enviar ahora$/i }).first();
  await send.click({ timeout: 20000 }).catch(() => {});
  await randomDelay(2000, 5000);
  const g2 = await guardSoftban(page);
  if (g2) return g2;
  return { ok: true };
}

/**
 * InMail / mensaje con asunto (Open Profile, Sales Navigator, etc.).
 * Si no aparece campo de asunto, devuelve `inmail_subject_field_missing`.
 */
export async function sendInMailToProfile(
  page: Page,
  profileUrl: string,
  subject: string,
  body: string,
  options?: SendMessageToProfileOptions
): Promise<ActionResult> {
  const openErr = await openMessagingComposeFromProfile(page, profileUrl, options?.skipProfileVisit);
  if (openErr) return openErr;

  const subj = page
    .locator(
      'input[placeholder*="Subject" i], input[placeholder*="Asunto" i], input[aria-label*="Subject" i], input[aria-label*="Asunto" i], input[name*="subject" i]'
    )
    .first();
  if (await subj.isVisible({ timeout: 8000 }).catch(() => false)) {
    await subj.fill(subject.slice(0, 200)).catch(() => {});
  } else {
    const g = await guardSoftban(page);
    if (g) return g;
    return { ok: false, error: "inmail_subject_field_missing" };
  }

  const box = page.locator(".msg-form__contenteditable, div[role='textbox']").first();
  await box.click({ timeout: 8000 }).catch(() => {});
  await box.fill(body.slice(0, 8000));
  await randomDelay(600, 1500);
  const send = page.getByRole("button", { name: /^send$|^enviar$|^enviar ahora$/i }).first();
  if (await send.isVisible({ timeout: 8000 }).catch(() => false)) {
    await send.click({ timeout: 12000 }).catch(() => {});
  }
  await randomDelay(2500, 5500);
  const g2 = await guardSoftban(page);
  if (g2) return g2;
  return { ok: true };
}

/**
 * Responde a un comentario en la primera publicación visible del perfil (Reply / Responder).
 */
export async function replyToCommentOnLeadRecentPost(
  page: Page,
  profileUrl: string,
  replyText: string
): Promise<ActionResult> {
  const r = await visitProfile(page, profileUrl, { light: true });
  if (!r.ok || r.softban) return r;
  await ensureProfilePageLoaded(page, profileUrl);
  await scrollProfileTopCardIntoView(page);
  await randomDelay(500, 1200);
  const g = await guardSoftban(page);
  if (g) return g;
  await openProfilePostsSection(page);

  const inMain = page.locator("main");
  const card = inMain.locator(".feed-shared-update-v2").first();
  await card.waitFor({ state: "visible", timeout: 22000 }).catch(() => {});

  let opened = await page.evaluate(() => {
    const root = document.querySelector("main");
    if (!root) return false;
    const c = root.querySelector(".feed-shared-update-v2");
    if (!c) return false;
    for (const b of c.querySelectorAll("button")) {
      const el = b as HTMLButtonElement;
      if (!el.offsetParent) continue;
      const lb = (el.getAttribute("aria-label") || "").toLowerCase();
      if (/comment|comentar|open comments|ver comentarios/i.test(lb)) {
        el.click();
        return true;
      }
    }
    return false;
  });
  if (!opened) {
    const cb = card.getByRole("button", { name: /Comment|Comentar|comments/i }).first();
    if (await cb.isVisible({ timeout: 7000 }).catch(() => false)) {
      await cb.click({ timeout: 5000 }).catch(() => {});
      opened = true;
    }
  }
  if (!opened) {
    const gx = await guardSoftban(page);
    if (gx) return gx;
    return { ok: false, error: "comment_button_missing" };
  }
  await randomDelay(1000, 2000);

  const replyClicked = await page.evaluate(() => {
    const c = document.querySelector("main .feed-shared-update-v2");
    if (!c) return false;
    const candidates: HTMLElement[] = [];
    for (const b of c.querySelectorAll("button, a[role='button']")) {
      const el = b as HTMLElement;
      if (!el.offsetParent) continue;
      const t = (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
      const al = (el.getAttribute("aria-label") || "").toLowerCase();
      const hay = `${t} ${al}`;
      if (/reply privately|responder por privado|message/i.test(hay) && !/reply$/i.test(t)) continue;
      if (/^reply$/i.test(t) || /^responder$/i.test(t) || /\breply\b/i.test(al) || /\bresponder\b/i.test(al)) {
        candidates.push(el);
      }
    }
    if (candidates.length === 0) return false;
    const pick = candidates.length > 1 ? candidates[1]! : candidates[0]!;
    pick.click();
    return true;
  });

  if (!replyClicked) {
    const r1 = card.getByRole("button", { name: /Reply|Responder/i }).nth(1);
    const r0 = card.getByRole("button", { name: /Reply|Responder/i }).first();
    if (await r1.isVisible({ timeout: 4000 }).catch(() => false)) {
      await r1.click({ timeout: 5000 }).catch(() => {});
    } else if (await r0.isVisible({ timeout: 3000 }).catch(() => false)) {
      await r0.click({ timeout: 5000 }).catch(() => {});
    } else {
      const gx = await guardSoftban(page);
      if (gx) return gx;
      return { ok: false, error: "reply_button_missing" };
    }
  }

  await randomDelay(600, 1200);
  const body = replyText.trim().slice(0, 3000);
  const editors = [
    page.locator(".comments-inline-reply textarea, .comments-inline-reply [contenteditable='true']"),
    card.locator(".comments-inline-reply textarea, .comments-inline-reply [contenteditable='true']"),
    page.locator(".comments-comment-box--reply textarea, .comments-comment-box--reply [contenteditable='true']"),
    page.locator(".comments-comment-box textarea").first(),
  ];
  let filled = false;
  for (const ed of editors) {
    const t = ed.first();
    if (!(await t.isVisible({ timeout: 2800 }).catch(() => false))) continue;
    const tag = (await t.evaluate((n) => n.tagName).catch(() => "")) || "";
    if (tag.toLowerCase() === "textarea") {
      await t.fill(body).catch(() => {});
    } else {
      await t.click({ timeout: 3000 }).catch(() => {});
      await t
        .evaluate((el, txt) => {
          (el as HTMLElement).textContent = txt;
          el.dispatchEvent(new Event("input", { bubbles: true }));
        }, body)
        .catch(() => {});
    }
    filled = true;
    break;
  }
  if (!filled) {
    const gx = await guardSoftban(page);
    if (gx) return gx;
    return { ok: false, error: "reply_editor_missing" };
  }
  await randomDelay(400, 800);
  const postBtn = page.getByRole("button", { name: /^Post$|^Publicar$|^Responder$|^Reply$/i }).first();
  if (await postBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
    await postBtn.click({ timeout: 6000 }).catch(() => {});
  } else {
    await page.keyboard.press("Enter").catch(() => {});
  }
  await randomDelay(2000, 4500);
  const g2 = await guardSoftban(page);
  if (g2) return g2;
  return { ok: true };
}

async function openProfilePostsSection(page: Page): Promise<void> {
  const fast = process.env.LINKEDIN_FAST_AUTOMATION === "true";
  const main = page.locator("main");
  const tabs = main.getByRole("tab", { name: /Posts|Publicaciones|Activity|Actividad/i });
  const n = await tabs.count().catch(() => 0);
  for (let i = 0; i < Math.min(n, 6); i++) {
    const t = tabs.nth(i);
    if (await t.isVisible({ timeout: 1500 }).catch(() => false)) {
      await t.click({ timeout: 5000 }).catch(() => {});
      await randomDelay(fast ? 400 : 1000, fast ? 900 : 2400);
      break;
    }
  }
  await page.evaluate(() => window.scrollTo(0, Math.min(480, document.body.scrollHeight * 0.15)));
  await randomDelay(fast ? 400 : 900, fast ? 800 : 2000);
}

/** Da «Me gusta» a la primera publicación visible en el perfil del lead. */
export async function likeLeadRecentPost(page: Page, profileUrl: string): Promise<ActionResult> {
  const r = await visitProfile(page, profileUrl, { light: true });
  if (!r.ok || r.softban) return r;
  await ensureProfilePageLoaded(page, profileUrl);
  await scrollProfileTopCardIntoView(page);
  await randomDelay(500, 1200);
  await openProfilePostsSection(page);

  const inMain = page.locator("main");
  await inMain
    .locator(".feed-shared-update-v2")
    .first()
    .waitFor({ state: "visible", timeout: 22000 })
    .catch(() => {});

  let clicked = await page.evaluate(() => {
    const root = document.querySelector("main");
    if (!root) return false;
    const cards = root.querySelectorAll(".feed-shared-update-v2");
    for (const card of cards) {
      const btns = card.querySelectorAll("button");
      for (const b of btns) {
        const el = b as HTMLButtonElement;
        if (el.offsetParent === null) continue;
        if (el.getAttribute("aria-pressed") === "true") continue;
        const label = (el.getAttribute("aria-label") || "").toLowerCase();
        if (/ya no me gusta|unlike|remove your like|quita tu reacción/.test(label)) continue;
        if (/comment|comentar|share|compartir|send|enviar/.test(label) && !/like|gusta|reaccionar/i.test(label))
          continue;
        if (/like|me gusta|reaccionar|react/i.test(label)) {
          el.click();
          return true;
        }
        const t = (el.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
        if (t === "like" || t === "me gusta") {
          el.click();
          return true;
        }
      }
    }
    return false;
  });

  if (!clicked) {
    const card = inMain.locator(".feed-shared-update-v2").first();
    const likeBtn = card.getByRole("button", { name: /Like|Me gusta|Reaccionar|React/i }).first();
    if (await likeBtn.isVisible({ timeout: 6000 }).catch(() => false)) {
      await likeBtn.click({ timeout: 6000 }).catch(() => {});
      clicked = true;
    }
  }

  if (!clicked) {
    const g = await guardSoftban(page);
    if (g) return g;
    return { ok: false, error: "like_button_missing" };
  }

  await randomDelay(1200, 2800);
  const g = await guardSoftban(page);
  if (g) return g;
  return { ok: true };
}

/** Comenta la primera publicación visible en el perfil (texto ya sustituido por el worker). */
export async function commentLeadRecentPost(page: Page, profileUrl: string, commentText: string): Promise<ActionResult> {
  const r = await visitProfile(page, profileUrl, { light: true });
  if (!r.ok || r.softban) return r;
  await ensureProfilePageLoaded(page, profileUrl);
  await scrollProfileTopCardIntoView(page);
  await randomDelay(500, 1200);
  await openProfilePostsSection(page);

  const inMain = page.locator("main");
  await inMain.locator(".feed-shared-update-v2").first().waitFor({ state: "visible", timeout: 22000 }).catch(() => {});

  let opened = await page.evaluate(() => {
    const root = document.querySelector("main");
    if (!root) return false;
    const card = root.querySelector(".feed-shared-update-v2");
    if (!card) return false;
    for (const b of card.querySelectorAll("button")) {
      const el = b as HTMLButtonElement;
      if (el.offsetParent === null) continue;
      const label = (el.getAttribute("aria-label") || "").toLowerCase();
      if (/comment|comentar|open comments|ver comentarios|add a comment/i.test(label)) {
        el.click();
        return true;
      }
    }
    return false;
  });

  if (!opened) {
    const c = inMain.locator(".feed-shared-update-v2").first().getByRole("button", { name: /Comment|Comentar/i }).first();
    if (await c.isVisible({ timeout: 7000 }).catch(() => false)) {
      await c.click({ timeout: 5000 }).catch(() => {});
      opened = true;
    }
  }

  if (!opened) {
    const g = await guardSoftban(page);
    if (g) return g;
    return { ok: false, error: "comment_button_missing" };
  }

  await randomDelay(900, 1800);

  const text = commentText.trim().slice(0, 3000);
  const editor = page
    .locator(".comments-comment-box textarea, .comments-comment-texteditor textarea, .comments-comment-box__form textarea")
    .first();
  const rich = page
    .locator(".comments-comment-box [contenteditable='true'], .comments-comment-texteditor [contenteditable='true']")
    .first();

  if (await editor.isVisible({ timeout: 9000 }).catch(() => false)) {
    await editor.fill(text);
  } else if (await rich.isVisible({ timeout: 6000 }).catch(() => false)) {
    await rich.click({ timeout: 4000 }).catch(() => {});
    await rich.evaluate((el, t) => {
      el.textContent = t;
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }, text);
  } else {
    const g = await guardSoftban(page);
    if (g) return g;
    return { ok: false, error: "comment_editor_missing" };
  }

  await randomDelay(400, 900);

  const postBtn = page.getByRole("button", { name: /^Post$|^Publicar$|^Comentar$/i }).first();
  if (await postBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
    await postBtn.click({ timeout: 6000 }).catch(() => {});
  } else {
    await page.keyboard.press("Enter").catch(() => {});
  }

  await randomDelay(2000, 4500);
  const g2 = await guardSoftban(page);
  if (g2) return g2;
  return { ok: true };
}

export async function publishPost(
  page: Page,
  content: string,
  imagePath?: string
): Promise<ActionResult> {
  await randomDelay(10000, 25000);
  await page.goto("https://www.linkedin.com/feed/", { waitUntil: "domcontentloaded", timeout: 90000 });
  const g = await guardSoftban(page);
  if (g) return g;

  const start = page.getByRole("button", { name: /start a post|crear publicación/i }).first();
  await start.click({ timeout: 15000 }).catch(async () => {
    await page.getByText(/start a post/i).first().click({ timeout: 8000 });
  });
  await randomDelay(2000, 5000);

  const editor = page.locator(".ql-editor, [data-placeholder*='What']").first();
  await editor.click({ timeout: 10000 });
  await editor.fill(content);

  if (imagePath) {
    const fileInput = page.locator('input[type="file"]').first();
    if (await fileInput.count()) {
      await fileInput.setInputFiles(imagePath);
      await randomDelay(5000, 12000);
    }
  }

  await randomDelay(2000, 5000);
  const postBtn = page.getByRole("button", { name: /post$/i }).first();
  await postBtn.click({ timeout: 15000 }).catch(() => {});

  await randomDelay(5000, 10000);
  const g2 = await guardSoftban(page);
  if (g2) return g2;
  return { ok: true };
}

export async function sessionWarmup(page: Page, randomProfileUrl?: string): Promise<ActionResult> {
  const r = await openFeed(page);
  if (!r.ok) return r;
  if (randomProfileUrl) {
    return visitProfile(page, randomProfileUrl, { light: true });
  }
  return { ok: true };
}
