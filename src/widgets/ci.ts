import Anthropic from '@anthropic-ai/sdk';
import type { ProjectConfig, WidgetModule, Result } from '../types.ts';
import { card, errorCard, escape, relTime, truncatedList } from '../render.ts';
import { buildKey, syncRun } from '../releaseChecklist.ts';
import { memoize, conditionalFetch } from '../cache.ts';

const CI_TTL_MS = 3 * 60_000;
// Workflow runs are immutable once concluded, so once we've summarized a
// failure the result is stable forever. Use a very-long TTL so we never
// re-bill the model for a run we've already analyzed.
const CI_SUMMARY_TTL_MS = 365 * 24 * 60 * 60_000;
const CI_SUMMARY_MODEL = 'claude-haiku-4-5-20251001';
// Trim log tails to this many bytes before feeding to the model.
const LOG_TAIL_BYTES = 10 * 1024;

type CiSummary = {
  failedCount: number;
  latestRunStatus: string | null;
};

type Run = {
  id: number;
  name: string;
  html_url: string;
  status: string;
  conclusion: string | null;
  updated_at: string;
};

type FailureSummary = {
  classification: 'real' | 'flake' | 'unknown';
  summary: string;
};

type RowData = {
  repo: string;
  branch: string;
  result: Result<Run | null>;
  checklist?: { key: string; items: string[]; checked: Set<string> };
  failureSummary?: FailureSummary;
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
  const url = `https://api.github.com/repos/${repo}/actions/workflows/${encodeURIComponent(workflow)}/runs?branch=${encodeURIComponent(branch)}&per_page=1`;
  const cacheKey = `ci:${repo}:${branch}:${workflow}`;
  try {
    return await memoize<Result<Run | null>>({
      key: cacheKey,
      ttlMs: CI_TTL_MS,
      fetchFresh: async () => {
        const res = await conditionalFetch(url, { headers });
        if (!res.ok) return { ok: false, error: `GitHub ${res.status}: ${await res.text()}` };
        const json = await res.json() as { workflow_runs?: Run[] };
        const run = json.workflow_runs?.[0];
        return { ok: true, data: run ?? null };
      },
    });
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

type Job = {
  id: number;
  name: string;
  conclusion: string | null;
};

async function fetchFailedJobIds(
  repo: string,
  runId: number,
  headers: Record<string, string>,
): Promise<number[]> {
  const url = `https://api.github.com/repos/${repo}/actions/runs/${runId}/jobs`;
  const res = await fetch(url, { headers });
  if (!res.ok) return [];
  const json = await res.json() as { jobs?: Job[] };
  return (json.jobs ?? [])
    .filter(j => j.conclusion && FAILURE_CONCLUSIONS.has(j.conclusion))
    .map(j => j.id);
}

async function fetchJobLogTail(
  repo: string,
  jobId: number,
  headers: Record<string, string>,
): Promise<string> {
  const url = `https://api.github.com/repos/${repo}/actions/jobs/${jobId}/logs`;
  const res = await fetch(url, { headers });
  if (!res.ok) return '';
  const text = await res.text();
  if (text.length <= LOG_TAIL_BYTES) return text;
  return text.slice(text.length - LOG_TAIL_BYTES);
}

function parseSummaryLine(line: string): FailureSummary {
  const trimmed = line.trim().replace(/^```.*$/gm, '').trim();
  const match = trimmed.match(/^\[(real|flake)\]\s*(.*)$/i);
  if (match) {
    const cls = match[1].toLowerCase() as 'real' | 'flake';
    return { classification: cls, summary: `[${cls}] ${match[2].trim()}` };
  }
  return { classification: 'unknown', summary: trimmed };
}

async function summarizeFailure(
  repo: string,
  runId: number,
  ghHeaders: Record<string, string>,
  apiKey: string,
): Promise<FailureSummary | null> {
  return memoize<FailureSummary | null>({
    key: `ci-summary:${repo}:${runId}`,
    ttlMs: CI_SUMMARY_TTL_MS,
    fetchFresh: async () => {
      try {
        const jobIds = await fetchFailedJobIds(repo, runId, ghHeaders);
        if (jobIds.length === 0) return null;
        const logs = await Promise.all(jobIds.map(id => fetchJobLogTail(repo, id, ghHeaders)));
        const combined = logs.filter(l => l.length > 0).join('\n---\n');
        if (!combined.trim()) return null;
        const client = new Anthropic({ apiKey });
        const response = await client.messages.create({
          model: CI_SUMMARY_MODEL,
          max_tokens: 200,
          system: [{
            type: 'text',
            text: `You are analyzing CI log tail output. Reply with ONE LINE containing: (a) classification in square brackets [real] or [flake], and (b) a specific root cause (class name, test name, error type). Example: "[real] NullPointerException in FooRepository.kt:47". Do not include any other text, prose, or explanation.`,
            cache_control: { type: 'ephemeral' },
          }],
          messages: [{ role: 'user', content: `Log tail:\n\n${combined}` }],
        });
        const text = response.content
          .filter(b => b.type === 'text')
          .map(b => (b as Anthropic.TextBlock).text)
          .join('')
          .split('\n')
          .find(l => l.trim().length > 0) ?? '';
        if (!text) return null;
        return parseSummaryLine(text);
      } catch {
        return null;
      }
    },
  });
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
  const aiSummary = row.failureSummary
    ? `<div class="meta ci-ai-summary">${escape(row.failureSummary.summary)}</div>`
    : '';
  return `
    <li>
      <a href="${escape(run.html_url)}" target="_blank" rel="noreferrer">
        <span class="repo">${repo}</span>
        <span class="num">${branch}</span>
        ${statusMarkup(run)}
        <span class="title">${escape(run.name ?? '')}</span>
      </a>
      <span class="meta">${relTime(run.updated_at)} ago</span>
      ${aiSummary}
      ${renderChecklist(row.checklist)}
    </li>`;
}

async function render(project: ProjectConfig): Promise<{ html: string; summary: CiSummary }> {
  const cfg = (project.widgets?.ci ?? {}) as CiConfig;
  const repos = cfg.repos ?? [];
  const branches = cfg.branches && cfg.branches.length > 0 ? cfg.branches : ['main'];
  const workflow = cfg.workflow?.trim();
  const checklistItems = (cfg.checklist ?? []).map(s => s.trim()).filter(Boolean);

  const emptySummary: CiSummary = { failedCount: 0, latestRunStatus: null };

  if (repos.length === 0) {
    return { html: card('Release build', '<p class="muted">No repos configured.</p>'), summary: emptySummary };
  }
  if (!workflow) {
    return {
      html: card('Release build', '<p class="muted">Set <code>widgets.ci.workflow</code> to the release workflow file name (e.g. <code>release.yml</code>).</p>'),
      summary: emptySummary,
    };
  }

  const token = process.env[project.github.tokenEnv];
  if (!token) {
    return {
      html: errorCard('Release build', `Set ${project.github.tokenEnv} in .env (see .env.example).`),
      summary: emptySummary,
    };
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

  const anthropicKey = process.env.ANTHROPIC_API_KEY;

  // We do per-row work in one parallel pass so fetchRun + checklist + the
  // optional AI failure summary all run concurrently across repos/branches
  // and rows don't serialize on each other's awaits.
  const rows: RowData[] = await Promise.all(
    pairs.map(async ({ repo, branch }): Promise<RowData> => {
      const result = await fetchRun(repo, branch, workflow, headers);
      const row: RowData = { repo, branch, result };
      const sideEffects: Promise<unknown>[] = [];
      if (checklistItems.length > 0 && result.ok && result.data) {
        sideEffects.push((async () => {
          const key = buildKey(repo, workflow, branch);
          const checked = await syncRun(key, result.data!.id, checklistItems);
          row.checklist = { key, items: checklistItems, checked: new Set(checked) };
        })());
      }
      if (anthropicKey && result.ok && result.data && isFailure(result.data)) {
        sideEffects.push((async () => {
          try {
            const fs = await summarizeFailure(repo, result.data!.id, headers, anthropicKey);
            if (fs) row.failureSummary = fs;
          } catch {
            // non-fatal; silently skip.
          }
        })());
      }
      if (sideEffects.length > 0) await Promise.all(sideEffects);
      return row;
    }),
  );

  // Compute summary: failedCount across all rows, and the status of the
  // most-recently-updated run across the whole set (mirrors what a
  // human would read off the top of the card).
  let failedCount = 0;
  let latestRun: Run | null = null;
  for (const row of rows) {
    if (!row.result.ok || !row.result.data) continue;
    const run = row.result.data;
    if (isFailure(run)) failedCount++;
    if (!latestRun || run.updated_at > latestRun.updated_at) {
      latestRun = run;
    }
  }
  const latestRunStatus = latestRun
    ? (latestRun.conclusion ?? latestRun.status ?? null)
    : null;

  return {
    html: card('Release build', truncatedList(rows.map(renderRow))),
    summary: { failedCount, latestRunStatus },
  };
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
  run: async project => {
    const { html, summary } = await render(project);
    return { html, summary };
  },
};
