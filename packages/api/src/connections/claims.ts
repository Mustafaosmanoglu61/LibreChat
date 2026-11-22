import type { ConnectionMetadata } from './types';

const DEFAULT_EXPIRES_IN = 3600;

export interface TokenClaims {
  exp?: number;
  nonce?: string;
  email?: string;
  scp?: string[];
  'https://api.openai.com/auth'?: { chatgpt_plan_type?: string; chatgpt_account_id?: string };
}

/**
 * Reads display fields from a JWT without verifying it. Used only to label the
 * connection in the UI; authorization rests on the provider accepting the token.
 */
export function readClaims(jwt: string | undefined): TokenClaims {
  const payload = jwt?.split('.')[1];
  if (!payload) {
    return {};
  }
  try {
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as TokenClaims;
  } catch {
    return {};
  }
}

/**
 * Seconds the access token has left. A transferred token may have been issued long
 * before upload, so its own `exp` wins over `expires_in`, which is relative to issuance.
 * An already-expired token yields 0 and is refreshed on first use.
 */
export function remainingLifetime(claims: TokenClaims, expiresIn: unknown): number {
  if (typeof claims.exp === 'number') {
    return Math.max(0, claims.exp - Math.floor(Date.now() / 1000));
  }
  return typeof expiresIn === 'number' && expiresIn > 0 ? expiresIn : DEFAULT_EXPIRES_IN;
}

/** Non-secret connection labels taken from the token set the provider issued. */
export function buildMetadata(params: {
  clientId: string;
  idToken: string | undefined;
  accessToken: string;
}): ConnectionMetadata {
  const identity = readClaims(params.idToken);
  const access = readClaims(params.accessToken);
  const auth = identity['https://api.openai.com/auth'] ?? {};
  return {
    clientId: params.clientId,
    accountEmail: identity.email,
    accountId: auth.chatgpt_account_id,
    plan: auth.chatgpt_plan_type,
    scopes: access.scp?.join(' '),
    connectedAt: new Date().toISOString(),
  };
}
