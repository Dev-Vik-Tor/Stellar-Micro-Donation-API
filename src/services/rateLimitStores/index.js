'use strict';

/**
 * Rate Limit Store Factory (#1482)
 *
 * RESPONSIBILITY: Create and manage rate limit store instances
 * OWNER: Backend Team
 * DEPENDENCIES: MemoryRateLimitStore, RedisRateLimitStore
 *
 * Automatically selects the appropriate store based on RATE_LIMIT_STORE
 * environment variable. Falls back to in-memory store on Redis errors.
 */

const log = require('../../utils/log');
const MemoryRateLimitStore = require('./MemoryRateLimitStore');
const RedisRateLimitStore = require('./RedisRateLimitStore');

let storeInstance = null;

/**
 * Create or return the singleton rate limit store instance.
 *
 * @returns {Promise<RateLimitStore>} Initialized rate limit store
 */
async function getRateLimitStore() {
  if (storeInstance) {
    return storeInstance;
  }

  const storeType = (process.env.RATE_LIMIT_STORE || 'memory').toLowerCase();

  if (storeType === 'redis') {
    try {
      const redisUrl = process.env.REDIS_URL;
      if (!redisUrl) {
        throw new Error('REDIS_URL is required when RATE_LIMIT_STORE=redis');
      }

      // Lazy-load Redis client only when needed
      let redis;
      try {
        redis = require('redis');
      } catch (err) {
        log.warn('RATE_LIMIT', 'redis package not installed; falling back to in-memory store', {
          error: err.message
        });
        storeInstance = new MemoryRateLimitStore();
        return storeInstance;
      }

      const client = redis.createClient({ url: redisUrl });
      client.on('error', (err) => {
        log.error('RATE_LIMIT', 'Redis client error', { error: err.message });
      });

      await client.connect();
      const isHealthy = await client.ping() === 'PONG';
      if (!isHealthy) {
        throw new Error('Redis health check failed');
      }

      storeInstance = new RedisRateLimitStore(client);
      log.info('RATE_LIMIT', 'Initialized Redis rate limit store', { url: redisUrl });
      return storeInstance;
    } catch (error) {
      log.warn('RATE_LIMIT', 'Failed to initialize Redis store; falling back to in-memory', {
        error: error.message
      });
      storeInstance = new MemoryRateLimitStore();
      return storeInstance;
    }
  }

  // Default to in-memory store
  storeInstance = new MemoryRateLimitStore();
  log.info('RATE_LIMIT', 'Initialized in-memory rate limit store');
  return storeInstance;
}

/**
 * Shutdown the current rate limit store instance.
 * Called during application shutdown.
 *
 * @returns {Promise<void>}
 */
async function shutdownRateLimitStore() {
  if (storeInstance) {
    try {
      await storeInstance.shutdown();
      storeInstance = null;
    } catch (error) {
      log.warn('RATE_LIMIT', 'Error shutting down rate limit store', {
        error: error.message
      });
    }
  }
}

/**
 * Reset the singleton store (for testing).
 */
function resetStore() {
  storeInstance = null;
}

module.exports = {
  getRateLimitStore,
  shutdownRateLimitStore,
  resetStore,
  MemoryRateLimitStore,
  RedisRateLimitStore,
};
