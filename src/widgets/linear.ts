import type { ProjectConfig, WidgetModule, Result } from '../types.ts';
import { card, errorCard, escape, relTime, truncatedList } from '../render.ts';
import { memoize } from '../cache.ts';

const LINEAR_TTL_MS = 60_000;

type LinearSummary = { inbox: number; assigned: number };

export type LinearIssueRef = {
  id: string;
  title: string;
  state: string;
  url: string;
};

type LinearConfig = {
  tokenEnv?: string;
  includeStates?: string[];
  maxIssues?: number;
  maxInboxItems?: number;
};

type Issue = {
  identifier: string;
  title: string;
  url: string;
  stateName: string;
  stateType: string;
  priority: number;
  priorityLabel: string;
  updatedAt: string;
  teamKey: string;
};

type InboxItem = {
  id: string;
  type: string;
  url: string;
  createdAt: string;
  actor: string;
  target: string;
};

type LinearData = { issues: Issue[]; inbox: InboxItem[] };

const DEFAULT_TOKEN_ENV = 'LINEAR_API_KEY';
const DEFAULT_STATES = ['started', 'unstarted'];
const DEFAULT_MAX_ISSUES = 15;
const DEFAULT_MAX_INBOX = 15;

const QUERY = `
query MissionControl($stateTypes: [String!], $issueLimit: Int!, $notifLimit: Int!) {
  viewer {
    assignedIssues(
      filter: { state: { type: { in: $stateTypes } } }
      first: $issueLimit
      orderBy: updatedAt
    ) {
      nodes {
        identifier
        title
        url
        priority
        priorityLabel
        updatedAt
        state { name type }
        team { key }
      }
    }
  }
  notifications(first: $notifLimit) {
    nodes {
      id
      type
      url
      createdAt
      readAt
      snoozedUntilAt
      actor { displayName name }
      externalUserActor { displayName name }
      botActor { name }
      ... on IssueNotification {
        issue { identifier title }
      }
      ... on ProjectNotification { project { name } }
      ... on InitiativeNotification { initiative { name } }
      ... on PullRequestNotification { pullRequest { title } }
    }
  }
}
`;

function describeNotificationType(type: string): string {
  const map: Record<string, string> = {
    issueAssignedToYou: 'assigned',
    issueUnassignedFromYou: 'unassigned',
    issueCreated: 'created',
    issueStatusChanged: 'status changed on',
    issueNewComment: 'commented on',
    issueCommentMention: 'mentioned you in',
    issueMention: 'mentioned you in',
    issueCommentReaction: 'reacted in',
    issueReaction: 'reacted to',
    issueDue: 'due soon:',
    issueBlocking: 'blocking:',
    issueUnblocked: 'unblocked',
    issueSubscribed: 'updated',
    issueEmoji: 'reacted to',
    projectUpdateCreated: 'project update on',
    projectUpdateMention: 'mentioned you in',
    documentMention: 'mentioned you in',
    initiativeMention: 'mentioned you in',
    pullRequestReview: 'PR review:',
  };
  return map[type] ?? type.replace(/([A-Z])/g, ' $1').toLowerCase().trim();
}

function extractTarget(node: any): string {
  if (node.issue) {
    return `${node.issue.identifier} ${node.issue.title}`;
  }
  if (node.project) return node.project.name;
  if (node.document) return node.document.title;
  if (node.initiative) return node.initiative.name;
  if (node.pullRequest) return node.pullRequest.title;
  return '';
}

function extractActor(node: any): string {
  if (node.actor) return node.actor.displayName ?? node.actor.name ?? 'someone';
  if (node.externalUserActor) return node.externalUserActor.displayName ?? node.externalUserActor.name ?? 'external';
  if (node.botActor) return node.botActor.name ?? 'bot';
  return 'Linear';
}

async function linearGraphql<T = any>(
  token: string,
  query: string,
  variables: Record<string, unknown>,
  cacheKey: string,
  ttlMs: number,
): Promise<{ data?: T; errors?: Array<{ message: string }>; httpError?: string }> {
  return memoize({
    key: cacheKey,
    ttlMs,
    fetchFresh: async () => {
      const res = await fetch('https://api.linear.app/graphql', {
        method: 'POST',
        headers: {
          Authorization: token,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ query, variables }),
      });
      if (!res.ok) {
        return { httpError: `Linear ${res.status}: ${await res.text()}` };
      }
      return await res.json() as { data?: T; errors?: Array<{ message: string }> };
    },
  });
}

async function fetchLinear(project: ProjectConfig): Promise<Result<LinearData>> {
  const config = (project.widgets.linear ?? {}) as LinearConfig;
  const tokenEnv = config.tokenEnv ?? DEFAULT_TOKEN_ENV;
  const token = process.env[tokenEnv];
  if (!token) {
    return { ok: false, error: `Set ${tokenEnv} in .env (see .env.example). Get a personal API key at https://linear.app/settings/api.` };
  }
  const stateTypes = config.includeStates ?? DEFAULT_STATES;
  const issueLimit = config.maxIssues ?? DEFAULT_MAX_ISSUES;
  // Inbox has no server-side readAt filter — overfetch so client-side trimming still yields enough.
  const notifLimit = Math.max((config.maxInboxItems ?? DEFAULT_MAX_INBOX) * 3, 50);

  try {
    const cfgKey = JSON.stringify({ tokenEnv, stateTypes, issueLimit, notifLimit });
    const cacheKey = `linear:main:${cfgKey}`;
    const json = await linearGraphql(token, QUERY, { stateTypes, issueLimit, notifLimit }, cacheKey, LINEAR_TTL_MS);
    if (json.httpError) {
      return { ok: false, error: json.httpError };
    }
    if (json.errors?.length) {
      return { ok: false, error: json.errors.map(e => e.message).join('; ') };
    }

    const issues: Issue[] = (json.data?.viewer?.assignedIssues?.nodes ?? []).map((n: any) => ({
      identifier: n.identifier,
      title: n.title,
      url: n.url,
      stateName: n.state?.name ?? '',
      stateType: n.state?.type ?? '',
      priority: n.priority ?? 0,
      priorityLabel: n.priorityLabel ?? '',
      updatedAt: n.updatedAt ?? '',
      teamKey: n.team?.key ?? '',
    }));

    const inboxNodes: any[] = json.data?.notifications?.nodes ?? [];
    const maxInbox = config.maxInboxItems ?? DEFAULT_MAX_INBOX;
    const inbox: InboxItem[] = inboxNodes
      .filter(n => n.readAt === null && n.snoozedUntilAt === null)
      .slice(0, maxInbox)
      .map(n => ({
        id: n.id,
        type: n.type,
        url: n.url,
        createdAt: n.createdAt,
        actor: extractActor(n),
        target: extractTarget(n),
      }));

    return { ok: true, data: { issues, inbox } };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

const ISSUES_BY_ID_QUERY = `
query IssuesByIdentifier($ids: [String!]!) {
  issues(filter: { identifier: { in: $ids } }, first: 100) {
    nodes {
      identifier
      title
      url
      state { name }
    }
  }
}
`;

/**
 * Fetch a specific set of Linear issues by their human identifiers (e.g. "FUT-123").
 * Uses the same token / env-var resolution as the main widget. Returns an empty
 * array on any failure (missing token, network error, Linear GraphQL error) so
 * that callers using this for decoration (like prs.ts) can silently degrade.
 */
export async function fetchIssues(project: ProjectConfig, ids: string[]): Promise<LinearIssueRef[]> {
  if (ids.length === 0) return [];
  const config = (project.widgets.linear ?? {}) as LinearConfig;
  const tokenEnv = config.tokenEnv ?? DEFAULT_TOKEN_ENV;
  const token = process.env[tokenEnv];
  if (!token) return [];

  const uniqueIds = Array.from(new Set(ids)).sort();
  const cacheKey = `linear:issues-by-id:${tokenEnv}:${uniqueIds.join(',')}`;

  try {
    const json = await linearGraphql(token, ISSUES_BY_ID_QUERY, { ids: uniqueIds }, cacheKey, LINEAR_TTL_MS);
    if (json.httpError || json.errors?.length) return [];
    const nodes: any[] = json.data?.issues?.nodes ?? [];
    return nodes.map(n => ({
      id: n.identifier,
      title: n.title,
      state: n.state?.name ?? '',
      url: n.url,
    }));
  } catch {
    return [];
  }
}

function sortIssues(issues: Issue[]): Issue[] {
  // "started" before "unstarted"; then priority (1=urgent, 2=high, ..., 0=no priority goes last); then updatedAt desc.
  const stateRank = (t: string) => (t === 'started' ? 0 : t === 'unstarted' ? 1 : 2);
  const prioRank = (p: number) => (p === 0 ? 99 : p);
  return [...issues].sort((a, b) => {
    const s = stateRank(a.stateType) - stateRank(b.stateType);
    if (s !== 0) return s;
    const p = prioRank(a.priority) - prioRank(b.priority);
    if (p !== 0) return p;
    return b.updatedAt.localeCompare(a.updatedAt);
  });
}

function renderIssues(issues: Issue[]): string {
  if (issues.length === 0) {
    return `<h3>My issues</h3><p class="muted">Nothing assigned.</p>`;
  }
  const rows = sortIssues(issues).map(i => {
    const prio = i.priority > 0 && i.priorityLabel ? `<span class="tag">${escape(i.priorityLabel)}</span>` : '';
    return `
    <li>
      <a href="${escape(i.url)}" target="_blank" rel="noreferrer">
        <span class="num">${escape(i.identifier)}</span>
        <span class="tag">${escape(i.stateName)}</span>
        ${prio}
        <span class="title">${escape(i.title)}</span>
      </a>
      <span class="meta">updated ${relTime(i.updatedAt)} ago</span>
    </li>`;
  });
  return `<h3>My issues <span class="count">${issues.length}</span></h3>${truncatedList(rows, { listClass: 'linear-issues' })}`;
}

function renderInbox(items: InboxItem[]): string {
  if (items.length === 0) {
    return `<h3>Inbox</h3><p class="muted">Inbox zero.</p>`;
  }
  const rows = items.map(n => `
    <li>
      <a href="${escape(n.url)}" target="_blank" rel="noreferrer">
        <span class="title">${escape(n.actor)} ${escape(describeNotificationType(n.type))} ${escape(n.target)}</span>
      </a>
      <span class="meta">${relTime(n.createdAt)} ago</span>
    </li>`);
  return `<h3>Inbox <span class="count">${items.length}</span></h3>${truncatedList(rows, { listClass: 'linear-inbox' })}`;
}

async function render(project: ProjectConfig): Promise<{ html: string; summary: LinearSummary }> {
  const result = await fetchLinear(project);
  if (!result.ok) {
    return { html: errorCard('Linear', result.error), summary: { inbox: 0, assigned: 0 } };
  }
  const body = renderIssues(result.data.issues) + renderInbox(result.data.inbox);
  return {
    html: card('Linear', body),
    summary: {
      inbox: result.data.inbox.length,
      assigned: result.data.issues.length,
    },
  };
}

export const linear: WidgetModule = {
  id: 'linear',
  title: 'Linear',
  envVars: project => {
    const cfg = (project.widgets.linear ?? {}) as LinearConfig;
    return [cfg.tokenEnv ?? DEFAULT_TOKEN_ENV];
  },
  configFields: [
    {
      type: 'string',
      key: 'tokenEnv',
      label: 'API key env var',
      placeholder: DEFAULT_TOKEN_ENV,
      description: 'Name of the env var holding a Linear personal API key. Defaults to LINEAR_API_KEY.',
    },
    {
      type: 'multiline-list',
      key: 'includeStates',
      label: 'Issue state types',
      placeholder: 'started\nunstarted',
      description: 'State types to include, one per line. Options: started, unstarted, backlog, completed, canceled, triage.',
    },
  ],
  run: async project => {
    const { html, summary } = await render(project);
    return { html, summary };
  },
};
