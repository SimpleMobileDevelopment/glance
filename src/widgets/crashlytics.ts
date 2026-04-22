import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import type { ProjectConfig, WidgetModule, Hero } from '../types.ts';
import { card, errorCard, escape, sparkline, type Tone } from '../render.ts';
import { getAccessToken, hasOAuthClient, hasRefreshToken } from '../auth/google.ts';
import { runQuery, fetchDatasetLocation, listTables } from '../bigquery.ts';
import { googleJson } from '../google/client.ts';
import { memoize } from '../cache.ts';

const execFileP = promisify(execFile);
const CRASH_ROOTCAUSE_MODEL = 'claude-haiku-4-5-20251001';
const CRASH_ROOTCAUSE_TTL_MS = 24 * 60 * 60_000;
const CRASH_ROOTCAUSE_TOP_N = 3;

type SourceRoot = { packagePrefix?: string; sourceRoot?: string };

type CrashlyticsConfig = {
  firebaseProjectId?: string;
  appId?: string;
  packageName?: string;
  gcpProjectId?: string;
  dataset?: string;
  table?: string;
  lookbackDays?: string | number;
  sourceRoots?: SourceRoot[];
};

const DEV_SUFFIX_RE = /\.(debug|test|dev|staging|qa|alpha|beta|internal)$/;

function pickPrimaryApp(
  apps: AndroidApp[],
  appId: string | undefined,
  packageName: string | undefined,
): AndroidApp | null {
  if (apps.length === 0) return null;
  if (appId) return apps.find(a => a.appId === appId) ?? null;
  if (packageName) return apps.find(a => a.packageName === packageName) ?? null;
  return apps.find(a => !DEV_SUFFIX_RE.test(a.packageName)) ?? apps[0];
}

type AndroidApp = {
  name: string;
  appId: string;
  displayName?: string;
  packageName: string;
};

async function fetchAndroidApps(firebaseProjectId: string): Promise<AndroidApp[]> {
  const data = await googleJson<{ apps?: AndroidApp[] }>(
    `https://firebase.googleapis.com/v1beta1/projects/${encodeURIComponent(firebaseProjectId)}/androidApps`,
  );
  return data.apps ?? [];
}

function consoleLink(firebaseProjectId: string, app: AndroidApp): string {
  return `https://console.firebase.google.com/project/${encodeURIComponent(firebaseProjectId)}/crashlytics/app/android:${encodeURIComponent(app.packageName)}`;
}

function deriveTableName(packageName: string): string {
  return `${packageName.replace(/\./g, '_')}_ANDROID`;
}

type IssueRow = {
  issue_id: string;
  issue_title: string;
  issue_subtitle: string;
  event_count: string;
  users_affected: string;
  blame_file: string;
  blame_line: string;
  blame_symbol: string;
};

async function fetchTopIssues(
  gcpProjectId: string, dataset: string, table: string, lookbackDays: number, location: string | null,
): Promise<IssueRow[]> {
  const sql = `
    SELECT
      issue_id,
      ANY_VALUE(issue_title) AS issue_title,
      ANY_VALUE(issue_subtitle) AS issue_subtitle,
      COUNT(*) AS event_count,
      COUNT(DISTINCT installation_uuid) AS users_affected,
      ANY_VALUE(blame_frame.file) AS blame_file,
      ANY_VALUE(CAST(blame_frame.line AS STRING)) AS blame_line,
      ANY_VALUE(blame_frame.symbol) AS blame_symbol
    FROM \`${gcpProjectId}.${dataset}.${table}\`
    WHERE event_timestamp >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL @lookback_days DAY)
      AND is_fatal = TRUE
    GROUP BY issue_id
    ORDER BY event_count DESC
    LIMIT 5
  `;
  return runQuery<IssueRow>(gcpProjectId, sql, [
    { name: 'lookback_days', type: 'INT64', value: String(lookbackDays) },
  ], location ?? undefined);
}

async function fetchImpactedUsers(
  gcpProjectId: string, dataset: string, table: string, lookbackDays: number, location: string | null,
): Promise<number> {
  const sql = `
    SELECT COUNT(DISTINCT installation_uuid) AS users
    FROM \`${gcpProjectId}.${dataset}.${table}\`
    WHERE event_timestamp >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL @lookback_days DAY)
      AND is_fatal = TRUE
  `;
  const rows = await runQuery<{ users: string }>(gcpProjectId, sql, [
    { name: 'lookback_days', type: 'INT64', value: String(lookbackDays) },
  ], location ?? undefined);
  return Number(rows[0]?.users ?? 0);
}

async function fetchDailyCrashCounts(
  gcpProjectId: string, dataset: string, table: string, lookbackDays: number, location: string | null,
): Promise<number[]> {
  // Bucket fatal events per UTC day across the lookback window. The output
  // array has one entry per day (oldest first), zero-filled for any day with
  // no crashes so the sparkline reads as a continuous timeline.
  const sql = `
    SELECT
      DATE(event_timestamp) AS day,
      COUNT(*) AS events
    FROM \`${gcpProjectId}.${dataset}.${table}\`
    WHERE event_timestamp >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL @lookback_days DAY)
      AND is_fatal = TRUE
    GROUP BY day
    ORDER BY day ASC
  `;
  const rows = await runQuery<{ day: string; events: string }>(gcpProjectId, sql, [
    { name: 'lookback_days', type: 'INT64', value: String(lookbackDays) },
  ], location ?? undefined);
  const byDay = new Map<string, number>();
  for (const r of rows) byDay.set(r.day, Number(r.events ?? 0));
  const out: number[] = [];
  const today = new Date();
  for (let i = lookbackDays - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setUTCDate(d.getUTCDate() - i);
    const key = d.toISOString().slice(0, 10);
    out.push(byDay.get(key) ?? 0);
  }
  return out;
}

function normalizeSourceRoots(raw: unknown): SourceRoot[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map(r => {
      if (!r || typeof r !== 'object') return null;
      const rec = r as Record<string, unknown>;
      const packagePrefix = typeof rec.packagePrefix === 'string' ? rec.packagePrefix.trim() : '';
      const sourceRoot = typeof rec.sourceRoot === 'string' ? rec.sourceRoot.trim() : '';
      if (!packagePrefix || !sourceRoot) return null;
      return { packagePrefix, sourceRoot };
    })
    .filter((r): r is SourceRoot & { packagePrefix: string; sourceRoot: string } => r !== null);
}

/**
 * Given a top-frame's class-like symbol (e.g. "co.future.future.ui.LoginVM$doLogin")
 * or file (e.g. "LoginVM.kt"), find a sourceRoot whose packagePrefix is a prefix
 * of the package portion. Returns the absolute file path or null.
 */
function resolveFramePath(
  symbol: string | undefined,
  file: string | undefined,
  roots: SourceRoot[],
): string | null {
  if (!file || !symbol || roots.length === 0) return null;
  // Extract package (drop the class name and anything after). Symbol looks like
  // "co.future.future.ui.LoginViewModel$invoke" — the package is everything
  // up to the last "."-segment whose first char is uppercase.
  const parts = symbol.split('.');
  let pkgEnd = parts.length;
  for (let i = 0; i < parts.length; i++) {
    const first = parts[i]?.[0] ?? '';
    if (first >= 'A' && first <= 'Z') { pkgEnd = i; break; }
  }
  const pkg = parts.slice(0, pkgEnd).join('.');
  if (!pkg) return null;
  // Longest matching prefix wins.
  const match = roots
    .filter(r => r.packagePrefix && pkg.startsWith(r.packagePrefix!))
    .sort((a, b) => (b.packagePrefix!.length - a.packagePrefix!.length))[0];
  if (!match || !match.sourceRoot) return null;
  const pkgPath = pkg.replace(/\./g, '/');
  return `${match.sourceRoot.replace(/\/$/, '')}/${pkgPath}/${file}`;
}

function studioLink(absPath: string, line: string | undefined): string {
  const lineNum = line && /^\d+$/.test(line) ? line : '1';
  const url = `studio://open?file=${encodeURIComponent(absPath)}&line=${encodeURIComponent(lineNum)}`;
  return `<a href="${escape(url)}">open</a>`;
}

// --- root-cause hint (Theme 6b) ---
// For each of the top N crash issues, if we have a resolved absolute path
// that lives inside a git checkout, fetch the recent git history for that
// file and ask Claude haiku for a likely culprit commit.

type RootCauseHint = {
  issueId: string;
  line: string; // either "likely culprit: <hash> — <reason>" or "" (skip)
};

async function findGitRoot(filePath: string): Promise<string | null> {
  const dir = path.dirname(filePath);
  try {
    const { stdout } = await execFileP('git', ['-C', dir, 'rev-parse', '--show-toplevel']);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

async function gitHeadSha(repoRoot: string): Promise<string | null> {
  try {
    const { stdout } = await execFileP('git', ['-C', repoRoot, 'rev-parse', 'HEAD']);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

async function gitLogFor(repoRoot: string, relPath: string): Promise<string> {
  try {
    const { stdout } = await execFileP(
      'git',
      ['-C', repoRoot, 'log', '-n', '20', '--format=%h %ad %s', '--date=short', '--', relPath],
      { maxBuffer: 2 * 1024 * 1024 },
    );
    return stdout.trim();
  } catch {
    return '';
  }
}

async function askClaudeForCulprit(
  apiKey: string,
  issueTitle: string,
  issueSubtitle: string,
  blameSymbol: string,
  blameFile: string,
  blameLine: string,
  gitLog: string,
): Promise<string> {
  const client = new Anthropic({ apiKey });
  const userMessage =
    `Android crash:\n` +
    `- Title: ${issueTitle}\n` +
    `- Subtitle: ${issueSubtitle}\n` +
    `- Top frame: ${blameSymbol} at ${blameFile}:${blameLine}\n\n` +
    `Recent git history of ${blameFile}:\n${gitLog}\n\n` +
    `Answer in the exact format requested.`;
  const response = await client.messages.create({
    model: CRASH_ROOTCAUSE_MODEL,
    max_tokens: 120,
    system: [{
      type: 'text',
      text: `Given an Android crash (title + stack snippet) and the recent git history of the affected file, reply with ONE LINE in EXACTLY one of these two forms: "likely culprit: <shorthash> — <reason>" or "no clear culprit". No other text.`,
      cache_control: { type: 'ephemeral' },
    }],
    messages: [{ role: 'user', content: userMessage }],
  });
  return response.content
    .filter(b => b.type === 'text')
    .map(b => (b as Anthropic.TextBlock).text)
    .join('')
    .trim();
}

async function computeRootCause(
  apiKey: string,
  issue: IssueRow,
  absPath: string,
): Promise<RootCauseHint | null> {
  const repoRoot = await findGitRoot(absPath);
  if (!repoRoot) return null;
  const rel = path.relative(repoRoot, absPath);
  if (!rel || rel.startsWith('..')) return null;
  const gitLog = await gitLogFor(repoRoot, rel);
  if (!gitLog) return null;
  const headSha = await gitHeadSha(repoRoot);
  if (!headSha) return null;

  const cacheKey = `crash-rootcause:${issue.issue_id}:${headSha}`;
  try {
    const line = await memoize<string>({
      key: cacheKey,
      ttlMs: CRASH_ROOTCAUSE_TTL_MS,
      fetchFresh: () => askClaudeForCulprit(
        apiKey,
        issue.issue_title || issue.issue_id,
        issue.issue_subtitle || '',
        issue.blame_symbol || '',
        issue.blame_file || '',
        issue.blame_line || '',
        gitLog,
      ),
    });
    // Claude sometimes echoes the "no clear culprit" sentinel. Treat
    // anything without "likely culprit:" as a skip.
    const first = line.split('\n').find(l => l.trim().length > 0) ?? '';
    if (!/likely culprit:/i.test(first)) return { issueId: issue.issue_id, line: '' };
    return { issueId: issue.issue_id, line: first.trim() };
  } catch {
    return null;
  }
}

async function render(project: ProjectConfig): Promise<{ html: string; hero?: Hero }> {
  const config = (project.widgets.crashlytics ?? {}) as CrashlyticsConfig;
  const { firebaseProjectId, appId, gcpProjectId } = config;
  const explicitPackageName = config.packageName?.toString().trim() || undefined;
  const dataset = config.dataset?.toString().trim() || 'firebase_crashlytics';
  const lookbackDays = Math.max(1, Number(config.lookbackDays ?? 7) || 7);
  const sourceRoots = normalizeSourceRoots(config.sourceRoots);

  if (!firebaseProjectId) {
    return { html: card('Crashlytics', `<p class="muted">Set <code>widgets.crashlytics.firebaseProjectId</code> in project.json.</p>`) };
  }
  if (!hasOAuthClient()) return { html: errorCard('Crashlytics', 'Google OAuth client not configured — see /settings.') };
  if (!hasRefreshToken()) return { html: errorCard('Crashlytics', 'Not connected to Google — click Connect on /settings.') };

  try { await getAccessToken(); }
  catch (e) { return { html: errorCard('Crashlytics', (e as Error).message) }; }

  let apps: AndroidApp[];
  try { apps = await fetchAndroidApps(firebaseProjectId); }
  catch (e) { return { html: errorCard('Crashlytics', (e as Error).message) }; }

  const primary = pickPrimaryApp(apps, appId, explicitPackageName);
  if (!primary) {
    const filters = [
      appId ? `appId <code>${escape(appId)}</code>` : null,
      explicitPackageName ? `package <code>${escape(explicitPackageName)}</code>` : null,
    ].filter(Boolean).join(' / ');
    return { html: card('Crashlytics', `<p class="muted">No matching Android apps in <code>${escape(firebaseProjectId)}</code>${filters ? ` for ${filters}` : ''}.</p>`) };
  }

  const table = config.table?.toString().trim() || deriveTableName(primary.packageName);

  let datasetLocation: string | null = null;
  const datasetErrors: string[] = [];
  if (gcpProjectId) {
    try {
      datasetLocation = await fetchDatasetLocation(gcpProjectId, dataset);
    } catch (e) {
      datasetErrors.push(`dataset: ${(e as Error).message}`);
    }
  }

  const headerBlock = `<p>
    <a href="${escape(consoleLink(firebaseProjectId, primary))}" target="_blank" rel="noreferrer">${escape(primary.displayName || primary.packageName)}</a>
    <span class="meta"><code>${escape(primary.packageName)}</code> · BigQuery: <code>${escape(`${gcpProjectId ?? '?'}.${dataset}.${table}`)}</code>${datasetLocation ? ` · location <code>${escape(datasetLocation)}</code>` : ''}</span>
  </p>`;

  const [issueRes, impactedRes, dailyRes] = gcpProjectId
    ? await Promise.allSettled([
        fetchTopIssues(gcpProjectId, dataset, table, lookbackDays, datasetLocation),
        fetchImpactedUsers(gcpProjectId, dataset, table, lookbackDays, datasetLocation),
        fetchDailyCrashCounts(gcpProjectId, dataset, table, lookbackDays, datasetLocation),
      ])
    : [
        { status: 'fulfilled', value: [] as IssueRow[] } as const,
        { status: 'fulfilled', value: null as number | null } as const,
        { status: 'fulfilled', value: [] as number[] } as const,
      ];

  const errors: string[] = [...datasetErrors];
  const issues = (issueRes.status === 'fulfilled' ? issueRes.value : []) as IssueRow[];
  if (issueRes.status === 'rejected') errors.push(`top issues: ${(issueRes.reason as Error).message}`);
  const impacted = impactedRes.status === 'fulfilled' ? (impactedRes.value as number | null) : null;
  if (impactedRes.status === 'rejected') errors.push(`impacted users: ${(impactedRes.reason as Error).message}`);
  const daily = dailyRes.status === 'fulfilled' ? (dailyRes.value as number[]) : [];

  let tableHint = '';
  const tableNotFound = gcpProjectId && (
    (issueRes.status === 'rejected' && /not found/i.test((issueRes.reason as Error).message)) ||
    (impactedRes.status === 'rejected' && /not found/i.test((impactedRes.reason as Error).message))
  );
  if (tableNotFound) {
    try {
      const tables = await listTables(gcpProjectId, dataset);
      const crashlyticsTables = tables.filter(t => /_ANDROID(_REALTIME)?$|_IOS(_REALTIME)?$/.test(t));
      if (tables.length === 0) {
        tableHint = `<p class="muted">Dataset <code>${escape(dataset)}</code> is empty — the first export batch hasn't landed yet (normally within 24h of enabling).</p>`;
      } else if (crashlyticsTables.length === 0) {
        tableHint = `<p class="muted">Dataset has ${tables.length} table(s) but none match Crashlytics naming (<code>*_ANDROID</code> / <code>*_IOS</code>). Is this the right dataset?</p>`;
      } else {
        tableHint = `<p class="muted">Tables actually in <code>${escape(dataset)}</code>: ${crashlyticsTables.map(t => `<code>${escape(t)}</code>`).join(', ')}. Set <code>table</code> in config to one of these.</p>`;
      }
    } catch (e) {
      errors.push(`list tables: ${(e as Error).message}`);
    }
  }

  const impactedBlock = impacted == null
    ? ''
    : `<p><span class="repo">Impacted users (${lookbackDays}d):</span> ${impacted.toLocaleString()} <span class="meta">distinct installations with a fatal crash</span></p>`;

  if (!gcpProjectId) {
    const bqMissing = `<p class="muted">Set <code>gcpProjectId</code> to query BigQuery for top issues.</p>`;
    return { html: card('Crashlytics', headerBlock + bqMissing + (errors.length ? `<p class="error">${escape(errors.join(' · '))}</p>` : '')) };
  }

  // Precompute root-cause hints for the top N issues (parallel, all-or-nothing per issue).
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const hintsByIssue = new Map<string, string>();
  if (anthropicKey && issues.length > 0) {
    const topIssues = issues.slice(0, CRASH_ROOTCAUSE_TOP_N);
    const hints = await Promise.all(topIssues.map(async i => {
      const resolved = resolveFramePath(i.blame_symbol, i.blame_file, sourceRoots);
      if (!resolved) return null;
      return computeRootCause(anthropicKey, i, resolved);
    }));
    for (const h of hints) {
      if (h && h.line) hintsByIssue.set(h.issueId, h.line);
    }
  }

  const issuesBlock = issues.length === 0
    ? `<h3>Top issues (last ${lookbackDays}d)</h3><p class="muted">${issueRes.status === 'fulfilled' ? 'No fatal issues in window ✓' : '—'}</p>`
    : `<h3>Top issues (last ${lookbackDays}d)</h3><ul>${issues.map(i => {
        const resolved = resolveFramePath(i.blame_symbol, i.blame_file, sourceRoots);
        const frameBits: string[] = [];
        if (i.blame_file) frameBits.push(escape(`${i.blame_file}${i.blame_line ? `:${i.blame_line}` : ''}`));
        if (resolved) frameBits.push(studioLink(resolved, i.blame_line));
        const frameLine = frameBits.length ? `<div class="desc">${frameBits.join(' · ')}</div>` : '';
        const hint = hintsByIssue.get(i.issue_id);
        const hintLine = hint ? `<div class="meta">💡 ${escape(hint)}</div>` : '';
        return `
        <li>
          <span class="title">${escape(i.issue_title || i.issue_id)}</span>
          ${i.issue_subtitle ? `<div class="desc">${escape(i.issue_subtitle)}</div>` : ''}
          ${frameLine}
          ${hintLine}
          <span class="meta">${Number(i.event_count).toLocaleString()} events · ${Number(i.users_affected).toLocaleString()} users</span>
        </li>`;
      }).join('')}</ul>`;

  const residualErrors = tableHint
    ? errors.filter(e => !/not found/i.test(e))
    : errors;
  const errorBlock = residualErrors.length === 0
    ? ''
    : `<p class="error">${escape(residualErrors.join(' · '))}</p>`;

  // Hero = impacted users count. Tone is a trend signal: green if the last day
  // is below the window average (downward), amber on flat or rising, red if
  // the latest day is a clear spike (≥2× the average).
  const avg = daily.length > 0 ? daily.reduce((a, b) => a + b, 0) / daily.length : 0;
  const last = daily[daily.length - 1] ?? 0;
  const heroTone: Tone = impacted == null
    ? 'muted'
    : avg > 0 && last >= avg * 2 ? 'red'
    : avg > 0 && last > avg ? 'amber'
    : 'green';
  const heroValue = impacted == null ? '—' : impacted.toLocaleString();
  const hero: Hero = { value: heroValue, tone: heroTone, label: `users/${lookbackDays}d` };

  return {
    html: card('Crashlytics', headerBlock + impactedBlock + issuesBlock + tableHint + errorBlock, {
      hero,
      sparkline: daily.length > 0 ? sparkline(daily, { tone: heroTone }) : undefined,
    }),
    hero,
  };
}

export const crashlytics: WidgetModule = {
  id: 'crashlytics',
  title: 'Crashlytics',
  envVars: ['GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET', 'GOOGLE_REFRESH_TOKEN'],
  configFields: [
    {
      type: 'string',
      key: 'firebaseProjectId',
      label: 'Firebase project ID',
      placeholder: 'my-project-prod',
      description: 'The Firebase project that owns the Android app(s).',
    },
    {
      type: 'string',
      key: 'appId',
      label: 'App ID (optional)',
      placeholder: '1:123456789:android:abcdef',
      description: 'Pin to a single Firebase Android app by numeric ID. Takes precedence over Package name.',
    },
    {
      type: 'string',
      key: 'packageName',
      label: 'Package name (optional)',
      placeholder: 'com.example.app',
      description: 'Pin to a specific app by package name. If both this and App ID are blank, the widget auto-picks the first Android app whose package does not end in .debug / .test / .dev / .staging / .qa / .alpha / .beta / .internal.',
    },
    {
      type: 'string',
      key: 'gcpProjectId',
      label: 'BigQuery project ID',
      placeholder: 'my-project-prod',
      description: 'GCP project holding the Crashlytics BigQuery export (often the same as Firebase project ID).',
    },
    {
      type: 'string',
      key: 'dataset',
      label: 'BigQuery dataset',
      placeholder: 'firebase_crashlytics',
      description: 'Defaults to firebase_crashlytics. Only change if you routed the export elsewhere.',
    },
    {
      type: 'string',
      key: 'table',
      label: 'BigQuery table (optional)',
      placeholder: 'com_example_app_ANDROID',
      description: 'Auto-derived from the app package name. Override if your table is named differently.',
    },
    {
      type: 'string',
      key: 'lookbackDays',
      label: 'Lookback days',
      placeholder: '7',
      description: 'Window for top issues and impacted-users count. Default 7.',
    },
    {
      type: 'object-list',
      key: 'sourceRoots',
      label: 'Source roots (Android Studio deep-links)',
      description: 'Map a Java/Kotlin package prefix to a local source root. When a crash\'s top frame matches, an "open" link appears next to it that launches Android Studio. One per line as `co.future.future | /absolute/path/to/src/main/java`.',
      fields: [
        { key: 'packagePrefix', label: 'Package prefix', placeholder: 'co.future.future' },
        { key: 'sourceRoot', label: 'Source root', placeholder: '/Users/you/git/android/app/src/main/java' },
      ],
    },
  ],
  run: async project => render(project),
};
