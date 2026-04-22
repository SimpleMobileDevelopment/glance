import { readFile, writeFile } from 'node:fs/promises';
import Anthropic from '@anthropic-ai/sdk';
import Parser from 'rss-parser';
import type { ProjectConfig, WidgetModule, Hero } from '../types.ts';
import { card, errorCard, escape, relTime, truncatedList, type Tone } from '../render.ts';

type AlertsConfig = {
  stack?: string[];
  model?: string;
  maxItems?: number;
};

type FeedRef = { name: string; url: string };
type FeedConfigRef = { feeds?: FeedRef[] };

type FeedItem = {
  url: string;
  title: string;
  description: string;
  source: string;
  pubDate: string;
};

type Classification = {
  url: string;
  actionable: boolean;
  action: string | null;
};

type CachedClassification = Classification & {
  classifiedAt: string;
  title: string;
  source: string;
  pubDate: string;
};

type Cache = Record<string, CachedClassification>;

const CACHE_FILE = '.alerts-cache.json';
const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';
const MAX_ITEMS_DEFAULT = 25;

async function loadCache(): Promise<Cache> {
  try {
    const raw = await readFile(CACHE_FILE, 'utf8');
    return JSON.parse(raw) as Cache;
  } catch {
    return {};
  }
}

async function saveCache(cache: Cache): Promise<void> {
  await writeFile(CACHE_FILE, JSON.stringify(cache, null, 2), 'utf8');
}

async function fetchFeedItems(sources: FeedRef[]): Promise<FeedItem[]> {
  const parser: Parser = new Parser({ timeout: 10_000 });
  const items: FeedItem[] = [];
  await Promise.all(sources.map(async ({ name, url }) => {
    try {
      const f = await parser.parseURL(url);
      for (const it of f.items.slice(0, 10)) {
        if (!it.link || !it.title) continue;
        const desc = String(it.contentSnippet ?? it.summary ?? it.content ?? '')
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 400);
        items.push({
          url: it.link,
          title: it.title,
          description: desc,
          source: name,
          pubDate: String(it.isoDate ?? it.pubDate ?? ''),
        });
      }
    } catch {
      // failed feeds silently skipped — the feed widget will surface those errors
    }
  }));
  items.sort((a, b) => b.pubDate.localeCompare(a.pubDate));
  return items;
}

function buildSystemPrompt(stack: string[]): string {
  return `You are a release-notes triage assistant for a software development team.

The team's stack and concerns:
${stack.map(s => `- ${s}`).join('\n')}

Your job: for each article (title + description) provided, decide whether it requires the team to take action — update a dependency, change a setting, comply with a new requirement, fix a deprecation, address a security advisory, etc.

Return JSON only. No prose, no markdown fences. Format:
{
  "items": [
    { "url": "...", "actionable": true,  "action": "verb-first one-sentence todo (max 90 chars)" },
    { "url": "...", "actionable": false, "action": null }
  ]
}

Be strict: ONLY mark actionable when the article describes something the team should DO that affects their stack as listed. Marketing announcements, general industry news, conceptual blog posts, and tangentially related items → actionable: false. When in doubt, choose false.`;
}

async function classify(
  client: Anthropic,
  model: string,
  systemPrompt: string,
  items: FeedItem[],
): Promise<Classification[]> {
  if (items.length === 0) return [];

  const userMessage = 'Articles:\n\n' + items.map((it, i) =>
    `[${i + 1}]\nURL: ${it.url}\nTitle: ${it.title}\nDescription: ${it.description}`
  ).join('\n\n');

  const response = await client.messages.create({
    model,
    max_tokens: 2048,
    system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: userMessage }],
  });

  const text = response.content
    .filter(b => b.type === 'text')
    .map(b => (b as Anthropic.TextBlock).text)
    .join('');
  const jsonText = text.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '').trim();
  const parsed = JSON.parse(jsonText) as { items: Classification[] };
  return parsed.items ?? [];
}

async function render(project: ProjectConfig): Promise<{ html: string; hero?: Hero }> {
  const config = (project.widgets.alerts ?? {}) as AlertsConfig;
  const stack = config.stack ?? [];
  const model = config.model ?? DEFAULT_MODEL;
  const maxItems = config.maxItems ?? MAX_ITEMS_DEFAULT;

  if (stack.length === 0) {
    return { html: card('Action items', `<p class="muted">No stack configured. Add lines to project.json under widgets.alerts.stack so the model knows what to flag.</p>`) };
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return { html: errorCard('Action items', 'Set ANTHROPIC_API_KEY in .env (see .env.example).') };
  }

  const feedConfig = (project.widgets.feed ?? {}) as FeedConfigRef;
  const sources = feedConfig.feeds ?? [];
  if (sources.length === 0) {
    return { html: card('Action items', '<p class="muted">Configure widgets.feed.feeds first — alerts scan the same sources.</p>') };
  }

  let items: FeedItem[];
  try {
    items = await fetchFeedItems(sources);
  } catch (e) {
    return { html: errorCard('Action items', `Feed fetch failed: ${(e as Error).message}`) };
  }
  items = items.slice(0, maxItems);

  const cache = await loadCache();
  const newItems = items.filter(it => !cache[it.url]);

  let classifyError: string | null = null;
  if (newItems.length > 0) {
    try {
      const client = new Anthropic({ apiKey });
      const classifications = await classify(client, model, buildSystemPrompt(stack), newItems);
      const byUrl = new Map(classifications.map(c => [c.url, c]));
      const now = new Date().toISOString();
      for (const it of newItems) {
        const c = byUrl.get(it.url);
        cache[it.url] = {
          url: it.url,
          actionable: c?.actionable ?? false,
          action: c?.action ?? null,
          classifiedAt: now,
          title: it.title,
          source: it.source,
          pubDate: it.pubDate,
        };
      }
      await saveCache(cache);
    } catch (e) {
      classifyError = (e as Error).message;
      console.error('[alerts]', classifyError);
    }
  }

  const actionable = items
    .map(it => cache[it.url])
    .filter((c): c is CachedClassification => !!c && c.actionable);

  if (actionable.length === 0) {
    const footer = classifyError
      ? `<p class="error">Classification error: ${escape(classifyError)}</p>`
      : '';
    const hero: Hero = { value: 0, tone: 'green', label: 'todos' };
    return {
      html: card('Action items', `<p class="muted">Nothing requiring action in the latest ${items.length} items. ${newItems.length} new this run.</p>${footer}`, { hero }),
      hero,
    };
  }

  const rows = actionable.map(c => `
    <li>
      <a href="${escape(c.url)}" target="_blank" rel="noreferrer">
        <span class="warn">★</span>
        <span class="title">${escape(c.action ?? c.title)}</span>
      </a>
      <div class="desc">${escape(c.title)}</div>
      <span class="meta">${escape(c.source)} · ${relTime(c.pubDate)}</span>
    </li>`);

  const footer = classifyError
    ? `<p class="error">Classification error this run (showing cached results): ${escape(classifyError)}</p>`
    : '';

  const tone: Tone = actionable.length === 0 ? 'green' : actionable.length >= 5 ? 'red' : 'amber';
  const hero: Hero = {
    value: actionable.length,
    tone,
    label: actionable.length === 1 ? 'todo' : 'todos',
  };
  return {
    html: card('Action items', `${truncatedList(rows)}${footer}`, { hero }),
    hero,
  };
}

export const alerts: WidgetModule = {
  id: 'alerts',
  title: 'Action items',
  envVars: ['ANTHROPIC_API_KEY'],
  configFields: [
    {
      type: 'multiline-list',
      key: 'stack',
      label: 'Stack & concerns',
      placeholder: 'Kotlin Multiplatform Mobile (Android + iOS)',
      description: 'One concern per line. Used as context for the LLM classifier.',
    },
    {
      type: 'string',
      key: 'model',
      label: 'Model (optional)',
      placeholder: 'claude-haiku-4-5-20251001',
      description: 'Defaults to Haiku 4.5.',
    },
  ],
  run: async project => render(project),
};
