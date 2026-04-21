import type { ProjectConfig, WidgetModule } from '../types.ts';
import { card, errorCard, escape } from '../render.ts';
import { getAccessToken, hasOAuthClient, hasRefreshToken } from '../auth/google.ts';
import { runQuery, fetchDatasetLocation, listTables } from '../bigquery.ts';
import { friendlyGoogleError } from '../errors.ts';

type CrashlyticsConfig = {
  firebaseProjectId?: string;
  appId?: string;
  packageName?: string;
  gcpProjectId?: string;
  dataset?: string;
  table?: string;
  lookbackDays?: string | number;
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

async function fetchAndroidApps(firebaseProjectId: string, token: string): Promise<AndroidApp[]> {
  const res = await fetch(
    `https://firebase.googleapis.com/v1beta1/projects/${encodeURIComponent(firebaseProjectId)}/androidApps`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!res.ok) throw new Error(friendlyGoogleError(await res.text(), res.status));
  const data = await res.json() as { apps?: AndroidApp[] };
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
      COUNT(DISTINCT installation_uuid) AS users_affected
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

async function run(project: ProjectConfig): Promise<string> {
  const config = (project.widgets.crashlytics ?? {}) as CrashlyticsConfig;
  const { firebaseProjectId, appId, gcpProjectId } = config;
  const explicitPackageName = config.packageName?.toString().trim() || undefined;
  const dataset = config.dataset?.toString().trim() || 'firebase_crashlytics';
  const lookbackDays = Math.max(1, Number(config.lookbackDays ?? 7) || 7);

  if (!firebaseProjectId) {
    return card('Crashlytics', `<p class="muted">Set <code>widgets.crashlytics.firebaseProjectId</code> in project.json.</p>`);
  }
  if (!hasOAuthClient()) return errorCard('Crashlytics', 'Google OAuth client not configured — see /settings.');
  if (!hasRefreshToken()) return errorCard('Crashlytics', 'Not connected to Google — click Connect on /settings.');

  let token: string;
  try { token = await getAccessToken(); }
  catch (e) { return errorCard('Crashlytics', (e as Error).message); }

  let apps: AndroidApp[];
  try { apps = await fetchAndroidApps(firebaseProjectId, token); }
  catch (e) { return errorCard('Crashlytics', (e as Error).message); }

  const primary = pickPrimaryApp(apps, appId, explicitPackageName);
  if (!primary) {
    const filters = [
      appId ? `appId <code>${escape(appId)}</code>` : null,
      explicitPackageName ? `package <code>${escape(explicitPackageName)}</code>` : null,
    ].filter(Boolean).join(' / ');
    return card('Crashlytics', `<p class="muted">No matching Android apps in <code>${escape(firebaseProjectId)}</code>${filters ? ` for ${filters}` : ''}.</p>`);
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

  const [issueRes, impactedRes] = gcpProjectId
    ? await Promise.allSettled([
        fetchTopIssues(gcpProjectId, dataset, table, lookbackDays, datasetLocation),
        fetchImpactedUsers(gcpProjectId, dataset, table, lookbackDays, datasetLocation),
      ])
    : [
        { status: 'fulfilled', value: [] as IssueRow[] } as const,
        { status: 'fulfilled', value: null as number | null } as const,
      ];

  const errors: string[] = [...datasetErrors];
  const issues = (issueRes.status === 'fulfilled' ? issueRes.value : []) as IssueRow[];
  if (issueRes.status === 'rejected') errors.push(`top issues: ${(issueRes.reason as Error).message}`);
  const impacted = impactedRes.status === 'fulfilled' ? (impactedRes.value as number | null) : null;
  if (impactedRes.status === 'rejected') errors.push(`impacted users: ${(impactedRes.reason as Error).message}`);

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
    return card('Crashlytics', headerBlock + bqMissing + (errors.length ? `<p class="error">${escape(errors.join(' · '))}</p>` : ''));
  }

  const issuesBlock = issues.length === 0
    ? `<h3>Top issues (last ${lookbackDays}d)</h3><p class="muted">${issueRes.status === 'fulfilled' ? 'No fatal issues in window ✓' : '—'}</p>`
    : `<h3>Top issues (last ${lookbackDays}d)</h3><ul>${issues.map(i => `
        <li>
          <span class="title">${escape(i.issue_title || i.issue_id)}</span>
          ${i.issue_subtitle ? `<div class="desc">${escape(i.issue_subtitle)}</div>` : ''}
          <span class="meta">${Number(i.event_count).toLocaleString()} events · ${Number(i.users_affected).toLocaleString()} users</span>
        </li>`).join('')}</ul>`;

  const residualErrors = tableHint
    ? errors.filter(e => !/not found/i.test(e))
    : errors;
  const errorBlock = residualErrors.length === 0
    ? ''
    : `<p class="error">${escape(residualErrors.join(' · '))}</p>`;

  return card('Crashlytics', headerBlock + impactedBlock + issuesBlock + tableHint + errorBlock);
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
  ],
  run,
};
