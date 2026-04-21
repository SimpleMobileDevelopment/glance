import { readFile, writeFile, mkdir } from 'node:fs/promises';
import type { ProjectConfig } from './src/types.ts';
import { renderProjectPage } from './src/render.ts';
import { REGISTRY } from './src/registry.ts';

const PROJECT_FILE = 'project.json';
const OUT_DIR = 'dist';

async function loadProject(): Promise<ProjectConfig> {
  const raw = await readFile(PROJECT_FILE, 'utf8');
  return JSON.parse(raw) as ProjectConfig;
}

const project = await loadProject();
const widgetsConfig = project.widgets ?? {};
const enabled = REGISTRY.filter(w => w.id in widgetsConfig);
const sections = await Promise.all(enabled.map(w => w.run(project)));
const html = renderProjectPage(project, sections, new Date());

await mkdir(OUT_DIR, { recursive: true });
await writeFile(`${OUT_DIR}/index.html`, html, 'utf8');
console.log(`wrote ${OUT_DIR}/index.html`);
