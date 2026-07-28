/**
 * GraphQL Router — mounts the /graphql HTTP endpoint and WebSocket subscription server.
 *
 * RESPONSIBILITY: Wire the GraphQL schema to Express and graphql-ws.
 * OWNER: Backend Team
 * DEPENDENCIES: graphql-http, graphql-ws, existing API key middleware, service layer
 *
 * Security:
 *  - All requests (HTTP + WS) require a valid API key.
 *  - Introspection is disabled in production (NODE_ENV=production).
 *  - Query depth is limited to prevent deeply nested abuse.
 */

const { createHandler } = require('graphql-http/lib/use/express');
const { useServer } = require('graphql-ws/use/ws');
const { WebSocketServer } = require('ws');
const { validate } = require('graphql');
const { buildSchema } = require('./schema');
const pubsub = require('./pubsub');
const requireApiKey = require('../middleware/apiKey');
const { getStellarService } = require('../config/stellar');
const DonationService = require('../services/DonationService');
const WalletService = require('../services/WalletService');
const StatsService = require('../services/StatsService');
const log = require('../utils/log');
const { parseLanguage, getMessage } = require('../utils/i18n');

const IS_PRODUCTION = process.env.NODE_ENV === 'production';

/** Maximum allowed query depth to prevent deeply nested abuse */
const MAX_QUERY_DEPTH = 5;

/**
 * Recursively compute the depth of a GraphQL selection set.
 * @param {object} selectionSet
 * @param {number} depth
 * @returns {number}
 */
function getQueryDepth(selectionSet, depth = 0) {
  if (!selectionSet || !selectionSet.selections) return depth;
  return Math.max(
    ...selectionSet.selections.map((s) =>
      getQueryDepth(s.selectionSet, depth + 1)
    )
  );
}

/**
 * Validate that a parsed document does not exceed MAX_QUERY_DEPTH.
 * @param {object} document - Parsed GraphQL document
 * @returns {{ valid: boolean, depth: number }}
 */
function checkDepth(document) {
  let maxDepth = 0;
  for (const def of document.definitions) {
    if (def.selectionSet) {
      const d = getQueryDepth(def.selectionSet);
      if (d > maxDepth) maxDepth = d;
    }
  }
  return { valid: maxDepth <= MAX_QUERY_DEPTH, depth: maxDepth };
}

// ─── Service instances ────────────────────────────────────────────────────────

const stellarService = getStellarService();
const donationService = new DonationService(stellarService);
const walletService = new WalletService(stellarService);

// StatsService uses only static methods — pass the class itself as the service object
const statsService = {
  getDailyStats: (...args) => StatsService.getDailyStats(...args),
  getSummaryStats: (...args) => StatsService.getSummaryStats(...args),
};

// ─── Schema ───────────────────────────────────────────────────────────────────

const schema = buildSchema({ donationService, walletService, statsService, pubsub });

// ─── Error sanitization ───────────────────────────────────────────────────────

/** Patterns that might expose sensitive implementation details in production. */
const SENSITIVE_PATTERNS = [
  /database|db|sql|query/gi,
  /file|path|directory|folder/gi,
  /internal|system|server|infrastructure/gi,
  /stack|trace|exception/gi,
  /password|secret|key|token|credential/gi,
  /localhost|127\.0\.0\.1|internal|private/gi,
  /\.js|\.json|\.env|config/gi,
];

/**
 * Sanitize a GraphQL error before it reaches the client.
 *
 * Routes every error through the same sanitization, i18n, and request-ID
 * injection pipeline that src/middleware/errorHandler.js applies to REST errors,
 * so both API surfaces present an equally-safe error contract.
 *
 * @param {import('graphql').GraphQLError} err   - The original GraphQL error
 * @param {object}                         reqCtx - Per-request context from createHandler
 * @returns {import('graphql').GraphQLError}      - Sanitized error safe for the client
 */
function sanitizeGraphQLError(err, reqCtx) {
  const isProduction = process.env.NODE_ENV === 'production';

  // Resolve correlation/request ID from context (injected by requestId middleware)
  const requestId = reqCtx?.raw?.id || reqCtx?.raw?.headers?.['x-request-id'];
  const lang = parseLanguage(
    reqCtx?.raw?.headers?.['accept-language']
  );

  // Log the original error server-side (never exposes stack to client)
  log.error('GRAPHQL_ERROR', 'GraphQL error occurred', {
    requestId,
    message: err.message,
    path: err.path,
    locations: err.locations,
    stack: err.stack, // server-side only
  });

  // Translate the message via the i18n catalogue when possible
  const translated = getMessage('INTERNAL_ERROR', lang);

  let safeMessage = err.message;

  if (isProduction) {
    // Check whether the original message contains sensitive implementation details
    const hasSensitiveContent = SENSITIVE_PATTERNS.some((p) => p.test(err.message));
    if (hasSensitiveContent || !err.originalError) {
      // Unexpected / unhandled errors → opaque message
      safeMessage = translated || 'An internal error occurred. Please try again later.';
    }
  }

  // Build an extensions bag consistent with the REST error contract
  const extensions = {
    ...(err.extensions || {}),
    requestId,
    timestamp: new Date().toISOString(),
  };

  return new err.constructor(safeMessage, {
    nodes: err.nodes,
    source: err.source,
    positions: err.positions,
    path: err.path,
    originalError: err.originalError,
    extensions,
  });
}

// ─── HTTP handler ─────────────────────────────────────────────────────────────

/**
 * Express middleware that handles GraphQL over HTTP (POST /graphql).
 * Authentication is enforced by requireApiKey before this handler runs.
 */
const graphqlHttpHandler = createHandler({
  schema,
  /**
   * Build per-request context, injecting the authenticated API key info.
   * @param {object} req - Express request
   * @returns {{ apiKey: object }}
   */
  context: (req) => ({ apiKey: req.raw.apiKey }),

  /**
   * Validate the incoming document before execution.
   * Blocks introspection in production and enforces depth limits.
   * @param {object} args
   * @returns {readonly Error[] | undefined}
   */
  validate(args) {
    const errors = validate(args.schema, args.documentAST);
    if (errors.length > 0) return errors;

    // Block introspection in production
    if (IS_PRODUCTION) {
      for (const def of args.documentAST.definitions) {
        const src = def.selectionSet?.selections ?? [];
        const hasIntrospection = src.some(
          (s) => s.name?.value === '__schema' || s.name?.value === '__type'
        );
        if (hasIntrospection) {
          return [new Error('GraphQL introspection is disabled in production.')];
        }
      }
    }

    // Enforce query depth limit
    const { valid, depth } = checkDepth(args.documentAST);
    if (!valid) {
      return [
        new Error(
          `Query depth ${depth} exceeds maximum allowed depth of ${MAX_QUERY_DEPTH}.`
        ),
      ];
    }

    return undefined;
  },

  /**
   * Sanitize errors before they reach the client.
   *
   * Routes every GraphQL error through the same sanitization, i18n, and
   * request-ID injection pipeline used by src/middleware/errorHandler.js,
   * so both the REST and GraphQL API surfaces present a consistent,
   * equally-safe error contract. Raw database errors or stack traces that
   * bubble up from resolvers are redacted in production.
   *
   * @param {import('graphql').GraphQLError} err     - Original error
   * @param {object}                         reqCtx  - Request context from createHandler
   * @returns {import('graphql').GraphQLError}       - Sanitized error
   */
  formatError(err, reqCtx) {
    return sanitizeGraphQLError(err, reqCtx);
  },
});

// ─── WebSocket subscription server ───────────────────────────────────────────

/**
 * Attach a graphql-ws WebSocket server to an existing HTTP server.
 * Clients must supply their API key in the `connectionParams.apiKey` field.
 *
 * @param {import('http').Server} httpServer - The running HTTP server
 * @returns {object} graphql-ws server handle (call .dispose() on shutdown)
 */
function attachSubscriptionServer(httpServer) {
  const wss = new WebSocketServer({ server: httpServer, path: '/graphql' });

  const wsServer = useServer(
    {
      schema,
      /**
       * Authenticate WebSocket connections via connectionParams.
       * @param {object} ctx - graphql-ws context
       * @returns {Promise<object>} context passed to resolvers
       */
      onConnect: async (ctx) => {
        const apiKey = ctx.connectionParams?.apiKey;
        if (!apiKey) {
          throw new Error('API key required');
        }

        // Reuse the same validation logic as the REST middleware
        const { validateKey } = require('../models/apiKeys');
        const { securityConfig } = require('../config/securityConfig');
        const legacyKeys = securityConfig.API_KEYS || [];

        const keyInfo = await validateKey(apiKey).catch(() => null);
        if (keyInfo) {
          return { apiKey: keyInfo };
        }
        if (legacyKeys.includes(apiKey)) {
          return { apiKey: { role: 'user', isLegacy: true } };
        }

        throw new Error('Invalid or expired API key');
      },
      context: (ctx) => ({ apiKey: ctx.extra?.apiKey ?? ctx.connectionParams }),
    },
    wss
  );

  log.info('GRAPHQL', 'WebSocket subscription server attached at /graphql');
  return wsServer;
}

// ─── Route factory ────────────────────────────────────────────────────────────

/**
 * Return an Express router that mounts the GraphQL HTTP endpoint.
 * Call attachSubscriptionServer(httpServer) separately after server.listen().
 *
 * @returns {import('express').Router}
 */
function createGraphQLRouter() {
  const express = require('express');
  const router = express.Router();

  // All GraphQL HTTP requests require a valid API key
  router.use(requireApiKey);

  // POST /graphql — execute queries and mutations
  router.post('/', graphqlHttpHandler);

  return router;
}

module.exports = { createGraphQLRouter, attachSubscriptionServer, pubsub, schema };
