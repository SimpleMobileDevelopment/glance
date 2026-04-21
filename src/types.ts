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

export type WidgetModule = {
  id: string;
  title: string;
  envVars?: string[] | ((project: ProjectConfig) => string[]);
  configFields?: FieldSpec[];
  run: (project: ProjectConfig) => Promise<string>;
};

export type Result<T> =
  | { ok: true; data: T }
  | { ok: false; error: string };
