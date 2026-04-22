import { readFile, writeFile, mkdir } from 'node:fs/promises';
import type { ProjectConfig } from './src/types.ts';
import { renderProjectPage } from './src/render.ts';
import { REGISTRY } from './src/registry.ts';
import { safeRun } from './src/runtime.ts';
import { parseProject } from './src/schema.ts';

const PROJECT_FILE = 'project.json';
const OUT_DIR = 'dist';

async function loadProject(): Promise<ProjectConfig> {
  const raw = await readFile(PROJECT_FILE, 'utf8');
  const parsed = parseProject(JSON.parse(raw));
  if (!parsed.ok) {
    console.warn(`[project.json] schema issues:\n  ${parsed.issues.join('\n  ')}`);
    return JSON.parse(raw) as ProjectConfig;
  }
  return parsed.project;
}

const project = await loadProject();
const widgetsConfig = project.widgets ?? {};
const enabled = REGISTRY.filter(w => w.id in widgetsConfig);
const results = await Promise.all(enabled.map(w => safeRun(w, project)));
const sections = enabled.map((w, i) => ({ id: w.id, html: results[i].html }));
const html = renderProjectPage(project, sections, new Date());

await mkdir(OUT_DIR, { recursive: true });
await writeFile(`${OUT_DIR}/index.html`, html, 'utf8');
console.log(`wrote ${OUT_DIR}/index.html`);
