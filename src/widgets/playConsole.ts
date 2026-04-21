import type { ProjectConfig, WidgetModule } from '../types.ts';
import { card, errorCard, escape, relTime, truncatedList } from '../render.ts';
import { getAccessToken, hasOAuthClient, hasRefreshToken } from '../auth/google.ts';
import { friendlyGoogleError } from '../errors.ts';

type PlayConfig = {
  packageName?: string;
  lookbackDays?: string | number;
};

const API = 'https://androidpublisher.googleapis.com/androidpublisher/v3';
const REPORTING_API = 'https://playdeveloperreporting.googleapis.com/v1beta1';

type DatePart = { year: number; month: number; day: number };

function gDate(d: Date): DatePart {
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

function datePartFromMs(ms: number): DatePart {
  const d = new Date(ms);
  return gDate(d);
}

const FRESHNESS_RE = /freshness (\d{4})-(\d{2})-(\d{2})/;

function parseFreshnessCap(errText: string): DatePart | null {
  const m = FRESHNESS_RE.exec(errText);
  if (!m) return null;
  return { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
}

async function gfetch<T>(path: string, token: string, init?: RequestInit, base: string = API): Promise<T> {
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: {
      ...(init?.headers ?? {}),
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  });
  if (!res.ok) throw new Error(friendlyGoogleError(await res.text(), res.status));
  return res.json() as Promise<T>;
}

type TimelineBody = {
  timelineSpec: { aggregationPeriod: string; startTime: DatePart; endTime: DatePart };
  metrics: string[];
};

async function queryMetricSet<T>(
  path: string,
  token: string,
  body: TimelineBody,
  lookbackDays: number,
): Promise<T> {
  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
  const res = await fetch(`${REPORTING_API}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  if (res.ok) return res.json() as Promise<T>;

  const errText = await res.text();
  if (res.status === 400) {
    const cap = parseFreshnessCap(errText);
    if (cap) {
      const endMs = Date.UTC(cap.year, cap.month - 1, cap.day);
      const retryBody: TimelineBody = {
        ...body,
        timelineSpec: {
          ...body.timelineSpec,
          startTime: datePartFromMs(endMs - lookbackDays * 86_400_000),
          endTime: cap,
        },
      };
      const res2 = await fetch(`${REPORTING_API}${path}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(retryBody),
      });
      if (res2.ok) return res2.json() as Promise<T>;
      throw new Error(friendlyGoogleError(await res2.text(), res2.status));
    }
  }
  throw new Error(friendlyGoogleError(errText, res.status));
}

type MetricRow = { metrics?: Array<{ decimalValue?: { value?: string } }> };

async function fetchVitalRate(
  packageName: string,
  token: string,
  metricSet: 'crashRateMetricSet' | 'anrRateMetricSet',
  metric: 'crashRate' | 'anrRate',
  lookbackDays: number,
): Promise<number | null> {
  const end = new Date();
  const start = new Date(end.getTime() - lookbackDays * 86_400_000);
  const body: TimelineBody = {
    timelineSpec: {
      aggregationPeriod: 'DAILY',
      startTime: gDate(start),
      endTime: gDate(end),
    },
    metrics: [metric],
  };
  const data = await queryMetricSet<{ rows?: MetricRow[] }>(
    `/apps/${encodeURIComponent(packageName)}/${metricSet}:query`,
    token,
    body,
    lookbackDays,
  );
  const values = (data.rows ?? [])
    .map(r => r.metrics?.[0]?.decimalValue?.value)
    .filter((v): v is string => !!v)
    .map(Number)
    .filter(n => !Number.isNaN(n));
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

type Review = { rating: number; text: string; when: string; reviewId: string };

type ReviewsResponse = {
  reviews?: Array<{
    reviewId: string;
    comments?: Array<{
      userComment?: {
        text?: string;
        starRating?: number;
        lastModified?: { seconds?: string };
      };
    }>;
  }>;
};

async function fetchBadReviews(packageName: string, token: string, lookbackDays: number): Promise<Review[]> {
  const data = await gfetch<ReviewsResponse>(
    `/applications/${encodeURIComponent(packageName)}/reviews?maxResults=50`,
    token,
  );
  const threshold = Date.now() - lookbackDays * 86_400_000;
  const out: Review[] = [];
  for (const r of data.reviews ?? []) {
    const c = r.comments?.[0]?.userComment;
    if (!c) continue;
    const star = c.starRating ?? 0;
    if (star > 2) continue;
    const when = c.lastModified?.seconds ? Number(c.lastModified.seconds) * 1000 : 0;
    if (when < threshold) continue;
    out.push({
      rating: star,
      text: (c.text ?? '').slice(0, 240),
      when: new Date(when).toISOString(),
      reviewId: r.reviewId,
    });
  }
  return out.sort((a, b) => b.when.localeCompare(a.when));
}

type Rollout = { track: string; versionCodes: string; status: string; userFraction?: number };

type TracksResponse = {
  tracks?: Array<{
    track: string;
    releases?: Array<{
      versionCodes?: string[];
      status?: string;
      userFraction?: number;
    }>;
  }>;
};

async function fetchRollouts(packageName: string, token: string): Promise<Rollout[]> {
  const edit = await gfetch<{ id: string }>(
    `/applications/${encodeURIComponent(packageName)}/edits`,
    token,
    { method: 'POST', body: '{}' },
  );
  try {
    const data = await gfetch<TracksResponse>(
      `/applications/${encodeURIComponent(packageName)}/edits/${edit.id}/tracks`,
      token,
    );
    const out: Rollout[] = [];
    for (const t of data.tracks ?? []) {
      for (const rel of t.releases ?? []) {
        out.push({
          track: t.track,
          versionCodes: (rel.versionCodes ?? []).join(', '),
          status: rel.status ?? 'unknown',
          userFraction: rel.userFraction,
        });
      }
    }
    return out;
  } finally {
    fetch(`${API}/applications/${encodeURIComponent(packageName)}/edits/${edit.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    }).catch(() => { /* edit auto-expires anyway */ });
  }
}

function fmtPct(v: number | null, warnAbove: number): string {
  if (v == null) return '<span class="muted">—</span>';
  const cls = v > warnAbove ? 'warn' : 'ok';
  return `<span class="${cls}">${(v * 100).toFixed(2)}%</span>`;
}

async function run(project: ProjectConfig): Promise<string> {
  const config = (project.widgets.playConsole ?? {}) as PlayConfig;
  const packageName = config.packageName;
  const lookbackDays = Math.max(1, Number(config.lookbackDays ?? 7) || 7);

  if (!packageName) {
    return card('Play Console', `<p class="muted">Set <code>widgets.playConsole.packageName</code> in project.json.</p>`);
  }
  if (!hasOAuthClient()) {
    return errorCard('Play Console', 'Google OAuth client not configured — see /settings.');
  }
  if (!hasRefreshToken()) {
    return errorCard('Play Console', 'Not connected to Google — click Connect on /settings.');
  }

  let token: string;
  try {
    token = await getAccessToken();
  } catch (e) {
    return errorCard('Play Console', (e as Error).message);
  }

  const [crashRate, anrRate, reviews, rollouts] = await Promise.all([
    fetchVitalRate(packageName, token, 'crashRateMetricSet', 'crashRate', lookbackDays)
      .catch(e => { console.error('[playConsole] crash:', e.message); return null; }),
    fetchVitalRate(packageName, token, 'anrRateMetricSet', 'anrRate', lookbackDays)
      .catch(e => { console.error('[playConsole] anr:', e.message); return null; }),
    fetchBadReviews(packageName, token, lookbackDays)
      .catch(e => { console.error('[playConsole] reviews:', e.message); return [] as Review[]; }),
    fetchRollouts(packageName, token)
      .catch(e => { console.error('[playConsole] rollouts:', e.message); return [] as Rollout[]; }),
  ]);

  const vitalsBlock = `<p>
    <span class="repo">Crash rate (${lookbackDays}d avg):</span> ${fmtPct(crashRate, 0.01)}
    &nbsp;·&nbsp;
    <span class="repo">ANR rate:</span> ${fmtPct(anrRate, 0.005)}
  </p>`;

  const activeRollouts = rollouts.filter(r => r.status === 'inProgress' || r.status === 'halted');
  const rolloutBlock = activeRollouts.length === 0
    ? `<h3>Rollouts</h3><p class="muted">No staged rollouts in progress.</p>`
    : `<h3>Rollouts</h3><ul>${activeRollouts.map(r => {
        const statusCls = r.status === 'halted' ? 'error' : 'warn';
        const pct = r.userFraction !== undefined ? ` · ${(r.userFraction * 100).toFixed(0)}%` : '';
        return `<li>
          <span class="tag">${escape(r.track)}</span>
          <span class="title">${escape(r.versionCodes || '(no versions)')}</span>
          <span class="meta"><span class="${statusCls}">${escape(r.status)}</span>${pct}</span>
        </li>`;
      }).join('')}</ul>`;

  const reviewsBlock = reviews.length === 0
    ? `<h3>Low-star reviews (last ${lookbackDays}d)</h3><p class="muted">No 1-2★ reviews ✓</p>`
    : `<h3>Low-star reviews (last ${lookbackDays}d)</h3>${truncatedList(reviews.map(r => `
      <li>
        <span class="warn">${'★'.repeat(r.rating)}${'☆'.repeat(5 - r.rating)}</span>
        ${r.text ? `<div class="desc">${escape(r.text)}</div>` : ''}
        <span class="meta">${relTime(r.when)} ago</span>
      </li>`))}`;

  return card('Play Console', vitalsBlock + rolloutBlock + reviewsBlock);
}

export const playConsole: WidgetModule = {
  id: 'playConsole',
  title: 'Play Console',
  envVars: ['GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET', 'GOOGLE_REFRESH_TOKEN'],
  configFields: [
    {
      type: 'string',
      key: 'packageName',
      label: 'Package name',
      placeholder: 'com.example.app',
      description: "Your app's Android package name as registered on Play Console.",
    },
    {
      type: 'string',
      key: 'lookbackDays',
      label: 'Lookback days',
      placeholder: '7',
      description: 'Period for crash/ANR averaging and review filtering. Default 7.',
    },
  ],
  run,
};
