// Simple in-memory cache helpers shared across widgets.
//
// memoize(): TTL-keyed cache for arbitrary async producers.
// conditionalFetch(): HTTP cache that uses ETag / Last-Modified so that
//   304 responses replay a previously-stored body transparently.
//
// Deliberately tiny: no disk persistence, no LRU eviction, no request
// coalescing — the map grows unbounded but entries are short-lived and
// keyed by stable strings, so this is fine for a single-user dashboard.

type MemoEntry<V> = { value: V; expires: number };

const memoStore = new Map<string, MemoEntry<unknown>>();

export async function memoize<V>(opts: {
  key: string;
  ttlMs: number;
  fetchFresh: () => Promise<V>;
}): Promise<V> {
  const now = Date.now();
  const hit = memoStore.get(opts.key) as MemoEntry<V> | undefined;
  if (hit && hit.expires > now) {
    return hit.value;
  }
  const value = await opts.fetchFresh();
  memoStore.set(opts.key, { value, expires: now + opts.ttlMs });
  return value;
}

// ---------------------------------------------------------------------------
// conditionalFetch
// ---------------------------------------------------------------------------

type HttpCacheEntry = {
  etag?: string;
  lastModified?: string;
  body: string;
  contentType?: string;
  status: number;
  statusText: string;
  // Headers we want to preserve across a 304 replay. Stored as array-of-tuples
  // so `new Headers()` can consume them directly.
  headers: Array<[string, string]>;
};

const httpStore = new Map<string, HttpCacheEntry>();

function mergeHeaders(init: RequestInit | undefined, extra: Record<string, string>): HeadersInit {
  // Normalize existing headers into a plain Record so we can layer ours on.
  const merged: Record<string, string> = {};
  const src = init?.headers;
  if (src) {
    if (src instanceof Headers) {
      src.forEach((v, k) => { merged[k] = v; });
    } else if (Array.isArray(src)) {
      for (const [k, v] of src) merged[k] = v;
    } else {
      Object.assign(merged, src as Record<string, string>);
    }
  }
  for (const [k, v] of Object.entries(extra)) {
    // Only add validators if the caller didn't already supply one.
    if (!(k.toLowerCase() in Object.fromEntries(Object.entries(merged).map(([kk, vv]) => [kk.toLowerCase(), vv])))) {
      merged[k] = v;
    }
  }
  return merged;
}

function buildReplayResponse(entry: HttpCacheEntry): Response {
  // A 304 has no body and typed as such by the fetch spec — callers can't
  // call `.json()` / `.text()` on it. Reconstruct a real 200-status Response
  // carrying the previously cached body so the caller code path is uniform.
  const headers = new Headers(entry.headers);
  if (entry.contentType && !headers.has('content-type')) {
    headers.set('content-type', entry.contentType);
  }
  return new Response(entry.body, {
    status: 200,
    statusText: 'OK (from conditional cache)',
    headers,
  });
}

export async function conditionalFetch(url: string, init?: RequestInit): Promise<Response> {
  const existing = httpStore.get(url);

  const validators: Record<string, string> = {};
  if (existing?.etag) validators['If-None-Match'] = existing.etag;
  if (existing?.lastModified) validators['If-Modified-Since'] = existing.lastModified;

  const mergedInit: RequestInit = {
    ...init,
    headers: mergeHeaders(init, validators),
  };

  const res = await fetch(url, mergedInit);

  if (res.status === 304 && existing) {
    return buildReplayResponse(existing);
  }

  if (res.ok) {
    // Store a fresh copy. We have to read the body as text to cache it, and
    // return a clone to the caller so they can still consume it themselves.
    const clone = res.clone();
    let bodyText = '';
    try {
      bodyText = await clone.text();
    } catch {
      // If reading fails, skip caching but still pass the original response back.
      return res;
    }
    const etag = res.headers.get('etag') ?? undefined;
    const lastModified = res.headers.get('last-modified') ?? undefined;
    const contentType = res.headers.get('content-type') ?? undefined;
    // Only cache if we have at least one validator — otherwise there's no way
    // to do a conditional request next time, so it would just waste memory.
    if (etag || lastModified) {
      const headerEntries: Array<[string, string]> = [];
      res.headers.forEach((v, k) => {
        // Strip hop-by-hop + length headers that would be wrong on replay.
        const lk = k.toLowerCase();
        if (lk === 'content-length' || lk === 'transfer-encoding' || lk === 'content-encoding') return;
        headerEntries.push([k, v]);
      });
      httpStore.set(url, {
        etag,
        lastModified,
        body: bodyText,
        contentType,
        status: res.status,
        statusText: res.statusText,
        headers: headerEntries,
      });
    }
    // We already consumed `clone`; the original `res` body is still unread.
    return res;
  }

  // Non-2xx (other than 304): don't cache, let the caller handle the error.
  return res;
}
