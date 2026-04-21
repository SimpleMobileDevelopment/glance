import { STYLE, escape } from './render.ts';
import type { FieldSpec, ProjectConfig, WidgetModule } from './types.ts';

export type EnvVar = { name: string; set: boolean; usedBy: string[] };
export type GoogleStatus = {
  clientConfigured: boolean;
  connected: boolean;
  email?: string;
  connectedAt?: string;
};

const SETTINGS_STYLE = `<style>
  .settings { max-width: 920px; margin: 0 auto; }
  .settings .card { margin-bottom: 16px; }
  textarea {
    width: 100%; min-height: 120px;
    background: #0e1116; color: var(--fg);
    border: 1px solid var(--border); border-radius: 6px;
    padding: 10px; font: 12px/1.5 ui-monospace, monospace;
    resize: vertical;
  }
  input, select {
    background: #0e1116; color: var(--fg);
    border: 1px solid var(--border); border-radius: 6px;
    padding: 8px 12px; font: 13px ui-sans-serif, system-ui, sans-serif;
  }
  input { width: 100%; }
  button {
    background: var(--accent); color: #0e1116; border: none;
    padding: 8px 16px; border-radius: 6px; cursor: pointer;
    font: 13px ui-sans-serif, system-ui, sans-serif; font-weight: 500;
  }
  button:hover { opacity: 0.9; }
  button.secondary { background: transparent; color: var(--fg); border: 1px solid var(--border); }
  .row { display: flex; gap: 8px; margin-top: 8px; align-items: center; }
  .row > input, .row > select { flex: 1; }
  .field { margin: 12px 0; }
  .field label { display: block; font-size: 12px; color: var(--muted); margin-bottom: 4px; text-transform: uppercase; letter-spacing: 0.5px; }
  .field .desc { font-size: 11px; color: var(--muted); margin-top: 4px; opacity: 0.7; }
  .widget { border-top: 1px solid var(--border); padding-top: 12px; margin-top: 16px; }
  .widget > label.toggle { display: flex; align-items: center; gap: 8px; font-size: 13px; cursor: pointer; }
  .widget > label.toggle input { width: auto; }
  .widget-fields { margin-top: 8px; padding-left: 24px; }
  .env-row { display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid var(--border); align-items: center; gap: 12px; }
  .env-row:last-of-type { border-bottom: none; }
  .env-row code { font: 12px ui-monospace, monospace; color: var(--fg); }
  .env-row .used { color: var(--muted); font-size: 11px; }
  .actions { display: flex; gap: 8px; margin-top: 16px; align-items: center; }
  #status { color: var(--muted); font-size: 12px; }
  #status.ok { color: var(--success); }
  #status.error { color: var(--error); }
</style>`;

function renderField(field: FieldSpec, value: unknown, widgetId: string): string {
  const path = `${widgetId}.${field.key}`;
  const label = `<label>${escape(field.label)}</label>`;
  const desc = field.description ? `<div class="desc">${escape(field.description)}</div>` : '';

  if (field.type === 'string') {
    const val = typeof value === 'string' ? value : '';
    return `<div class="field">
      ${label}
      <input data-widget-field="${escape(path)}" data-type="string" value="${escape(val)}" placeholder="${escape(field.placeholder ?? '')}" />
      ${desc}
    </div>`;
  }

  if (field.type === 'multiline-list') {
    const val = Array.isArray(value) ? value.join('\n') : '';
    return `<div class="field">
      ${label}
      <textarea data-widget-field="${escape(path)}" data-type="multiline-list" placeholder="${escape(field.placeholder ?? '')}">${escape(val)}</textarea>
      ${desc}
    </div>`;
  }

  // object-list
  const items = Array.isArray(value) ? value as Array<Record<string, unknown>> : [];
  const lines = items
    .map(item => field.fields.map(f => String(item[f.key] ?? '')).join(' | '))
    .join('\n');
  return `<div class="field">
    ${label}
    <textarea data-widget-field="${escape(path)}" data-type="object-list" data-object-keys="${escape(field.fields.map(f => f.key).join(','))}" placeholder="${escape(field.fields.map(f => f.placeholder ?? f.label).join(' | '))}">${escape(lines)}</textarea>
    ${desc}
  </div>`;
}

function renderWidgetSection(widget: WidgetModule, widgetCfg: unknown, enabled: boolean): string {
  const fields = (widget.configFields ?? [])
    .map(f => renderField(f, (widgetCfg && typeof widgetCfg === 'object') ? (widgetCfg as Record<string, unknown>)[f.key] : undefined, widget.id))
    .join('');
  const fieldsBlock = widget.configFields && widget.configFields.length > 0
    ? `<div class="widget-fields">${fields}</div>`
    : '';
  return `<div class="widget" data-widget="${escape(widget.id)}">
    <label class="toggle">
      <input type="checkbox" data-enable="${escape(widget.id)}" ${enabled ? 'checked' : ''} />
      <strong>${escape(widget.title)}</strong>
      <span class="muted">(${escape(widget.id)})</span>
    </label>
    ${fieldsBlock}
  </div>`;
}

function renderProjectForm(project: ProjectConfig | null, registry: WidgetModule[]): string {
  const widgetsCfg = project?.widgets ?? {};
  const widgetSections = registry
    .map(w => renderWidgetSection(w, widgetsCfg[w.id], w.id in widgetsCfg))
    .join('');

  return `<form id="project-form">
    <div class="field">
      <label>Display name</label>
      <input data-path="displayName" value="${escape(project?.displayName ?? '')}" placeholder="My Project" />
    </div>
    <div class="field">
      <label>GitHub username</label>
      <input data-path="github.username" value="${escape(project?.github?.username ?? '')}" placeholder="your-github-handle" />
    </div>
    <div class="field">
      <label>GitHub token env var</label>
      <input data-path="github.tokenEnv" value="${escape(project?.github?.tokenEnv ?? 'GITHUB_TOKEN')}" placeholder="GITHUB_TOKEN" />
      <div class="desc">Name of the env var that holds the GitHub token.</div>
    </div>
    ${widgetSections}
    <div class="actions">
      <button type="button" onclick="saveProject()">Save project.json</button>
    </div>
  </form>`;
}

function renderGoogleCard(status: GoogleStatus): string {
  if (!status.clientConfigured) {
    return `<section class="card">
      <h2>Google connection</h2>
      <p class="muted">Set <code>GOOGLE_OAUTH_CLIENT_ID</code> and <code>GOOGLE_OAUTH_CLIENT_SECRET</code> below. See <code>.env.example</code> for one-time GCP Console setup steps.</p>
    </section>`;
  }
  if (!status.connected) {
    return `<section class="card">
      <h2>Google connection</h2>
      <p class="muted">Shared credential for Play Console + Firebase widgets.</p>
      <div class="actions">
        <a href="/oauth/google/start"><button>Connect Google</button></a>
      </div>
    </section>`;
  }
  const when = status.connectedAt ? new Date(status.connectedAt).toLocaleString() : '';
  return `<section class="card">
    <h2>Google connection</h2>
    <p>Connected as <code>${escape(status.email ?? '(unknown)')}</code>${when ? ` · since ${escape(when)}` : ''}</p>
    <div class="actions">
      <a href="/oauth/google/start"><button class="secondary">Reconnect</button></a>
      <button class="secondary" onclick="disconnectGoogle()">Disconnect</button>
    </div>
  </section>`;
}

export function renderSettings(
  project: ProjectConfig | null,
  envVars: EnvVar[],
  knownEnvNames: string[],
  registry: WidgetModule[],
  googleStatus: GoogleStatus,
): string {
  const envRows = envVars.length === 0
    ? '<p class="muted">No environment variables defined yet.</p>'
    : envVars.map(v => `
      <div class="env-row">
        <div>
          <code>${escape(v.name)}</code>
          ${v.usedBy.length > 0 ? `<div class="used">used by ${escape(v.usedBy.join(', '))}</div>` : ''}
        </div>
        <span class="${v.set ? 'ok' : 'muted'}">${v.set ? 'set' : 'missing'}</span>
      </div>`).join('');

  const knownOptions = knownEnvNames
    .map(n => `<option value="${escape(n)}">${escape(n)}</option>`)
    .join('');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>glance · settings</title>
${STYLE}
${SETTINGS_STYLE}
</head>
<body>
<div class="settings">
  <header>
    <div class="left">
      <h1>Settings</h1>
      <span class="crumb"><a href="/">← dashboard</a></span>
    </div>
    <div class="actions">
      <button class="secondary" onclick="refresh()">Refresh now</button>
      <span id="status"></span>
    </div>
  </header>

  ${renderGoogleCard(googleStatus)}

  <section class="card">
    <h2>Environment variables</h2>
    <p class="muted">Secrets are never displayed. Use the form below to set or rotate values; saving triggers an immediate rebuild.</p>
    ${envRows}
    <h3>Set or replace</h3>
    <div class="row">
      <input list="env-suggestions" id="env-name" placeholder="GITHUB_TOKEN" autocomplete="off" />
      <input id="env-value" type="password" placeholder="paste value" autocomplete="off" />
      <button onclick="saveEnv()">Save</button>
    </div>
    <datalist id="env-suggestions">${knownOptions}</datalist>
  </section>

  <section class="card">
    <h2>Project</h2>
    ${renderProjectForm(project, registry)}
  </section>
</div>

<script>
const status = document.getElementById('status');
function setStatus(msg, kind) {
  status.textContent = msg;
  status.className = kind || '';
  if (msg) setTimeout(() => { status.textContent = ''; status.className = ''; }, 5000);
}

function setPath(obj, path, value) {
  const parts = path.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (typeof cur[parts[i]] !== 'object' || cur[parts[i]] === null) cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = value;
}

function parseFieldValue(el) {
  const type = el.dataset.type;
  if (type === 'string') return el.value.trim();
  if (type === 'multiline-list') {
    return el.value.split('\\n').map(s => s.trim()).filter(Boolean);
  }
  if (type === 'object-list') {
    const keys = (el.dataset.objectKeys || '').split(',');
    return el.value.split('\\n').map(s => s.trim()).filter(Boolean).map(line => {
      const parts = line.split('|').map(p => p.trim());
      const obj = {};
      keys.forEach((k, i) => { obj[k] = parts[i] || ''; });
      return obj;
    });
  }
  return el.value;
}

function buildProjectJson(form) {
  const obj = { displayName: '', github: {}, widgets: {} };
  form.querySelectorAll('[data-path]').forEach(el => {
    const v = el.value.trim();
    if (v) setPath(obj, el.dataset.path, v);
  });
  form.querySelectorAll('[data-widget]').forEach(widgetEl => {
    const id = widgetEl.dataset.widget;
    const enableEl = widgetEl.querySelector('[data-enable="' + id + '"]');
    if (!enableEl || !enableEl.checked) return;
    const cfg = {};
    widgetEl.querySelectorAll('[data-widget-field]').forEach(field => {
      const key = field.dataset.widgetField.split('.').slice(1).join('.');
      const val = parseFieldValue(field);
      const isEmpty = val === '' || val === null || val === undefined ||
                      (Array.isArray(val) && val.length === 0);
      if (!isEmpty) cfg[key] = val;
    });
    obj.widgets[id] = cfg;
  });
  return obj;
}

async function saveProject() {
  const form = document.getElementById('project-form');
  const obj = buildProjectJson(form);
  setStatus('Saving…');
  const res = await fetch('/api/project', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(obj, null, 2),
  });
  setStatus(res.ok ? 'Saved & rebuilding…' : 'Save failed: ' + await res.text(), res.ok ? 'ok' : 'error');
}

async function saveEnv() {
  const name = document.getElementById('env-name').value.trim();
  const value = document.getElementById('env-value').value;
  if (!name) { setStatus('Name required', 'error'); return; }
  if (!value) { setStatus('Value required', 'error'); return; }
  setStatus('Saving…');
  const res = await fetch('/api/env', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, value }),
  });
  if (res.ok) {
    document.getElementById('env-value').value = '';
    setStatus('Saved & rebuilding… reload page to see status', 'ok');
  } else {
    setStatus('Save failed: ' + await res.text(), 'error');
  }
}

async function refresh() {
  setStatus('Rebuilding…');
  const res = await fetch('/api/refresh', { method: 'POST' });
  setStatus(res.ok ? 'Rebuilding…' : 'Failed', res.ok ? 'ok' : 'error');
}

async function disconnectGoogle() {
  if (!confirm('Disconnect Google? Play Console and Firebase widgets will stop updating until you reconnect.')) return;
  setStatus('Disconnecting…');
  const res = await fetch('/api/oauth/google/disconnect', { method: 'POST' });
  if (res.ok) { window.location.reload(); }
  else { setStatus('Disconnect failed: ' + await res.text(), 'error'); }
}
</script>
</body>
</html>`;
}
