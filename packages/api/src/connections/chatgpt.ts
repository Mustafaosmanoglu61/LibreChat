import type { ConnectionGrant, ConnectionCallback, ConnectionProvider } from './types';

export const CHATGPT_PROVIDER_ID = 'chatgpt';

const AUTHORIZE_ENDPOINT = 'https://auth.openai.com/api/accounts/authorize';
const TOKEN_ENDPOINT = 'https://auth.openai.com/api/accounts/oauth/token';
const RESOURCE = 'https://api.openai.com/v1';
const SCOPES = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
/** First-time registration entrypoint; the callback returns the client id to keep. */
const REGISTRATION_CLIENT_ID = 'dynamic_agent_client';
/**
 * OpenAI rejects a non-loopback redirect_uri for dynamically registered clients, so the
 * browser lands here and the user pastes the address back. Nothing needs to listen on it.
 */
export const CHATGPT_REDIRECT_URI = 'http://127.0.0.1:1455/auth/callback';

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  id_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

/** The one fetch shape the provider needs; injectable so tests substitute the network. */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/** Raised when the provider refuses a refresh token; the user has to reconnect. */
export class ConnectionGrantError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ConnectionGrantError';
  }
}

/**
 * "Sign in with ChatGPT" plan usage: inference runs on the user's own ChatGPT plan
 * through the public Responses API, authorized by a token OpenAI issued to this app.
 */
export function createChatGPTProvider(params: { fetch?: FetchLike } = {}): ConnectionProvider {
  const request = params.fetch ?? fetch;

  async function redeem(form: Record<string, string>, refusal: string): Promise<ConnectionGrant> {
    const response = await request(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form),
    });
    const body = (await response.json().catch(() => ({}))) as TokenResponse;
    if (!response.ok || !body.access_token) {
      throw new ConnectionGrantError(
        body.error ?? `http_${response.status}`,
        body.error_description ?? refusal,
      );
    }
    return {
      accessToken: body.access_token,
      refreshToken: body.refresh_token,
      idToken: body.id_token,
      expiresIn: body.expires_in ?? 3600,
    };
  }

  return {
    id: CHATGPT_PROVIDER_ID,

    redirectUri: CHATGPT_REDIRECT_URI,

    refresh({ refreshToken, clientId }) {
      return redeem(
        {
          grant_type: 'refresh_token',
          client_id: clientId,
          refresh_token: refreshToken,
          resource: RESOURCE,
        },
        'ChatGPT token refresh was refused',
      );
    },

    authorize({ state, nonce, codeChallenge, hostId, appName, clientId, loginHint }) {
      const params = new URLSearchParams({
        client_id: clientId ?? REGISTRATION_CLIENT_ID,
        response_type: 'code',
        redirect_uri: CHATGPT_REDIRECT_URI,
        scope: SCOPES,
        resource: RESOURCE,
        state,
        nonce,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
        ext_agent_host_id: hostId,
      });
      if (clientId == null) {
        params.set('agent_name_hint', appName);
      }
      if (loginHint) {
        params.set('login_hint', loginHint);
      }
      return `${AUTHORIZE_ENDPOINT}?${params}`;
    },

    readCallback(url): ConnectionCallback {
      let parsed: URL;
      try {
        parsed = new URL(url.trim());
      } catch {
        return { error: 'invalid_callback_url' };
      }
      const query = parsed.searchParams;
      const issued = [...query.values()].find((value) => value.startsWith('oaiapp_'));
      return {
        code: query.get('code') ?? undefined,
        state: query.get('state') ?? undefined,
        clientId: query.get('client_id') ?? issued,
        error: query.get('error') ?? undefined,
        errorDescription: query.get('error_description') ?? undefined,
      };
    },

    exchange({ code, clientId, codeVerifier }) {
      return redeem(
        {
          grant_type: 'authorization_code',
          client_id: clientId,
          code,
          code_verifier: codeVerifier,
          redirect_uri: CHATGPT_REDIRECT_URI,
          resource: RESOURCE,
        },
        'ChatGPT refused the authorization code',
      );
    },

    materialize({ connection }) {
      return {
        apiKey: connection.accessToken ?? '',
        baseURL: RESOURCE,
        trustedBaseURL: true,
      };
    },
  };
}
