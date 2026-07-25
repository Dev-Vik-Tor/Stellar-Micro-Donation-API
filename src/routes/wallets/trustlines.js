/**
 * Trustlines Routes - Custom asset trustline management for Stellar accounts
 *
 * RESPONSIBILITY: HTTP request handling for trustline and account options operations
 * OWNER: Backend Team
 * DEPENDENCIES: StellarService, Database
 *
 * Endpoints for creating, updating, and removing trustlines for custom Stellar assets.
 */

const express = require('express');
const router = express.Router();
const { checkPermission } = require('../../middleware/rbac');
const { PERMISSIONS } = require('../../utils/permissions');
const { validateSchema } = require('../../middleware/schemaValidation');
const { payloadSizeLimiter, ENDPOINT_LIMITS } = require('../../middleware/payloadSizeLimiter');
const asyncHandler = require('../../utils/asyncHandler');
const AuditLogService = require('../../services/AuditLogService');
const Database = require('../../utils/database');
const { NotFoundError } = require('../../utils/errors');

const { getStellarService } = require('../../config/stellar');

// ─── Trustline Endpoints ──────────────────────────────────────────────────────

/** Maximum trust limit allowed by the Stellar network */
const STELLAR_MAX_LIMIT = '922337203685.4775807';

/**
 * Validate a trust limit string.
 * @param {string} limit - Limit value to validate
 * @returns {string|null} Error message, or null if valid
 */
function validateTrustLimit(limit) {
  const num = parseFloat(limit);
  if (isNaN(num) || num <= 0) return 'limit must be a positive numeric string';
  if (num > parseFloat(STELLAR_MAX_LIMIT)) {
    return `limit cannot exceed Stellar maximum of ${STELLAR_MAX_LIMIT}`;
  }
  return null;
}

const trustlineCreateSchema = validateSchema({
  params: { fields: { id: { type: 'integerString', required: true } } },
  body: {
    fields: {
      secretKey:    { type: 'string', required: true },
      assetCode:    { type: 'string', required: true, trim: true, minLength: 1, maxLength: 12 },
      issuerPublic: { type: 'string', required: true, trim: true },
      limit:        { type: 'string', required: false, nullable: true },
    },
  },
});

const trustlineUpdateSchema = validateSchema({
  params: {
    fields: {
      id:    { type: 'integerString', required: true },
      asset: { type: 'string', required: true },
    },
  },
  body: {
    fields: {
      secretKey:    { type: 'string', required: true },
      issuerPublic: { type: 'string', required: true, trim: true },
      limit:        { type: 'string', required: true },
    },
  },
});

/**
 * POST /wallets/:id/trustlines
 * Create a trustline for a custom asset on the wallet's Stellar account.
 * Optionally set a custom trust limit.
 *
 * @body {string}      secretKey    - Secret key of the wallet account
 * @body {string}      assetCode    - Asset code (1-12 alphanumeric characters)
 * @body {string}      issuerPublic - Public key of the asset issuer
 * @body {string|null} [limit]      - Optional trust limit (positive numeric string,
 *   max "922337203685.4775807"). Omit for unlimited.
 */
async function handleTrustlineCreate(req, res, next) {
  try {
    const { secretKey, assetCode, issuerPublic, limit } = req.body;

    if (limit !== null && limit !== undefined) {
      const err = validateTrustLimit(limit);
      if (err) return res.status(400).json({ success: false, error: { code: 'INVALID_LIMIT', message: err } });
    }

    const stellar = getStellarService();
    const result = await stellar.addTrustline(secretKey, assetCode, issuerPublic, limit || null);

    await AuditLogService.log({
      category: AuditLogService.CATEGORY.WALLET_OPERATION,
      action: 'TRUSTLINE_CREATED',
      severity: AuditLogService.SEVERITY.MEDIUM,
      result: 'SUCCESS',
      userId: req.user && req.user.id,
      requestId: req.id,
      ipAddress: req.ip,
      resource: req.originalUrl,
      details: { walletId: req.params.id, assetCode, issuerPublic, limit: result.limit, txHash: result.hash },
    });

    return res.status(201).json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
}

router.post('/:id/trustlines', checkPermission(PERMISSIONS.WALLETS_UPDATE), trustlineCreateSchema, payloadSizeLimiter(ENDPOINT_LIMITS.wallet), asyncHandler(handleTrustlineCreate));
router.post('/:id/trustline', checkPermission(PERMISSIONS.WALLETS_UPDATE), trustlineCreateSchema, payloadSizeLimiter(ENDPOINT_LIMITS.wallet), asyncHandler(handleTrustlineCreate));

/**
 * PATCH /wallets/:id/trustlines/:asset
 * Update the trust limit for an existing trustline without removing it.
 *
 * @param {string} asset         - Asset code in the URL path
 * @body {string} secretKey      - Secret key of the wallet account
 * @body {string} issuerPublic   - Public key of the asset issuer
 * @body {string} limit          - New trust limit (positive numeric string,
 *   max "922337203685.4775807")
 */
async function handleTrustlineUpdate(req, res, next) {
  try {
    const { asset } = req.params;
    const { secretKey, issuerPublic, limit } = req.body;

    const err = validateTrustLimit(limit);
    if (err) return res.status(400).json({ success: false, error: { code: 'INVALID_LIMIT', message: err } });

    const stellar = getStellarService();
    const result = await stellar.addTrustline(secretKey, asset, issuerPublic, limit);

    await AuditLogService.log({
      category: AuditLogService.CATEGORY.WALLET_OPERATION,
      action: 'TRUSTLINE_UPDATED',
      severity: AuditLogService.SEVERITY.MEDIUM,
      result: 'SUCCESS',
      userId: req.user && req.user.id,
      requestId: req.id,
      ipAddress: req.ip,
      resource: req.originalUrl,
      details: { walletId: req.params.id, assetCode: asset, issuerPublic, limit: result.limit, txHash: result.hash },
    });

    return res.json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
}

router.patch('/:id/trustlines/:asset', checkPermission(PERMISSIONS.WALLETS_UPDATE), trustlineUpdateSchema, payloadSizeLimiter(ENDPOINT_LIMITS.wallet), asyncHandler(handleTrustlineUpdate));
router.patch('/:id/trustline/:asset', checkPermission(PERMISSIONS.WALLETS_UPDATE), trustlineUpdateSchema, payloadSizeLimiter(ENDPOINT_LIMITS.wallet), asyncHandler(handleTrustlineUpdate));

// ─── Account Set Options ──────────────────────────────────────────────────────

const walletOptionsSchema = validateSchema({
  params: { fields: { id: { type: 'integerString', required: true } } },
  body: {
    fields: {
      secret:         { type: 'string', required: true },
      homeDomain:     { type: 'string', required: false, nullable: true, maxLength: 32 },
      inflationDest:  { type: 'string', required: false, nullable: true },
      masterWeight:   { type: 'integer', required: false, min: 0, max: 255 },
      lowThreshold:   { type: 'integer', required: false, min: 0, max: 255 },
      medThreshold:   { type: 'integer', required: false, min: 0, max: 255 },
      highThreshold:  { type: 'integer', required: false, min: 0, max: 255 },
      setFlags:       { type: 'integer', required: false, min: 0 },
      clearFlags:     { type: 'integer', required: false, min: 0 },
    },
  },
});

/**
 * PATCH /wallets/:id/options
 * Set Stellar account options for a custodial wallet.
 * Validates that AUTH_IMMUTABLE cannot be cleared.
 * Logs changes to the audit trail.
 */
router.patch('/:id/options', checkPermission(PERMISSIONS.WALLETS_UPDATE), walletOptionsSchema, payloadSizeLimiter(ENDPOINT_LIMITS.wallet), asyncHandler(async (req, res, next) => {
  try {
    const walletId = parseInt(req.params.id, 10);
    const { secret, ...options } = req.body;

    const wallet = await Database.get('SELECT * FROM users WHERE id = ?', [walletId]);
    if (!wallet) throw new NotFoundError(`Wallet ${walletId} not found`);

    const stellar = getStellarService();
    const result = await stellar.setOptions(secret, options);

    await AuditLogService.log({
      category: AuditLogService.CATEGORY.WALLET_OPERATION,
      action: 'WALLET_OPTIONS_SET',
      severity: AuditLogService.SEVERITY.MEDIUM,
      result: 'SUCCESS',
      requestId: req.id,
      ipAddress: req.ip,
      resource: `/wallets/${walletId}/options`,
      details: { walletId, options: Object.keys(options), transactionHash: result.hash },
    });

    return res.json({ success: true, data: { walletId, transactionHash: result.hash, ledger: result.ledger } });
  } catch (error) {
    next(error);
  }
}));

// ─── Trustline Management ───────────────────────────────────────────────────────

const trustlineDeleteSchema = validateSchema({
  params: {
    fields: {
      id: { type: 'integerString', required: true },
      asset: { type: 'string', required: true },
    },
  },
  body: {
    fields: {
      secretKey:    { type: 'string', required: true },
      issuerPublic: { type: 'string', required: true, trim: true },
    },
  },
});

const trustlineListSchema = validateSchema({
  params: {
    fields: {
      id: { type: 'integerString', required: true },
    },
  },
});

/**
 * DELETE /wallets/:id/trustlines/:asset
 * Remove a trustline for a custom asset from the wallet's Stellar account.
 * The account must have a zero balance for the asset before removal.
 *
 * @param {string} asset - Asset code in the URL path
 * @body {string} secretKey    - Secret key of the wallet account
 * @body {string} issuerPublic - Public key of the asset issuer
 */
async function handleTrustlineDelete(req, res, next) {
  try {
    const { asset } = req.params;
    const { secretKey, issuerPublic } = req.body;

    const stellar = getStellarService();
    const result = await stellar.removeTrustline(secretKey, asset, issuerPublic);

    await AuditLogService.log({
      category: AuditLogService.CATEGORY.WALLET_OPERATION,
      action: 'TRUSTLINE_REMOVED',
      severity: AuditLogService.SEVERITY.MEDIUM,
      result: 'SUCCESS',
      userId: req.user && req.user.id,
      requestId: req.id,
      ipAddress: req.ip,
      resource: req.originalUrl,
      details: { walletId: req.params.id, assetCode: asset, issuerPublic, txHash: result.hash },
    });

    return res.json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
}

router.delete('/:id/trustlines/:asset', checkPermission(PERMISSIONS.WALLETS_UPDATE), trustlineDeleteSchema, asyncHandler(handleTrustlineDelete));
router.delete('/:id/trustline/:asset', checkPermission(PERMISSIONS.WALLETS_UPDATE), trustlineDeleteSchema, asyncHandler(handleTrustlineDelete));

/**
 * GET /wallets/:id/trustlines
 * List all trustlines (and native XLM balance) for the wallet's Stellar account.
 * Response is cached for 30 seconds per wallet.
 */
router.get('/:id/trustlines', checkPermission(PERMISSIONS.WALLETS_READ), trustlineListSchema, asyncHandler(async (req, res, next) => {
  try {
    const walletId = parseInt(req.params.id, 10);

    const wallet = await Database.get('SELECT id, publicKey, address FROM users WHERE id = ?', [walletId]);
    if (!wallet) {
      return res.status(404).json({
        success: false,
        error: { code: 'WALLET_NOT_FOUND', message: `Wallet ${walletId} not found` },
      });
    }

    const publicKey = wallet.publicKey || wallet.address;
    const stellar = getStellarService();

    let balances;
    try {
      balances = await stellar.getAccountBalances(publicKey);
    } catch (err) {
      // Horizon returns 404 when the account has never been funded
      const notFound =
        err?.status === 404 ||
        err?.response?.status === 404 ||
        err?.message?.toLowerCase().includes('not found') ||
        err?.message?.toLowerCase().includes('does not exist');
      if (notFound) {
        return res.status(422).json({
          success: false,
          error: { code: 'STELLAR_ACCOUNT_NOT_FOUND', message: 'Stellar account does not exist on the network' },
        });
      }
      throw err;
    }

    const trustlines = balances.map(b => {
      if (b.asset_type === 'native') {
        return { assetCode: 'XLM', assetType: 'native', balance: b.balance };
      }
      return {
        assetCode: b.asset_code,
        assetIssuer: b.asset_issuer,
        balance: b.balance,
        limit: b.limit,
        authorized: Boolean(b.is_authorized),
      };
    });

    res.setHeader('Cache-Control', 'private, max-age=30');

    await AuditLogService.log({
      category: AuditLogService.CATEGORY.WALLET_OPERATION,
      action: 'TRUSTLINES_LISTED',
      severity: AuditLogService.SEVERITY.LOW,
      result: 'SUCCESS',
      userId: req.user && req.user.id,
      requestId: req.id,
      ipAddress: req.ip,
      resource: `/wallets/${walletId}/trustlines`,
      details: { walletId, count: trustlines.length },
    });

    return res.json({ success: true, data: trustlines, count: trustlines.length });
  } catch (error) {
    next(error);
  }
}));

module.exports = router;
