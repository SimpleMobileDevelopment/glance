import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';

const AUTH_FILE = '.google-auth.json';
const ENV_FILE = '.env';

export const SCOPES = [
  'https://www.googleapis.com/auth/androidpublisher',
  'https://www.googleapis.com/auth/playdeveloperreporting',
  'https://www.googleapis.com/auth/cloud-platform.read-only',
  'https://www.googleapis.com/auth/bigquery.readonly',
  'https://www.googleapis.com/auth/userinfo.email',
  'openid',
];

export type GoogleAuthState = {
  email?: string;
  scopes?: string[];
  connectedAt?: string;
};

type PendingFlow = {
  verifier: string;
  redirectUri: string;
  expiresAt: number;
};

const pendingFlows = new Map<string, PendingFlow>();

let accessTokenCache: { token: string; expiresAt: number } | null = null;

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function createPkcePair(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

export function hasOAuthClient(): boolean {
  const id = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const secret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  return !!id && !!secret && !id.includes('replace_me') && !secret.includes('replace_me');
}

export function hasRefreshToken(): boolean {
  const t = process.env.GOOGLE_REFRESH_TOKEN;
  return !!t && !t.includes('replace_me');
}

export async function readAuthState(): Promise<GoogleAuthState> {
  if (!existsSync(AUTH_FILE)) return {};
  try {
    return JSON.parse(await readFile(AUTH_FILE, 'utf8')) as GoogleAuthState;
  } catch {
    return {};
  }
}

async function writeAuthState(state: GoogleAuthState): Promise<void> {
  await writeFile(AUTH_FILE, JSON.stringify(state, null, 2), 'utf8');
}

async function upsertEnvVar(name: string, value: string): Promise<void> {
  const lines = existsSync(ENV_FILE) ? (await readFile(ENV_FILE, 'utf8')).split(/\r?\n/) : [];
  const re = new RegExp(`^\\s*${name}\\s*=`);
  let updated = false;
  const newLines = lines.map(l => {
    if (re.test(l)) { updated = true; return `${name}=${value}`; }
    return l;
  });
  if (!updated) {
    if (newLines.length > 0 && newLines[newLines.length - 1] !== '') newLines.push('');
    newLines.push(`${name}=${value}`);
  }
  await writeFile(ENV_FILE, newLines.join('\n'));
  process.env[name] = value;
}

export function buildAuthUrl(redirectUri: string): { url: string; state: string } {
  if (!hasOAuthClient()) {
    throw new Error('Set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET in .env first.');
  }
  const { verifier, challenge } = createPkcePair();
  const state = base64url(randomBytes(16));
  pendingFlows.set(state, { verifier, redirectUri, expiresAt: Date.now() + 10 * 60_000 });
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_OAUTH_CLIENT_ID!,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: SCOPES.join(' '),
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
  });
  return { url: `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`, state };
}

export async function completeAuthFlow(code: string, state: string): Promise<GoogleAuthState> {
  const pending = pendingFlows.get(state);
  if (!pending) throw new Error('Unknown or expired OAuth state — retry from /settings.');
  pendingFlows.delete(state);
  if (Date.now() > pending.expiresAt) throw new Error('OAuth flow expired — retry from /settings.');

  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_OAUTH_CLIENT_ID!,
      client_secret: process.env.GOOGLE_OAUTH_CLIENT_SECRET!,
      code,
      code_verifier: pending.verifier,
      grant_type: 'authorization_code',
      redirect_uri: pending.redirectUri,
    }),
  });
  if (!tokenRes.ok) {
    throw new Error(`Token exchange failed: ${tokenRes.status} ${await tokenRes.text()}`);
  }
  const tokens = await tokenRes.json() as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
    scope: string;
  };
  if (!tokens.refresh_token) {
    throw new Error('Google did not return a refresh token. Revoke access at myaccount.google.com/permissions and retry.');
  }

  accessTokenCache = { token: tokens.access_token, expiresAt: Date.now() + (tokens.expires_in - 60) * 1000 };

  const userRes = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });
  const email = userRes.ok ? (await userRes.json() as { email?: string }).email : undefined;

  await upsertEnvVar('GOOGLE_REFRESH_TOKEN', tokens.refresh_token);
  const next: GoogleAuthState = {
    email,
    scopes: tokens.scope.split(' '),
    connectedAt: new Date().toISOString(),
  };
  await writeAuthState(next);
  return next;
}

export async function getAccessToken(): Promise<string> {
  if (accessTokenCache && accessTokenCache.expiresAt > Date.now()) return accessTokenCache.token;
  if (!hasOAuthClient()) throw new Error('Google OAuth client not configured.');
  if (!hasRefreshToken()) throw new Error('Not connected to Google — visit /settings.');

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_OAUTH_CLIENT_ID!,
      client_secret: process.env.GOOGLE_OAUTH_CLIENT_SECRET!,
      refresh_token: process.env.GOOGLE_REFRESH_TOKEN!,
      grant_type: 'refresh_token',
    }),
  });
  if (!res.ok) throw new Error(`Refresh failed: ${res.status} ${await res.text()}`);
  const tokens = await res.json() as { access_token: string; expires_in: number };
  accessTokenCache = { token: tokens.access_token, expiresAt: Date.now() + (tokens.expires_in - 60) * 1000 };
  return tokens.access_token;
}

export async function disconnect(): Promise<void> {
  accessTokenCache = null;
  await upsertEnvVar('GOOGLE_REFRESH_TOKEN', 'replace_me');
  if (existsSync(AUTH_FILE)) await writeFile(AUTH_FILE, '{}', 'utf8');
}
