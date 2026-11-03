const router = require('express').Router();
const { authenticate } = require('../middleware/auth.middleware');
const { getTransactionGraph, getJobNetworks } = require('../controllers/graph.controller');

router.get('/transaction/:transactionId', authenticate, getTransactionGraph);
router.get('/job/:jobId/networks', authenticate, getJobNetworks);

module.exports = router;
