import type { TConnectionsConfig } from 'librechat-data-provider';
import type { Response } from 'express';
import type { ConnectionKey, ConnectionStore, StoredConnection } from './types';
import type { ConnectionFlowState, ConnectionFlowStore } from './flow';
import type { ConnectionRequest } from './handlers';
import { createConnectionHandlers } from './handlers';
import { createChatGPTProvider } from './chatgpt';
import { createConnectionFlows } from './flow';

function memoryStore(): ConnectionStore & { rows: Map<string, StoredConnection> } {
  const rows = new Map<string, StoredConnection>();
  const id = (k: ConnectionKey) => `${k.userId}:${k.providerId}:${k.endpoint}`;
  return {
    rows,
    async read(key) {
      return rows.get(id(key)) ?? null;
    },
    async write({ grant, metadata, ...key }) {
      rows.set(id(key), {
        providerId: key.providerId,
        endpoint: key.endpoint,
        accessToken: grant.accessToken,
        accessTokenExpiresAt: new Date(Date.now() + grant.expiresIn * 1000),
        refreshToken: grant.refreshToken,
        metadata,
      });
    },
    async patchMetadata({ patch, ...key }) {
      const row = rows.get(id(key));
      if (row) {
        row.metadata = { ...row.metadata, ...patch };
      }
    },
    async remove(key) {
      rows.delete(id(key));
    },
  };
}

function memoryFlows(): ConnectionFlowStore {
  const rows = new Map<string, ConnectionFlowState>();
  return {
    async get(key) {
      return rows.get(key);
    },
    async set(key, value) {
      rows.set(key, value);
    },
    async delete(key) {
      rows.delete(key);
    },
  };
}

type FetchResponse = globalThis.Response;
type FetchMock = jest.Mock<Promise<FetchResponse>, [string, RequestInit]>;
const fetchMock = (impl?: () => Promise<FetchResponse>): FetchMock =>
  jest.fn<Promise<FetchResponse>, [string, RequestInit]>(impl);

function makeHandlers(store: ConnectionStore, fetchImpl: FetchMock = fetchMock()) {
  const flows = createConnectionFlows({
    store,
    flows: memoryFlows(),
    providers: [createChatGPTProvider({ fetch: fetchImpl })],
    hostId: 'urn:uuid:00000000-0000-5000-8000-000000000000',
    appName: 'MLP/AI',
  });
  return createConnectionHandlers({ getStore: () => store, getFlows: () => flows });
}

const config: TConnectionsConfig = {
  enabled: true,
  refreshLeadMs: 120_000,
  flowTtlMs: 600_000,
  providers: { chatgpt: { endpoints: ['ChatGPT'] } },
};

const jwt = (claims: Record<string, unknown>) =>
  `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`;

function request(overrides: {
  params?: Record<string, string>;
  body?: Record<string, unknown>;
  userId?: string | null;
  connections?: TConnectionsConfig;
}): ConnectionRequest {
  return {
    params: overrides.params ?? { providerId: 'chatgpt', endpoint: 'ChatGPT' },
    body: overrides.body ?? {},
    user: overrides.userId === null ? undefined : { id: overrides.userId ?? 'user-1' },
    config: { connections: overrides.connections ?? config },
  } as unknown as ConnectionRequest;
}

function response() {
  const res = { statusCode: 0, body: undefined as unknown };
  const api = {
    status(code: number) {
      res.statusCode = code;
      return api;
    },
    json(body: unknown) {
      res.body = body;
      return api;
    },
    end() {
      return api;
    },
  };
  return { res, api: api as unknown as Response };
}

const validBody = {
  client_id: 'oaiapp_abc',
  access_token: jwt({ scp: ['openid', 'chatgpt.tokens.use.direct'] }),
  refresh_token: 'refresh-secret',
  id_token: jwt({
    email: 'user@example.com',
    'https://api.openai.com/auth': { chatgpt_plan_type: 'plus', chatgpt_account_id: 'acct-1' },
  }),
  expires_in: 3600,
};

describe('createConnectionHandlers', () => {
  it('stores the connection for the signed-in user and answers without any token', async () => {
    const store = memoryStore();
    const { connect } = makeHandlers(store);
    const { res, api } = response();

    await connect(request({ body: validBody }), api);

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({
      providerId: 'chatgpt',
      endpoint: 'ChatGPT',
      connected: true,
      accountEmail: 'user@example.com',
      plan: 'plus',
    });
    expect(JSON.stringify(res.body)).not.toContain('refresh-secret');
    const stored = await store.read({
      userId: 'user-1',
      providerId: 'chatgpt',
      endpoint: 'ChatGPT',
    });
    expect(stored?.refreshToken).toBe('refresh-secret');
    expect(stored?.metadata).toMatchObject({
      clientId: 'oaiapp_abc',
      accountId: 'acct-1',
      scopes: 'openid chatgpt.tokens.use.direct',
    });
  });

  it.each([
    [
      'an endpoint the provider does not serve',
      { params: { providerId: 'chatgpt', endpoint: 'openAI' } },
    ],
    [
      'a provider that does not serve the endpoint',
      { params: { providerId: 'other', endpoint: 'ChatGPT' } },
    ],
    ['a deployment with connections disabled', { connections: { ...config, enabled: false } }],
  ])('refuses %s, so arbitrary identifiers cannot be written', async (_label, overrides) => {
    const store = memoryStore();
    const { connect } = makeHandlers(store);
    const { res, api } = response();

    await connect(request({ body: validBody, ...overrides }), api);

    expect(res.statusCode).toBe(404);
    expect(store.rows.size).toBe(0);
  });

  it.each([
    ['client_id', { ...validBody, client_id: undefined }],
    ['access_token', { ...validBody, access_token: 42 }],
    ['refresh_token', { ...validBody, refresh_token: '' }],
    ['an oversized token', { ...validBody, refresh_token: 'x'.repeat(20_000) }],
  ])('rejects a body missing %s', async (_label, body) => {
    const store = memoryStore();
    const { connect } = makeHandlers(store);
    const { res, api } = response();

    await connect(request({ body }), api);

    expect(res.statusCode).toBe(400);
    expect(store.rows.size).toBe(0);
  });

  it('requires a signed-in user', async () => {
    const { connect } = makeHandlers(memoryStore());
    const { res, api } = response();

    await connect(request({ body: validBody, userId: null }), api);

    expect(res.statusCode).toBe(401);
  });

  it('reports every configured endpoint, flagging the ones that need reauth', async () => {
    const store = memoryStore();
    const twoEndpoints = {
      ...config,
      providers: { chatgpt: { endpoints: ['ChatGPT', 'ChatGPT Pro'] } },
    };
    const handlers = makeHandlers(store);
    await handlers.connect(request({ body: validBody, connections: twoEndpoints }), response().api);
    await store.patchMetadata({
      userId: 'user-1',
      providerId: 'chatgpt',
      endpoint: 'ChatGPT',
      patch: { lastErrorCode: 'invalid_grant' },
    });
    const { res, api } = response();

    await handlers.status(request({ connections: twoEndpoints }), api);

    expect(res.body).toEqual({
      connections: [
        expect.objectContaining({ endpoint: 'ChatGPT', connected: false, needsReauth: true }),
        expect.objectContaining({ endpoint: 'ChatGPT Pro', connected: false, needsReauth: false }),
      ],
    });
    expect(JSON.stringify(res.body)).not.toContain('refresh-secret');
  });

  describe('access token lifetime', () => {
    const nowSeconds = () => Math.floor(Date.now() / 1000);
    const storedExpiry = async (store: ReturnType<typeof memoryStore>) =>
      (
        await store.read({ userId: 'user-1', providerId: 'chatgpt', endpoint: 'ChatGPT' })
      )?.accessTokenExpiresAt?.getTime() ?? NaN;

    it('takes the token own exp, so a token uploaded after it expired is refreshed on first use', async () => {
      const store = memoryStore();
      const { connect } = makeHandlers(store);
      const issuedThirteenHoursAgo = jwt({ exp: nowSeconds() - 12 * 3600 });

      await connect(
        request({ body: { ...validBody, access_token: issuedThirteenHoursAgo, expires_in: 3600 } }),
        response().api,
      );

      expect(await storedExpiry(store)).toBeLessThanOrEqual(Date.now());
    });

    it('keeps only the remaining lifetime of a still-valid token, not a fresh expires_in', async () => {
      const store = memoryStore();
      const { connect } = makeHandlers(store);
      const thirtyMinutesLeft = jwt({ exp: nowSeconds() + 30 * 60 });

      await connect(
        request({ body: { ...validBody, access_token: thirtyMinutesLeft, expires_in: 3600 } }),
        response().api,
      );

      const remainingMs = (await storedExpiry(store)) - Date.now();
      expect(remainingMs).toBeGreaterThan(29 * 60 * 1000);
      expect(remainingMs).toBeLessThanOrEqual(30 * 60 * 1000);
    });

    it('falls back to expires_in when the token carries no exp', async () => {
      const store = memoryStore();
      const { connect } = makeHandlers(store);

      await connect(
        request({ body: { ...validBody, access_token: jwt({}), expires_in: 600 } }),
        response().api,
      );

      const remainingMs = (await storedExpiry(store)) - Date.now();
      expect(remainingMs).toBeGreaterThan(590 * 1000);
      expect(remainingMs).toBeLessThanOrEqual(600 * 1000);
    });
  });

  it('disconnects only the signed-in user', async () => {
    const store = memoryStore();
    const handlers = makeHandlers(store);
    await handlers.connect(request({ body: validBody }), response().api);
    await handlers.connect(request({ body: validBody, userId: 'user-2' }), response().api);
    const { res, api } = response();

    await handlers.disconnect(request({}), api);

    expect(res.statusCode).toBe(204);
    expect(
      await store.read({ userId: 'user-1', providerId: 'chatgpt', endpoint: 'ChatGPT' }),
    ).toBeNull();
    expect(
      await store.read({ userId: 'user-2', providerId: 'chatgpt', endpoint: 'ChatGPT' }),
    ).not.toBeNull();
  });

  describe('browser connect', () => {
    const tokenResponse = (body: Record<string, unknown>, status = 200) =>
      Promise.resolve(new globalThis.Response(JSON.stringify(body), { status }));

    it('starts a flow and completes it from the pasted redirect address', async () => {
      const store = memoryStore();
      const fetchImpl = fetchMock(() =>
        tokenResponse({
          access_token: validBody.access_token,
          refresh_token: 'issued-refresh',
          id_token: validBody.id_token,
          expires_in: 3600,
        }),
      );
      const handlers = makeHandlers(store, fetchImpl);
      const started = response();

      await handlers.start(request({}), started.api);

      expect(started.res.statusCode).toBe(200);
      const { flowId, authorizeUrl, redirectUri } = started.res.body as {
        flowId: string;
        authorizeUrl: string;
        redirectUri: string;
      };
      expect(redirectUri).toBe('http://127.0.0.1:1455/auth/callback');
      const state = new URL(authorizeUrl).searchParams.get('state');
      const completed = response();

      await handlers.complete(
        request({
          body: {
            flowId,
            callbackUrl: `${redirectUri}?code=ac.code&state=${state}&client_id=oaiapp_issued`,
          },
        }),
        completed.api,
      );

      expect(completed.res.statusCode).toBe(200);
      expect(completed.res.body).toMatchObject({
        connected: true,
        accountEmail: 'user@example.com',
      });
      expect(JSON.stringify(completed.res.body)).not.toContain('issued-refresh');
      const stored = await store.read({
        userId: 'user-1',
        providerId: 'chatgpt',
        endpoint: 'ChatGPT',
      });
      expect(stored?.metadata.clientId).toBe('oaiapp_issued');
    });

    it('maps a flow error to its status and a code the UI can localize', async () => {
      const handlers = makeHandlers(memoryStore());
      const { res, api } = response();

      await handlers.complete(
        request({
          body: { flowId: 'unknown', callbackUrl: 'http://127.0.0.1:1455/auth/callback?code=x' },
        }),
        api,
      );

      expect(res.statusCode).toBe(410);
      expect(res.body).toMatchObject({ code: 'flow_not_found' });
    });

    it('rejects a completion without the pasted address', async () => {
      const handlers = makeHandlers(memoryStore());
      const { res, api } = response();

      await handlers.complete(request({ body: { flowId: 'f' } }), api);

      expect(res.statusCode).toBe(400);
    });

    it('refuses to start for an endpoint the config does not serve', async () => {
      const handlers = makeHandlers(memoryStore());
      const { res, api } = response();

      await handlers.start(request({ params: { providerId: 'chatgpt', endpoint: 'openAI' } }), api);

      expect(res.statusCode).toBe(404);
    });
  });
});
