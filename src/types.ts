export type ProjectConfig = {
  displayName: string;
  github: {
    username: string;
    tokenEnv: string;
    extraQuery?: string;
  };
  widgets: Record<string, unknown>;
};

export type FieldSpec =
  | { type: 'string'; key: string; label: string; placeholder?: string; description?: string }
  | { type: 'multiline-list'; key: string; label: string; placeholder?: string; description?: string }
  | {
      type: 'object-list';
      key: string;
      label: string;
      fields: Array<{ key: string; label: string; placeholder?: string }>;
      description?: string;
    };

export type Tone = 'red' | 'amber' | 'green' | 'muted';

export type Hero = {
  value: string | number;
  tone?: Tone;
  label?: string;
};

export type WidgetResult = {
  html: string;
  summary?: unknown;
  hero?: Hero;
};

export type WidgetModule = {
  id: string;
  title: string;
  envVars?: string[] | ((project: ProjectConfig) => string[]);
  configFields?: FieldSpec[];
  run: (project: ProjectConfig) => Promise<WidgetResult>;
};

export type Result<T> =
  | { ok: true; data: T }
  | { ok: false; error: string };
