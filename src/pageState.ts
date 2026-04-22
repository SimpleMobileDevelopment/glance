import type { ProjectConfig } from './types.ts';
import { REGISTRY } from './registry.ts';
import { safeRun } from './runtime.ts';
import { renderProjectPage } from './render.ts';

type PageState = {
  html: string;
  widgetHtml: Map<string, string>;
  generatedAt: Date;
};

const state: PageState = {
  html: '',
  widgetHtml: new Map<string, string>(),
  generatedAt: new Date(0),
};

export function getState(): PageState {
  return state;
}

function enabledWidgetsFor(project: ProjectConfig) {
  const widgetsConfig = project.widgets ?? {};
  return REGISTRY.filter(w => w.id in widgetsConfig);
}

function composeSections(project: ProjectConfig): { id: string; html: string }[] {
  const enabled = enabledWidgetsFor(project);
  const sections: { id: string; html: string }[] = [];
  for (const widget of enabled) {
    const html = state.widgetHtml.get(widget.id);
    if (html) sections.push({ id: widget.id, html });
  }
  return sections;
}

export async function rebuildAll(project: ProjectConfig): Promise<void> {
  const enabled = enabledWidgetsFor(project);
  const results = await Promise.all(enabled.map(w => safeRun(w, project)));
  const newMap = new Map<string, string>();
  enabled.forEach((w, i) => {
    newMap.set(w.id, results[i].html);
  });
  state.widgetHtml = newMap;
  state.generatedAt = new Date();
  const sections = enabled.map(w => ({ id: w.id, html: newMap.get(w.id) ?? '' }));
  state.html = renderProjectPage(project, sections, state.generatedAt);
}

export async function refreshWidget(
  project: ProjectConfig,
  widgetId: string,
): Promise<string> {
  const widget = REGISTRY.find(w => w.id === widgetId);
  if (!widget) throw new Error(`unknown widget: ${widgetId}`);
  const widgetsConfig = project.widgets ?? {};
  if (!(widget.id in widgetsConfig)) {
    throw new Error(`widget not enabled: ${widgetId}`);
  }
  const result = await safeRun(widget, project);
  state.widgetHtml.set(widget.id, result.html);
  state.generatedAt = new Date();
  const sections = composeSections(project);
  state.html = renderProjectPage(project, sections, state.generatedAt);
  return result.html;
}
