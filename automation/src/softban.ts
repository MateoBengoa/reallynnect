import type { Page } from "playwright";

export type SoftbanSignal = "ok" | "suspected";

export async function detectSoftban(page: Page): Promise<SoftbanSignal> {
  const url = page.url();
  const title = await page.title().catch(() => "");

  const urlLower = url.toLowerCase();
  const titleLower = title.toLowerCase();

  if (
    urlLower.includes("checkpoint") ||
    urlLower.includes("challenge") ||
    titleLower.includes("captcha") ||
    titleLower.includes("security")
  ) {
    return "suspected";
  }

  const body = await page
    .locator("body")
    .innerText()
    .catch(() => "");

  const b = body.toLowerCase();
  if (
    b.includes("temporarily restricted") ||
    b.includes("unusual activity") ||
    b.includes("verify you are human")
  ) {
    return "suspected";
  }

  return "ok";
}
