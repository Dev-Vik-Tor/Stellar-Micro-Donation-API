'use strict';

/**
 * Redis Rate Limit Store (#1482)
 *
 * RESPONSIBILITY: Provide distributed rate limit counters backed by Redis
 * OWNER: Backend Team
 * DEPENDENCIES: redis client, RateLimitStore base class
 *
 * Uses Redis INCR and EXPIRE commands for atomic, distributed rate limiting.
 * Supports horizontal scaling across multiple server instances.
 */

const RateLimitStore = require('./RateLimitStore');
const log = require('../../utils/log');

class RedisRateLimitStore extends RateLimitStore {
  /**
   * @param {Object} redisClient - Initialized Redis client
   */
  constructor(redisClient) {
    super();
    this.client = redisClient;
    this.healthCheckInProgress = false;
  }

  /**
   * Increment a rate limit counter by 1 using Redis INCR.
   * Sets expiration with EXPIRE if counter was newly created.
   *
   * @param {string} key - Rate limit key
   * @param {number} windowMs - Expiration window in milliseconds
   * @returns {Promise<number>} The new counter value after increment
   */
  async increment(key, windowMs) {
    try {
      // INCR is atomic and returns the new value
      const newValue = await this.client.incr(key);

      // Set expiration only (Redis resets TTL if we use EXPIRE on existing keys)
      // Use EXPIRE with seconds (convert milliseconds to seconds, rounding up)
      const expirationSeconds = Math.ceil(windowMs / 1000);
      await this.client.expire(key, expirationSeconds);

      return newValue;
    } catch (error) {
      log.error('REDIS_RATE_LIMIT', 'Failed to increment rate limit counter', {
        key,
        error: error.message
      });
      throw error;
    }
  }

  /**
   * Get the current counter value from Redis.
   *
   * @param {string} key - Rate limit key
   * @returns {Promise<number>} Current counter value, or 0 if key does not exist
   */
  async get(key) {
    try {
      const value = await this.client.get(key);
      return value ? parseInt(value, 10) : 0;
    } catch (error) {
      log.error('REDIS_RATE_LIMIT', 'Failed to get rate limit counter', {
        key,
        error: error.message
      });
      throw error;
    }
  }

  /**
   * Reset a rate limit counter to 0 by deleting the key.
   *
   * @param {string} key - Rate limit key
   * @returns {Promise<void>}
   */
  async reset(key) {
    try {
      await this.client.del(key);
    } catch (error) {
      log.error('REDIS_RATE_LIMIT', 'Failed to reset rate limit counter', {
        key,
        error: error.message
      });
      throw error;
    }
  }

  /**
   * Check if Redis connection is healthy with a simple PING.
   *
   * @returns {Promise<boolean>} True if Redis is reachable, false otherwise
   */
  async isHealthy() {
    if (this.healthCheckInProgress) {
      return true; // Avoid concurrent health checks
    }

    this.healthCheckInProgress = true;
    try {
      const pong = await this.client.ping();
      return pong === 'PONG';
    } catch (error) {
      log.warn('REDIS_RATE_LIMIT', 'Redis health check failed', {
        error: error.message
      });
      return false;
    } finally {
      this.healthCheckInProgress = false;
    }
  }

  /**
   * Gracefully shutdown the Redis connection.
   *
   * @returns {Promise<void>}
   */
  async shutdown() {
    try {
      if (this.client && typeof this.client.quit === 'function') {
        await this.client.quit();
      }
    } catch (error) {
      log.warn('REDIS_RATE_LIMIT', 'Error during Redis shutdown', {
        error: error.message
      });
    }
  }
}

module.exports = RedisRateLimitStore;
