import { getAccessToken } from './auth/google.ts';
import { friendlyGoogleError } from './errors.ts';

export type BqParamType = 'STRING' | 'INT64' | 'TIMESTAMP' | 'BOOL';
export type BqParam = { name: string; type: BqParamType; value: string };

type JobsQueryResponse = {
  jobComplete: boolean;
  schema?: { fields: Array<{ name: string; type: string }> };
  rows?: Array<{ f: Array<{ v: unknown }> }>;
};

export async function runQuery<T = Record<string, unknown>>(
  gcpProjectId: string,
  sql: string,
  params: BqParam[] = [],
  location?: string,
): Promise<T[]> {
  const token = await getAccessToken();
  const body: Record<string, unknown> = {
    query: sql,
    useLegacySql: false,
    timeoutMs: 30_000,
  };
  if (location) body.location = location;
  if (params.length > 0) {
    body.parameterMode = 'NAMED';
    body.queryParameters = params.map(p => ({
      name: p.name,
      parameterType: { type: p.type },
      parameterValue: { value: p.value },
    }));
  }
  const res = await fetch(
    `https://bigquery.googleapis.com/bigquery/v2/projects/${encodeURIComponent(gcpProjectId)}/queries`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
  );
  if (!res.ok) throw new Error(friendlyGoogleError(await res.text(), res.status));
  const data = await res.json() as JobsQueryResponse;
  if (!data.jobComplete) {
    throw new Error('BigQuery query timed out — try a smaller lookback window.');
  }
  const fields = data.schema?.fields ?? [];
  return (data.rows ?? []).map(r => {
    const obj: Record<string, unknown> = {};
    fields.forEach((f, i) => { obj[f.name] = r.f[i]?.v; });
    return obj as T;
  });
}

export async function fetchDatasetLocation(
  gcpProjectId: string,
  datasetId: string,
): Promise<string | null> {
  const token = await getAccessToken();
  const res = await fetch(
    `https://bigquery.googleapis.com/bigquery/v2/projects/${encodeURIComponent(gcpProjectId)}/datasets/${encodeURIComponent(datasetId)}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!res.ok) throw new Error(friendlyGoogleError(await res.text(), res.status));
  const data = await res.json() as { location?: string };
  return data.location ?? null;
}

export async function listTables(
  gcpProjectId: string,
  datasetId: string,
): Promise<string[]> {
  const token = await getAccessToken();
  const out: string[] = [];
  let pageToken: string | undefined;
  do {
    const qs = new URLSearchParams({ maxResults: '200' });
    if (pageToken) qs.set('pageToken', pageToken);
    const res = await fetch(
      `https://bigquery.googleapis.com/bigquery/v2/projects/${encodeURIComponent(gcpProjectId)}/datasets/${encodeURIComponent(datasetId)}/tables?${qs}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!res.ok) throw new Error(friendlyGoogleError(await res.text(), res.status));
    const data = await res.json() as {
      tables?: Array<{ tableReference?: { tableId?: string } }>;
      nextPageToken?: string;
    };
    for (const t of data.tables ?? []) {
      if (t.tableReference?.tableId) out.push(t.tableReference.tableId);
    }
    pageToken = data.nextPageToken;
  } while (pageToken);
  return out.sort();
}