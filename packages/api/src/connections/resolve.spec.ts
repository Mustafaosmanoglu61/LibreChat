process.env.CREDS_KEY =
  process.env.CREDS_KEY ?? '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

import mongoose from 'mongoose';
import { ErrorTypes } from 'librechat-data-provider';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type { TConnectionsConfig } from 'librechat-data-provider';
import type { ConnectionStore, ConnectionMetadata } from './types';

type ChatGPTModule = typeof import('./chatgpt');
type ResolveModule = typeof import('./resolve');

const CHATGPT_PROVIDER_ID = 'chatgpt';
let createChatGPTProvider: ChatGPTModule['createChatGPTProvider'];
let createConnectionResolver: ResolveModule['createConnectionResolver'];

const ENDPOINT = 'ChatGPT';
const LEAD_MS = 120_000;

let mongoServer: MongoMemoryServer;
let store: ConnectionStore;

const userId = new mongoose.Types.ObjectId().toString();
const key = { userId, providerId: CHATGPT_PROVIDER_ID, endpoint: ENDPOINT };
const metadata: ConnectionMetadata = {
  clientId: 'oaiapp_test',
  connectedAt: '2026-11-22T00:00:00.000Z',
};

function tokenResponse(status: number, body: Record<string, unknown>) {
  return Promise.resolve(new Response(JSON.stringify(body), { status }));
}

const config: TConnectionsConfig = {
  enabled: true,
  refreshLeadMs: LEAD_MS,
  providers: { [CHATGPT_PROVIDER_ID]: { endpoints: [ENDPOINT] } },
};

function build(fetchImpl: jest.Mock<Promise<Response>, [string, RequestInit]>) {
  const provider = createChatGPTProvider({ fetch: fetchImpl });
  const resolve = createConnectionResolver({ store, providers: [provider] });
  return (params: { userId: string; endpoint: string }, override?: TConnectionsConfig) =>
    resolve({ ...params, config: override ?? config });
}

const mockFetch = (status: number, body: Record<string, unknown>) =>
  jest.fn<Promise<Response>, [string, RequestInit]>(() => tokenResponse(status, body));
const noFetch = () => jest.fn<Promise<Response>, [string, RequestInit]>();

function parseError(error: unknown) {
  return JSON.parse((error as Error).message) as { type: string; endpoint: string };
}

beforeAll(async () => {
  jest.resetModules();
  const dataSchemas = await import('@librechat/data-schemas');
  const { createConnectionStore } = await import('./store');
  ({ createChatGPTProvider } = await import('./chatgpt'));
  ({ createConnectionResolver } = await import('./resolve'));
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  dataSchemas.createModels(mongoose);
  store = createConnectionStore(dataSchemas.createMethods(mongoose));
});

afterEach(async () => {
  await mongoose.connection.db?.collection('tokens').deleteMany({});
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

describe('createConnectionResolver', () => {
  it('returns null for endpoints no connection provider serves', async () => {
    const fetchImpl = noFetch();
    const resolve = build(fetchImpl);

    expect(await resolve({ userId, endpoint: 'openAI' })).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('returns null when connections are disabled, even for a configured endpoint', async () => {
    const fetchImpl = noFetch();
    await store.write({ ...key, grant: { accessToken: 'live', expiresIn: 3600 }, metadata });

    expect(
      await build(fetchImpl)({ userId, endpoint: ENDPOINT }, { ...config, enabled: false }),
    ).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('asks the user to connect when no connection is stored', async () => {
    const resolve = build(noFetch());

    const error = await resolve({ userId, endpoint: ENDPOINT }).catch((e: unknown) => e);

    expect(parseError(error)).toMatchObject({ type: ErrorTypes.NO_CONNECTION, endpoint: ENDPOINT });
  });

  it('uses a fresh access token without refreshing', async () => {
    const fetchImpl = noFetch();
    await store.write({
      ...key,
      grant: { accessToken: 'live', refreshToken: 'r1', expiresIn: 3600 },
      metadata,
    });

    const credential = await build(fetchImpl)({ userId, endpoint: ENDPOINT });

    expect(credential).toEqual({
      apiKey: 'live',
      baseURL: 'https://api.openai.com/v1',
      trustedBaseURL: true,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refreshes inside the lead window and persists the rotated refresh token', async () => {
    const fetchImpl = mockFetch(200, {
      access_token: 'renewed',
      refresh_token: 'r2',
      expires_in: 3600,
    });
    await store.write({
      ...key,
      grant: { accessToken: 'stale', refreshToken: 'r1', expiresIn: 60 },
      metadata,
    });

    const credential = await build(fetchImpl)({ userId, endpoint: ENDPOINT });
    const stored = await store.read(key);

    expect(credential?.apiKey).toBe('renewed');
    expect(stored?.refreshToken).toBe('r2');
    expect(stored?.metadata.lastRefreshAt).toEqual(expect.any(String));
    const body = String(fetchImpl.mock.calls[0][1].body);
    expect(body).toContain('grant_type=refresh_token');
    expect(body).toContain('client_id=oaiapp_test');
    expect(body).toContain('refresh_token=r1');
  });

  it('redeems a refresh token once when turns race for it', async () => {
    const fetchImpl = mockFetch(200, {
      access_token: 'renewed',
      refresh_token: 'r2',
      expires_in: 3600,
    });
    await store.write({
      ...key,
      grant: { accessToken: 'stale', refreshToken: 'r1', expiresIn: 60 },
      metadata,
    });
    const resolve = build(fetchImpl);

    const results = await Promise.all([
      resolve({ userId, endpoint: ENDPOINT }),
      resolve({ userId, endpoint: ENDPOINT }),
      resolve({ userId, endpoint: ENDPOINT }),
    ]);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(results.map((r) => r?.apiKey)).toEqual(['renewed', 'renewed', 'renewed']);
  });

  it('keeps the old refresh token when the provider does not rotate it', async () => {
    const fetchImpl = mockFetch(200, { access_token: 'renewed', expires_in: 3600 });
    await store.write({
      ...key,
      grant: { accessToken: 'stale', refreshToken: 'r1', expiresIn: 60 },
      metadata,
    });

    await build(fetchImpl)({ userId, endpoint: ENDPOINT });

    expect((await store.read(key))?.refreshToken).toBe('r1');
  });

  it('marks the connection for reauth when the provider refuses the refresh token', async () => {
    const fetchImpl = mockFetch(400, { error: 'invalid_grant', error_description: 'revoked' });
    await store.write({
      ...key,
      grant: { accessToken: 'stale', refreshToken: 'r1', expiresIn: 60 },
      metadata,
    });

    const error = await build(fetchImpl)({ userId, endpoint: ENDPOINT }).catch((e: unknown) => e);

    expect(parseError(error).type).toBe(ErrorTypes.CONNECTION_EXPIRED);
    expect((await store.read(key))?.metadata.lastErrorCode).toBe('invalid_grant');
  });

  it('asks to reconnect when the access token expired and no refresh token remains', async () => {
    const fetchImpl = noFetch();
    await store.write({ ...key, grant: { accessToken: 'stale', expiresIn: 60 }, metadata });

    const error = await build(fetchImpl)({ userId, endpoint: ENDPOINT }).catch((e: unknown) => e);

    expect(parseError(error).type).toBe(ErrorTypes.CONNECTION_EXPIRED);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
