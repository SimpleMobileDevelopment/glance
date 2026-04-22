import { getAccessToken } from '../auth/google.ts';
import { friendlyGoogleError } from '../errors.ts';

/**
 * Performs a Google API fetch with a Bearer access token attached.
 * Throws a friendly, user-readable error on non-OK responses.
 */
export async function googleFetch(url: string, init?: RequestInit): Promise<Response> {
  const token = await getAccessToken();
  const headers: Record<string, string> = {
    ...(init?.headers as Record<string, string> | undefined),
    Authorization: `Bearer ${token}`,
  };
  // Only default Content-Type on requests that likely have a body.
  if (init?.body !== undefined && init.body !== null && !('Content-Type' in headers) && !('content-type' in headers)) {
    headers['Content-Type'] = 'application/json';
  }
  const res = await fetch(url, { ...init, headers });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(friendlyGoogleError(text, res.status));
  }
  return res;
}

/**
 * Performs a Google API fetch and returns the parsed JSON body.
 * Throws via friendlyGoogleError on non-OK responses.
 */
export async function googleJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await googleFetch(url, init);
  return res.json() as Promise<T>;
}
