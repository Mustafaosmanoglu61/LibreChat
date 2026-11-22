const express = require('express');
const { createConnectionHandlers } = require('@librechat/api');
const requireJwtAuth = require('~/server/middleware/requireJwtAuth');
const configMiddleware = require('~/server/middleware/config/app');
const { getConnectionStore } = require('~/server/services/Connections');

let handlers;
/** Built on first request so requiring the route table has no side effects. */
const route = (name) => (req, res) => {
  handlers ??= createConnectionHandlers({ getStore: getConnectionStore });
  return handlers[name](req, res);
};

const router = express.Router();
/** Auth first, then role/tenant-scoped config: a connection is only accepted for an endpoint that config serves. */
router.use(requireJwtAuth, configMiddleware);
router.get('/', route('status'));
router.post('/:providerId/:endpoint', route('connect'));
router.delete('/:providerId/:endpoint', route('disconnect'));

module.exports = router;
