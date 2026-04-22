import { z } from 'zod';
import type { ProjectConfig } from './types.ts';

export const ProjectConfigSchema = z.object({
  displayName: z.string().min(1),
  github: z.object({
    username: z.string(),
    tokenEnv: z.string(),
    extraQuery: z.string().optional(),
  }),
  widgets: z.record(z.string(), z.unknown()),
});

export type ParseResult =
  | { ok: true; project: ProjectConfig }
  | { ok: false; issues: string[] };

export function parseProject(raw: unknown): ParseResult {
  const result = ProjectConfigSchema.safeParse(raw);
  if (result.success) {
    return { ok: true, project: result.data as ProjectConfig };
  }
  const issues = result.error.issues.map(i => `${i.path.join('.') || '(root)'}: ${i.message}`);
  return { ok: false, issues };
}
