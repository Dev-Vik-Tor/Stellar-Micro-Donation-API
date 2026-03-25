/**
 * Donation Routes - API Endpoint Layer
 * 
 * RESPONSIBILITY: HTTP request handling for donation operations
 * OWNER: Backend Team
 * DEPENDENCIES: DonationService, middleware (auth, validation, rate limiting)
 * 
 * Thin controllers that orchestrate service calls for donation creation, verification,
 * and status management. All business logic delegated to DonationService.
 */

const express = require('express');
const router = express.Router();
const requireApiKey = require('../middleware/apiKey');
const { requireIdempotency, storeIdempotencyResponse } = require('../middleware/idempotency');
const { checkPermission } = require('../middleware/rbac');
const { PERMISSIONS } = require('../utils/permissions');
const { ValidationError, ERROR_CODES } = require('../utils/errors');
const log = require('../utils/log');
const { donationRateLimiter, verificationRateLimiter } = require('../middleware/rateLimiter');
const { validateRequiredFields, validateFloat, validateInteger } = require('../utils/validationHelpers');
const { validateSchema } = require('../middleware/schemaValidation');
const { TRANSACTION_STATES } = require('../utils/transactionStateMachine');
const { parseCursorPaginationQuery } = require('../utils/pagination');
const { parseAssetInput } = require('../utils/stellarAsset');

const { getStellarService } = require('../config/stellar');
const DonationService = require('../services/DonationService');
const { LIFECYCLE_STAGES } = require('../middleware/requestLifecycle');

const stellarService = getStellarService();
const donationService = new DonationService(stellarService);

const verifyDonationSchema = validateSchema({
  body: {
    fields: {
      transactionHash: {
        type: 'string',
        required: true,
        trim: true,
      },
    },
  },
});

const sendDonationSchema = validateSchema({
  body: {
    fields: {
      senderId: { type: 'integer', required: true, min: 1 },
      receiverId: { type: 'integer', required: true, min: 1 },
      amount: { type: 'number', required: true, min: 0.0000001 },
      memo: { type: 'string', required: false, maxLength: 255, nullable: true },
    },
  },
});

const createDonationSchema = validateSchema({
  body: {
    fields: {
      amount: { type: 'numberString', required: true, min: 0.0000001 },
      donor: {
        type: 'string',
        required: false,
        maxLength: 255,
        nullable: true,
      },
      recipient: {
        type: 'string',
        required: true,
        maxLength: 255,
      },
      memo: {
        type: 'string',
        required: false,
        maxLength: 255,
        nullable: true,
      },
      sourceAsset: {
        types: ['string', 'object'],
        required: false,
        nullable: true,
      },
      sourceAmount: {
        type: 'numberString',
        required: false,
      },
    },
    validate: (body) => {
      if ((body.sourceAsset && !body.sourceAmount) || (!body.sourceAsset && body.sourceAmount)) {
        return 'sourceAsset and sourceAmount must be provided together';
      }

      return null;
    },
  },
});

const pathEstimateSchema = validateSchema({
  query: {
    fields: {
      sourceAsset: {
        type: 'string',
        required: true,
      },
      sourceAmount: {
        type: 'numberString',
        required: false,
      },
      destAsset: {
        type: 'string',
        required: false,
      },
      destAmount: {
        type: 'numberString',
        required: false,
      },
    },
    validate: (query) => {
      if (!query.sourceAmount && !query.destAmount) {
        return 'Either sourceAmount or destAmount is required';
      }

      return null;
    },
  },
});

const donationIdParamSchema = validateSchema({
  params: {
    fields: {
      id: { type: 'integerString', required: true },
    },
  },
});

const recentDonationsQuerySchema = validateSchema({
  query: {
    fields: {
      limit: {
        type: 'integerString',
        required: false,
        validate: (value) => {
          const parsed = Number(value);
          return parsed >= 1 && parsed <= 100
            ? true
            : 'limit must be an integer between 1 and 100';
        },
      },
    },
  },
});

const updateDonationStatusSchema = validateSchema({
  params: {
    fields: {
      id: { type: 'integerString', required: true },
    },
  },
  body: {
    fields: {
      status: {
        type: 'string',
        required: true,
        enum: [...Object.values(TRANSACTION_STATES), 'completed', 'cancelled'],
      },
      stellarTxId: {
        type: 'string',
        required: false,
        maxLength: 128,
        nullable: true,
      },
      ledger: {
        type: 'integer',
        required: false,
        min: 1,
        nullable: true,
      },
    },
  },
});

/**
 * POST /donations/verify
 * Verify a donation transaction by hash
 * Rate limited: 30 requests per minute per IP
 */
router.post('/verify', verificationRateLimiter, checkPermission(PERMISSIONS.DONATIONS_VERIFY), verifyDonationSchema, async (req, res) => {
  try {
    const { transactionHash } = req.body;
    const verification = await donationService.verifyTransaction(transactionHash);

    // Mark processing complete
    if (req.markLifecycleStage) {
      req.markLifecycleStage(LIFECYCLE_STAGES.PROCESSED);
    }

    res.status(200).json({
      success: true,
      data: verification
    });
  } catch (error) {
    const status = error.status || error.statusCode || 500;
    const code = error.code || error.errorCode || 'VERIFICATION_FAILED';
    const message = error.message || 'Failed to verify transaction';

    res.status(status).json({
      success: false,
      error: {
        code,
        message
      }
    });
  }
});

/**
 * POST /donations/send
 * Send XLM from one wallet to another and record it
 * Requires idempotency key to prevent duplicate transactions
 * Rate limited: 10 requests per minute per IP
 */
router.post('/send', donationRateLimiter, requireIdempotency, sendDonationSchema, async (req, res) => {
  try {
    const { senderId, receiverId, amount, memo } = req.body;

    log.debug('DONATION_ROUTE', 'Processing donation request', {
      requestId: req.id,
      senderId,
      receiverId,
      amount,
      hasMemo: !!memo
    });

    // Validation
    const requiredValidation = validateRequiredFields(
      { senderId, receiverId, amount },
      ['senderId', 'receiverId', 'amount']
    );

    if (!requiredValidation.valid) {
      return res.status(400).json({
        success: false,
        error: `Missing required fields: ${requiredValidation.missing.join(', ')}`
      });
    }

    if (typeof senderId === 'object' || typeof receiverId === 'object') {
      return res.status(400).json({
        success: false,
        error: 'Malformed request: senderId and receiverId must be valid IDs'
      });
    }

    const amountValidation = validateFloat(amount);
    if (!amountValidation.valid) {
      return res.status(400).json({
        success: false,
        error: `Invalid amount: ${amountValidation.error}`
      });
    }

    // Delegate to service
    const result = await donationService.sendCustodialDonation({
      senderId,
      receiverId,
      amount: amountValidation.value,
      memo,
      idempotencyKey: req.idempotency.key,
      requestId: req.id
    });

    // Inject remaining limit headers if available
    if (result.remainingLimits) {
      const { dailyRemaining, monthlyRemaining } = result.remainingLimits;
      if (dailyRemaining !== null) res.setHeader('X-Donation-Daily-Remaining', dailyRemaining);
      if (monthlyRemaining !== null) res.setHeader('X-Donation-Monthly-Remaining', monthlyRemaining);
    }

    // Mark processing complete
    if (req.markLifecycleStage) {
      req.markLifecycleStage(LIFECYCLE_STAGES.PROCESSED);
    }

    const response = {
      success: true,
      data: result
    };

    await storeIdempotencyResponse(req, response);
    res.status(201).json(response);
  } catch (error) {
    log.error('DONATION_ROUTE', 'Failed to send donation', {
      requestId: req.id,
      error: error.message,
      stack: error.stack
    });

    // Handle duplicate donation gracefully
    if (error.name === 'DuplicateError') {
      return res.status(409).json({
        success: false,
        error: {
          code: error.code,
          message: error.message
        }
      });
    }

    // Pass business logic and other structured errors to the global error handler
    if (error.statusCode) {
      return next(error);
    }

    res.status(500).json({
      success: false,
      error: 'Failed to send donation',
      message: error.message
    });
  }
});

/**
 * POST /donations
 * Create a non-custodial donation record
 */
router.post('/', donationRateLimiter, requireApiKey, requireIdempotency, createDonationSchema, async (req, res, next) => {
  try {
    const { amount, donor, recipient, memo, sourceAsset, sourceAmount } = req.body;

    // Basic validation
    if (!amount || !recipient) {
      throw new ValidationError('Missing required fields: amount, recipient', null, ERROR_CODES.MISSING_REQUIRED_FIELD);
    }

    if (typeof recipient !== 'string' || (donor && typeof donor !== 'string')) {
      return res.status(400).json({
        error: 'Malformed request: donor and recipient must be strings'
      });
    }

    const amountValidation = validateFloat(amount);
    if (!amountValidation.valid) {
      return res.status(400).json({
        error: `Invalid amount: ${amountValidation.error}`
      });
    }

    let sourceAmountValidation = null;
    let normalizedSourceAsset = null;
    if (sourceAsset || sourceAmount) {
      normalizedSourceAsset = parseAssetInput(sourceAsset, 'sourceAsset');
      sourceAmountValidation = validateFloat(sourceAmount);
      if (!sourceAmountValidation.valid) {
        return res.status(400).json({
          error: `Invalid sourceAmount: ${sourceAmountValidation.error}`
        });
      }
    }

    // Delegate to service
    const transaction = await donationService.createDonationRecord({
      amount: amountValidation.value,
      donor,
      recipient,
      memo,
      sourceAsset: normalizedSourceAsset,
      sourceAmount: sourceAmountValidation ? sourceAmountValidation.value : undefined,
      idempotencyKey: req.idempotency.key
    });

    // Mark processing complete
    if (req.markLifecycleStage) {
      req.markLifecycleStage(LIFECYCLE_STAGES.PROCESSED);
    }

    const response = {
      success: true,
      data: {
        verified: true,
        transactionHash: transaction.stellarTxId || transaction.id
      }
    };

    await storeIdempotencyResponse(req, response);
    res.status(201).json(response);
  } catch (error) {
    next(error);
  }
});

/**
 * GET /donations
 * Get all donations
 */
router.get('/', checkPermission(PERMISSIONS.DONATIONS_READ), (req, res, next) => {
  try {
    const pagination = parseCursorPaginationQuery(req.query);
    const result = donationService.getPaginatedDonations(pagination);
    
    // Mark processing complete
    if (req.markLifecycleStage) {
      req.markLifecycleStage(LIFECYCLE_STAGES.PROCESSED);
    }

    res.setHeader('X-Total-Count', String(result.totalCount));
    
    res.json({
      success: true,
      data: result.data,
      count: result.data.length,
      meta: result.meta
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /donations/path-estimate
 * Estimate the best Stellar path payment route for a donation.
 */
router.get('/path-estimate', requireApiKey, pathEstimateSchema, async (req, res, next) => {
  try {
    const sourceAmount = req.query.sourceAmount ? validateFloat(req.query.sourceAmount) : null;
    const destAmount = req.query.destAmount ? validateFloat(req.query.destAmount) : null;

    if (sourceAmount && !sourceAmount.valid) {
      return res.status(400).json({
        success: false,
        error: `Invalid sourceAmount: ${sourceAmount.error}`
      });
    }

    if (destAmount && !destAmount.valid) {
      return res.status(400).json({
        success: false,
        error: `Invalid destAmount: ${destAmount.error}`
      });
    }

    const estimate = await donationService.estimateDonationPath({
      sourceAsset: req.query.sourceAsset,
      sourceAmount: sourceAmount ? sourceAmount.value : undefined,
      destAsset: req.query.destAsset,
      destAmount: destAmount ? destAmount.value : undefined,
    });

    res.status(200).json({
      success: true,
      data: estimate,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /donations/limits
 * Get current donation amount limits
 */
router.get('/limits', checkPermission(PERMISSIONS.DONATIONS_READ), (req, res) => {
  try {
    const limits = donationService.getDonationLimits();
    
    // Mark processing complete
    if (req.markLifecycleStage) {
      req.markLifecycleStage(LIFECYCLE_STAGES.PROCESSED);
    }
    
    res.json({
      success: true,
      data: limits
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /donations/recent
 * Get recent donations (read-only, no sensitive data)
 * Query params:
 *   - limit: number of recent donations to return (default: 10, max: 100)
 */
router.get('/recent', checkPermission(PERMISSIONS.DONATIONS_READ), recentDonationsQuerySchema, (req, res, next) => {
  try {
    const limitValidation = validateInteger(req.query.limit, {
      min: 1,
      max: 100,
      default: 10
    });

    if (!limitValidation.valid) {
      throw new ValidationError(
        `Invalid limit parameter: ${limitValidation.error}`,
        null,
        ERROR_CODES.INVALID_LIMIT
      );
    }

    const transactions = donationService.getRecentDonations(limitValidation.value);

    // Mark processing complete
    if (req.markLifecycleStage) {
      req.markLifecycleStage(LIFECYCLE_STAGES.PROCESSED);
    }

    res.json({
      success: true,
      data: transactions,
      count: transactions.length,
      limit: limitValidation.value
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /donations/:id
 * Get a specific donation
 */
router.get('/:id', checkPermission(PERMISSIONS.DONATIONS_READ), donationIdParamSchema, (req, res, next) => {
  try {
    const transaction = donationService.getDonationById(req.params.id);

    // Mark processing complete
    if (req.markLifecycleStage) {
      req.markLifecycleStage(LIFECYCLE_STAGES.PROCESSED);
    }

    res.json({
      success: true,
      data: transaction
    });
  } catch (error) {
    next(error);
  }
});

/**
 * PATCH /donations/:id/status
 * Update donation transaction status
 */
router.patch('/:id/status', checkPermission(PERMISSIONS.DONATIONS_UPDATE), updateDonationStatusSchema, async (req, res, next) => {
  try {
    const { id } = req.params;
    const { status, stellarTxId, ledger } = req.body;

    if (!status) {
      throw new ValidationError('Missing required field: status', null, ERROR_CODES.MISSING_REQUIRED_FIELD);
    }

    const stellarData = {};
    if (stellarTxId) stellarData.transactionId = stellarTxId;
    if (ledger) stellarData.ledger = ledger;

    const updatedTransaction = donationService.updateDonationStatus(id, status, stellarData);

    // Mark processing complete
    if (req.markLifecycleStage) {
      req.markLifecycleStage(LIFECYCLE_STAGES.PROCESSED);
    }

    res.json({
      success: true,
      data: updatedTransaction
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
