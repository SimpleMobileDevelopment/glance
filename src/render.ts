import type { ProjectConfig, Hero, Tone } from './types.ts';
export type { Tone, Hero } from './types.ts';

export const FONT_LINKS = `<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Sans+Condensed:wght@500;600&display=swap" rel="stylesheet">`;

export const STYLE = `<style>
  :root {
    --bg: #07090c;
    --card: #0d1117;
    --card-hi: #11161d;
    --border: #1f2329;
    --rule: #161b22;
    --fg: #d6dde4;
    --muted: #7d8691;
    --accent: #6ea8fe;
    --error: #f85149;
    --success: #3fb950;
    --warning: #d29922;
    --mono: 'IBM Plex Mono', ui-monospace, SFMono-Regular, Menlo, monospace;
    --sans: 'IBM Plex Sans', ui-sans-serif, system-ui, -apple-system, sans-serif;
    --condensed: 'IBM Plex Sans Condensed', var(--sans);
  }
  * { box-sizing: border-box; }
  body {
    font: 14px/1.55 var(--sans);
    font-feature-settings: 'tnum' 1;
    background: var(--bg);
    color: var(--fg);
    margin: 0;
    padding: 20px 24px 40px;
  }
  /* --- top bar --- */
  .topbar {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    padding: 4px 2px 14px;
    border-bottom: 1px solid var(--border);
    margin-bottom: 16px;
    gap: 16px;
  }
  .crest { display: flex; gap: 10px; align-items: baseline; }
  .brand {
    font-family: var(--mono);
    font-weight: 600;
    letter-spacing: 0.22em;
    font-size: 11px;
    color: var(--accent);
    text-transform: uppercase;
  }
  .crest .sep { color: var(--border); font-family: var(--mono); }
  .crest .project-name {
    font-family: var(--condensed);
    text-transform: uppercase;
    letter-spacing: 0.14em;
    font-size: 13px;
    font-weight: 600;
    color: var(--fg);
  }
  .stamp {
    font-family: var(--mono);
    font-variant-numeric: tabular-nums;
    font-size: 11px;
    color: var(--muted);
    letter-spacing: 0.02em;
  }
  .stamp a { color: var(--muted); }
  .stamp a:hover { color: var(--fg); }

  /* --- status strip --- */
  .status-strip {
    position: sticky;
    top: 0;
    z-index: 10;
    background: var(--bg);
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    padding: 12px 0;
    margin-bottom: 18px;
    border-bottom: 1px solid var(--border);
  }
  .strip-cell {
    display: inline-flex;
    align-items: baseline;
    gap: 10px;
    padding: 8px 14px 9px;
    background: var(--card);
    color: var(--fg);
    text-decoration: none;
    border: 1px solid var(--border);
    border-radius: 3px;
    transition: background 120ms ease, border-color 120ms ease;
  }
  .strip-cell:hover { background: var(--card-hi); border-color: var(--muted); text-decoration: none; }
  .strip-label {
    font-family: var(--condensed);
    font-size: 10px;
    letter-spacing: 0.18em;
    color: var(--muted);
    text-transform: uppercase;
    font-weight: 600;
  }
  .strip-value {
    font-family: var(--mono);
    font-variant-numeric: tabular-nums;
    font-weight: 500;
    font-size: 15px;
    letter-spacing: -0.01em;
    line-height: 1;
  }

  /* --- lede panel (morning plan) --- */
  .lede { margin-bottom: 20px; }
  .lede .widget-wrap { position: relative; }
  .lede .card {
    border-left: 3px solid var(--accent);
    padding: 22px 28px;
    background: var(--card);
  }
  .lede .card h2 {
    margin-bottom: 14px;
  }
  .lede .card p,
  .lede .card > *:not(h2) {
    font-family: var(--sans);
    font-size: 17px;
    line-height: 1.5;
    color: var(--fg);
    letter-spacing: -0.005em;
    font-weight: 400;
  }
  .lede .card p { margin: 0; }

  /* --- grid --- */
  main { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
  @media (max-width: 900px) { main { grid-template-columns: 1fr; } }

  /* --- cards --- */
  .card {
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 20px 24px;
    position: relative;
    transition: opacity 180ms ease;
  }
  .card.tone-red    { border-left: 3px solid var(--error);   padding-left: 21px; }
  .card.tone-amber  { border-left: 3px solid var(--warning); padding-left: 21px; }
  .card.tone-green  { opacity: 0.72; }
  .card.tone-green:hover { opacity: 1; }

  .card h2 {
    margin: 0 0 14px;
    padding-right: 36px;
    display: flex;
    align-items: baseline;
    gap: 10px;
    font-family: var(--condensed);
    text-transform: uppercase;
    letter-spacing: 0.14em;
    font-size: 11px;
    font-weight: 600;
    color: var(--muted);
  }
  .card h2 > span:first-child { color: var(--fg); }
  .card h2 .hero {
    font-family: var(--mono);
    font-variant-numeric: tabular-nums;
    font-size: 28px;
    line-height: 1;
    font-weight: 500;
    letter-spacing: -0.03em;
    text-transform: none;
    margin-left: auto;
  }
  .card h2 .hero-label {
    font-family: var(--condensed);
    font-size: 10px;
    color: var(--muted);
    text-transform: uppercase;
    letter-spacing: 0.14em;
    margin-left: 6px;
    font-weight: 500;
  }
  .card h2 .spark { margin-left: 10px; display: inline-flex; align-items: center; opacity: 0.85; }
  .card h3 {
    font-family: var(--condensed);
    text-transform: uppercase;
    letter-spacing: 0.12em;
    font-size: 11px;
    font-weight: 600;
    color: var(--fg);
    margin: 18px 0 8px;
  }

  /* --- tone helpers --- */
  .dot { display: inline-block; margin-right: 6px; line-height: 1; font-size: 10px; vertical-align: baseline; }
  .dot-red   { color: var(--error); }
  .dot-amber { color: var(--warning); }
  .dot-green { color: var(--success); }
  .dot-muted { color: var(--muted); }
  .tone-red    { color: var(--error); }
  .tone-amber  { color: var(--warning); }
  .tone-green  { color: var(--success); }
  .tone-muted  { color: var(--muted); }

  /* --- lists + rows --- */
  ul { list-style: none; padding: 0; margin: 0; }
  li { padding: 9px 0; border-bottom: 1px solid var(--rule); }
  li:last-child { border-bottom: none; }
  a { color: var(--accent); text-decoration: none; }
  a:hover { text-decoration: underline; }
  .repo {
    color: var(--muted);
    margin-right: 6px;
    font-family: var(--mono);
    font-size: 12px;
    letter-spacing: 0;
  }
  .num {
    color: var(--muted);
    margin-right: 6px;
    font-family: var(--mono);
    font-variant-numeric: tabular-nums;
    font-size: 12px;
  }
  .title { color: var(--fg); }
  .count {
    color: var(--muted);
    font-weight: normal;
    font-size: 11px;
    margin-left: 6px;
    font-family: var(--mono);
    font-variant-numeric: tabular-nums;
    letter-spacing: 0;
  }
  .tag {
    background: #161b22;
    color: var(--muted);
    border-radius: 2px;
    padding: 1px 6px;
    font-size: 10px;
    letter-spacing: 0.04em;
    margin-right: 6px;
    font-family: var(--condensed);
    text-transform: uppercase;
  }
  .meta {
    display: block;
    color: var(--muted);
    font-family: var(--mono);
    font-variant-numeric: tabular-nums;
    font-size: 11px;
    margin-top: 3px;
    letter-spacing: 0;
  }
  .desc { color: var(--fg); font-size: 12px; margin-top: 4px; opacity: 0.85; }
  .muted { color: var(--muted); }
  .ok    { color: var(--success); }
  .warn  { color: var(--warning); }
  .error {
    color: var(--error);
    white-space: pre-wrap;
    font-family: var(--mono);
    font-size: 12px;
  }

  /* --- truncated list expand --- */
  details.more-items { margin: 0; padding: 0; }
  details.more-items > summary {
    list-style: none;
    cursor: pointer;
    color: var(--muted);
    font-family: var(--condensed);
    text-transform: uppercase;
    letter-spacing: 0.14em;
    font-size: 10px;
    font-weight: 500;
    padding: 10px 0;
    border-top: 1px solid var(--rule);
    user-select: none;
  }
  details.more-items > summary::-webkit-details-marker { display: none; }
  details.more-items > summary::marker { display: none; }
  details.more-items > summary::before {
    content: "+";
    display: inline-block;
    margin-right: 8px;
    font-family: var(--mono);
    transition: transform 150ms ease;
  }
  details.more-items[open] > summary::before { content: "−"; }
  details.more-items > summary:hover { color: var(--fg); }
  details.more-items > ul > li:first-child { border-top: 0; }

  /* --- checklist --- */
  .checklist { margin: 10px 0 2px; padding: 0; }
  .checklist li { padding: 3px 0; border: none; }
  .checklist label { display: inline-flex; align-items: center; gap: 8px; cursor: pointer; font-size: 13px; color: var(--fg); }
  .checklist input[type=checkbox] { margin: 0; cursor: pointer; accent-color: var(--accent); }
  .checklist li.done label { color: var(--muted); text-decoration: line-through; }

  /* --- widget wrap + refresh button --- */
  .widget-wrap { position: relative; transition: opacity 150ms ease; }
  .widget-wrap > .card { margin: 0; }
  .refresh-btn {
    position: absolute; top: 10px; right: 10px;
    width: 24px; height: 24px;
    display: inline-flex; align-items: center; justify-content: center;
    background: transparent; color: var(--muted);
    border: 1px solid var(--border); border-radius: 3px;
    cursor: pointer;
    font-family: var(--mono);
    font-size: 14px; line-height: 1;
    padding: 0;
    transition: color 120ms ease, border-color 120ms ease, transform 600ms ease;
    z-index: 2;
  }
  .refresh-btn:hover { color: var(--fg); border-color: var(--muted); }
  .refresh-btn:focus { outline: 1px solid var(--accent); outline-offset: 2px; }
  .widget-wrap.refreshing { opacity: 0.55; pointer-events: none; }
  .widget-wrap.refreshing .refresh-btn {
    animation: glance-spin 900ms linear infinite;
    pointer-events: none;
  }
  .widget-wrap.refresh-error .refresh-btn { color: var(--error); border-color: var(--error); }
  @keyframes glance-spin {
    from { transform: rotate(0deg); }
    to   { transform: rotate(360deg); }
  }
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

document.addEventListener('click', async (e) => {
  const target = e.target;
  if (!(target instanceof Element)) return;
  const btn = target.closest('[data-refresh]');
  if (!btn) return;
  e.preventDefault();
  const id = btn.getAttribute('data-refresh');
  if (!id) return;
  const wrap = btn.closest('[data-widget-id]');
  if (!wrap) return;
  wrap.classList.remove('refresh-error');
  wrap.classList.add('refreshing');
  try {
    const res = await fetch('/api/widget/' + encodeURIComponent(id) + '/refresh', { method: 'POST' });
    if (!res.ok) throw new Error('refresh failed: ' + res.status);
    const data = await res.json();
    if (typeof data.html !== 'string') throw new Error('bad response');
    const preservedBtn = wrap.querySelector(':scope > .refresh-btn');
    wrap.innerHTML = data.html;
    if (preservedBtn) wrap.appendChild(preservedBtn);
    else {
      const nb = document.createElement('button');
      nb.className = 'refresh-btn';
      nb.setAttribute('data-refresh', id);
      nb.setAttribute('aria-label', 'refresh');
      nb.textContent = '↻';
      wrap.appendChild(nb);
    }
  } catch {
    wrap.classList.add('refresh-error');
    setTimeout(() => wrap.classList.remove('refresh-error'), 2500);
  } finally {
    wrap.classList.remove('refreshing');
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

export type CardOpts = {
  hero?: Hero;
  sparkline?: string;
};

function renderHeader(title: string, opts?: CardOpts): string {
  const spark = opts?.sparkline ? `<span class="spark">${opts.sparkline}</span>` : '';
  let hero = '';
  if (opts?.hero) {
    const tone = opts.hero.tone ?? 'muted';
    const label = opts.hero.label ? `<span class="hero-label">${escape(opts.hero.label)}</span>` : '';
    hero = `<span class="hero tone-${tone}">${escape(String(opts.hero.value))}</span>${label}`;
  }
  return `<h2><span>${escape(title)}</span>${spark}${hero}</h2>`;
}

function cardToneClass(opts?: CardOpts): string {
  if (!opts?.hero?.tone) return '';
  return ` tone-${opts.hero.tone}`;
}

export function card(title: string, body: string, opts?: CardOpts): string {
  return `<section class="card${cardToneClass(opts)}">${renderHeader(title, opts)}${body}</section>`;
}

export function errorCard(title: string, message: string): string {
  return `<section class="card tone-red">${renderHeader(title)}<p class="error">${escape(message)}</p></section>`;
}

export function dot(tone: Tone): string {
  return `<span class="dot dot-${tone}">●</span>`;
}

export function sparkline(values: number[], opts: { width?: number; height?: number; tone?: Tone } = {}): string {
  if (values.length === 0) return '';
  const w = opts.width ?? 80;
  const h = opts.height ?? 14;
  const tone = opts.tone ?? 'muted';
  const color = { red: '#f85149', amber: '#d29922', green: '#3fb950', muted: '#8b949e' }[tone];
  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const range = max - min || 1;
  const stepX = values.length > 1 ? w / (values.length - 1) : w;
  const points = values.map((v, i) => {
    const x = i * stepX;
    const y = h - ((v - min) / range) * h;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  return `<svg class="sparkline" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true"><polyline fill="none" stroke="${color}" stroke-width="1.25" points="${points}"/></svg>`;
}

/**
 * Render a row of N squares (pass=green, fail=red, muted=gray) — used for CI-run histories
 * where points are categorical rather than numeric.
 */
export function sparkBar(cells: Array<'ok' | 'err' | 'muted'>, opts: { cellWidth?: number; height?: number; gap?: number } = {}): string {
  if (cells.length === 0) return '';
  const cw = opts.cellWidth ?? 4;
  const h = opts.height ?? 14;
  const gap = opts.gap ?? 1;
  const w = cells.length * cw + (cells.length - 1) * gap;
  const colorFor = (c: 'ok' | 'err' | 'muted') =>
    c === 'ok' ? '#3fb950' : c === 'err' ? '#f85149' : '#8b949e';
  const rects = cells.map((c, i) => {
    const x = i * (cw + gap);
    return `<rect x="${x}" y="0" width="${cw}" height="${h}" fill="${colorFor(c)}" opacity="${c === 'muted' ? 0.4 : 0.9}"/>`;
  }).join('');
  return `<svg class="sparkline" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-hidden="true">${rects}</svg>`;
}

export function truncatedList(
  rows: string[],
  options: { visible?: number; listClass?: string } = {},
): string {
  const visible = options.visible ?? 3;
  const classAttr = options.listClass ? ` class="${options.listClass}"` : '';
  if (rows.length <= visible) {
    return `<ul${classAttr}>${rows.join('')}</ul>`;
  }
  const head = rows.slice(0, visible).join('');
  const tail = rows.slice(visible).join('');
  const moreCount = rows.length - visible;
  return `<ul${classAttr}>${head}</ul><details class="more-items"><summary>Show ${moreCount} more</summary><ul${classAttr}>${tail}</ul></details>`;
}

const STRIP_LABELS: Record<string, string> = {
  prs: 'PR',
  linear: 'LIN',
  ci: 'CI',
  drift: 'DRIFT',
  crashlytics: 'CRASH',
  playConsole: 'PLAY',
  gitStatus: 'LOCAL',
  deadlines: 'DEAD',
  alerts: 'ALERT',
  calendar: 'CAL',
  feed: 'FEED',
  morningPlan: 'PLAN',
};

function stripLabel(id: string): string {
  return STRIP_LABELS[id] ?? id.slice(0, 5).toUpperCase();
}

function renderStatusStrip(sections: { id: string; hero?: Hero }[]): string {
  const cells = sections
    .filter(s => s.id !== 'morningPlan' && s.hero)
    .map(s => {
      const hero = s.hero!;
      const tone = hero.tone ?? 'muted';
      return `<a class="strip-cell" href="#w-${escape(s.id)}">
        <span class="strip-label">${escape(stripLabel(s.id))}</span>
        <span class="strip-value tone-${tone}">${escape(String(hero.value))}</span>
      </a>`;
    });
  if (cells.length === 0) return '';
  return `<nav class="status-strip" aria-label="status summary">${cells.join('')}</nav>`;
}

function wrapWidget(s: { id: string; html: string }): string {
  return `<div id="w-${escape(s.id)}" class="widget-wrap" data-widget-id="${escape(s.id)}">${s.html}<button class="refresh-btn" data-refresh="${escape(s.id)}" aria-label="refresh">↻</button></div>`;
}

export function renderProjectPage(
  project: ProjectConfig,
  sections: { id: string; html: string; hero?: Hero }[],
  generatedAt: Date,
): string {
  const lede = sections.find(s => s.id === 'morningPlan');
  const gridSections = sections.filter(s => s.id !== 'morningPlan');
  const ledeBlock = lede ? `<section class="lede">${wrapWidget(lede)}</section>` : '';
  const strip = renderStatusStrip(sections);
  const wrapped = gridSections.map(wrapWidget);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>glance · ${escape(project.displayName)}</title>
${FONT_LINKS}
${STYLE}
</head>
<body>
  <header class="topbar">
    <div class="crest">
      <span class="brand">GLANCE</span>
      <span class="sep">/</span>
      <span class="project-name">${escape(project.displayName)}</span>
    </div>
    <span class="stamp">UPDATED ${escape(generatedAt.toLocaleString())} · <a href="/settings">SETTINGS</a></span>
  </header>
  ${strip}
  ${ledeBlock}
  <main>
    ${wrapped.join('\n    ')}
  </main>
${DASHBOARD_SCRIPT}
</body>
</html>`;
}
