import type { TConnectionStatus } from 'librechat-data-provider';
import type { TokenMethods } from '@librechat/data-schemas';

/** A provider the user connects with their own account, instead of an operator API key. */
export interface ConnectionProvider {
  readonly id: string;
  /** Redeems a refresh token. Called under the refresh lease, never directly. */
  refresh(params: { refreshToken: string; clientId: string }): Promise<ConnectionGrant>;
  /** Turns stored state into the options the chat path hands to the provider SDK. */
  materialize(params: { connection: StoredConnection }): ResolvedCredential;
  /** OAuth providers: where the provider sends the browser back with the code. */
  readonly redirectUri?: string;
  /** OAuth providers: the URL that starts consent. */
  authorize?(params: AuthorizeParams): string;
  /** OAuth providers: reads the code and issued client id from the redirect URL. */
  readCallback?(url: string): ConnectionCallback;
  /** OAuth providers: redeems an authorization code with its PKCE verifier. */
  exchange?(params: {
    code: string;
    clientId: string;
    codeVerifier: string;
  }): Promise<ConnectionGrant>;
}

export interface AuthorizeParams {
  state: string;
  nonce: string;
  codeChallenge: string;
  /** Stable identifier for this deployment, sent on every authorization. */
  hostId: string;
  /** Name shown to the user on the provider's consent screen. */
  appName: string;
  /** The client the provider issued on an earlier connect; absent on first registration. */
  clientId?: string;
  loginHint?: string;
}

export interface ConnectionCallback {
  code?: string;
  state?: string;
  clientId?: string;
  error?: string;
  errorDescription?: string;
}

/** The token set a provider returns from an authorization-code or refresh exchange. */
export interface ConnectionGrant {
  accessToken: string;
  refreshToken?: string;
  idToken?: string;
  expiresIn: number;
}

/** Non-secret state kept alongside a connection, readable after the access row expires. */
export interface ConnectionMetadata {
  clientId: string;
  accountEmail?: string;
  accountId?: string;
  plan?: string;
  scopes?: string;
  connectedAt: string;
  lastRefreshAt?: string;
  lastErrorCode?: string;
}

export interface StoredConnection {
  providerId: string;
  endpoint: string;
  accessToken?: string;
  accessTokenExpiresAt?: Date;
  refreshToken?: string;
  metadata: ConnectionMetadata;
}

/** What the chat path needs to talk to the provider as this user. */
export interface ResolvedCredential {
  apiKey: string;
  baseURL?: string;
  /** True only when the destination URL came from admin config, never from the user. */
  trustedBaseURL: boolean;
  headers?: Record<string, string>;
}

/** Client-visible connection state; the wire type the Connections tab reads. */
export type ConnectionStatus = TConnectionStatus;

export interface ConnectionKey {
  userId: string;
  providerId: string;
  endpoint: string;
}

export interface ConnectionStore {
  read(key: ConnectionKey): Promise<StoredConnection | null>;
  write(
    params: ConnectionKey & { grant: ConnectionGrant; metadata: ConnectionMetadata },
  ): Promise<void>;
  patchMetadata(params: ConnectionKey & { patch: Partial<ConnectionMetadata> }): Promise<void>;
  remove(key: ConnectionKey): Promise<void>;
}

export type ConnectionStoreDeps = Pick<
  TokenMethods,
  'findToken' | 'createToken' | 'updateToken' | 'deleteTokens'
>;
