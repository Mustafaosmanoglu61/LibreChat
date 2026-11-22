import { createHash } from 'node:crypto';
import type { ConnectionKey, ConnectionStore, StoredConnection } from './types';
import type { ConnectionFlowState, ConnectionFlowStore } from './flow';
import { createConnectionFlows, deriveHostId } from './flow';
import { createChatGPTProvider } from './chatgpt';

type FetchMock = jest.Mock<Promise<Response>, [string, RequestInit]>;

const HOST_ID = 'urn:uuid:00000000-0000-5000-8000-000000000000';
const REDIRECT = 'http://127.0.0.1:1455/auth/callback';
const target = { userId: 'user-1', providerId: 'chatgpt', endpoint: 'ChatGPT' };

const jwt = (claims: Record<string, unknown>) =>
  `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`;

function memoryStore(): ConnectionStore {
  const rows = new Map<string, StoredConnection>();
  const id = (k: ConnectionKey) => `${k.userId}:${k.providerId}:${k.endpoint}`;
  return {
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
    async patchMetadata() {},
    async remove(key) {
      rows.delete(id(key));
    },
  };
}

function memoryFlows(): ConnectionFlowStore & { size: () => number } {
  const rows = new Map<string, ConnectionFlowState>();
  return {
    size: () => rows.size,
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

function setup(fetchImpl: FetchMock = jest.fn()) {
  const store = memoryStore();
  const flowStore = memoryFlows();
  const flows = createConnectionFlows({
    store,
    flows: flowStore,
    providers: [createChatGPTProvider({ fetch: fetchImpl })],
    hostId: HOST_ID,
    appName: 'MLP/AI',
  });
  return { store, flowStore, flows, fetchImpl };
}

function grantResponse(overrides: Record<string, unknown> = {}) {
  return jest.fn<Promise<Response>, [string, RequestInit]>(() =>
    Promise.resolve(
      new Response(
        JSON.stringify({
          access_token: jwt({ exp: Math.floor(Date.now() / 1000) + 3600, scp: ['openid'] }),
          refresh_token: 'issued-refresh',
          id_token: jwt({ email: 'user@example.com' }),
          expires_in: 3600,
          ...overrides,
        }),
        { status: 200 },
      ),
    ),
  );
}

async function startFlow(flows: ReturnType<typeof setup>['flows']) {
  const started = await flows.start({ ...target, ttlMs: 600_000 });
  const query = new URL(started.authorizeUrl).searchParams;
  return { ...started, query, state: query.get('state') ?? '' };
}

describe('createConnectionFlows', () => {
  describe('start', () => {
    it('registers a new client with PKCE on the loopback redirect OpenAI accepts', async () => {
      const { flows, flowStore } = setup();

      const { query, redirectUri } = await startFlow(flows);

      expect(redirectUri).toBe(REDIRECT);
      expect(query.get('client_id')).toBe('dynamic_agent_client');
      expect(query.get('agent_name_hint')).toBe('MLP/AI');
      expect(query.get('ext_agent_host_id')).toBe(HOST_ID);
      expect(query.get('redirect_uri')).toBe(REDIRECT);
      expect(query.get('code_challenge_method')).toBe('S256');
      expect(query.get('scope')).toContain('chatgpt.tokens.use.direct');
      expect(query.get('resource')).toBe('https://api.openai.com/v1');
      expect(flowStore.size()).toBe(1);
    });

    it('reauthorizes the existing client instead of registering a duplicate', async () => {
      const { flows, store } = setup();
      await store.write({
        ...target,
        grant: { accessToken: 'a', refreshToken: 'r', expiresIn: 0 },
        metadata: {
          clientId: 'oaiapp_existing',
          accountEmail: 'user@example.com',
          connectedAt: 'x',
        },
      });

      const { query } = await startFlow(flows);

      expect(query.get('client_id')).toBe('oaiapp_existing');
      expect(query.get('login_hint')).toBe('user@example.com');
      expect(query.has('agent_name_hint')).toBe(false);
    });
  });

  describe('complete', () => {
    it('exchanges the pasted code with the server-held verifier and stores the grant', async () => {
      const { flows, store, flowStore, fetchImpl } = setup(grantResponse());
      const { flowId, state, query } = await startFlow(flows);

      const metadata = await flows.complete({
        ...target,
        flowId,
        callbackUrl: `${REDIRECT}?code=ac.code&state=${state}&client_id=oaiapp_issued`,
      });

      const form = new URLSearchParams(String(fetchImpl.mock.calls[0][1].body));
      expect(form.get('grant_type')).toBe('authorization_code');
      expect(form.get('code')).toBe('ac.code');
      expect(form.get('client_id')).toBe('oaiapp_issued');
      expect(form.get('redirect_uri')).toBe(REDIRECT);
      const verifier = form.get('code_verifier') ?? '';
      expect(createHash('sha256').update(verifier).digest('base64url')).toBe(
        query.get('code_challenge'),
      );
      expect(metadata).toMatchObject({
        clientId: 'oaiapp_issued',
        accountEmail: 'user@example.com',
      });
      expect((await store.read(target))?.refreshToken).toBe('issued-refresh');
      expect(flowStore.size()).toBe(0);
    });

    it('accepts the address with surrounding whitespace, as pasted from an address bar', async () => {
      const { flows } = setup(grantResponse());
      const { flowId, state } = await startFlow(flows);

      await expect(
        flows.complete({
          ...target,
          flowId,
          callbackUrl: `  ${REDIRECT}?code=c&state=${state}&client_id=oaiapp_x \n`,
        }),
      ).resolves.toMatchObject({ clientId: 'oaiapp_x' });
    });

    it('keeps the flow when the pasted address belongs to another attempt, so the user can retry', async () => {
      const { flows, flowStore } = setup(grantResponse());
      const { flowId, state } = await startFlow(flows);

      await expect(
        flows.complete({ ...target, flowId, callbackUrl: `${REDIRECT}?code=c&state=wrong` }),
      ).rejects.toMatchObject({ code: 'state_mismatch' });
      expect(flowStore.size()).toBe(1);

      await expect(
        flows.complete({
          ...target,
          flowId,
          callbackUrl: `${REDIRECT}?code=c&state=${state}&client_id=oaiapp_x`,
        }),
      ).resolves.toBeDefined();
    });

    it('is single-use: a redeemed flow cannot be completed again', async () => {
      const { flows } = setup(grantResponse());
      const { flowId, state } = await startFlow(flows);
      const callbackUrl = `${REDIRECT}?code=c&state=${state}&client_id=oaiapp_x`;
      await flows.complete({ ...target, flowId, callbackUrl });

      await expect(flows.complete({ ...target, flowId, callbackUrl })).rejects.toMatchObject({
        code: 'flow_not_found',
      });
    });

    it("never completes another user's flow", async () => {
      const { flows, fetchImpl } = setup(grantResponse());
      const { flowId, state } = await startFlow(flows);

      await expect(
        flows.complete({
          ...target,
          userId: 'user-2',
          flowId,
          callbackUrl: `${REDIRECT}?code=c&state=${state}&client_id=oaiapp_x`,
        }),
      ).rejects.toMatchObject({ code: 'flow_not_found' });
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('reports a refused consent and discards the flow', async () => {
      const { flows, flowStore } = setup();
      const { flowId, state } = await startFlow(flows);

      await expect(
        flows.complete({
          ...target,
          flowId,
          callbackUrl: `${REDIRECT}?error=access_denied&state=${state}`,
        }),
      ).rejects.toMatchObject({ code: 'denied' });
      expect(flowStore.size()).toBe(0);
    });

    it('rejects text that is not an address', async () => {
      const { flows } = setup();
      const { flowId } = await startFlow(flows);

      await expect(
        flows.complete({ ...target, flowId, callbackUrl: 'not a url' }),
      ).rejects.toMatchObject({ code: 'invalid_callback' });
    });

    it('surfaces a refused code exchange', async () => {
      const refused = jest.fn<Promise<Response>, [string, RequestInit]>(() =>
        Promise.resolve(new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 })),
      );
      const { flows } = setup(refused);
      const { flowId, state } = await startFlow(flows);

      await expect(
        flows.complete({
          ...target,
          flowId,
          callbackUrl: `${REDIRECT}?code=c&state=${state}&client_id=oaiapp_x`,
        }),
      ).rejects.toMatchObject({ code: 'exchange_failed' });
    });

    it('rejects an identity token minted for a different attempt', async () => {
      const { flows, store } = setup(grantResponse({ id_token: jwt({ nonce: 'other' }) }));
      const { flowId, state } = await startFlow(flows);

      await expect(
        flows.complete({
          ...target,
          flowId,
          callbackUrl: `${REDIRECT}?code=c&state=${state}&client_id=oaiapp_x`,
        }),
      ).rejects.toMatchObject({ code: 'state_mismatch' });
      expect(await store.read(target)).toBeNull();
    });
  });

  describe('deriveHostId', () => {
    it('is a stable urn:uuid per deployment and differs between deployments', () => {
      const a = deriveHostId('https://chat.example.com');

      expect(a).toMatch(
        /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
      expect(deriveHostId('https://chat.example.com')).toBe(a);
      expect(deriveHostId('https://other.example.com')).not.toBe(a);
    });
  });
});
