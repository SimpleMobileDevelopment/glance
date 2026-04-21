import type { ProjectConfig } from './types.ts';

export const STYLE = `<style>
  :root {
    --bg: #0e1116; --card: #161b22; --border: #30363d;
    --fg: #c9d1d9; --muted: #8b949e; --accent: #58a6ff;
    --error: #f85149; --success: #3fb950; --warning: #d29922;
  }
  * { box-sizing: border-box; }
  body {
    font: 14px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
    background: var(--bg); color: var(--fg); margin: 0; padding: 24px;
  }
  header { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 24px; gap: 16px; }
  header .left { display: flex; align-items: baseline; gap: 12px; }
  h1 { font-size: 18px; margin: 0; letter-spacing: 0.5px; text-transform: uppercase; }
  .crumb { color: var(--muted); font-size: 12px; }
  .crumb a { color: var(--muted); text-decoration: none; }
  .crumb a:hover { text-decoration: underline; }
  .stamp { color: var(--muted); font-size: 12px; }
  main { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
  @media (max-width: 900px) { main { grid-template-columns: 1fr; } }
  .card { background: var(--card); border: 1px solid var(--border); border-radius: 8px; padding: 16px 20px; }
  .card h2 { margin-top: 0; font-size: 13px; text-transform: uppercase; letter-spacing: 0.5px; color: var(--muted); }
  .card h3 { font-size: 13px; margin: 16px 0 8px; color: var(--fg); }
  .count { color: var(--muted); font-weight: normal; font-size: 12px; margin-left: 4px; }
  ul { list-style: none; padding: 0; margin: 0; }
  li { padding: 8px 0; border-bottom: 1px solid var(--border); }
  li:last-child { border-bottom: none; }
  a { color: var(--accent); text-decoration: none; }
  a:hover { text-decoration: underline; }
  .repo { color: var(--muted); margin-right: 4px; }
  .num { color: var(--muted); margin-right: 6px; }
  .title { color: var(--fg); }
  .tag { background: #21262d; color: var(--muted); border-radius: 3px; padding: 0 6px; font-size: 11px; margin-right: 6px; }
  .meta { display: block; color: var(--muted); font-size: 12px; margin-top: 2px; }
  .desc { color: var(--fg); font-size: 12px; margin-top: 4px; opacity: 0.85; }
  .muted { color: var(--muted); }
  .ok { color: var(--success); }
  .warn { color: var(--warning); }
  .error { color: var(--error); white-space: pre-wrap; font-family: ui-monospace, monospace; font-size: 12px; }
  details.more-items { margin: 0; padding: 0; }
  details.more-items > summary {
    list-style: none;
    cursor: pointer;
    color: var(--muted);
    font-size: 12px;
    padding: 8px 0;
    border-top: 1px solid var(--border);
    user-select: none;
  }
  details.more-items > summary::-webkit-details-marker { display: none; }
  details.more-items > summary::marker { display: none; }
  details.more-items > summary::before {
    content: "▸";
    display: inline-block;
    margin-right: 6px;
    transition: transform 150ms ease;
  }
  details.more-items[open] > summary::before { transform: rotate(90deg); }
  details.more-items > summary:hover { color: var(--fg); }
  details.more-items > ul > li:first-child { border-top: 0; }
  .checklist { margin: 10px 0 2px; padding: 0; }
  .checklist li { padding: 3px 0; border: none; }
  .checklist label { display: inline-flex; align-items: center; gap: 8px; cursor: pointer; font-size: 13px; color: var(--fg); }
  .checklist input[type=checkbox] { margin: 0; cursor: pointer; accent-color: var(--accent); }
  .checklist li.done label { color: var(--muted); text-decoration: line-through; }
</style>`;

const DASHBOARD_SCRIPT = `<script>
(async () => {
  try {
    const res = await fetch('/api/checklist');
    if (!res.ok) return;
    const state = await res.json();
    document.querySelectorAll('ul.checklist[data-checklist-key]').forEach(ul => {
      const entry = state[ul.dataset.checklistKey];
      if (!entry) return;
      const checked = new Set(entry.checked || []);
      ul.querySelectorAll('input[type=checkbox][data-checklist-item]').forEach(cb => {
        const isDone = checked.has(cb.dataset.checklistItem);
        cb.checked = isDone;
        cb.closest('li').classList.toggle('done', isDone);
      });
    });
  } catch {}
})();

document.addEventListener('change', async (e) => {
  const cb = e.target;
  if (!(cb instanceof HTMLInputElement)) return;
  if (cb.type !== 'checkbox' || !cb.dataset.checklistKey || !cb.dataset.checklistItem) return;
  const li = cb.closest('li');
  const checked = cb.checked;
  li.classList.toggle('done', checked);
  try {
    const res = await fetch('/api/checklist', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: cb.dataset.checklistKey, item: cb.dataset.checklistItem, checked }),
    });
    if (!res.ok) throw new Error(await res.text());
  } catch {
    cb.checked = !checked;
    li.classList.toggle('done', !checked);
  }
});
</script>`;

export function escape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function relTime(iso: string): string {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '';
  const d = (Date.now() - t) / 1000;
  if (d < 60)     return `${Math.floor(d)}s`;
  if (d < 3600)   return `${Math.floor(d / 60)}m`;
  if (d < 86_400) return `${Math.floor(d / 3600)}h`;
  return `${Math.floor(d / 86_400)}d`;
}

export function card(title: string, body: string): string {
  return `<section class="card"><h2>${escape(title)}</h2>${body}</section>`;
}

export function errorCard(title: string, message: string): string {
  return `<section class="card"><h2>${escape(title)}</h2><p class="error">${escape(message)}</p></section>`;
}

export function truncatedList(
  rows: string[],
  options: { visible?: number; listClass?: string } = {},
): string {
  const visible = options.visible ?? 5;
  const classAttr = options.listClass ? ` class="${options.listClass}"` : '';
  if (rows.length <= visible) {
    return `<ul${classAttr}>${rows.join('')}</ul>`;
  }
  const head = rows.slice(0, visible).join('');
  const tail = rows.slice(visible).join('');
  const moreCount = rows.length - visible;
  return `<ul${classAttr}>${head}</ul><details class="more-items"><summary>Show ${moreCount} more</summary><ul${classAttr}>${tail}</ul></details>`;
}

export function renderProjectPage(
  project: ProjectConfig,
  sections: string[],
  generatedAt: Date,
): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>glance · ${escape(project.displayName)}</title>
${STYLE}
</head>
<body>
  <header>
    <div class="left">
      <h1>${escape(project.displayName)}</h1>
    </div>
    <span class="stamp">updated ${generatedAt.toLocaleString()} · <a href="/settings">settings</a></span>
  </header>
  <main>
    ${sections.join('\n    ')}
  </main>
${DASHBOARD_SCRIPT}
</body>
</html>`;
}
