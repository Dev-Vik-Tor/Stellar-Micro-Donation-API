/**
 * Block Check Middleware
 * 
 * Early check for auto-blocked IPs before processing request
 */

const abuseDetectionService = require('../services/AbuseDetectionService');
const log = require('../utils/log');

function blockCheck(req, res, next) {
  // Skip IP blocking in test environment — tests generate expected 4xx responses
  if (process.env.NODE_ENV === 'test' || process.env.NODE_ENV === 'testing') {
    return next();
  }

  // Use only req.ip (set by Express based on trust proxy) — never fall back to
  // the X-Forwarded-For header, which is client-controlled and can be spoofed.
  // If req.ip is not available, fall through to 'unknown' and allow the request
  // to proceed; a missing IP is not grounds for a hard block.
  const ip = req.ip || 'unknown';

  if (abuseDetectionService.isBlocked(ip)) {
    log.warn('BLOCK_CHECK', 'Request blocked', { ip, path: req.path, method: req.method });

    return res.status(403).json({
      success: false,
      error: {
        code: 'BLOCKED_IP',
        message: 'IP temporarily blocked for abuse prevention',
        blockedUntil: 'Admin contact required',
        requestId: req.id
      }
    });
  }

  // Add IP to request for logging
  req.clientIp = ip;
  next();
}

module.exports = blockCheck;

