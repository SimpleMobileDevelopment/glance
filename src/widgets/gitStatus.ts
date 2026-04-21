import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import type { ProjectConfig, WidgetModule, Result } from '../types.ts';
import { card, escape } from '../render.ts';

const execFileP = promisify(execFile);

type GitStatusConfig = { paths?: string[] };

type RepoStatus = {
  count: number;
  preview: string[];
};

async function statusOf(repoPath: string): Promise<Result<RepoStatus>> {
  try {
    const { stdout } = await execFileP(
      'git',
      ['-C', repoPath, 'status', '--porcelain'],
      { maxBuffer: 4 * 1024 * 1024 },
    );
    const lines = stdout.split('\n').filter(l => l.length > 0);
    return { ok: true, data: { count: lines.length, preview: lines.slice(0, 5) } };
  } catch (e) {
    return { ok: false, error: (e as Error).stderr?.toString().trim() || (e as Error).message };
  }
}

function renderRepo(repoPath: string, result: Result<RepoStatus>): string {
  const label = escape(path.basename(repoPath));
  if (!result.ok) {
    return `<li>
      <span class="repo">${label}</span>
      <span style="color:var(--error)">${escape(result.error)}</span>
    </li>`;
  }
  if (result.data.count === 0) {
    return `<li>
      <span class="repo">${label}</span>
      <span class="ok">clean ✓</span>
    </li>`;
  }
  const preview = result.data.preview
    .map(line => `<div class="meta">${escape(line)}</div>`)
    .join('');
  return `<li>
    <span class="repo">${label}</span>
    <span class="warn">${result.data.count} change${result.data.count === 1 ? '' : 's'}</span>
    ${preview}
  </li>`;
}

async function run(project: ProjectConfig): Promise<string> {
  const config = (project.widgets.gitStatus ?? {}) as GitStatusConfig;
  const paths = config.paths ?? [];
  if (paths.length === 0) {
    return card('Local changes', `<p class="muted">No repos configured. Add some to project.json under widgets.gitStatus.paths.</p>`);
  }
  const results = await Promise.all(paths.map(async p => ({ repoPath: p, result: await statusOf(p) })));
  const body = `<ul>${results.map(r => renderRepo(r.repoPath, r.result)).join('')}</ul>`;
  return card('Local changes', body);
}

export const gitStatus: WidgetModule = {
  id: 'gitStatus',
  title: 'Local changes',
  configFields: [
    {
      type: 'multiline-list',
      key: 'paths',
      label: 'Repo paths',
      placeholder: 'C:\\path\\to\\repo',
      description: 'Absolute paths to local git repos.',
    },
  ],
  run,
};
