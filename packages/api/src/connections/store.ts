import { encryptV2, decryptV2, getTenantId } from '@librechat/data-schemas';
import type {
  ConnectionKey,
  ConnectionStore,
  StoredConnection,
  ConnectionMetadata,
  ConnectionStoreDeps,
} from './types';

const ACCESS_TYPE = 'provider_connection';
const REFRESH_TYPE = 'provider_connection_refresh';
const META_TYPE = 'provider_connection_meta';

/** The refresh grant outlives any access token; OpenAI rotates it on every redemption. */
const REFRESH_TTL_SECONDS = 30 * 24 * 60 * 60;
/** Metadata survives both so the UI can still say "reconnect" after the tokens are reaped. */
const META_TTL_SECONDS = 365 * 24 * 60 * 60;

const identifierFor = ({ providerId, endpoint }: Pick<ConnectionKey, 'providerId' | 'endpoint'>) =>
  `conn:${providerId}:${endpoint}`;

export function createConnectionStore(deps: ConnectionStoreDeps): ConnectionStore {
  const { findToken, createToken, updateToken, deleteTokens } = deps;

  async function upsert(params: {
    userId: string;
    type: string;
    identifier: string;
    token: string;
    expiresIn: number;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    const { userId, type, identifier, token, expiresIn, metadata } = params;
    const expiresAt = new Date(Date.now() + expiresIn * 1000);
    const updated = await updateToken(
      { userId, type, identifier },
      { token, expiresAt, ...(metadata ? { metadata } : {}) },
    );
    if (updated != null) {
      return;
    }
    await createToken({
      userId,
      type,
      identifier,
      token,
      expiresIn,
      ...(metadata ? { metadata } : {}),
      ...(getTenantId() ? { tenantId: getTenantId() } : {}),
    } as Parameters<typeof createToken>[0]);
  }

  function readMetadata(raw: unknown): ConnectionMetadata | null {
    if (raw == null) {
      return null;
    }
    const plain = raw instanceof Map ? Object.fromEntries(raw) : (raw as Record<string, unknown>);
    if (typeof plain.clientId !== 'string' || typeof plain.connectedAt !== 'string') {
      return null;
    }
    return plain as unknown as ConnectionMetadata;
  }

  return {
    async read(key) {
      const identifier = identifierFor(key);
      const [access, refresh, meta] = await Promise.all([
        findToken({ userId: key.userId, type: ACCESS_TYPE, identifier }),
        findToken({ userId: key.userId, type: REFRESH_TYPE, identifier: `${identifier}:refresh` }),
        findToken({ userId: key.userId, type: META_TYPE, identifier: `${identifier}:meta` }),
      ]);
      const metadata = readMetadata(meta?.metadata);
      if (metadata == null) {
        return null;
      }
      const connection: StoredConnection = {
        providerId: key.providerId,
        endpoint: key.endpoint,
        metadata,
      };
      if (access?.token) {
        connection.accessToken = await decryptV2(access.token);
        connection.accessTokenExpiresAt = access.expiresAt;
      }
      if (refresh?.token) {
        connection.refreshToken = await decryptV2(refresh.token);
      }
      return connection;
    },

    async write({ userId, providerId, endpoint, grant, metadata }) {
      const identifier = identifierFor({ providerId, endpoint });
      const writes: Promise<void>[] = [
        upsert({
          userId,
          type: ACCESS_TYPE,
          identifier,
          token: await encryptV2(grant.accessToken),
          expiresIn: grant.expiresIn,
        }),
        upsert({
          userId,
          type: META_TYPE,
          identifier: `${identifier}:meta`,
          token: metadata.accountId ?? providerId,
          expiresIn: META_TTL_SECONDS,
          metadata: metadata as unknown as Record<string, unknown>,
        }),
      ];
      if (grant.refreshToken) {
        writes.push(
          upsert({
            userId,
            type: REFRESH_TYPE,
            identifier: `${identifier}:refresh`,
            token: await encryptV2(grant.refreshToken),
            expiresIn: REFRESH_TTL_SECONDS,
          }),
        );
      }
      await Promise.all(writes);
    },

    async patchMetadata({ userId, providerId, endpoint, patch }) {
      const identifier = `${identifierFor({ providerId, endpoint })}:meta`;
      const existing = await findToken({ userId, type: META_TYPE, identifier });
      const current = readMetadata(existing?.metadata);
      if (current == null) {
        return;
      }
      await updateToken(
        { userId, type: META_TYPE, identifier },
        { metadata: { ...current, ...patch } as unknown as Record<string, unknown> },
      );
    },

    async remove({ userId, providerId, endpoint }) {
      const identifier = identifierFor({ providerId, endpoint });
      await Promise.all([
        deleteTokens({ userId, type: ACCESS_TYPE, identifier }),
        deleteTokens({ userId, type: REFRESH_TYPE, identifier: `${identifier}:refresh` }),
        deleteTokens({ userId, type: META_TYPE, identifier: `${identifier}:meta` }),
      ]);
    },
  };
}
