import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { ProjectConfig, WidgetModule, Hero } from '../types.ts';
import { card, errorCard, escape, type Tone } from '../render.ts';

type CustomEntry = { name?: string; date?: string; url?: string };

type DeadlinesConfig = {
  custom?: CustomEntry[];
  hideBundled?: boolean;
};

type Deadline = {
  name: string;
  date: string;
  category: string;
  url?: string;
};

type BundledData = {
  items: Deadline[];
};

const BUNDLED_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'deadlines.data.json');

async function loadBundled(): Promise<Deadline[]> {
  const raw = await readFile(BUNDLED_PATH, 'utf8');
  const parsed = JSON.parse(raw) as BundledData;
  return parsed.items ?? [];
}

function parseDate(iso: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
  const d = new Date(iso + 'T00:00:00Z');
  return Number.isNaN(d.getTime()) ? null : d;
}

function daysUntil(target: Date, now: Date): number {
  const ms = target.getTime() - now.getTime();
  return Math.ceil(ms / 86_400_000);
}

function urgencyClass(days: number): string {
  if (days <= 7) return 'error';
  if (days <= 30) return 'warn';
  return 'muted';
}

function formatWhen(days: number, iso: string): string {
  if (days < 0) return `${iso} · ${Math.abs(days)}d ago`;
  if (days === 0) return `${iso} · today`;
  if (days === 1) return `${iso} · tomorrow`;
  return `${iso} · in ${days}d`;
}

async function render(project: ProjectConfig): Promise<{ html: string; hero?: Hero }> {
  const config = (project.widgets.deadlines ?? {}) as DeadlinesConfig;

  let bundled: Deadline[] = [];
  if (!config.hideBundled) {
    try {
      bundled = await loadBundled();
    } catch (e) {
      return { html: errorCard('Deadlines', `Failed to load bundled data: ${(e as Error).message}`) };
    }
  }

  const custom: Deadline[] = (config.custom ?? [])
    .filter(e => e.name && e.date)
    .map(e => ({
      name: e.name!,
      date: e.date!,
      category: 'custom',
      url: e.url || undefined,
    }));

  const all = [...bundled, ...custom];
  const now = new Date();

  const enriched = all
    .map(d => {
      const parsed = parseDate(d.date);
      return parsed ? { d, parsed, days: daysUntil(parsed, now) } : null;
    })
    .filter((x): x is { d: Deadline; parsed: Date; days: number } => x !== null)
    .filter(x => x.days >= -7)
    .sort((a, b) => a.parsed.getTime() - b.parsed.getTime());

  if (enriched.length === 0) {
    return { html: card('Deadlines', `<p class="muted">Nothing upcoming. Add custom entries in settings (name | YYYY-MM-DD | url).</p>`) };
  }

  const rows = enriched.map(({ d, days }) => {
    const cls = urgencyClass(days);
    const title = d.url
      ? `<a href="${escape(d.url)}" target="_blank" rel="noreferrer">${escape(d.name)}</a>`
      : escape(d.name);
    return `<li>
      <span class="${cls}">●</span>
      <span class="title">${title}</span>
      <span class="tag">${escape(d.category)}</span>
      <span class="meta">${escape(formatWhen(days, d.date))}</span>
    </li>`;
  }).join('');

  const soonest = enriched[0].days;
  const heroTone: Tone = soonest <= 7 ? 'red' : soonest <= 30 ? 'amber' : 'muted';
  const heroValue = soonest < 0 ? `${Math.abs(soonest)}d ago` : soonest === 0 ? 'today' : `${soonest}d`;
  const hero: Hero = { value: heroValue, tone: heroTone, label: 'next' };
  return {
    html: card('Deadlines', `<ul>${rows}</ul>`, { hero }),
    hero,
  };
}

export const deadlines: WidgetModule = {
  id: 'deadlines',
  title: 'Deadlines',
  configFields: [
    {
      type: 'object-list',
      key: 'custom',
      label: 'Custom deadlines',
      description: 'One per line as `name | YYYY-MM-DD | url` (url optional). E.g. keystore expiry, domain renewal.',
      fields: [
        { key: 'name', label: 'Name', placeholder: 'Upload keystore expires' },
        { key: 'date', label: 'Date', placeholder: '2027-03-15' },
        { key: 'url', label: 'URL', placeholder: 'https://...' },
      ],
    },
  ],
  run: async project => render(project),
};
