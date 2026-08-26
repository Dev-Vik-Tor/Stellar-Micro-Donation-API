'use strict';

/**
 * Abstract base class for rate limit store implementations (#1482)
 *
 * RESPONSIBILITY: Define the interface for pluggable rate limit storage backends
 * OWNER: Backend Team
 *
 * Implementations must support distributed rate limiting across multiple server instances.
 */

class RateLimitStore {
  /**
   * Increment a rate limit counter by 1.
   * Atomically increments the counter and sets/updates the expiration.
   *
   * @param {string} key - Rate limit key (e.g., "ip:192.0.2.1:donation")
   * @param {number} windowMs - Expiration window in milliseconds
   * @returns {Promise<number>} The new counter value after increment
   */
  async increment(key, windowMs) {
    throw new Error('increment() must be implemented by subclass');
  }

  /**
   * Get the current counter value for a key.
   *
   * @param {string} key - Rate limit key
   * @returns {Promise<number>} Current counter value, or 0 if key does not exist
   */
  async get(key) {
    throw new Error('get() must be implemented by subclass');
  }

  /**
   * Reset a rate limit counter to 0.
   *
   * @param {string} key - Rate limit key
   * @returns {Promise<void>}
   */
  async reset(key) {
    throw new Error('reset() must be implemented by subclass');
  }

  /**
   * Check if the store is healthy and operational.
   *
   * @returns {Promise<boolean>} True if store is ready, false otherwise
   */
  async isHealthy() {
    throw new Error('isHealthy() must be implemented by subclass');
  }

  /**
   * Gracefully shutdown the store.
   *
   * @returns {Promise<void>}
   */
  async shutdown() {
    throw new Error('shutdown() must be implemented by subclass');
  }
}

module.exports = RateLimitStore;
