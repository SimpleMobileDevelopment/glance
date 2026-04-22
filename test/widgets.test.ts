import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { prs } from '../src/widgets/prs.ts';
import { ci } from '../src/widgets/ci.ts';
import { linear } from '../src/widgets/linear.ts';
import type { WidgetModule, ProjectConfig } from '../src/types.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURES_DIR = path.join(__dirname, 'fixtures');
const SNAPSHOTS_DIR = path.join(__dirname, 'snapshots');
const UPDATE = process.env.UPDATE_SNAPSHOTS === '1';

// Each fixture file is `{ urlPatterns: Record<string, responseJson>, project: ProjectConfig }`.
// For GET requests (GitHub REST), the key is a substring of the URL.
// For POST requests (Linear GraphQL), the key is `urlSubstring|QUERY:<opName>|teamKey:<uniqueTag>`
// where the uniqueTag is embedded in the fixture's data.team.key so the test stub can
// distinguish between fixtures hitting the same URL (both hit api.linear.app/graphql).
type Fixture = {
  urlPatterns: Record<string, unknown>;
  project: ProjectConfig;
};

type StubCtx = {
  tag: string;
  patterns: Record<string, unknown>;
};

function installFetchStub(ctx: StubCtx): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: any, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : (input as URL | Request).toString();
    const method = (init?.method ?? 'GET').toUpperCase();

    // For POST requests, pull the body as a string so we can match on GraphQL operation name.
    let bodyStr = '';
    if (method === 'POST' && init?.body) {
      bodyStr = typeof init.body === 'string' ? init.body : '';
    }

    for (const [key, value] of Object.entries(ctx.patterns)) {
      // Key format: "urlSubstring" OR "urlSubstring|QUERY:<op>|...custom-tag..."
      const parts = key.split('|');
      const urlPart = parts[0];
      if (!url.includes(urlPart)) continue;
      let bodyOk = true;
      for (const p of parts.slice(1)) {
        if (p.startsWith('QUERY:')) {
          const op = p.slice('QUERY:'.length);
          if (!bodyStr.includes(op)) { bodyOk = false; break; }
        } else if (p.startsWith('teamKey:')) {
          // Just a uniqueness tag; don't match against body/url.
          // (The tag exists so tests against the same URL stay distinct.)
          continue;
        } else {
          // Any other literal: must appear in body.
          if (!bodyStr.includes(p)) { bodyOk = false; break; }
        }
      }
      if (!bodyOk) continue;
      return new Response(JSON.stringify(value), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    throw new Error(`[test stub] no fixture matched for ${method} ${url}`);
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

async function loadFixture(widget: string, name: string): Promise<Fixture> {
  const raw = await readFile(path.join(FIXTURES_DIR, widget, `${name}.json`), 'utf8');
  return JSON.parse(raw) as Fixture;
}

function simpleDiff(a: string, b: string): string {
  const ax = a.split('\n');
  const bx = b.split('\n');
  const out: string[] = [];
  const max = Math.max(ax.length, bx.length);
  for (let i = 0; i < max; i++) {
    if (ax[i] === bx[i]) continue;
    if (ax[i] !== undefined) out.push(`- ${ax[i]}`);
    if (bx[i] !== undefined) out.push(`+ ${bx[i]}`);
    if (out.length > 40) {
      out.push('... (diff truncated)');
      break;
    }
  }
  return out.join('\n');
}

async function checkSnapshot(widget: string, name: string, html: string): Promise<void> {
  const snapPath = path.join(SNAPSHOTS_DIR, `${widget}.${name}.html`);
  if (UPDATE) {
    await writeFile(snapPath, html, 'utf8');
    return;
  }
  let expected: string;
  try {
    expected = await readFile(snapPath, 'utf8');
  } catch {
    throw new Error(`missing snapshot ${snapPath} — run UPDATE_SNAPSHOTS=1 npm test to create it`);
  }
  if (expected !== html) {
    const diff = simpleDiff(expected, html);
    throw new Error(`snapshot mismatch for ${widget}.${name}:\n${diff}`);
  }
}

// Pin Date.now so relTime("...") produces stable output across runs.
// All fixtures use timestamps up to 2026-04-21; pin "now" to 2026-04-21T12:00:00Z.
const FROZEN_NOW = new Date('2026-04-21T12:00:00Z').getTime();
function installClock(): () => void {
  const origNow = Date.now;
  Date.now = () => FROZEN_NOW;
  return () => { Date.now = origNow; };
}

async function runWidgetCase(widget: WidgetModule, caseName: string): Promise<void> {
  const fixture = await loadFixture(widget.id, caseName);
  const restoreFetch = installFetchStub({
    tag: `${widget.id}.${caseName}`,
    patterns: fixture.urlPatterns,
  });
  const restoreClock = installClock();
  try {
    const result = await widget.run(fixture.project);
    await checkSnapshot(widget.id, caseName, result.html);
  } finally {
    restoreClock();
    restoreFetch();
  }
}

// --- env shim: widgets bail out early without these ---
process.env.GITHUB_TOKEN_FUTURE ??= 'dummy-gh-token';
process.env.LINEAR_API_KEY ??= 'dummy-linear-token';

// --- discover fixtures under test/fixtures/<widget>/<case>.json ---
async function discover(widgetId: string): Promise<string[]> {
  try {
    const entries = await readdir(path.join(FIXTURES_DIR, widgetId));
    return entries.filter(e => e.endsWith('.json')).map(e => e.replace(/\.json$/, ''));
  } catch {
    return [];
  }
}

const PRS_CASES = await discover('prs');
const CI_CASES = await discover('ci');
const LINEAR_CASES = await discover('linear');

for (const c of PRS_CASES) {
  test(`prs widget · ${c}`, () => runWidgetCase(prs, c));
}
for (const c of CI_CASES) {
  test(`ci widget · ${c}`, () => runWidgetCase(ci, c));
}
for (const c of LINEAR_CASES) {
  test(`linear widget · ${c}`, () => runWidgetCase(linear, c));
}
