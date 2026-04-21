import type { ProjectConfig, WidgetModule, Result } from '../types.ts';
import { card, errorCard, escape, relTime, truncatedList } from '../render.ts';
import { buildKey, syncRun } from '../releaseChecklist.ts';

type Run = {
  id: number;
  name: string;
  html_url: string;
  status: string;
  conclusion: string | null;
  updated_at: string;
};

type RowData = {
  repo: string;
  branch: string;
  result: Result<Run | null>;
  checklist?: { key: string; items: string[]; checked: Set<string> };
};

type CiConfig = {
  repos?: string[];
  branches?: string[];
  workflow?: string;
  checklist?: string[];
};

const FAILURE_CONCLUSIONS = new Set(['failure', 'cancelled', 'timed_out', 'startup_failure']);

function isFailure(run: Run): boolean {
  return run.conclusion != null && FAILURE_CONCLUSIONS.has(run.conclusion);
}

async function fetchRun(
  repo: string,
  branch: string,
  workflow: string,
  headers: Record<string, string>,
): Promise<Result<Run | null>> {
  try {
    const url = `https://api.github.com/repos/${repo}/actions/workflows/${encodeURIComponent(workflow)}/runs?branch=${encodeURIComponent(branch)}&per_page=1`;
    const res = await fetch(url, { headers });
    if (!res.ok) return { ok: false, error: `GitHub ${res.status}: ${await res.text()}` };
    const json = await res.json() as { workflow_runs?: Run[] };
    const run = json.workflow_runs?.[0];
    return { ok: true, data: run ?? null };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

function statusMarkup(run: Run): string {
  if (run.conclusion === 'success') {
    return '<span class="ok">✓ success</span>';
  }
  if (isFailure(run)) {
    return `<span class="error">✗ ${escape(run.conclusion ?? '')}</span>`;
  }
  if (run.conclusion === 'skipped') {
    return '<span class="muted">— skipped</span>';
  }
  if (run.status === 'queued' || run.status === 'in_progress') {
    return `<span class="warn">⏳ ${escape(run.status)}</span>`;
  }
  return `<span class="muted">${escape(run.conclusion ?? run.status ?? '?')}</span>`;
}

function renderChecklist(checklist: RowData['checklist']): string {
  if (!checklist || checklist.items.length === 0) return '';
  const keyAttr = escape(checklist.key);
  const rows = checklist.items.map(item => {
    const done = checklist.checked.has(item);
    const itemAttr = escape(item);
    return `<li class="${done ? 'done' : ''}">
        <label>
          <input type="checkbox" ${done ? 'checked' : ''} data-checklist-key="${keyAttr}" data-checklist-item="${itemAttr}" />
          ${escape(item)}
        </label>
      </li>`;
  }).join('');
  return `<ul class="checklist" data-checklist-key="${keyAttr}">${rows}</ul>`;
}

function renderRow(row: RowData): string {
  const repo = escape(row.repo);
  const branch = escape(row.branch);
  if (!row.result.ok) {
    return `
    <li>
      <span class="repo">${repo}</span>
      <span class="num">${branch}</span>
      <span style="color:var(--error)">${escape(row.result.error)}</span>
    </li>`;
  }
  const run = row.result.data;
  if (!run) {
    return `
    <li>
      <span class="repo">${repo}</span>
      <span class="num">${branch}</span>
      <span class="muted">no runs</span>
    </li>`;
  }
  return `
    <li>
      <a href="${escape(run.html_url)}" target="_blank" rel="noreferrer">
        <span class="repo">${repo}</span>
        <span class="num">${branch}</span>
        ${statusMarkup(run)}
        <span class="title">${escape(run.name ?? '')}</span>
      </a>
      <span class="meta">${relTime(run.updated_at)} ago</span>
      ${renderChecklist(row.checklist)}
    </li>`;
}

async function run(project: ProjectConfig): Promise<string> {
  const cfg = (project.widgets?.ci ?? {}) as CiConfig;
  const repos = cfg.repos ?? [];
  const branches = cfg.branches && cfg.branches.length > 0 ? cfg.branches : ['main'];
  const workflow = cfg.workflow?.trim();
  const checklistItems = (cfg.checklist ?? []).map(s => s.trim()).filter(Boolean);

  if (repos.length === 0) {
    return card('Release build', '<p class="muted">No repos configured.</p>');
  }
  if (!workflow) {
    return card('Release build', '<p class="muted">Set <code>widgets.ci.workflow</code> to the release workflow file name (e.g. <code>release.yml</code>).</p>');
  }

  const token = process.env[project.github.tokenEnv];
  if (!token) {
    return errorCard('Release build', `Set ${project.github.tokenEnv} in .env (see .env.example).`);
  }

  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'mission-control',
  };

  const pairs: Array<{ repo: string; branch: string }> = [];
  for (const repo of repos) {
    for (const branch of branches) {
      pairs.push({ repo, branch });
    }
  }

  const rows: RowData[] = await Promise.all(
    pairs.map(async ({ repo, branch }): Promise<RowData> => {
      const result = await fetchRun(repo, branch, workflow, headers);
      const row: RowData = { repo, branch, result };
      if (checklistItems.length > 0 && result.ok && result.data) {
        const key = buildKey(repo, workflow, branch);
        const checked = await syncRun(key, result.data.id, checklistItems);
        row.checklist = { key, items: checklistItems, checked: new Set(checked) };
      }
      return row;
    }),
  );

  return card('Release build', truncatedList(rows.map(renderRow)));
}

export const ci: WidgetModule = {
  id: 'ci',
  title: 'Release build',
  envVars: project => [project.github.tokenEnv],
  configFields: [
    {
      type: 'multiline-list',
      key: 'repos',
      label: 'Repos',
      placeholder: 'owner/repo',
      description: 'One owner/repo per line.',
    },
    {
      type: 'multiline-list',
      key: 'branches',
      label: 'Branches',
      placeholder: 'main',
      description: 'One per line. Defaults to "main" if empty.',
    },
    {
      type: 'string',
      key: 'workflow',
      label: 'Release workflow file',
      placeholder: 'release.yml',
      description: 'Workflow file name (under .github/workflows/) for the release build. Only failed runs of this workflow are shown.',
    },
    {
      type: 'multiline-list',
      key: 'checklist',
      label: 'Release checklist',
      placeholder: 'Submit for review in Play Console',
      description: 'One item per line. Checkboxes reset automatically when a new release run is detected.',
    },
  ],
  run,
};
