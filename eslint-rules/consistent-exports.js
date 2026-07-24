'use strict';

/**
 * ESLint rule: consistent-exports
 *
 * Enforces consistent module export patterns per module type:
 * - Services/Classes: direct export (module.exports = ClassName)
 * - Utilities: named exports (module.exports = { func1, func2, ... })
 * - Routes: direct router export
 * - Migrations: special format (exports.up, exports.down)
 *
 * See docs/EXPORT_CONVENTIONS.md for full guidelines.
 */
module.exports = {
  meta: {
    type: 'suggestion',
    docs: {
      description: 'Enforce consistent export patterns by module type',
      url: 'docs/EXPORT_CONVENTIONS.md',
    },
    messages: {
      inconsistentService:
        'Service modules should export the class/service directly, not as an object literal. ' +
        'Change: module.exports = Class; See docs/EXPORT_CONVENTIONS.md',
      inconsistentUtil:
        'Utility modules should export named functions in an object. ' +
        'Change: module.exports = { func1, func2, ... }; See docs/EXPORT_CONVENTIONS.md',
    },
    schema: [],
  },

  create(context) {
    // For now, this rule is a stub that documents the convention.
    // Full enforcement would require significant refactoring of the codebase.
    // Enable enforcement incrementally as modules are updated.
    return {};
  },
};
