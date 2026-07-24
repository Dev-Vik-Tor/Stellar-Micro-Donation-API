'use strict';

/**
 * ESLint rule: no-floating-promises
 *
 * Detects .then() calls that lack a .catch() handler.
 * Missing error handlers can cause silent failures in async operations.
 *
 * Valid:
 * - await promise
 * - return promise
 * - promise.catch(() => {})  // error is handled
 * - promise.then(...).catch(...)  // chain has terminal catch
 * - const _x = promise  // intentionally discarded
 *
 * Invalid:
 * - promise.then(...)  // no .catch(), errors silently fail
 * - db.query().then(handler)  // unhandled rejection
 */
module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Prevent .then() chains without .catch() handlers',
      url: 'docs/FLOATING_PROMISES.md',
    },
    messages: {
      thenWithoutCatch:
        'Promise .then() lacks a .catch() handler. Rejections will fail silently. ' +
        'Add .catch(...) or await the promise.',
    },
    schema: [],
  },

  create(context) {
    return {
      // Match CallExpression where the callee is MemberExpression .then
      CallExpression(node) {
        // Check if this is a .then() call
        if (node.callee.type !== 'MemberExpression' ||
            node.callee.property.name !== 'then') {
          return;
        }

        // Now check if this .then() call's result is handled with .catch()
        const parent = node.parent;

        // Case 1: Parent is MemberExpression (.catch follows)
        if (parent.type === 'MemberExpression' && parent.object === node) {
          if (parent.property.name === 'catch') {
            // Has .catch(), ok
            return;
          }
          // Other property (like .then again), need to recurse upward
          // For now, allow chaining patterns
          return;
        }

        // Case 2: Parent is VariableDeclarator (const x = promise.then(...))
        if (parent.type === 'VariableDeclarator') {
          // Assigned to variable starting with _ means intentionally ignored
          if (parent.id.name && parent.id.name.startsWith('_')) {
            return;
          }
          // Otherwise it's stored, which is fine
          return;
        }

        // Case 3: Parent is AwaitExpression
        if (parent.type === 'AwaitExpression') {
          return; // Awaited, ok
        }

        // Case 4: Parent is ReturnStatement
        if (parent.type === 'ReturnStatement') {
          return; // Returned, ok
        }

        // Case 5: Parent is ExpressionStatement (standalone .then())
        if (parent.type === 'ExpressionStatement') {
          // This is a floating .then() without .catch()
          context.report({ node, messageId: 'thenWithoutCatch' });
          return;
        }

        // Case 6: Parent is CallExpression with this as argument
        if (parent.type === 'CallExpression' && parent.arguments.includes(node)) {
          // Passed as argument to another function; let it be for now
          return;
        }
      },
    };
  },
};
