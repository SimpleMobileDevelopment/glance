import { createHash } from 'node:crypto';
import Anthropic from '@anthropic-ai/sdk';
import type { ProjectConfig, WidgetModule, WidgetResult } from '../types.ts';
import { card, errorCard, escape } from '../render.ts';
import { safeRun } from '../runtime.ts';
import { memoize } from '../cache.ts';

const MODEL = 'claude-haiku-4-5-20251001';
const PLAN_TTL_MS = 15 * 60_000;

// Registry imports morningPlan, and morningPlan needs REGISTRY to enumerate
// enabled widgets — so we resolve the registry lazily at run time via dynamic
// import. This breaks the otherwise-circular dependency. We also explicitly
// skip the morningPlan entry itself to prevent infinite recursion if the
// enable-check ever allows it.
async function collectSummaries(project: ProjectConfig): Promise<Record<string, unknown>> {
  const { REGISTRY } = await import('../registry.ts');
  const widgetsConfig = project.widgets ?? {};
  const candidates = REGISTRY.filter(w => w.id !== 'morningPlan' && w.id in widgetsConfig);
  const results = await Promise.all(candidates.map(w => safeRun(w, project)));
  const out: Record<string, unknown> = {};
  for (let i = 0; i < candidates.length; i++) {
    const s = results[i].summary;
    if (s !== undefined && s !== null) {
      out[candidates[i].id] = s;
    }
  }
  return out;
}

function buildSystemPrompt(): string {
  return `You are a terse morning briefer for a software engineer. Given a JSON snapshot of their current work (pending PRs, CI state, Linear issues/inbox, meetings), produce a focused morning plan in exactly 3 sentences. The first sentence must name the single most important thing to do first. No preamble, no bullet list, no markdown fences, no sign-off. Plain prose only.`;
}

async function callClaude(apiKey: string, snapshot: Record<string, unknown>): Promise<string> {
  const client = new Anthropic({ apiKey });
  const userMessage = 'Current snapshot:\n\n```json\n' + JSON.stringify(snapshot, null, 2) + '\n```\n\nWrite the morning plan.';
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 400,
    system: [{ type: 'text', text: buildSystemPrompt(), cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: userMessage }],
  });
  return response.content
    .filter(b => b.type === 'text')
    .map(b => (b as Anthropic.TextBlock).text)
    .join('')
    .trim();
}

function hashSnapshot(snapshot: Record<string, unknown>): string {
  return createHash('sha1').update(JSON.stringify(snapshot)).digest('hex').slice(0, 16);
}

async function run(project: ProjectConfig): Promise<WidgetResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return { html: errorCard('Morning plan', 'Set ANTHROPIC_API_KEY in .env to enable the morning plan.') };
  }

  let snapshot: Record<string, unknown>;
  try {
    snapshot = await collectSummaries(project);
  } catch (e) {
    return { html: errorCard('Morning plan', `Could not collect widget summaries: ${(e as Error).message}`) };
  }

  if (Object.keys(snapshot).length === 0) {
    return { html: card('Morning plan', `<p class="muted">No widget summaries available yet — configure ci / linear / prs / calendar first.</p>`) };
  }

  try {
    const key = `morningPlan:${hashSnapshot(snapshot)}`;
    const plan = await memoize<string>({
      key,
      ttlMs: PLAN_TTL_MS,
      fetchFresh: () => callClaude(apiKey, snapshot),
    });
    const body = `<p>${escape(plan).replace(/\n+/g, '<br/>')}</p>`;
    return { html: card('Morning plan', body) };
  } catch (e) {
    return { html: errorCard('Morning plan', (e as Error).message) };
  }
}

export const morningPlan: WidgetModule = {
  id: 'morningPlan',
  title: 'Morning plan',
  envVars: ['ANTHROPIC_API_KEY'],
  run,
};
