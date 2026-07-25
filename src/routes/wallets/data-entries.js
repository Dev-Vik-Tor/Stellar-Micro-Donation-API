/**
 * Data Entries Routes - Wallet data entry management for Stellar accounts
 *
 * RESPONSIBILITY: HTTP request handling for Stellar account data entries
 * OWNER: Backend Team
 * DEPENDENCIES: WalletService, StellarService
 *
 * Endpoints for creating, retrieving, and deleting data entries on Stellar accounts.
 * WARNING: Data entries are publicly readable on-chain. Do not store PII or secrets.
 */

const express = require('express');
const router = express.Router();
const { checkPermission } = require('../../middleware/rbac');
const { PERMISSIONS } = require('../../utils/permissions');
const { validateDataEntry } = require('../../middleware/validateDataEntry');
const asyncHandler = require('../../utils/asyncHandler');
const WalletService = require('../../services/WalletService');
const AuditLogService = require('../../services/AuditLogService');
const { ValidationError } = require('../../utils/errors');
const { ERROR_CODES } = require('../../utils/errors');
const { validateSchema } = require('../../middleware/schemaValidation');

const walletService = new WalletService();

const walletIdSchema = validateSchema({
  params: {
    fields: {
      id: { type: 'string', required: true, trim: true, minLength: 1 }
    }
  }
});

/**
 * POST /wallets/:id/data
 * Create or update a data entry on the wallet's Stellar account
 * Body: { secretKey, key, value }
 *
 * SECURITY WARNING: Data entries are publicly readable on-chain.
 * Do not store PII, secrets, or sensitive information.
 */
router.post('/:id/data',
  checkPermission(PERMISSIONS.WALLETS_UPDATE),
  walletIdSchema,
  validateDataEntry,
  asyncHandler(async (req, res, next) => {
    try {
      const { id } = req.params;
      const { secretKey, key, value } = req.body;

      if (!secretKey) {
        throw new ValidationError(
          'Secret key is required to set data entries',
          null,
          ERROR_CODES.MISSING_REQUIRED_FIELD
        );
      }

      const result = await walletService.setAccountData(id, secretKey, key, value);

      await AuditLogService.log({
        category: AuditLogService.CATEGORY.WALLET_OPERATION,
        action: 'DATA_ENTRY_SET',
        severity: AuditLogService.SEVERITY.MEDIUM,
        result: 'SUCCESS',
        userId: req.user && req.user.id,
        requestId: req.id,
        ipAddress: req.ip,
        resource: `/wallets/${id}/data`,
        details: { walletId: id, key, txHash: result.hash }
      });

      res.status(201).json({
        success: true,
        data: {
          hash: result.hash,
          ledger: result.ledger
        }
      });
    } catch (error) {
      next(error);
    }
  })
);

/**
 * GET /wallets/:id/data
 * Fetch all current data entries for a wallet from the Stellar network
 */
router.get('/:id/data',
  checkPermission(PERMISSIONS.WALLETS_READ),
  walletIdSchema,
  asyncHandler(async (req, res, next) => {
    try {
      const { id } = req.params;

      const result = await walletService.getAccountData(id);

      res.json({
        success: true,
        data: result.entries || {},
        count: Object.keys(result.entries || {}).length
      });
    } catch (error) {
      next(error);
    }
  })
);

/**
 * DELETE /wallets/:id/data/:key
 * Remove a specific data entry from the wallet's Stellar account
 * Body: { secretKey }
 *
 * Deletion is done by setting the value to null in a manageData operation.
 */
router.delete('/:id/data/:key',
  checkPermission(PERMISSIONS.WALLETS_UPDATE),
  asyncHandler(async (req, res, next) => {
    try {
      const { id, key } = req.params;
      const { secretKey } = req.body;

      // Validate wallet ID
      const walletId = parseInt(id, 10);
      if (isNaN(walletId) || walletId < 1) {
        throw new ValidationError('Invalid wallet ID', null, ERROR_CODES.INVALID_REQUEST);
      }

      if (!secretKey) {
        throw new ValidationError(
          'Secret key is required to delete data entries',
          null,
          ERROR_CODES.MISSING_REQUIRED_FIELD
        );
      }

      if (!key) {
        throw new ValidationError(
          'Data entry key is required',
          null,
          ERROR_CODES.MISSING_REQUIRED_FIELD
        );
      }

      const result = await walletService.deleteAccountData(walletId, secretKey, key);

      await AuditLogService.log({
        category: AuditLogService.CATEGORY.WALLET_OPERATION,
        action: 'DATA_ENTRY_DELETED',
        severity: AuditLogService.SEVERITY.MEDIUM,
        result: 'SUCCESS',
        userId: req.user && req.user.id,
        requestId: req.id,
        ipAddress: req.ip,
        resource: `/wallets/${id}/data/${key}`,
        details: { walletId: id, key, txHash: result.hash }
      });

      res.json({
        success: true,
        data: {
          hash: result.hash,
          ledger: result.ledger
        }
      });
    } catch (error) {
      next(error);
    }
  })
);

module.exports = router;
