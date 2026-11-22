import { logger } from '@librechat/data-schemas';
import type { TConnectionsConfig } from 'librechat-data-provider';
import type { Request, Response } from 'express';
import type { ConnectionStore, ConnectionStatus, ConnectionMetadata } from './types';
import type { ServerRequest } from '~/types/http';
import { getConnectionProviderId } from './resolve';

export type ConnectionRequest = ServerRequest &
  Request<{ providerId?: string; endpoint?: string }, unknown, ConnectBody>;

export type ConnectionRouteHandler = (req: ConnectionRequest, res: Response) => Promise<void>;

export interface ConnectBody {
  client_id?: unknown;
  access_token?: unknown;
  refresh_token?: unknown;
  id_token?: unknown;
  expires_in?: unknown;
}

export interface ConnectionHandlers {
  connect: ConnectionRouteHandler;
  status: ConnectionRouteHandler;
  disconnect: ConnectionRouteHandler;
}

const MAX_TOKEN_LENGTH = 16_384;
const DEFAULT_EXPIRES_IN = 3600;

interface TokenClaims {
  email?: string;
  scp?: string[];
  'https://api.openai.com/auth'?: { chatgpt_plan_type?: string; chatgpt_account_id?: string };
}

/**
 * Reads display fields from a JWT without verifying it. Used only to label the
 * connection in the UI; authorization rests on the provider accepting the token.
 */
function readClaims(jwt: string | undefined): TokenClaims {
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

const isToken = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= MAX_TOKEN_LENGTH;

/** Every endpoint a provider serves under this config, flattened for the status view. */
function configuredConnections(config: TConnectionsConfig | undefined) {
  if (config?.enabled !== true) {
    return [];
  }
  return Object.entries(config.providers ?? {}).flatMap(([providerId, settings]) =>
    (settings?.endpoints ?? []).map((endpoint) => ({ providerId, endpoint })),
  );
}

function describe(
  key: { providerId: string; endpoint: string },
  metadata: ConnectionMetadata | undefined,
  hasRefresh: boolean,
): ConnectionStatus {
  return {
    providerId: key.providerId,
    endpoint: key.endpoint,
    connected: metadata != null && hasRefresh && metadata.lastErrorCode == null,
    needsReauth: metadata != null && (!hasRefresh || metadata.lastErrorCode != null),
    accountEmail: metadata?.accountEmail,
    plan: metadata?.plan,
    connectedAt: metadata?.connectedAt,
    lastErrorCode: metadata?.lastErrorCode,
  };
}

export function createConnectionHandlers(deps: {
  getStore: () => ConnectionStore;
}): ConnectionHandlers {
  const { getStore } = deps;

  /** Resolves the route's provider/endpoint only when this deployment's config serves it. */
  function resolveTarget(req: ConnectionRequest) {
    const { providerId, endpoint } = req.params;
    if (!providerId || !endpoint) {
      return null;
    }
    const served = getConnectionProviderId(req.config?.connections, endpoint);
    return served === providerId ? { providerId, endpoint } : null;
  }

  return {
    async connect(req, res) {
      const userId = req.user?.id;
      if (!userId) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }
      const target = resolveTarget(req);
      if (target == null) {
        res.status(404).json({ error: 'Connection is not configured for this endpoint' });
        return;
      }
      const { client_id, access_token, refresh_token, id_token, expires_in } = req.body ?? {};
      if (!isToken(client_id) || !isToken(access_token) || !isToken(refresh_token)) {
        res
          .status(400)
          .json({ error: 'client_id, access_token and refresh_token are required strings' });
        return;
      }
      const idToken = isToken(id_token) ? id_token : undefined;
      const identity = readClaims(idToken);
      const access = readClaims(access_token);
      const auth = identity['https://api.openai.com/auth'] ?? {};
      const expiresIn =
        typeof expires_in === 'number' && expires_in > 0 ? expires_in : DEFAULT_EXPIRES_IN;
      const metadata: ConnectionMetadata = {
        clientId: client_id,
        accountEmail: identity.email,
        accountId: auth.chatgpt_account_id,
        plan: auth.chatgpt_plan_type,
        scopes: access.scp?.join(' '),
        connectedAt: new Date().toISOString(),
      };
      try {
        await getStore().write({
          userId,
          ...target,
          grant: { accessToken: access_token, refreshToken: refresh_token, idToken, expiresIn },
          metadata,
        });
        res.status(200).json(describe(target, metadata, true));
      } catch (error) {
        logger.error('[connections] Failed to store connection', error);
        res.status(500).json({ error: 'Failed to store connection' });
      }
    },

    async status(req, res) {
      const userId = req.user?.id;
      if (!userId) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }
      const targets = configuredConnections(req.config?.connections);
      try {
        const statuses = await Promise.all(
          targets.map(async (target) => {
            const connection = await getStore().read({ userId, ...target });
            return describe(target, connection?.metadata, connection?.refreshToken != null);
          }),
        );
        res.status(200).json({ connections: statuses });
      } catch (error) {
        logger.error('[connections] Failed to read connection status', error);
        res.status(500).json({ error: 'Failed to read connections' });
      }
    },

    async disconnect(req, res) {
      const userId = req.user?.id;
      if (!userId) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }
      const target = resolveTarget(req);
      if (target == null) {
        res.status(404).json({ error: 'Connection is not configured for this endpoint' });
        return;
      }
      try {
        await getStore().remove({ userId, ...target });
        res.status(204).end();
      } catch (error) {
        logger.error('[connections] Failed to remove connection', error);
        res.status(500).json({ error: 'Failed to remove connection' });
      }
    },
  };
}
