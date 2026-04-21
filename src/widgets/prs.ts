import type { ProjectConfig, WidgetModule, Result } from '../types.ts';
import { card, errorCard, escape, relTime, truncatedList } from '../render.ts';

type PR = {
  title: string;
  url: string;
  repo: string;
  number: number;
  updatedAt: string;
  author: string;
  draft: boolean;
};

type PRData = { mine: PR[]; reviewQueue: PR[] };

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
      const res = await fetch(url, { headers });
      if (!res.ok) throw new Error(`GitHub ${res.status}: ${await res.text()}`);
      const json = await res.json() as { items: any[] };
      return json.items.map<PR>(it => ({
        title: it.title,
        url: it.html_url,
        repo: String(it.repository_url).replace('https://api.github.com/repos/', ''),
        number: it.number,
        updatedAt: it.updated_at,
        author: it.user?.login ?? 'unknown',
        draft: it.draft ?? false,
      }));
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

function renderPRList(label: string, prs: PR[]): string {
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
      <span class="meta">by ${escape(p.author)} · ${relTime(p.updatedAt)} ago</span>
    </li>`);
  return `<h3>${escape(label)} <span class="count">${prs.length}</span></h3>${truncatedList(rows, { listClass: 'prs' })}`;
}

async function run(project: ProjectConfig): Promise<string> {
  const result = await fetchPRs(project);
  if (!result.ok) return errorCard('PR queue', result.error);
  const body = renderPRList('Yours', result.data.mine) +
               renderPRList('Awaiting your review', result.data.reviewQueue);
  return card('PR queue', body);
}

export const prs: WidgetModule = {
  id: 'prs',
  title: 'PR queue',
  envVars: project => [project.github.tokenEnv],
  run,
};
