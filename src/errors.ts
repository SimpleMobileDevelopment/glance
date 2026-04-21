type GoogleErrorShape = {
  error?: {
    message?: string;
    status?: string;
    details?: Array<Record<string, unknown>>;
  };
};

export function friendlyGoogleError(raw: string, status: number): string {
  const trimmed = raw.trimStart();
  if (trimmed.startsWith('<') || /^<!doctype/i.test(trimmed.slice(0, 10))) {
    if (status === 404) return 'Not found — the API returned an HTML 404 (resource name is likely invalid).';
    return `HTTP ${status}: non-JSON response from endpoint.`;
  }
  try {
    const { error } = JSON.parse(raw) as GoogleErrorShape;
    if (!error) return truncate(raw);
    const info = error.details?.find(d => typeof d['@type'] === 'string' && (d['@type'] as string).includes('ErrorInfo'));
    const reason = info && typeof info.reason === 'string' ? info.reason : undefined;
    if (reason === 'ACCESS_TOKEN_SCOPE_INSUFFICIENT') {
      return 'Reconnect Google on /settings — the refresh token is missing a required scope.';
    }
    const msg = error.message ?? '';
    const prefixed = (prefix: string) => /^(?:invalid|not found|permission denied|unauthenticated)\b/i.test(msg) ? msg : `${prefix}${msg}`.trim();
    if (error.status === 'INVALID_ARGUMENT') return prefixed('Invalid request: ');
    if (error.status === 'PERMISSION_DENIED') return prefixed('Permission denied: ');
    if (error.status === 'NOT_FOUND') return prefixed('Not found: ');
    if (error.status === 'UNAUTHENTICATED') return 'Not authenticated — reconnect Google on /settings.';
    return msg || `${status} ${error.status ?? ''}`.trim();
  } catch {
    return truncate(raw);
  }
}

function truncate(s: string): string {
  return s.length > 200 ? `${s.slice(0, 200)}…` : s;
}