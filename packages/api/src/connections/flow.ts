import { createHash, randomBytes } from 'node:crypto';
import type { TConnectionFlowErrorCode } from 'librechat-data-provider';
import type { ConnectionStore, ConnectionMetadata, ConnectionProvider } from './types';
import { buildMetadata, readClaims, remainingLifetime } from './claims';
import { ConnectionGrantError } from './chatgpt';

/** What a started connect flow keeps server-side until the user pastes the redirect back. */
export interface ConnectionFlowState {
  userId: string;
  providerId: string;
  endpoint: string;
  state: string;
  nonce: string;
  codeVerifier: string;
  /** Client issued on an earlier connect, reused so reconnecting does not register again. */
  clientId?: string;
}

/** Short-lived, shared storage for flow state; a Keyv-compatible cache satisfies it. */
export interface ConnectionFlowStore {
  get(key: string): Promise<ConnectionFlowState | undefined>;
  set(key: string, value: ConnectionFlowState, ttlMs: number): Promise<unknown>;
  delete(key: string): Promise<unknown>;
}

/** The flow's own failures; the handler adds `invalid_request` and `internal`. */
export type ConnectionFlowErrorCode = Exclude<
  TConnectionFlowErrorCode,
  'invalid_request' | 'internal'
>;

export class ConnectionFlowError extends Error {
  constructor(
    readonly code: ConnectionFlowErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ConnectionFlowError';
  }
}

const b64url = (buffer: Buffer) => buffer.toString('base64url');
const flowKey = (flowId: string) => `connection:${flowId}`;

/**
 * A stable `urn:uuid` for this deployment, derived from a seed such as its public URL,
 * so every authorization from the same server presents the same host to the provider.
 */
export function deriveHostId(seed: string): string {
  const hex = createHash('sha256').update(`librechat-connections:${seed}`).digest('hex');
  const variant = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  return `urn:uuid:${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export interface ConnectionFlowStart {
  flowId: string;
  authorizeUrl: string;
  redirectUri?: string;
}

export interface ConnectionFlows {
  start(params: {
    userId: string;
    providerId: string;
    endpoint: string;
    ttlMs: number;
  }): Promise<ConnectionFlowStart>;
  complete(params: {
    userId: string;
    providerId: string;
    endpoint: string;
    flowId: string;
    callbackUrl: string;
  }): Promise<ConnectionMetadata>;
}

export function createConnectionFlows(deps: {
  store: ConnectionStore;
  flows: ConnectionFlowStore;
  providers: readonly ConnectionProvider[];
  hostId: string;
  appName: string;
}): ConnectionFlows {
  const { store, flows, hostId, appName } = deps;
  const providers = new Map(deps.providers.map((provider) => [provider.id, provider]));

  function oauthProvider(providerId: string) {
    const provider = providers.get(providerId);
    if (!provider?.authorize || !provider.exchange || !provider.readCallback) {
      throw new ConnectionFlowError(
        'unsupported',
        `${providerId} does not support browser connect`,
      );
    }
    return provider as Required<
      Pick<ConnectionProvider, 'authorize' | 'exchange' | 'readCallback'>
    > &
      ConnectionProvider;
  }

  async function start(params: {
    userId: string;
    providerId: string;
    endpoint: string;
    ttlMs: number;
  }): Promise<ConnectionFlowStart> {
    const { userId, providerId, endpoint, ttlMs } = params;
    const provider = oauthProvider(providerId);
    const existing = await store.read({ userId, providerId, endpoint });
    const codeVerifier = b64url(randomBytes(32));
    const flow: ConnectionFlowState = {
      userId,
      providerId,
      endpoint,
      state: b64url(randomBytes(24)),
      nonce: b64url(randomBytes(24)),
      codeVerifier,
      clientId: existing?.metadata.clientId,
    };
    const flowId = b64url(randomBytes(18));
    await flows.set(flowKey(flowId), flow, ttlMs);
    const authorizeUrl = provider.authorize({
      state: flow.state,
      nonce: flow.nonce,
      codeChallenge: b64url(createHash('sha256').update(codeVerifier).digest()),
      hostId,
      appName,
      clientId: flow.clientId,
      loginHint: existing?.metadata.accountEmail,
    });
    return { flowId, authorizeUrl, redirectUri: provider.redirectUri };
  }

  /**
   * Redeems the code from the redirect the user pasted back. The flow is consumed only
   * once the pasted address is shown to belong to it, so a mistyped paste can be retried.
   */
  async function complete(params: {
    userId: string;
    providerId: string;
    endpoint: string;
    flowId: string;
    callbackUrl: string;
  }): Promise<ConnectionMetadata> {
    const { userId, providerId, endpoint, flowId, callbackUrl } = params;
    const provider = oauthProvider(providerId);
    const flow = await flows.get(flowKey(flowId));
    if (
      flow == null ||
      flow.userId !== userId ||
      flow.providerId !== providerId ||
      flow.endpoint !== endpoint
    ) {
      throw new ConnectionFlowError('flow_not_found', 'Connect flow expired or not found');
    }
    const callback = provider.readCallback(callbackUrl);
    if (callback.error === 'invalid_callback_url') {
      throw new ConnectionFlowError(
        'invalid_callback',
        'That is not the address the browser opened',
      );
    }
    if (callback.error) {
      await flows.delete(flowKey(flowId));
      throw new ConnectionFlowError('denied', callback.errorDescription ?? callback.error);
    }
    if (!callback.code || callback.state !== flow.state) {
      throw new ConnectionFlowError(
        'state_mismatch',
        'The address does not belong to this connect attempt',
      );
    }
    const clientId = callback.clientId ?? flow.clientId;
    if (!clientId) {
      throw new ConnectionFlowError('invalid_callback', 'The provider did not return a client id');
    }

    await flows.delete(flowKey(flowId));
    const grant = await provider
      .exchange({ code: callback.code, clientId, codeVerifier: flow.codeVerifier })
      .catch((error: unknown) => {
        throw error instanceof ConnectionGrantError
          ? new ConnectionFlowError('exchange_failed', error.message)
          : error;
      });

    const identityNonce = readClaims(grant.idToken).nonce;
    if (identityNonce != null && identityNonce !== flow.nonce) {
      throw new ConnectionFlowError('state_mismatch', 'Identity token nonce does not match');
    }

    const metadata = buildMetadata({
      clientId,
      idToken: grant.idToken,
      accessToken: grant.accessToken,
    });
    await store.write({
      userId,
      providerId,
      endpoint,
      grant: {
        ...grant,
        expiresIn: remainingLifetime(readClaims(grant.accessToken), grant.expiresIn),
      },
      metadata,
    });
    return metadata;
  }

  return { start, complete };
}
