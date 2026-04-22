import type { ProjectConfig, WidgetModule } from '../types.ts';
import { card, errorCard, escape, truncatedList } from '../render.ts';
import { hasOAuthClient, hasRefreshToken } from '../auth/google.ts';
import { googleJson } from '../google/client.ts';

type CalendarConfig = {
  calendarId?: string;
};

type CalendarSummary = {
  nextMeetingAt?: string;
  meetingsToday: number;
};

type CalEvent = {
  id: string;
  summary?: string;
  start?: { dateTime?: string; date?: string; timeZone?: string };
  end?: { dateTime?: string; date?: string; timeZone?: string };
  htmlLink?: string;
  hangoutLink?: string;
  conferenceData?: {
    entryPoints?: Array<{ entryPointType?: string; uri?: string }>;
  };
  attendees?: Array<{ self?: boolean; responseStatus?: string }>;
  status?: string;
};

type EventsListResponse = {
  items?: CalEvent[];
};

function isAllDay(e: CalEvent): boolean {
  return !!(e.start?.date && !e.start?.dateTime);
}

function isDeclined(e: CalEvent): boolean {
  const me = e.attendees?.find(a => a.self);
  if (me && me.responseStatus === 'declined') return true;
  if (e.status === 'cancelled') return true;
  return false;
}

function meetingLink(e: CalEvent): string | undefined {
  if (e.hangoutLink) return e.hangoutLink;
  const video = e.conferenceData?.entryPoints?.find(p => p.entryPointType === 'video');
  if (video?.uri) return video.uri;
  return e.htmlLink;
}

function fmtTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

function fmtRange(e: CalEvent): string {
  const startIso = e.start?.dateTime;
  const endIso = e.end?.dateTime;
  if (!startIso) return '';
  if (!endIso) return fmtTime(startIso);
  return `${fmtTime(startIso)}–${fmtTime(endIso)}`;
}

function endOfLocalDay(now: Date): Date {
  const end = new Date(now);
  end.setHours(23, 59, 59, 999);
  return end;
}

async function runCalendar(project: ProjectConfig): Promise<{ html: string; summary: CalendarSummary }> {
  const config = (project.widgets.calendar ?? {}) as CalendarConfig;
  const calendarId = (config.calendarId?.toString().trim()) || 'primary';
  const emptySummary: CalendarSummary = { meetingsToday: 0 };

  if (!hasOAuthClient()) {
    return { html: errorCard('Calendar', 'Google OAuth client not configured — see /settings.'), summary: emptySummary };
  }
  if (!hasRefreshToken()) {
    return { html: errorCard('Calendar', 'Not connected to Google — click Connect on /settings.'), summary: emptySummary };
  }

  const now = new Date();
  const eod = endOfLocalDay(now);
  const in24h = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  const windowEnd = in24h.getTime() > eod.getTime() ? in24h : eod;

  const url = new URL(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`);
  url.searchParams.set('timeMin', now.toISOString());
  url.searchParams.set('timeMax', windowEnd.toISOString());
  url.searchParams.set('singleEvents', 'true');
  url.searchParams.set('orderBy', 'startTime');
  url.searchParams.set('maxResults', '50');

  let events: CalEvent[];
  try {
    const data = await googleJson<EventsListResponse>(url.toString());
    events = (data.items ?? []).filter(e => !isAllDay(e) && !isDeclined(e) && !!e.start?.dateTime);
  } catch (e) {
    return { html: errorCard('Calendar', (e as Error).message), summary: emptySummary };
  }

  const todayMsEnd = eod.getTime();
  const todayEvents = events.filter(e => {
    const s = e.start?.dateTime ? new Date(e.start.dateTime).getTime() : 0;
    return s <= todayMsEnd;
  });
  const summary: CalendarSummary = {
    nextMeetingAt: events[0]?.start?.dateTime,
    meetingsToday: todayEvents.length,
  };

  if (events.length === 0) {
    return { html: card('Calendar', `<p class="muted">No meetings scheduled in the next 24h ✓</p>`), summary };
  }

  const next = events[0];
  const link = meetingLink(next);
  const nextTitle = next.summary || '(no title)';
  const nextRendered = link
    ? `<a href="${escape(link)}" target="_blank" rel="noreferrer">${escape(nextTitle)}</a>`
    : escape(nextTitle);
  const nextBlock = `<p>
    <span class="repo">Next:</span>
    <span class="title">${nextRendered}</span>
    <span class="meta">${escape(fmtRange(next))}</span>
  </p>`;

  const todayRemaining = todayEvents.slice(1);

  const listBlock = todayRemaining.length === 0
    ? `<h3>Today</h3><p class="muted">Nothing else on the calendar today.</p>`
    : `<h3>Today</h3>${truncatedList(todayRemaining.map(e => {
        const l = meetingLink(e);
        const title = e.summary || '(no title)';
        const rendered = l
          ? `<a href="${escape(l)}" target="_blank" rel="noreferrer">${escape(title)}</a>`
          : escape(title);
        return `<li>
          <span class="title">${rendered}</span>
          <span class="meta">${escape(fmtRange(e))}</span>
        </li>`;
      }))}`;

  return { html: card('Calendar', nextBlock + listBlock), summary };
}

export const calendar: WidgetModule = {
  id: 'calendar',
  title: 'Calendar',
  envVars: ['GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET', 'GOOGLE_REFRESH_TOKEN'],
  configFields: [
    {
      type: 'string',
      key: 'calendarId',
      label: 'Calendar ID (optional)',
      placeholder: 'primary',
      description: 'Defaults to your primary calendar. Use an email address to pick a different one (e.g., team@company.com).',
    },
  ],
  run: async project => {
    const { html, summary } = await runCalendar(project);
    return { html, summary };
  },
};
