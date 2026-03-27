import type { BrowserContext, Page } from "playwright";
import fs from "fs/promises";
import path from "path";

export async function enrichWorkerFailureMessage(base: string, taskId: string, page?: Page | null): Promise<string> {
  const trimmed = base.trim().slice(0, 400);
  if (!page) return trimmed.slice(0, 500);
  let url = "";
  try {
    url = page.url() || "";
  } catch {
    url = "";
  }
  const dir = (process.env.TASK_ARTIFACTS_DIR ?? "").trim() || (process.env.PLAYWRIGHT_TRACE_DIR ?? "").trim();
  let suffix = url ? ` @ ${url.slice(0, 160)}` : "";
  if (dir) {
    try {
      await fs.mkdir(dir, { recursive: true });
      const fn = `fail-${String(taskId).slice(0, 8)}-${Date.now()}.png`;
      const fp = path.join(dir, fn);
      await page.screenshot({ path: fp, fullPage: false }).catch(() => {});
      suffix += ` ss=${fn}`;
    } catch {
      /* ignore */
    }
  }
  return (trimmed + suffix).slice(0, 500);
}

export type TraceController = {
  stopDiscard: () => Promise<void>;
  stopSaveFailure: () => Promise<void>;
};

export async function startPlaywrightTraceIfConfigured(
  context: BrowserContext,
  taskId: string,
  action: string
): Promise<TraceController | null> {
  const dir = process.env.PLAYWRIGHT_TRACE_DIR?.trim();
  if (!dir) return null;
  await fs.mkdir(dir, { recursive: true });
  const stamp = `${String(taskId).slice(0, 8)}-${action}-${Date.now()}`;
  const outZip = path.join(dir, `${stamp}.zip`);
  await context.tracing.start({ screenshots: true, snapshots: true });
  return {
    stopDiscard: async () => {
      try {
        await context.tracing.stop();
      } catch {
        /* ignore */
      }
    },
    stopSaveFailure: async () => {
      try {
        await context.tracing.stop({ path: outZip });
      } catch {
        try {
          await context.tracing.stop();
        } catch {
          /* ignore */
        }
      }
    },
  };
}
