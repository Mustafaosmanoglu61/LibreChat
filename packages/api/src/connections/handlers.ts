import { logger } from '@librechat/data-schemas';
import type { TConnectionsConfig } from 'librechat-data-provider';
import type { Request, Response } from 'express';
import type { ConnectionStore, ConnectionStatus, ConnectionMetadata } from './types';
import type { ServerRequest } from '~/types/http';
import type { ConnectionFlows } from './flow';
import { buildMetadata, readClaims, remainingLifetime } from './claims';
import { getConnectionProviderId } from './resolve';
import { ConnectionFlowError } from './flow';

export type ConnectionRequest = ServerRequest &
  Request<{ providerId?: string; endpoint?: string }, unknown, ConnectBody>;

export type ConnectionRouteHandler = (req: ConnectionRequest, res: Response) => Promise<void>;

export interface ConnectBody {
  flowId?: unknown;
  callbackUrl?: unknown;
  client_id?: unknown;
  access_token?: unknown;
  refresh_token?: unknown;
  id_token?: unknown;
  expires_in?: unknown;
}

export interface ConnectionHandlers {
  start: ConnectionRouteHandler;
  complete: ConnectionRouteHandler;
  connect: ConnectionRouteHandler;
  status: ConnectionRouteHandler;
  disconnect: ConnectionRouteHandler;
}

const MAX_TOKEN_LENGTH = 16_384;
const MAX_CALLBACK_URL_LENGTH = 8_192;
const DEFAULT_FLOW_TTL_MS = 600_000;

const FLOW_ERROR_STATUS: Record<ConnectionFlowError['code'], number> = {
  unsupported: 400,
  flow_not_found: 410,
  state_mismatch: 400,
  invalid_callback: 400,
  denied: 400,
  exchange_failed: 502,
};

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
  getFlows: () => ConnectionFlows;
}): ConnectionHandlers {
  const { getStore, getFlows } = deps;

  function sendFlowError(res: Response, error: unknown) {
    if (error instanceof ConnectionFlowError) {
      res.status(FLOW_ERROR_STATUS[error.code]).json({ error: error.message, code: error.code });
      return;
    }
    logger.error('[connections] Connect flow failed', error);
    res.status(500).json({ error: 'Connect flow failed', code: 'internal' });
  }

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
    async start(req, res) {
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
        const flow = await getFlows().start({
          userId,
          ...target,
          ttlMs: req.config?.connections?.flowTtlMs ?? DEFAULT_FLOW_TTL_MS,
        });
        res.status(200).json(flow);
      } catch (error) {
        sendFlowError(res, error);
      }
    },

    async complete(req, res) {
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
      const { flowId, callbackUrl } = req.body ?? {};
      if (
        typeof flowId !== 'string' ||
        typeof callbackUrl !== 'string' ||
        flowId.length === 0 ||
        callbackUrl.length === 0 ||
        flowId.length > 256 ||
        callbackUrl.length > MAX_CALLBACK_URL_LENGTH
      ) {
        res
          .status(400)
          .json({ error: 'flowId and callbackUrl are required', code: 'invalid_request' });
        return;
      }
      try {
        const metadata = await getFlows().complete({ userId, ...target, flowId, callbackUrl });
        res.status(200).json(describe(target, metadata, true));
      } catch (error) {
        sendFlowError(res, error);
      }
    },

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
      const expiresIn = remainingLifetime(readClaims(access_token), expires_in);
      const metadata = buildMetadata({ clientId: client_id, idToken, accessToken: access_token });
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
