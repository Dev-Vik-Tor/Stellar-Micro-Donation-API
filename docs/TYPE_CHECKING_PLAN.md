# Type Checking Plan - JSDoc + checkJs

## Overview

This document outlines the incremental adoption of static type checking via JSDoc + `checkJs` configuration, without requiring a full TypeScript migration.

## Current Status

Type checking is **enabled** via `jsconfig.json` for critical modules:
- `src/utils/money.js` - Money math and stroop arithmetic
- `src/utils/validators.js` - API input validation
- `src/services/StellarService.js` - Stellar blockchain interface (placeholder)
- `src/services/DonationService.js` - Core donation logic (placeholder)

All critical utilities have JSDoc type annotations via `@param`, `@returns`, `@typedef`, and inline `@type` declarations.

## Motivation

1. **Protects financial code**: Money utilities and validators handle real values; type errors here cause production bugs
2. **Catches early**: Type mismatches (e.g., `number` vs `BigInt`, string parsing) are caught at CI time
3. **Incremental**: Doesn't require rewriting the codebase; adds coverage module by module
4. **Documentation**: JSDoc types serve as inline documentation for developers

## JSDoc Type Annotations

All typed modules use JSDoc conventions:

```javascript
// @ts-check

/**
 * Add two BigInt stroop values.
 * @param {bigint} a - first stroop amount
 * @param {bigint} b - second stroop amount
 * @returns {bigint} sum of stroops
 */
function addStroops(a, b) {
  return a + b;
}
```

### Supported Patterns

- **Primitives**: `@param {string}`, `@param {number}`, `@param {bigint}`, `@param {boolean}`
- **Union types**: `@param {(string|number)}`
- **Objects**: `@param {{id: number, name: string}} obj`
- **Typedefs**: `@typedef {object} MyType` with property definitions
- **Functions**: `@param {Function}`, `@param {(arg: string) => number}`
- **Optionals**: `@param {string} [optional]`
- **Nullability**: `@param {?string}` (can be string or null)

## Expansion Phases

### Phase 1: Core Utilities (DONE)
- ✓ `src/utils/money.js` - Money math and stroop conversion
- ✓ `src/utils/validators.js` - Validation functions
- Scope: ~30 functions, critical financial code

### Phase 2: Service Interfaces (PLANNED)
- `src/services/StellarService.js` - Stellar SDK wrapper
- `src/services/DonationService.js` - Donation workflow
- Scope: ~50-70 functions, public API surface

### Phase 3: Middleware & Route Handlers (PLANNED)
- Core middleware: `src/middleware/rbac.js`, `src/middleware/validation.js`
- High-value route handlers
- Scope: ~80-100 functions, request/response contracts

### Phase 4: Remaining Critical Modules (PLANNED)
- Database layer utilities
- Error handling and logging
- Scope: ~100+ functions

### Phase 5: Optional Features (DEFERRED)
- Tests (may stay untyped)
- Scripts (often one-off, low risk)
- Example code

## Configuration

The `jsconfig.json` file configures:
- `checkJs: true` - Enable type checking for `.js` files
- `strict: true` - Strict mode for missing types, implicit `any`, etc.
- `include` - Explicit list of modules to type-check
- `exclude` - Excludes `node_modules`, tests, etc.

To add a module to type checking:
1. Add JSDoc type annotations (`@param`, `@returns`, etc.)
2. Add `// @ts-check` at the top of the file
3. List the file path in `jsconfig.json` `include` array
4. Run type checking: `npx tsc --noEmit`

## Continuous Integration

A CI step runs type checking on all opted-in modules:

```bash
npx tsc --noEmit
```

This ensures type errors block merges and new violations are caught immediately.

## Known Limitations

1. **No full TypeScript**: Class definitions, interfaces, and decorators aren't available
2. **Implicit `any`**: Dynamic or externally-typed values may need `@type {any}` pragmatically
3. **Partial coverage**: Only opted-in modules are checked; un-annotated imports use `any`
4. **Callback complexity**: Function types can be verbose in JSDoc; consider breaking into `@typedef`

## Migration Path to Full TypeScript

If full TypeScript adoption becomes desirable:
1. Existing JSDoc types map directly to TypeScript interfaces (`@typedef` → `interface`)
2. Opted-in modules require minimal changes to convert to `.ts`
3. Untyped modules can be migrated incrementally or left as `.js`
4. `tsconfig.json` can coexist with `jsconfig.json` during transition

## References

- [TypeScript JSDoc Reference](https://www.typescriptlang.org/docs/handbook/jsdoc-supported-types.html)
- [TypeScript checkJs Documentation](https://www.typescriptlang.org/tsconfig#checkJs)
- [CommonJS Modules](https://nodejs.org/api/modules.html)
