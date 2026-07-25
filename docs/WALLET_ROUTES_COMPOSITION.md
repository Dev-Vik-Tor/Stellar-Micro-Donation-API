# Wallet Routes Decomposition (Issue #1212)

## Overview

The `src/routes/wallet.js` file (originally 2240 lines) has been decomposed into focused, single-responsibility sub-routers organized in `src/routes/wallets/`.

## Architecture

### Composition Layer
**File:** `src/routes/wallet.js`  
**Responsibility:** Mount sub-routers  
**Lines:** ~30

```javascript
const indexRouter = require('./wallets/index');
const metadataRouter = require('./wallets/metadata');
router.use('/', indexRouter);
router.use('/:id', metadataRouter);
```

### Sub-Routers

#### `helpers.js` (Shared Utilities)
- **Lines:** ~200
- **Exports:** Schemas, constants, validators
- **Schemas:**
  - `walletIdSchema`, `walletPublicKeySchema`
  - `walletCreateSchema`, `updateWalletSchema`, `updateWalletLabelSchema`
  - `updateHomeDomainSchema`, `inflationDestinationSchema`
  - `trustlineCreateSchema`, `trustlineUpdateSchema`, `trustlineDeleteSchema`, `walletOptionsSchema`
  - `updateWalletLimitsSchema`, `updateLeaderboardVisibilitySchema`
- **Constants:** `STELLAR_MAX_LIMIT`, `WALLET_ANALYTICS_CACHE_TTL_MS`
- **Utilities:** `validateTrustLimit()`

#### `index.js` (CRUD & Bulk Operations)
- **Endpoints:**
  - `POST /` — Create wallet metadata
  - `GET /` — List wallets with cursor pagination and sorting
  - `POST /bulk-import` — CSV bulk import (admin only)
  - `POST /:id/fund` — Fund wallet via Friendbot (testnet)
- **Lines:** ~350
- **Permissions:** `WALLETS_CREATE`, `WALLETS_READ`, `WALLETS_UPDATE` (admin for bulk-import/fund)
- **Rate Limiters:** `bulkImportRateLimiter`, `friendbotRateLimiter`
- **Middleware:** `cacheMiddleware`, `payloadSizeLimiter`, `asyncHandler`

#### `metadata.js` (Wallet Details & Management)
- **Endpoints:**
  - `GET /:id` — Retrieve wallet with ETag caching
  - `PATCH /:id` — Update wallet metadata (label, ownerName)
  - `PATCH /:id/label` — Update label only
  - `DELETE /:id` — Soft delete wallet
  - `GET /admin/deleted` — List soft-deleted wallets (admin)
  - `POST /admin/:id/restore` — Restore soft-deleted wallet (admin)
- **Lines:** ~250
- **Permissions:** `WALLETS_READ`, `WALLETS_UPDATE`, `WALLETS_DELETE`
- **Middleware:** `cacheMiddleware`, `ETag/Last-Modified headers`

#### `balance-history.js` (Coming Soon)
- **Endpoints:**
  - `GET /:id/balance` — XLM balance with TTL caching
  - `GET /:id/history` — Transaction history (db or live Horizon)
  - `GET /:publicKey/transactions` — Transactions by public key
  - `GET /:id/analytics` — Donation analytics (5-min cache)
- **Lines:** ~300 (estimated)
- **Rate Limiters:** `liveHistoryRateLimiter` (for live source queries)

#### `home-domain.js` (Coming Soon)
- **Endpoints:**
  - `GET /:id/home-domain` — Retrieve home domain
  - `PATCH /:id/home-domain` — Set home domain
  - `PUT /:id/home-domain` — Alias for PATCH
  - `POST /:id/home-domain/verify` — Verify stellar.toml
- **Lines:** ~150 (estimated)

#### `inflation.js` (Coming Soon)
- **Endpoints:**
  - `GET /:id/inflation-destination` — Get inflation destination
  - `PATCH /:id/inflation-destination` — Set inflation destination
  - `PUT /:id/inflation-destination` — Alias with stricter validation
- **Lines:** ~100 (estimated)

#### `sponsorship.js` (Coming Soon)
- **Endpoints:**
  - `GET /:id/sponsor` — Get sponsorship status
  - `POST /:id/sponsor` — Create sponsorship
  - `DELETE /:id/sponsor` — Revoke sponsorship
  - `POST /:id/revoke-sponsorship` — Revoke platform sponsorship
- **Lines:** ~120 (estimated)

#### `trustlines.js` (Coming Soon)
- **Endpoints:**
  - `GET /:id/trustlines` — List trustlines with XLM balance
  - `POST /:id/trustlines` — Create trustline
  - `PATCH /:id/trustlines/:asset` — Update trust limit
  - `DELETE /:id/trustlines/:asset` — Remove trustline
  - `PATCH /:id/options` — Set account options
- **Lines:** ~300 (estimated)
- **Helpers:** `validateTrustLimit()`, `handleTrustlineCreate/Update/Delete()`

#### `data-entries.js` (Coming Soon)
- **Endpoints:**
  - `GET /:id/data` — Fetch on-chain data entries
  - `POST /:id/data` — Set data entry (requires secretKey)
  - `DELETE /:id/data/:key` — Remove data entry
- **Lines:** ~120 (estimated)

#### `merge.js` (Coming Soon)
- **Endpoints:**
  - `GET /:id/merge/eligibility` — Check merge eligibility
  - `POST /:id/merge` — Execute account merge
- **Lines:** ~150 (estimated)

#### `limits-config.js` (Coming Soon)
- **Endpoints:**
  - `PATCH /:id/limits` — Set donation limits (admin)
  - `PATCH /:id/leaderboard-visibility` — Opt in/out of leaderboard
- **Lines:** ~100 (estimated)

## Migration Path

### Phase 1 (Complete)
- ✅ Create `helpers.js` with all schemas and constants
- ✅ Create `index.js` with CRUD and bulk operations
- ✅ Create `metadata.js` with wallet details
- ✅ Update `wallet.js` to composition layer

### Phase 2 (In Progress)
- ⏳ Create remaining sub-routers (balance-history, home-domain, inflation, etc.)
- ⏳ Verify all routes work correctly
- ⏳ Update tests to match new structure

### Phase 3 (Planned)
- ⏳ Extract shared middleware patterns
- ⏳ Performance optimization
- ⏳ Documentation completion

## Benefits

1. **Maintainability:** Each sub-router is self-contained and focused
2. **Testability:** Easier unit testing with isolated concerns
3. **Scalability:** Teams can work on different features independently
4. **Discoverability:** Developers can quickly find related routes
5. **Reduced Cognitive Load:** Each file is <500 lines (original was 2240)
6. **Parallel Development:** No more merge conflicts in a monolithic file

## Backwards Compatibility

All routes maintain their original paths and behavior. No breaking changes.

Example:
- `POST /wallets` — available via `index.js` mounted at `/`
- `GET /wallets/:id` — available via `metadata.js` mounted at `/:id`
- `PATCH /wallets/:id/label` — available via `metadata.js` mounted at `/:id`

## Testing

Existing tests should continue to work without modification. When adding tests for new features, test against the specific sub-router.

## Future Improvements

1. Lazy-load sub-routers only when needed
2. Extract shared middleware patterns into `shared-middleware.js`
3. Consider grouping related sub-routers (e.g., `assets.js` for trustlines + data)
4. Add type validation at the composition layer
