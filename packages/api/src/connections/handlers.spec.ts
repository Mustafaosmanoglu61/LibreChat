import type { TConnectionsConfig } from 'librechat-data-provider';
import type { Response } from 'express';
import type { ConnectionKey, ConnectionStore, StoredConnection } from './types';
import type { ConnectionRequest } from './handlers';
import { createConnectionHandlers } from './handlers';

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

const config: TConnectionsConfig = {
  enabled: true,
  refreshLeadMs: 120_000,
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
    const { connect } = createConnectionHandlers({ getStore: () => store });
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
    const { connect } = createConnectionHandlers({ getStore: () => store });
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
    const { connect } = createConnectionHandlers({ getStore: () => store });
    const { res, api } = response();

    await connect(request({ body }), api);

    expect(res.statusCode).toBe(400);
    expect(store.rows.size).toBe(0);
  });

  it('requires a signed-in user', async () => {
    const { connect } = createConnectionHandlers({ getStore: memoryStore });
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
    const handlers = createConnectionHandlers({ getStore: () => store });
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

  it('disconnects only the signed-in user', async () => {
    const store = memoryStore();
    const handlers = createConnectionHandlers({ getStore: () => store });
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
});
