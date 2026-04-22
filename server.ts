import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync, watch } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { renderSettings, type EnvVar } from './src/settings.ts';
import { REGISTRY } from './src/registry.ts';
import type { ProjectConfig } from './src/types.ts';
import { parseProject } from './src/schema.ts';
import { readState as readChecklistState, toggleItem as toggleChecklistItem } from './src/releaseChecklist.ts';
import { rebuildAll, refreshWidget, getState } from './src/pageState.ts';
import {
  buildAuthUrl,
  completeAuthFlow,
  disconnect as disconnectGoogle,
  hasOAuthClient,
  hasRefreshToken,
  readAuthState,
} from './src/auth/google.ts';

const PORT = Number(process.env.PORT ?? 4321);
const DIST_DIR = 'dist';
const PROJECT_FILE = 'project.json';
const ENV_FILE = '.env';
const ENV_EXAMPLE = '.env.example';
const REBUILD_INTERVAL_MS = 15 * 60 * 1000;

let buildInProgress = false;
let buildQueued = false;

async function rebuild(): Promise<void> {
  if (buildInProgress) {
    buildQueued = true;
    return;
  }
  buildInProgress = true;
  console.log('[build] start');
  const start = Date.now();
  try {
    if (process.env.GLANCE_FORK_BUILD === '1') {
      await new Promise<void>((resolve, reject) => {
        const child = spawn(process.execPath, ['--env-file-if-exists=.env', 'mission-control.ts'], {
          stdio: 'inherit',
        });
        child.on('exit', code => code === 0 ? resolve() : reject(new Error(`build exit ${code}`)));
        child.on('error', reject);
      });
    } else {
      const project = await loadProject();
      if (!project) throw new Error('project.json missing or invalid');
      await rebuildAll(project);
    }
    console.log(`[build] done in ${Date.now() - start}ms`);
  } catch (e) {
    console.error('[build] failed:', (e as Error).message);
  } finally {
    buildInProgress = false;
    if (buildQueued) {
      buildQueued = false;
      rebuild().catch(e => console.error('[build] queued failed:', e.message));
    }
  }
}

function contentType(p: string): string {
  if (p.endsWith('.html')) return 'text/html; charset=utf-8';
  if (p.endsWith('.css'))  return 'text/css; charset=utf-8';
  if (p.endsWith('.js'))   return 'text/javascript; charset=utf-8';
  if (p.endsWith('.json')) return 'application/json; charset=utf-8';
  if (p.endsWith('.svg'))  return 'image/svg+xml';
  return 'text/plain; charset=utf-8';
}

async function serveStatic(res: ServerResponse, fsPath: string): Promise<boolean> {
  if (!existsSync(fsPath)) return false;
  const data = await readFile(fsPath);
  res.writeHead(200, { 'Content-Type': contentType(fsPath), 'Cache-Control': 'no-cache' });
  res.end(data);
  return true;
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

async function loadProject(): Promise<ProjectConfig | null> {
  if (!existsSync(PROJECT_FILE)) return null;
  const raw = await readFile(PROJECT_FILE, 'utf8');
  const json = JSON.parse(raw);
  const parsed = parseProject(json);
  if (!parsed.ok) {
    console.warn(`[project.json] schema issues:\n  ${parsed.issues.join('\n  ')}`);
    return json as ProjectConfig;
  }
  return parsed.project;
}

function computeEnvVarUsage(project: ProjectConfig | null): Map<string, Set<string>> {
  const usage = new Map<string, Set<string>>();
  if (!project) return usage;
  const enabledWidgets = project.widgets ?? {};
  for (const widget of REGISTRY) {
    if (!(widget.id in enabledWidgets)) continue;
    if (!widget.envVars) continue;
    const names = typeof widget.envVars === 'function' ? widget.envVars(project) : widget.envVars;
    for (const name of names) {
      if (!usage.has(name)) usage.set(name, new Set());
      usage.get(name)!.add(widget.id);
    }
  }
  return usage;
}

function parseEnvLines(content: string): { name: string; value: string }[] {
  return content
    .split(/\r?\n/)
    .map(line => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return null;
      const eq = trimmed.indexOf('=');
      if (eq < 0) return null;
      return { name: trimmed.slice(0, eq).trim(), value: trimmed.slice(eq + 1).trim() };
    })
    .filter((v): v is { name: string; value: string } => !!v && /^[A-Z_][A-Z0-9_]*$/.test(v.name));
}

async function readEnvVars(usage: Map<string, Set<string>>): Promise<EnvVar[]> {
  const content = existsSync(ENV_FILE) ? await readFile(ENV_FILE, 'utf8') : '';
  const fromFile = parseEnvLines(content).map(({ name, value }) => ({
    name,
    set: value !== '' && !value.includes('replace_me'),
    usedBy: [...(usage.get(name) ?? [])].sort(),
  }));
  const inFile = new Set(fromFile.map(v => v.name));
  for (const name of usage.keys()) {
    if (!inFile.has(name)) {
      fromFile.push({ name, set: false, usedBy: [...(usage.get(name) ?? [])].sort() });
    }
  }
  fromFile.sort((a, b) => a.name.localeCompare(b.name));
  return fromFile;
}

async function knownEnvNames(): Promise<string[]> {
  const sources = [ENV_EXAMPLE, ENV_FILE].filter(existsSync);
  const names = new Set<string>();
  for (const src of sources) {
    const content = await readFile(src, 'utf8');
    for (const { name } of parseEnvLines(content)) names.add(name);
  }
  return [...names].sort();
}

async function upsertEnvVar(name: string, value: string): Promise<void> {
  const lines = existsSync(ENV_FILE) ? (await readFile(ENV_FILE, 'utf8')).split(/\r?\n/) : [];
  const re = new RegExp(`^\\s*${name}\\s*=`);
  let updated = false;
  const newLines = lines.map(l => {
    if (re.test(l)) { updated = true; return `${name}=${value}`; }
    return l;
  });
  if (!updated) {
    if (newLines.length > 0 && newLines[newLines.length - 1] !== '') newLines.push('');
    newLines.push(`${name}=${value}`);
  }
  await writeFile(ENV_FILE, newLines.join('\n'));
}

function isValidEnvName(name: string): boolean {
  return /^[A-Z_][A-Z0-9_]*$/.test(name);
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const method = req.method ?? 'GET';

    if (method === 'POST' && url.pathname === '/api/refresh') {
      rebuild().catch(e => console.error('[refresh]', e.message));
      res.writeHead(202, { 'Content-Type': 'application/json' }).end('{"ok":true}');
      return;
    }

    if (
      method === 'POST' &&
      url.pathname.startsWith('/api/widget/') &&
      url.pathname.endsWith('/refresh')
    ) {
      const id = url.pathname.slice('/api/widget/'.length, -'/refresh'.length);
      if (!id || id.includes('/')) {
        res.writeHead(400, { 'Content-Type': 'text/plain' }).end('invalid widget id');
        return;
      }
      const project = await loadProject();
      if (!project) {
        res.writeHead(500, { 'Content-Type': 'text/plain' }).end('project.json missing');
        return;
      }
      if (!REGISTRY.some(w => w.id === id)) {
        res.writeHead(404, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'unknown widget' }));
        return;
      }
      try {
        const html = await refreshWidget(project, id);
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ html }));
      } catch (e) {
        const msg = (e as Error).message;
        if (/unknown widget|not enabled/i.test(msg)) {
          res.writeHead(404, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: msg }));
        } else {
          res.writeHead(500, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: msg }));
        }
      }
      return;
    }

    if (method === 'GET' && url.pathname === '/oauth/google/start') {
      try {
        const redirectUri = `http://${req.headers.host ?? `127.0.0.1:${PORT}`}/oauth/google/callback`;
        const { url: authUrl } = buildAuthUrl(redirectUri);
        res.writeHead(302, { Location: authUrl }).end();
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'text/plain' }).end((e as Error).message);
      }
      return;
    }

    if (method === 'GET' && url.pathname === '/oauth/google/callback') {
      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');
      const oauthError = url.searchParams.get('error');
      if (oauthError) {
        res.writeHead(400, { 'Content-Type': 'text/plain' }).end(`OAuth error: ${oauthError}`);
        return;
      }
      if (!code || !state) {
        res.writeHead(400, { 'Content-Type': 'text/plain' }).end('Missing code or state.');
        return;
      }
      try {
        await completeAuthFlow(code, state);
        rebuild().catch(e => console.error('[rebuild]', e.message));
        res.writeHead(302, { Location: '/settings?connected=1' }).end();
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'text/plain' }).end((e as Error).message);
      }
      return;
    }

    if (method === 'POST' && url.pathname === '/api/oauth/google/disconnect') {
      try {
        await disconnectGoogle();
        res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"ok":true}');
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'text/plain' }).end((e as Error).message);
      }
      return;
    }

    if (method === 'POST' && url.pathname === '/api/project') {
      const body = await readBody(req);
      try { JSON.parse(body); } catch (e) { res.writeHead(400).end(`invalid JSON: ${(e as Error).message}`); return; }
      await writeFile(PROJECT_FILE, body);
      rebuild().catch(e => console.error('[rebuild]', e.message));
      res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"ok":true}');
      return;
    }

    if (method === 'GET' && url.pathname === '/api/checklist') {
      const state = await readChecklistState();
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(state));
      return;
    }

    if (method === 'POST' && url.pathname === '/api/checklist') {
      const body = await readBody(req);
      let parsed: { key?: unknown; item?: unknown; checked?: unknown };
      try { parsed = JSON.parse(body); } catch { res.writeHead(400).end('invalid JSON'); return; }
      const key = String(parsed.key ?? '').trim();
      const item = String(parsed.item ?? '').trim();
      const checked = Boolean(parsed.checked);
      if (!key || !item) { res.writeHead(400).end('key and item required'); return; }
      await toggleChecklistItem(key, item, checked);
      res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"ok":true}');
      return;
    }

    if (method === 'POST' && url.pathname === '/api/env') {
      const body = await readBody(req);
      let parsed: { name?: unknown; value?: unknown };
      try { parsed = JSON.parse(body); } catch { res.writeHead(400).end('invalid JSON'); return; }
      const name = String(parsed.name ?? '').trim();
      const value = String(parsed.value ?? '');
      if (!isValidEnvName(name)) { res.writeHead(400).end('invalid env var name'); return; }
      if (value === '') { res.writeHead(400).end('value required'); return; }
      await upsertEnvVar(name, value);
      rebuild().catch(e => console.error('[rebuild]', e.message));
      res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"ok":true}');
      return;
    }

    if (method === 'GET' && url.pathname === '/settings') {
      const project = await loadProject();
      const usage = computeEnvVarUsage(project);
      const [env, known, googleState] = await Promise.all([
        readEnvVars(usage),
        knownEnvNames(),
        readAuthState(),
      ]);
      const googleStatus = {
        clientConfigured: hasOAuthClient(),
        connected: hasRefreshToken(),
        email: googleState.email,
        connectedAt: googleState.connectedAt,
      };
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(renderSettings(project, env, known, REGISTRY, googleStatus));
      return;
    }

    if (method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      const mem = getState().html;
      if (mem) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
        res.end(mem);
        return;
      }
    }

    const fsPath = path.join(DIST_DIR, url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\//, ''));
    if (await serveStatic(res, fsPath)) return;

    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found');
  } catch (e) {
    console.error('[server]', e);
    res.writeHead(500, { 'Content-Type': 'text/plain' }).end((e as Error).message);
  }
});

setInterval(() => {
  rebuild().catch(e => console.error('[scheduled]', e.message));
}, REBUILD_INTERVAL_MS);

let projectWatchTimer: NodeJS.Timeout | null = null;
try {
  watch(PROJECT_FILE, () => {
    if (projectWatchTimer) clearTimeout(projectWatchTimer);
    projectWatchTimer = setTimeout(() => {
      projectWatchTimer = null;
      console.log(`[watch] ${PROJECT_FILE} changed, rebuilding`);
      rebuild().catch(e => console.error('[watch]', e.message));
    }, 250);
  });
} catch (e) {
  console.warn(`[watch] could not watch ${PROJECT_FILE}:`, (e as Error).message);
}

rebuild().catch(e => console.error('[initial]', e.message));

server.listen(PORT, '127.0.0.1', () => {
  console.log(`glance:   http://127.0.0.1:${PORT}/`);
  console.log(`settings: http://127.0.0.1:${PORT}/settings`);
});
