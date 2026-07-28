/**
 * Auth Middleware
 *
 * RESPONSIBILITY: Provide admin verification and general authentication middleware.
 * DEPENDENCIES: rbac middleware
 */

'use strict';

const rbac = require('./rbac');

/**
 * Verify admin authorization middleware.
 */
const verifyAdmin = (req, res, next) => {
  return rbac.requireAdmin()(req, res, next);
};

module.exports = {
  verifyAdmin,
  requireAdmin: verifyAdmin,
};
