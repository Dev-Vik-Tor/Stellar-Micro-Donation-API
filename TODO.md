# Issue #1363 — No schema validation on roles.json structure in the permissions model

## Steps

- [x] 1. Analyze the codebase and create plan (completed)
- [x] 2. Update `src/models/permissions.js` — Add `validateRolesConfig()` function and integrate into `loadRolesConfig()`
- [x] 3. Create `tests/models/permissions.test.js` — Comprehensive tests for schema validation (37 tests, all passing)
- [ ] 4. Verify existing tests still pass

