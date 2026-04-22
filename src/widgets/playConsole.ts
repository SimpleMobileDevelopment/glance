import type { ProjectConfig, WidgetModule, Hero } from '../types.ts';
import { card, errorCard, escape, relTime, truncatedList, dot, type Tone } from '../render.ts';
import { hasOAuthClient, hasRefreshToken } from '../auth/google.ts';
import { googleFetch, googleJson } from '../google/client.ts';

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

type TimelineBody = {
  timelineSpec: { aggregationPeriod: string; startTime: DatePart; endTime: DatePart };
  metrics: string[];
};

async function queryMetricSet<T>(
  path: string,
  body: TimelineBody,
  lookbackDays: number,
): Promise<T> {
  const url = `${REPORTING_API}${path}`;
  try {
    return await googleJson<T>(url, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  } catch (e) {
    const msg = (e as Error).message;
    // Retry once with the freshness-capped window if the API told us about it.
    const cap = parseFreshnessCap(msg);
    if (!cap) throw e;
    const endMs = Date.UTC(cap.year, cap.month - 1, cap.day);
    const retryBody: TimelineBody = {
      ...body,
      timelineSpec: {
        ...body.timelineSpec,
        startTime: datePartFromMs(endMs - lookbackDays * 86_400_000),
        endTime: cap,
      },
    };
    return googleJson<T>(url, {
      method: 'POST',
      body: JSON.stringify(retryBody),
    });
  }
}

type MetricRow = { metrics?: Array<{ decimalValue?: { value?: string } }> };

async function fetchVitalRate(
  packageName: string,
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

async function fetchBadReviews(packageName: string, lookbackDays: number): Promise<Review[]> {
  const data = await googleJson<ReviewsResponse>(
    `${API}/applications/${encodeURIComponent(packageName)}/reviews?maxResults=50`,
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

async function fetchRollouts(packageName: string): Promise<Rollout[]> {
  const edit = await googleJson<{ id: string }>(
    `${API}/applications/${encodeURIComponent(packageName)}/edits`,
    { method: 'POST', body: '{}' },
  );
  try {
    const data = await googleJson<TracksResponse>(
      `${API}/applications/${encodeURIComponent(packageName)}/edits/${edit.id}/tracks`,
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
    googleFetch(`${API}/applications/${encodeURIComponent(packageName)}/edits/${edit.id}`, {
      method: 'DELETE',
    }).catch(() => { /* edit auto-expires anyway */ });
  }
}

function fmtPct(v: number | null, warnAbove: number): string {
  if (v == null) return '<span class="muted">—</span>';
  const cls = v > warnAbove ? 'warn' : 'ok';
  return `<span class="${cls}">${(v * 100).toFixed(2)}%</span>`;
}

async function render(project: ProjectConfig): Promise<{ html: string; hero?: Hero }> {
  const config = (project.widgets.playConsole ?? {}) as PlayConfig;
  const packageName = config.packageName;
  const lookbackDays = Math.max(1, Number(config.lookbackDays ?? 7) || 7);

  if (!packageName) {
    return { html: card('Play Console', `<p class="muted">Set <code>widgets.playConsole.packageName</code> in project.json.</p>`) };
  }
  if (!hasOAuthClient()) {
    return { html: errorCard('Play Console', 'Google OAuth client not configured — see /settings.') };
  }
  if (!hasRefreshToken()) {
    return { html: errorCard('Play Console', 'Not connected to Google — click Connect on /settings.') };
  }

  const [crashRate, anrRate, reviews, rollouts] = await Promise.all([
    fetchVitalRate(packageName, 'crashRateMetricSet', 'crashRate', lookbackDays)
      .catch(e => { console.error('[playConsole] crash:', e.message); return null; }),
    fetchVitalRate(packageName, 'anrRateMetricSet', 'anrRate', lookbackDays)
      .catch(e => { console.error('[playConsole] anr:', e.message); return null; }),
    fetchBadReviews(packageName, lookbackDays)
      .catch(e => { console.error('[playConsole] reviews:', e.message); return [] as Review[]; }),
    fetchRollouts(packageName)
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
        const rolloutTone = r.status === 'halted' ? 'red' : 'amber';
        const pct = r.userFraction !== undefined ? ` · ${(r.userFraction * 100).toFixed(0)}%` : '';
        return `<li>
          ${dot(rolloutTone)}
          <span class="tag">${escape(r.track)}</span>
          <span class="title">${escape(r.versionCodes || '(no versions)')}</span>
          <span class="meta"><span class="tone-${rolloutTone}">${escape(r.status)}</span>${pct}</span>
        </li>`;
      }).join('')}</ul>`;

  const reviewsBlock = reviews.length === 0
    ? `<h3>Low-star reviews (last ${lookbackDays}d)</h3><p class="muted">No 1-2★ reviews.</p>`
    : `<h3>Low-star reviews (last ${lookbackDays}d)</h3>${truncatedList(reviews.map(r => `
      <li>
        <span class="warn">${'★'.repeat(r.rating)}${'☆'.repeat(5 - r.rating)}</span>
        ${r.text ? `<div class="desc">${escape(r.text)}</div>` : ''}
        <span class="meta">${relTime(r.when)}</span>
      </li>`))}`;

  // Hero = active rollout count. Red if anything halted, amber if active rollouts, green otherwise.
  const halted = activeRollouts.some(r => r.status === 'halted');
  const heroTone: Tone = halted ? 'red' : activeRollouts.length > 0 ? 'amber' : 'green';
  const hero: Hero = {
    value: activeRollouts.length,
    tone: heroTone,
    label: activeRollouts.length === 1 ? 'rollout' : 'rollouts',
  };
  return {
    html: card('Play Console', vitalsBlock + rolloutBlock + reviewsBlock, { hero }),
    hero,
  };
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
  run: async project => render(project),
};
