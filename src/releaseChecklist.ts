import { readFile, writeFile, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';

const STATE_FILE = '.release-checklist.json';

export type ChecklistEntry = { runId: number; checked: string[] };
export type ChecklistState = Record<string, ChecklistEntry>;

export function buildKey(repo: string, workflow: string, branch: string): string {
  return `${repo}::${workflow}::${branch}`;
}

export async function readState(): Promise<ChecklistState> {
  if (!existsSync(STATE_FILE)) return {};
  try {
    const raw = await readFile(STATE_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return (parsed && typeof parsed === 'object') ? parsed as ChecklistState : {};
  } catch {
    return {};
  }
}

async function writeState(state: ChecklistState): Promise<void> {
  const tmp = `${STATE_FILE}.tmp`;
  await writeFile(tmp, JSON.stringify(state, null, 2), 'utf8');
  await rename(tmp, STATE_FILE);
}

let lock: Promise<unknown> = Promise.resolve();
function synchronize<T>(fn: () => Promise<T>): Promise<T> {
  const next = lock.then(fn, fn);
  lock = next.catch(() => undefined);
  return next;
}

export function syncRun(key: string, runId: number, items: string[]): Promise<string[]> {
  return synchronize(async () => {
    const state = await readState();
    const prev = state[key];
    const resetting = !prev || prev.runId !== runId;
    const checked = resetting ? [] : prev.checked.filter(c => items.includes(c));
    const unchanged = prev && prev.runId === runId && prev.checked.length === checked.length
      && prev.checked.every((c, i) => c === checked[i]);
    if (unchanged) return checked;
    state[key] = { runId, checked };
    await writeState(state);
    return checked;
  });
}

export function toggleItem(key: string, item: string, checked: boolean): Promise<void> {
  return synchronize(async () => {
    const state = await readState();
    const entry = state[key];
    if (!entry) return;
    const set = new Set(entry.checked);
    if (checked) set.add(item);
    else set.delete(item);
    entry.checked = [...set];
    await writeState(state);
  });
}
