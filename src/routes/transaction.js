const express = require('express');
const router = express.Router();
const Transaction = require('../models/transaction');
const TransactionSyncService = require('../../services/TransactionSyncService');
const { buildErrorResponse } = require('../../utils/validationErrorFormatter');
const sseManager = require('../../services/SseManager');



router.get('/', async (req, res) => {
  try {
    let { limit = 10, offset = 0 } = req.query;

    
    limit = parseInt(limit);
    offset = parseInt(offset);

    
    if (isNaN(limit) || limit <= 0) {
      return res.status(400).json(
        buildErrorResponse([{ code: 'INVALID_LIMIT', receivedValue: req.query.limit }])
      );
    }

    if (isNaN(offset) || offset < 0) {
      return res.status(400).json(
        buildErrorResponse([{ code: 'INVALID_OFFSET', receivedValue: req.query.offset }])
      );
    }

    const result = Transaction.getPaginated({ limit, offset });

    return res.status(200).json({
      success: true,
      data: result.data,
      pagination: result.pagination
    });

  } catch (error) {
    return res.status(500).json({
      success: false,
      error: {
        code: 'SERVER_ERROR',
        message: 'Failed to fetch transactions'
      }
    });
  }
});

router.post('/sync', async (req, res) => {
  try {
    const { publicKey } = req.body;

    if (!publicKey) {
      return res.status(400).json(
        buildErrorResponse([{ code: 'MISSING_PUBLIC_KEY', receivedValue: publicKey }])
      );
    }

    const syncService = new TransactionSyncService();
    const result = await syncService.syncWalletTransactions(publicKey);

    return res.status(200).json({
      success: true,
      data: result
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: { code: 'SYNC_FAILED', message: error.message }
    });
  }
});


/**
 * GET /transactions/stream
 * SSE endpoint for real-time confirmed transaction events.
 * Query params: ?walletAddress=  ?campaignId=
 * Header: x-api-key (used as connection key; defaults to 'anonymous')
 */
router.get('/stream', (req, res) => {
  const apiKey = req.headers['x-api-key'] || 'anonymous';
  const filters = {
    walletAddress: req.query.walletAddress || null,
    campaignId: req.query.campaignId || null,
  };

  const { added, limitExceeded } = sseManager.addClient(apiKey, res, filters);

  if (limitExceeded) {
    return res.status(429).json({
      success: false,
      error: { code: 'CONNECTION_LIMIT_EXCEEDED', message: 'Max 5 concurrent SSE connections per API key' },
    });
  }

  if (!added) {
    return res.status(500).json({ success: false, error: { code: 'SSE_ERROR', message: 'Failed to add SSE client' } });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  // Send initial connection event
  res.write(`data: ${JSON.stringify({ type: 'connected' })}\n\n`);
});

module.exports = router;
module.exports.sseManager = sseManager;