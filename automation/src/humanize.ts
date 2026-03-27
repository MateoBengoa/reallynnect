import type { Page } from "playwright";

/** Acorta pausas cuando el worker exporta LINKEDIN_FAST_AUTOMATION=true (desarrollo local). */
function linkedInFast(): boolean {
  return process.env.LINKEDIN_FAST_AUTOMATION === "true";
}

export async function randomDelay(minMs: number, maxMs: number): Promise<void> {
  let min = minMs;
  let max = maxMs;
  if (linkedInFast()) {
    min = Math.min(min, 250);
    max = Math.min(Math.max(max, min), 2000);
  }
  const ms = Math.floor(Math.random() * (max - min + 1)) + min;
  await new Promise((r) => setTimeout(r, ms));
}

export async function humanScroll(page: Page, durationMs: number): Promise<void> {
  const cap = linkedInFast() ? Math.min(durationMs, 5000) : durationMs;
  const start = Date.now();
  while (Date.now() - start < cap) {
    const delta = 200 + Math.random() * 400;
    await page.mouse.wheel(0, delta);
    await randomDelay(200, 800);
  }
}

export async function lightMouseJitter(page: Page): Promise<void> {
  const vp = page.viewportSize();
  if (!vp) return;
  for (let i = 0; i < 3; i++) {
    const x = Math.random() * vp.width * 0.8 + vp.width * 0.1;
    const y = Math.random() * vp.height * 0.8 + vp.height * 0.1;
    await page.mouse.move(x, y, { steps: 5 + Math.floor(Math.random() * 10) });
    await randomDelay(100, 400);
  }
}
