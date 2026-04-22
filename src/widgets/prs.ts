import type { ProjectConfig, WidgetModule, Result } from '../types.ts';
import { card, errorCard, escape, relTime, truncatedList } from '../render.ts';
import { memoize, conditionalFetch } from '../cache.ts';
import { fetchIssues, type LinearIssueRef } from './linear.ts';

const PRS_TTL_MS = 2 * 60_000;
const LINEAR_ID_REGEX = /[A-Z]{2,4}-\d+/g;

type PR = {
  title: string;
  body?: string;
  url: string;
  repo: string;
  number: number;
  updatedAt: string;
  author: string;
  draft: boolean;
};

type PRData = { mine: PR[]; reviewQueue: PR[] };
type PRSummary = { mine: number; reviewQueue: number };

async function fetchPRs(project: ProjectConfig): Promise<Result<PRData>> {
  const token = process.env[project.github.tokenEnv];
  const username = project.github.username;
  if (!token) {
    return { ok: false, error: `Set ${project.github.tokenEnv} in .env (see .env.example).` };
  }
  if (!username) {
    return { ok: false, error: `Set github.username in project.json.` };
  }
  try {
    const headers = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'mission-control',
    };
    const extra = project.github.extraQuery ? ` ${project.github.extraQuery}` : '';

    const search = async (q: string): Promise<PR[]> => {
      const url = `https://api.github.com/search/issues?q=${encodeURIComponent(q)}&per_page=30`;
      const cacheKey = `prs:search:${q}`;
      return memoize<PR[]>({
        key: cacheKey,
        ttlMs: PRS_TTL_MS,
        fetchFresh: async () => {
          const res = await conditionalFetch(url, { headers });
          if (!res.ok) throw new Error(`GitHub ${res.status}: ${await res.text()}`);
          const json = await res.json() as { items: any[] };
          return json.items.map<PR>(it => ({
            title: it.title,
            body: typeof it.body === 'string' ? it.body : undefined,
            url: it.html_url,
            repo: String(it.repository_url).replace('https://api.github.com/repos/', ''),
            number: it.number,
            updatedAt: it.updated_at,
            author: it.user?.login ?? 'unknown',
            draft: it.draft ?? false,
          }));
        },
      });
    };

    const [mine, reviewQueue] = await Promise.all([
      search(`is:open is:pr author:${username} archived:false${extra}`),
      search(`is:open is:pr review-requested:${username} archived:false${extra}`),
    ]);

    return { ok: true, data: { mine, reviewQueue } };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

function extractLinearIds(prs: PR[]): string[] {
  const ids = new Set<string>();
  for (const pr of prs) {
    const haystack = `${pr.title ?? ''} ${pr.body ?? ''}`;
    const matches = haystack.match(LINEAR_ID_REGEX);
    if (matches) for (const id of matches) ids.add(id);
  }
  return [...ids];
}

function renderLinearBadges(pr: PR, issuesById: Map<string, LinearIssueRef>): string {
  const haystack = `${pr.title ?? ''} ${pr.body ?? ''}`;
  const matches = haystack.match(LINEAR_ID_REGEX);
  if (!matches || matches.length === 0) return '';
  const seen = new Set<string>();
  const badges: string[] = [];
  for (const id of matches) {
    if (seen.has(id)) continue;
    seen.add(id);
    const issue = issuesById.get(id);
    if (!issue) continue;
    badges.push(
      `<a href="${escape(issue.url)}" target="_blank" rel="noreferrer"><span class="tag">[${escape(issue.id)} · ${escape(issue.state)}]</span></a>`,
    );
  }
  return badges.join('');
}

function renderPRList(label: string, prs: PR[], issuesById: Map<string, LinearIssueRef>): string {
  if (prs.length === 0) {
    return `<h3>${escape(label)}</h3><p class="muted">Nothing here.</p>`;
  }
  const rows = prs.map(p => `
    <li>
      <a href="${escape(p.url)}" target="_blank" rel="noreferrer">
        <span class="repo">${escape(p.repo)}</span>
        <span class="num">#${p.number}</span>
        ${p.draft ? '<span class="tag">draft</span>' : ''}
        <span class="title">${escape(p.title)}</span>
      </a>
      ${renderLinearBadges(p, issuesById)}
      <span class="meta">by ${escape(p.author)} · ${relTime(p.updatedAt)} ago</span>
    </li>`);
  return `<h3>${escape(label)} <span class="count">${prs.length}</span></h3>${truncatedList(rows, { listClass: 'prs' })}`;
}

async function render(project: ProjectConfig): Promise<{ html: string; summary: PRSummary }> {
  const result = await fetchPRs(project);
  if (!result.ok) {
    return { html: errorCard('PR queue', result.error), summary: { mine: 0, reviewQueue: 0 } };
  }

  // Cross-link PR titles/bodies to Linear. Silently fall back to empty map if
  // Linear isn't configured or the lookup fails.
  const allPRs = [...result.data.mine, ...result.data.reviewQueue];
  const ids = extractLinearIds(allPRs);
  const issuesById = new Map<string, LinearIssueRef>();
  if (ids.length > 0) {
    try {
      const issues = await fetchIssues(project, ids);
      for (const issue of issues) issuesById.set(issue.id, issue);
    } catch {
      // Intentionally swallow — badges are decorative.
    }
  }

  const body = renderPRList('Yours', result.data.mine, issuesById) +
               renderPRList('Awaiting your review', result.data.reviewQueue, issuesById);
  return {
    html: card('PR queue', body),
    summary: {
      mine: result.data.mine.length,
      reviewQueue: result.data.reviewQueue.length,
    },
  };
}

export const prs: WidgetModule = {
  id: 'prs',
  title: 'PR queue',
  envVars: project => [project.github.tokenEnv],
  run: async project => {
    const { html, summary } = await render(project);
    return { html, summary };
  },
};
