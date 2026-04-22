import type { ProjectConfig, WidgetModule, WidgetResult } from './types.ts';
import { errorCard } from './render.ts';

export const DEFAULT_WIDGET_TIMEOUT_MS = 20_000;

export async function runWithTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function safeRun(
  widget: WidgetModule,
  project: ProjectConfig,
  timeoutMs: number = DEFAULT_WIDGET_TIMEOUT_MS,
): Promise<WidgetResult> {
  try {
    return await runWithTimeout(widget.run(project), timeoutMs, `widget ${widget.id}`);
  } catch (e) {
    return { html: errorCard(widget.title, (e as Error).message) };
  }
}
