import { ErrorTypes } from 'librechat-data-provider';
import type { TConnectionsConfig } from 'librechat-data-provider';
import type {
  ConnectionKey,
  ConnectionStore,
  ConnectionProvider,
  ResolvedCredential,
} from './types';
import { ConnectionGrantError } from './chatgpt';

export interface ConnectionResolverDeps {
  store: ConnectionStore;
  providers: readonly ConnectionProvider[];
  now?: () => number;
}

const connectionError = (type: string, key: ConnectionKey) =>
  new Error(JSON.stringify({ type, providerId: key.providerId, endpoint: key.endpoint }));

/** The provider id serving an endpoint under this config, if connections are on. */
export function getConnectionProviderId(
  config: TConnectionsConfig | undefined,
  endpoint: string,
): string | undefined {
  if (config?.enabled !== true) {
    return undefined;
  }
  for (const [providerId, settings] of Object.entries(config.providers ?? {})) {
    if (settings?.endpoints?.includes(endpoint)) {
      return providerId;
    }
  }
  return undefined;
}

/**
 * Resolves the credential a connected endpoint should use for this user, refreshing it
 * when it is about to expire. Returns null for endpoints no connection provider serves,
 * so every other endpoint keeps today's key resolution untouched.
 *
 * Built once per process: the refresh single-flight below must be shared by every
 * request, while the connections config is read per call so tenant and role
 * overrides apply.
 */
export type ConnectionResolver = (params: {
  userId: string;
  endpoint: string;
  config: TConnectionsConfig | undefined;
}) => Promise<ResolvedCredential | null>;

export function createConnectionResolver(deps: ConnectionResolverDeps): ConnectionResolver {
  const { store } = deps;
  const now = deps.now ?? Date.now;
  const providers = new Map(deps.providers.map((provider) => [provider.id, provider]));
  /**
   * One refresh per connection at a time. OpenAI rotates the refresh token on every
   * redemption, so two concurrent redemptions would spend the same token twice and
   * the provider may revoke the whole grant.
   */
  const inflight = new Map<string, Promise<ResolvedCredential>>();

  const isFresh = (expiresAt: Date | undefined, leadMs: number) =>
    (expiresAt?.getTime() ?? 0) - now() > leadMs;

  async function refreshAndPersist(
    key: ConnectionKey,
    provider: ConnectionProvider,
    leadMs: number,
  ): Promise<ResolvedCredential> {
    const connection = await store.read(key);
    if (connection == null) {
      throw connectionError(ErrorTypes.NO_CONNECTION, key);
    }
    if (connection.accessToken != null && isFresh(connection.accessTokenExpiresAt, leadMs)) {
      return provider.materialize({ connection });
    }
    if (connection.refreshToken == null) {
      throw connectionError(ErrorTypes.CONNECTION_EXPIRED, key);
    }
    try {
      const grant = await provider.refresh({
        refreshToken: connection.refreshToken,
        clientId: connection.metadata.clientId,
      });
      const metadata = {
        ...connection.metadata,
        lastRefreshAt: new Date(now()).toISOString(),
        lastErrorCode: undefined,
      };
      await store.write({
        ...key,
        grant: { ...grant, refreshToken: grant.refreshToken ?? connection.refreshToken },
        metadata,
      });
      return provider.materialize({
        connection: { ...connection, accessToken: grant.accessToken, metadata },
      });
    } catch (error) {
      if (error instanceof ConnectionGrantError) {
        await store.patchMetadata({ ...key, patch: { lastErrorCode: error.code } });
        throw connectionError(ErrorTypes.CONNECTION_EXPIRED, key);
      }
      throw error;
    }
  }

  return async function resolveConnection(params: {
    userId: string;
    endpoint: string;
    config: TConnectionsConfig | undefined;
  }): Promise<ResolvedCredential | null> {
    const { userId, endpoint, config } = params;
    const providerId = getConnectionProviderId(config, endpoint);
    const provider = providerId != null ? providers.get(providerId) : undefined;
    if (provider == null) {
      return null;
    }
    const leadMs = config?.refreshLeadMs ?? 0;
    const key: ConnectionKey = { userId, endpoint, providerId: provider.id };
    const connection = await store.read(key);
    if (connection == null) {
      throw connectionError(ErrorTypes.NO_CONNECTION, key);
    }
    if (connection.accessToken != null && isFresh(connection.accessTokenExpiresAt, leadMs)) {
      return provider.materialize({ connection });
    }
    const flightKey = `${key.userId}:${key.providerId}:${key.endpoint}`;
    const pending = inflight.get(flightKey);
    if (pending != null) {
      return pending;
    }
    const flight = refreshAndPersist(key, provider, leadMs).finally(() =>
      inflight.delete(flightKey),
    );
    inflight.set(flightKey, flight);
    return flight;
  };
}
