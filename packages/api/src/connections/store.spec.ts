process.env.CREDS_KEY =
  process.env.CREDS_KEY ?? '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type { ConnectionStore, ConnectionMetadata } from './types';

let mongoServer: MongoMemoryServer;
let store: ConnectionStore;

const userId = new mongoose.Types.ObjectId().toString();
const key = { userId, providerId: 'chatgpt', endpoint: 'ChatGPT' };
const metadata: ConnectionMetadata = {
  clientId: 'oaiapp_test',
  accountEmail: 'user@example.com',
  plan: 'plus',
  connectedAt: '2026-11-22T00:00:00.000Z',
};

beforeAll(async () => {
  jest.resetModules();
  const dataSchemas = await import('@librechat/data-schemas');
  const { createConnectionStore } = await import('./store');
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

describe('createConnectionStore', () => {
  it('returns null when the user has never connected', async () => {
    expect(await store.read(key)).toBeNull();
  });

  it('round-trips a grant and its metadata', async () => {
    await store.write({
      ...key,
      grant: { accessToken: 'access-1', refreshToken: 'refresh-1', expiresIn: 3600 },
      metadata,
    });

    const connection = await store.read(key);

    expect(connection?.accessToken).toBe('access-1');
    expect(connection?.refreshToken).toBe('refresh-1');
    expect(connection?.metadata).toMatchObject(metadata);
    expect(connection?.accessTokenExpiresAt?.getTime()).toBeGreaterThan(Date.now());
  });

  it('never stores tokens in plaintext', async () => {
    await store.write({
      ...key,
      grant: { accessToken: 'secret-access', refreshToken: 'secret-refresh', expiresIn: 3600 },
      metadata,
    });

    const rows = await mongoose.connection
      .db!.collection('tokens')
      .find({ userId: new mongoose.Types.ObjectId(userId) })
      .toArray();
    const stored = rows.map((row) => String(row.token)).join(' ');

    expect(rows).toHaveLength(3);
    expect(stored).not.toContain('secret-access');
    expect(stored).not.toContain('secret-refresh');
  });

  it('replaces the refresh token on rotation instead of adding a row', async () => {
    await store.write({
      ...key,
      grant: { accessToken: 'a1', refreshToken: 'r1', expiresIn: 3600 },
      metadata,
    });
    await store.write({
      ...key,
      grant: { accessToken: 'a2', refreshToken: 'r2', expiresIn: 3600 },
      metadata,
    });

    const connection = await store.read(key);
    const count = await mongoose.connection.db!.collection('tokens').countDocuments({});

    expect(connection?.accessToken).toBe('a2');
    expect(connection?.refreshToken).toBe('r2');
    expect(count).toBe(3);
  });

  it('keeps metadata readable after the access row is gone, so the UI can ask to reconnect', async () => {
    await store.write({
      ...key,
      grant: { accessToken: 'a1', refreshToken: 'r1', expiresIn: 3600 },
      metadata,
    });
    await mongoose.connection.db!.collection('tokens').deleteOne({ type: 'provider_connection' });

    const connection = await store.read(key);

    expect(connection?.accessToken).toBeUndefined();
    expect(connection?.refreshToken).toBe('r1');
    expect(connection?.metadata.accountEmail).toBe('user@example.com');
  });

  it('patches metadata without touching tokens', async () => {
    await store.write({
      ...key,
      grant: { accessToken: 'a1', refreshToken: 'r1', expiresIn: 3600 },
      metadata,
    });
    await store.patchMetadata({ ...key, patch: { lastErrorCode: 'invalid_grant' } });

    const connection = await store.read(key);

    expect(connection?.metadata.lastErrorCode).toBe('invalid_grant');
    expect(connection?.metadata.clientId).toBe('oaiapp_test');
    expect(connection?.accessToken).toBe('a1');
  });

  it('isolates users and endpoints', async () => {
    const other = { ...key, userId: new mongoose.Types.ObjectId().toString() };
    await store.write({ ...key, grant: { accessToken: 'mine', expiresIn: 3600 }, metadata });

    expect(await store.read(other)).toBeNull();
    expect(await store.read({ ...key, endpoint: 'Other' })).toBeNull();
  });

  it('removes every row of a connection', async () => {
    await store.write({
      ...key,
      grant: { accessToken: 'a1', refreshToken: 'r1', expiresIn: 3600 },
      metadata,
    });
    await store.remove(key);

    expect(await store.read(key)).toBeNull();
    expect(await mongoose.connection.db!.collection('tokens').countDocuments({})).toBe(0);
  });
});
