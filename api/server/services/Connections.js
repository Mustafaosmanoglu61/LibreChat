const {
  createChatGPTProvider,
  createConnectionStore,
  createConnectionResolver,
} = require('@librechat/api');
const db = require('~/models');

/** Built on first use so requiring this module has no side effects. */
let store;
let resolver;

function getConnectionStore() {
  store ??= createConnectionStore(db);
  return store;
}

/** One resolver per process: its refresh single-flight must be shared by every request. */
function resolveConnection(params) {
  resolver ??= createConnectionResolver({
    store: getConnectionStore(),
    providers: [createChatGPTProvider()],
  });
  return resolver(params);
}

module.exports = { getConnectionStore, resolveConnection };
