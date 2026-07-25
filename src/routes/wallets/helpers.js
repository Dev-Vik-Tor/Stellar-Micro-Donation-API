/**
 * Wallet Routes Helpers - Shared Schemas, Validators, and Utilities
 *
 * RESPONSIBILITY: Centralized schema definitions and helper functions for wallet sub-routers
 * DEPENDENCIES: validation middleware, utilities
 */

const { validateSchema } = require('../../middleware/schemaValidation');
const { isValidStellarPublicKey } = require('../../utils/validators');

const STELLAR_MAX_LIMIT = '922337203685.4775807';
const WALLET_ANALYTICS_CACHE_TTL_MS = 5 * 60 * 1000;

// ─── Wallet ID & Address Schemas ───────────────────────────────────────────

const walletIdSchema = validateSchema({
  params: {
    fields: {
      id: { type: 'string', required: true, trim: true, minLength: 1 }
    }
  }
});

const walletPublicKeySchema = validateSchema({
  params: {
    fields: {
      publicKey: { type: 'string', required: true, trim: true, minLength: 1 }
    }
  }
});

// ─── Wallet CRUD Schemas ───────────────────────────────────────────────────

const walletCreateSchema = validateSchema({
  body: {
    fields: {
      address: {
        type: 'string',
        required: true,
        trim: true,
        minLength: 1,
        validate: (value) => isValidStellarPublicKey(value)
          ? true
          : 'address must be a valid Stellar public key (56-character Ed25519 public key starting with G)',
      },
      label: { type: 'string', required: false, nullable: true },
      ownerName: { type: 'string', required: false, nullable: true },
      sponsored: { type: 'boolean', required: false, nullable: true }
    }
  }
});

const updateWalletSchema = validateSchema({
  body: {
    fields: {
      label: { type: 'string', required: false, nullable: true, maxLength: 100 },
      ownerName: { type: 'string', required: false, nullable: true, maxLength: 200 },
    }
  }
});

const updateWalletLabelSchema = validateSchema({
  body: {
    fields: {
      label: { type: 'string', required: false, nullable: true, maxLength: 100 },
    }
  }
});

// ─── Home Domain Schemas ───────────────────────────────────────────────────

const updateHomeDomainSchema = validateSchema({
  body: {
    fields: {
      domain: { type: 'string', required: true },
      sourceSecret: { type: 'string', required: true },
    }
  }
});

// ─── Inflation Destination Schemas ────────────────────────────────────────

const inflationDestinationSchema = validateSchema({
  body: {
    fields: {
      destination: { type: 'string', required: true },
      signedXDR: { type: 'string', required: true },
    }
  }
});

// ─── Trustline Schemas ────────────────────────────────────────────────────

const trustlineCreateSchema = validateSchema({
  body: {
    fields: {
      secretKey: { type: 'string', required: true },
      assetCode: { type: 'string', required: true },
      issuerPublic: { type: 'string', required: true },
      limit: { type: 'string', required: false, nullable: true }
    }
  }
});

const trustlineUpdateSchema = validateSchema({
  body: {
    fields: {
      secretKey: { type: 'string', required: true },
      issuerPublic: { type: 'string', required: true },
      limit: { type: 'string', required: true }
    }
  }
});

const trustlineDeleteSchema = validateSchema({
  body: {
    fields: {
      secretKey: { type: 'string', required: true },
      issuerPublic: { type: 'string', required: true }
    }
  }
});

const trustlineListSchema = validateSchema({
  params: {
    fields: {
      id: { type: 'string', required: true }
    }
  }
});

// ─── Account Options Schema ───────────────────────────────────────────────

const walletOptionsSchema = validateSchema({
  body: {
    fields: {
      secret: { type: 'string', required: true },
      homeDomain: { type: 'string', required: false, nullable: true },
      inflationDest: { type: 'string', required: false, nullable: true },
      masterWeight: { type: 'integer', required: false, nullable: true },
      lowThreshold: { type: 'integer', required: false, nullable: true },
      medThreshold: { type: 'integer', required: false, nullable: true },
      highThreshold: { type: 'integer', required: false, nullable: true },
      setFlags: { type: 'array', required: false, nullable: true },
      clearFlags: { type: 'array', required: false, nullable: true }
    }
  }
});

// ─── Wallet Configuration Schemas ────────────────────────────────────────

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

// ─── Utility Functions ────────────────────────────────────────────────────

function validateTrustLimit(limit) {
  if (!limit) return null;

  const parsed = parseFloat(limit);
  if (isNaN(parsed) || parsed <= 0) {
    return 'Trust limit must be a positive number';
  }

  const maxLimit = parseFloat(STELLAR_MAX_LIMIT);
  if (parsed > maxLimit) {
    return `Trust limit cannot exceed ${STELLAR_MAX_LIMIT}`;
  }

  return null;
}

module.exports = {
  // Constants
  STELLAR_MAX_LIMIT,
  WALLET_ANALYTICS_CACHE_TTL_MS,

  // Schemas - Identifiers
  walletIdSchema,
  walletPublicKeySchema,

  // Schemas - CRUD
  walletCreateSchema,
  updateWalletSchema,
  updateWalletLabelSchema,

  // Schemas - Home Domain
  updateHomeDomainSchema,

  // Schemas - Inflation Destination
  inflationDestinationSchema,

  // Schemas - Trustlines
  trustlineCreateSchema,
  trustlineUpdateSchema,
  trustlineDeleteSchema,
  trustlineListSchema,
  walletOptionsSchema,

  // Schemas - Configuration
  updateWalletLimitsSchema,
  updateLeaderboardVisibilitySchema,

  // Utilities
  validateTrustLimit,
};
