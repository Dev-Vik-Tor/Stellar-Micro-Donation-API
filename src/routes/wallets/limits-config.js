/**
 * Limits & Configuration Routes - Wallet limits and visibility settings
 *
 * RESPONSIBILITY: HTTP request handling for wallet limits and configuration
 * OWNER: Backend Team
 * DEPENDENCIES: LimitService, WalletService, Database
 *
 * Endpoints for setting per-wallet donation limits and managing leaderboard visibility.
 */

const express = require('express');
const router = express.Router();
const { checkPermission, requireAdmin } = require('../../middleware/rbac');
const { PERMISSIONS } = require('../../utils/permissions');
const { validateSchema } = require('../../middleware/schemaValidation');
const { payloadSizeLimiter, ENDPOINT_LIMITS } = require('../../middleware/payloadSizeLimiter');
const asyncHandler = require('../../utils/asyncHandler');
const { NotFoundError, ValidationError, ERROR_CODES } = require('../../utils/errors');
const Database = require('../../utils/database');
const LimitService = require('../../services/LimitService');
const AuditLogService = require('../../services/AuditLogService');
const Wallet = require('../../models/wallet');

const walletIdSchema = validateSchema({
  params: {
    fields: {
      id: { type: 'string', required: true, trim: true, minLength: 1 }
    }
  }
});

const updateWalletLimitsSchema = validateSchema({
  body: {
    fields: {
      daily_limit: { type: 'number', required: false, nullable: true },
      monthly_limit: { type: 'number', required: false, nullable: true },
      per_transaction_limit: { type: 'number', required: false, nullable: true },
    }
  }
});

const updateLeaderboardVisibilitySchema = validateSchema({
  body: {
    fields: {
      visible: { type: 'boolean', required: true },
    }
  }
});

/**
 * PATCH /wallets/:id/limits
 * Set per-wallet donation limits (admin only)
 * Body: { daily_limit, monthly_limit, per_transaction_limit } — all optional, positive number or null
 */
router.patch('/:id/limits', requireAdmin(), updateWalletLimitsSchema, payloadSizeLimiter(ENDPOINT_LIMITS.wallet), asyncHandler(async (req, res, next) => {
  try {
    const userId = parseInt(req.params.id, 10);
    if (isNaN(userId) || userId < 1) {
      throw new ValidationError('Invalid wallet ID', null, ERROR_CODES.INVALID_REQUEST);
    }

    const user = await Database.get('SELECT id FROM users WHERE id = ?', [userId]);
    if (!user) {
      throw new NotFoundError('Wallet not found', ERROR_CODES.WALLET_NOT_FOUND);
    }

    const { daily_limit, monthly_limit, per_transaction_limit } = req.body;
    const limits = {};

    for (const [key, val] of Object.entries({ daily_limit, monthly_limit, per_transaction_limit })) {
      if (val === undefined) continue;
      if (val !== null && (typeof val !== 'number' || val <= 0 || !isFinite(val))) {
        throw new ValidationError(
          `${key} must be a positive number or null`,
          null,
          ERROR_CODES.INVALID_AMOUNT
        );
      }
      limits[key] = val;
    }

    if (Object.keys(limits).length === 0) {
      throw new ValidationError(
        'At least one limit field (daily_limit, monthly_limit, per_transaction_limit) is required',
        null,
        ERROR_CODES.MISSING_REQUIRED_FIELD
      );
    }

    await LimitService.setWalletLimits(userId, limits);

    const updated = await Database.get(
      'SELECT id, publicKey, daily_limit, monthly_limit, per_transaction_limit FROM users WHERE id = ?',
      [userId]
    );

    await AuditLogService.log({
      category: AuditLogService.CATEGORY.WALLET_OPERATION,
      action: AuditLogService.ACTION.WALLET_UPDATED,
      severity: AuditLogService.SEVERITY.HIGH,
      result: 'SUCCESS',
      userId: req.user && req.user.id,
      requestId: req.id,
      ipAddress: req.ip,
      resource: `/wallets/${userId}/limits`,
      details: { walletId: userId, limits, updatedBy: req.user && req.user.id }
    });

    res.json({ success: true, data: updated });
  } catch (error) {
    next(error);
  }
}));

/**
 * PATCH /wallets/:id/leaderboard-visibility
 * Opt a wallet in or out of public leaderboard ranking.
 * Body: { visible: boolean }
 */
router.patch('/:id/leaderboard-visibility', checkPermission(PERMISSIONS.WALLETS_UPDATE), walletIdSchema, updateLeaderboardVisibilitySchema, payloadSizeLimiter(ENDPOINT_LIMITS.wallet), asyncHandler(async (req, res, next) => {
  try {
    const { visible } = req.body || {};
    if (typeof visible !== 'boolean') {
      return res.status(400).json({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: "'visible' must be a boolean" },
      });
    }
    const wallet = Wallet.getById(req.params.id);
    const updated = Wallet.update(wallet.id, { leaderboard_visibility: visible });
    res.json({ success: true, data: { id: updated.id, leaderboard_visibility: updated.leaderboard_visibility } });
  } catch (err) {
    next(err);
  }
}));

module.exports = router;
