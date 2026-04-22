import Parser from 'rss-parser';
import type { ProjectConfig, WidgetModule, Result } from '../types.ts';
import { card, errorCard, escape, relTime, truncatedList } from '../render.ts';

type Source = { name: string; url: string };
type FeedConfig = { feeds?: Source[] };
type FeedItem = { title: string; url: string; pubDate: string; source: string; description: string };

function summarize(raw: string | undefined): string {
  if (!raw) return '';
  const text = raw.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  if (text.length <= 200) return text;
  return text.slice(0, 197) + '…';
}

async function fetchFeed(sources: Source[]): Promise<Result<FeedItem[]>> {
  if (sources.length === 0) {
    return { ok: true, data: [] };
  }
  const parser: Parser = new Parser({ timeout: 10_000 });
  const all: FeedItem[] = [];
  const errors: string[] = [];

  await Promise.all(sources.map(async ({ name, url }) => {
    try {
      const feed = await parser.parseURL(url);
      for (const item of feed.items.slice(0, 10)) {
        all.push({
          title: item.title ?? '(untitled)',
          url: item.link ?? '#',
          pubDate: item.isoDate ?? item.pubDate ?? '',
          source: name,
          description: summarize(item.contentSnippet ?? item.summary ?? item.content),
        });
      }
    } catch (e) {
      errors.push(`${name}: ${(e as Error).message}`);
    }
  }));

  if (all.length === 0) {
    return { ok: false, error: errors.join('\n') || 'No items.' };
  }
  all.sort((a, b) => (b.pubDate ?? '').localeCompare(a.pubDate ?? ''));
  return { ok: true, data: all.slice(0, 25) };
}

async function render(project: ProjectConfig): Promise<string> {
  const config = (project.widgets.feed ?? {}) as FeedConfig;
  const sources = config.feeds ?? [];
  if (sources.length === 0) {
    return card('Intel feed', `<p class="muted">No feeds configured. Add some to project.json under widgets.feed.feeds.</p>`);
  }
  const result = await fetchFeed(sources);
  if (!result.ok) return errorCard('Intel feed', result.error);
  const rows = result.data.map(it => `
    <li>
      <a href="${escape(it.url)}" target="_blank" rel="noreferrer">${escape(it.title)}</a>
      ${it.description ? `<div class="desc">${escape(it.description)}</div>` : ''}
      <span class="meta">${escape(it.source)} · ${relTime(it.pubDate)} ago</span>
    </li>`);
  return card('Intel feed', truncatedList(rows, { listClass: 'feed' }));
}

export const feed: WidgetModule = {
  id: 'feed',
  title: 'Intel feed',
  configFields: [
    {
      type: 'object-list',
      key: 'feeds',
      label: 'RSS sources',
      description: 'One per line as `Name | URL`.',
      fields: [
        { key: 'name', label: 'Name', placeholder: 'Android Weekly' },
        { key: 'url', label: 'URL', placeholder: 'https://androidweekly.net/rss.xml' },
      ],
    },
  ],
  run: async project => ({ html: await render(project) }),
};
