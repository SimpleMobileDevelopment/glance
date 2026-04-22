import type { ProjectConfig, Hero } from './types.ts';
import { REGISTRY } from './registry.ts';
import { safeRun } from './runtime.ts';
import { renderProjectPage } from './render.ts';

type WidgetRenderState = { html: string; hero?: Hero };

type PageState = {
  html: string;
  widgets: Map<string, WidgetRenderState>;
  generatedAt: Date;
};

const state: PageState = {
  html: '',
  widgets: new Map<string, WidgetRenderState>(),
  generatedAt: new Date(0),
};

export function getState(): PageState {
  return state;
}

function enabledWidgetsFor(project: ProjectConfig) {
  const widgetsConfig = project.widgets ?? {};
  return REGISTRY.filter(w => w.id in widgetsConfig);
}

function composeSections(project: ProjectConfig): { id: string; html: string; hero?: Hero }[] {
  const enabled = enabledWidgetsFor(project);
  const sections: { id: string; html: string; hero?: Hero }[] = [];
  for (const widget of enabled) {
    const entry = state.widgets.get(widget.id);
    if (entry) sections.push({ id: widget.id, html: entry.html, hero: entry.hero });
  }
  return sections;
}

export async function rebuildAll(project: ProjectConfig): Promise<void> {
  const enabled = enabledWidgetsFor(project);
  const results = await Promise.all(enabled.map(w => safeRun(w, project)));
  const newMap = new Map<string, WidgetRenderState>();
  enabled.forEach((w, i) => {
    newMap.set(w.id, { html: results[i].html, hero: results[i].hero });
  });
  state.widgets = newMap;
  state.generatedAt = new Date();
  const sections = enabled.map(w => ({
    id: w.id,
    html: newMap.get(w.id)?.html ?? '',
    hero: newMap.get(w.id)?.hero,
  }));
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
  state.widgets.set(widget.id, { html: result.html, hero: result.hero });
  state.generatedAt = new Date();
  const sections = composeSections(project);
  state.html = renderProjectPage(project, sections, state.generatedAt);
  return result.html;
}
