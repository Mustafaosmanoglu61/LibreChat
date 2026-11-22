const { CacheKeys } = require('librechat-data-provider');
const {
  deriveHostId,
  createChatGPTProvider,
  createConnectionFlows,
  createConnectionStore,
  createConnectionResolver,
} = require('@librechat/api');
const db = require('~/models');

/** Built on first use so requiring this module has no side effects. */
let store;
let resolver;
let flows;
let providers;

const getProviders = () => {
  providers ??= [createChatGPTProvider()];
  return providers;
};

function getConnectionStore() {
  store ??= createConnectionStore(db);
  return store;
}

/** One resolver per process: its refresh single-flight must be shared by every request. */
function resolveConnection(params) {
  resolver ??= createConnectionResolver({ store: getConnectionStore(), providers: getProviders() });
  return resolver(params);
}

/** Flow state lives in the shared FLOWS cache, so start and complete may land on different replicas. */
function getConnectionFlows() {
  if (flows != null) {
    return flows;
  }
  /* Required here, not at the top: loading the cache module builds every log store, which
     this module must not do merely by being required (route tables and tests load it). */
  const { getLogStores } = require('~/cache');
  flows = createConnectionFlows({
    store: getConnectionStore(),
    flows: getLogStores(CacheKeys.FLOWS),
    providers: getProviders(),
    hostId: deriveHostId(process.env.DOMAIN_SERVER || process.env.DOMAIN_CLIENT || 'librechat'),
    appName: process.env.APP_TITLE || 'LibreChat',
  });
  return flows;
}

module.exports = { getConnectionStore, getConnectionFlows, resolveConnection };
