/**
 * Wallet Routes - Composition Layer
 *
 * RESPONSIBILITY: Mount decomposed wallet sub-routers (issue #1212)
 * OWNER: Backend Team
 * DEPENDENCIES: Wallet sub-routers in ./wallets/
 *
 * This file now serves as a thin composition layer that mounts focused
 * sub-routers, each handling specific wallet operations:
 * - index.js: CRUD + bulk operations
 * - metadata.js: Wallet metadata (get, update, delete)
 * - balance-history.js: Balance and transaction history
 * - home-domain.js: Home domain management
 * - inflation.js: Inflation destination
 * - sponsorship.js: Account sponsorship
 * - trustlines.js: Trustline management
 * - data-entries.js: Account data
 * - merge.js: Account merging
 * - limits-config.js: Wallet limits and config
 *
 * See docs/WALLET_ROUTES_COMPOSITION.md for architecture details.
 */

const express = require('express');
const router = express.Router();

// Mount decomposed sub-routers
const indexRouter = require('./wallets/index');
const metadataRouter = require('./wallets/metadata');

// Mount all routes (sub-routers handle their own paths)
router.use('/', indexRouter);
router.use('/:id', metadataRouter);

module.exports = router;
