/**
 * RoundRobinStrategy
 *
 * Selects the recipient at the given currentIndex in the pool.
 * No exclusions — all pool members are eligible.
 */

class RoundRobinStrategy {
  /**
   * @param {Array<{id: string}>} pool
   * @param {{ currentIndex: number }} context
   * @returns {{ selectedId: string, excludedIds: string[] }}
   */
  select(pool, { currentIndex }) {
    // Defensive bounds check: if the stored index is out of range (e.g., the
    // pool shrank between rotations), wrap back to 0 so we never index into
    // undefined and crash with a TypeError.
    const safeIndex = currentIndex >= pool.length ? 0 : currentIndex;
    const recipient = pool[safeIndex];
    return { selectedId: recipient.id, excludedIds: [] };
  }
}

module.exports = RoundRobinStrategy;
