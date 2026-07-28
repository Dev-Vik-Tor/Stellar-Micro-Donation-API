/**
 * Home Domain Routes - Wallet home domain management endpoints
 *
 * RESPONSIBILITY: HTTP request handling for home domain operations on Stellar accounts
 * OWNER: Backend Team
 * DEPENDENCIES: WalletService, StellarService
 *
 * Endpoints for setting, retrieving, and verifying home domains on Stellar accounts.
 */

const express = require('express');
const router = express.Router();
const { checkPermission } = require('../../middleware/rbac');
const { PERMISSIONS } = require('../../utils/permissions');
const { validateSchema } = require('../../middleware/schemaValidation');
const { payloadSizeLimiter, ENDPOINT_LIMITS } = require('../../middleware/payloadSizeLimiter');
const asyncHandler = require('../../utils/asyncHandler');
const WalletService = require('../../services/WalletService');
const AuditLogService = require('../../services/AuditLogService');

const { getStellarService } = require('../../config/stellar');

const walletService = new WalletService();

const walletIdSchema = validateSchema({
  params: {
    fields: {
      id: { type: 'string', required: true, trim: true, minLength: 1 }
    }
  }
});

const updateHomeDomainSchema = validateSchema({
  body: {
    fields: {
      domain: { type: 'string', required: true },
      sourceSecret: { type: 'string', required: true },
    }
  }
});

/**
 * PATCH /wallets/:id/home-domain
 * Set the home domain on a wallet's Stellar account.
 * Body: { domain: string, sourceSecret: string }
 */
router.patch('/:id/home-domain', checkPermission(PERMISSIONS.WALLETS_UPDATE), walletIdSchema, updateHomeDomainSchema, payloadSizeLimiter(ENDPOINT_LIMITS.wallet), asyncHandler(async (req, res, next) => {
  try {
    const { domain, sourceSecret } = req.body;

    if (!domain || !sourceSecret) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: domain, sourceSecret',
      });
    }

    const wallet = await walletService.getWalletById(req.params.id);
    if (!wallet) {
      return res.status(404).json({ success: false, error: 'Wallet not found' });
    }

    const stellarSvc = getStellarService();
    let result;
    try {
      result = await stellarSvc.setHomeDomain(sourceSecret, domain);
    } catch (err) {
      if (err && err.name === 'ValidationError') {
        return next(err);
      }
      return res.status(502).json({
        success: false,
        error: 'Stellar network error while setting home domain',
      });
    }

    await AuditLogService.log({
      category: AuditLogService.CATEGORY.WALLET_OPERATION,
      action: AuditLogService.ACTION.HOME_DOMAIN_UPDATED,
      severity: AuditLogService.SEVERITY.MEDIUM,
      result: 'SUCCESS',
      userId: req.user && req.user.id,
      requestId: req.id,
      ipAddress: req.ip,
      resource: `/wallets/${req.params.id}/home-domain`,
      details: { walletId: req.params.id, homeDomain: domain, txHash: result.hash },
    });

    return res.json({
      success: true,
      data: { homeDomain: domain },
    });
  } catch (error) {
    next(error);
  }
}));

/**
 * PUT /wallets/:id/home-domain
 * Idiomatic alias for PATCH — sets the home domain on a wallet's Stellar account.
 * Body: { domain: string, sourceSecret: string }
 */
router.put('/:id/home-domain', checkPermission(PERMISSIONS.WALLETS_UPDATE), walletIdSchema, updateHomeDomainSchema, payloadSizeLimiter(ENDPOINT_LIMITS.wallet), asyncHandler(async (req, res, next) => {
  try {
    const { domain, sourceSecret } = req.body;

    if (!domain || !sourceSecret) {
      return res.status(400).json({ success: false, error: 'Missing required fields: domain, sourceSecret' });
    }

    const wallet = await walletService.getWalletById(req.params.id);
    if (!wallet) {
      return res.status(404).json({ success: false, error: 'Wallet not found' });
    }

    const stellarSvc = getStellarService();
    let result;
    try {
      result = await stellarSvc.setHomeDomain(sourceSecret, domain);
    } catch (err) {
      if (err && err.name === 'ValidationError') return next(err);
      return res.status(502).json({ success: false, error: 'Stellar network error while setting home domain' });
    }

    await AuditLogService.log({
      category: AuditLogService.CATEGORY.WALLET_OPERATION,
      action: AuditLogService.ACTION.HOME_DOMAIN_UPDATED,
      severity: AuditLogService.SEVERITY.MEDIUM,
      result: 'SUCCESS',
      userId: req.user && req.user.id,
      requestId: req.id,
      ipAddress: req.ip,
      resource: `/wallets/${req.params.id}/home-domain`,
      details: { walletId: req.params.id, homeDomain: domain, txHash: result.hash },
    });

    return res.json({ success: true, data: { homeDomain: domain } });
  } catch (error) {
    next(error);
  }
}));

/**
 * GET /wallets/:id/home-domain
 * Returns the current home_domain set on the wallet's Stellar account.
 */
router.get('/:id/home-domain', checkPermission(PERMISSIONS.WALLETS_READ), walletIdSchema, asyncHandler(async (req, res, next) => {
  try {
    const wallet = await walletService.getWalletById(req.params.id);
    if (!wallet) {
      return res.status(404).json({ success: false, error: 'Wallet not found' });
    }

    const stellarSvc = getStellarService();
    const homeDomain = await stellarSvc.getHomeDomain(wallet.address || wallet.publicKey).catch(() => null);

    return res.json({ success: true, data: { homeDomain: homeDomain || null } });
  } catch (error) {
    next(error);
  }
}));

/**
 * POST /wallets/:id/home-domain/verify
 * Fetches https://{domain}/.well-known/stellar.toml and confirms the wallet's
 * public key is listed under ACCOUNTS.
 */
router.post('/:id/home-domain/verify', checkPermission(PERMISSIONS.WALLETS_READ), walletIdSchema, payloadSizeLimiter(ENDPOINT_LIMITS.wallet), asyncHandler(async (req, res, next) => {
  try {
    const wallet = await walletService.getWalletById(req.params.id);
    if (!wallet) {
      return res.status(404).json({ success: false, error: 'Wallet not found' });
    }

    const stellarSvc = getStellarService();
    const publicKey = wallet.address || wallet.publicKey;
    const homeDomain = await stellarSvc.getHomeDomain(publicKey).catch(() => null);

    if (!homeDomain) {
      return res.status(400).json({ success: false, error: 'No home domain is set for this wallet' });
    }

    const https = require('https');
    const tomlUrl = `https://${homeDomain}/.well-known/stellar.toml`;

    const tomlContent = await new Promise((resolve, reject) => {
      const req2 = https.get(tomlUrl, { timeout: 5000 }, (response) => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          response.resume();
          return reject(new Error(`stellar.toml returned HTTP ${response.statusCode}`));
        }
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => resolve(chunks.join('')));
      });
      req2.on('timeout', () => { req2.destroy(); reject(new Error('Request timed out after 5 seconds')); });
      req2.on('error', (err) => reject(err));
    }).catch((err) => {
      return res.status(502).json({
        success: false,
        error: `Could not fetch stellar.toml from ${tomlUrl}: ${err.message}`,
      });
    });

    // If response was already sent (error case above), stop here
    if (res.headersSent) return;

    const listed = tomlContent.includes(publicKey);
    if (!listed) {
      return res.status(422).json({
        success: false,
        error: `Account ${publicKey} is not listed in ${tomlUrl}`,
        data: { homeDomain, publicKey, verified: false },
      });
    }

    return res.json({
      success: true,
      data: { homeDomain, publicKey, verified: true },
    });
  } catch (error) {
    next(error);
  }
}));

module.exports = router;
