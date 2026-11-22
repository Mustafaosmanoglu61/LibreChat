import type { ConnectionGrant, ConnectionProvider } from './types';

export const CHATGPT_PROVIDER_ID = 'chatgpt';

const TOKEN_ENDPOINT = 'https://auth.openai.com/api/accounts/oauth/token';
const RESOURCE = 'https://api.openai.com/v1';

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

  return {
    id: CHATGPT_PROVIDER_ID,

    async refresh({ refreshToken, clientId }): Promise<ConnectionGrant> {
      const response = await request(TOKEN_ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          client_id: clientId,
          refresh_token: refreshToken,
          resource: RESOURCE,
        }),
      });
      const body = (await response.json().catch(() => ({}))) as TokenResponse;
      if (!response.ok || !body.access_token) {
        throw new ConnectionGrantError(
          body.error ?? `http_${response.status}`,
          body.error_description ?? 'ChatGPT token refresh was refused',
        );
      }
      return {
        accessToken: body.access_token,
        refreshToken: body.refresh_token,
        idToken: body.id_token,
        expiresIn: body.expires_in ?? 3600,
      };
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
