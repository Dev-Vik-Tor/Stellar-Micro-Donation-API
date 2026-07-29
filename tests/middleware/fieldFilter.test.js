'use strict';

/**
 * Tests: src/middleware/fieldFilter.js (issue #1390)
 *
 * fieldFilter.js exports four symbols:
 *   fieldFilterMiddleware()  — Express middleware factory
 *   filterObject()           — low-level object picker (used internally)
 *   applyFilter()            — envelope-aware filter
 *   isValidFieldPath()       — path segment validator
 *
 * Test categories:
 *
 *  isValidFieldPath
 *    - valid simple and dotted paths
 *    - invalid: empty, non-string, injection characters
 *
 *  filterObject
 *    - picks requested top-level fields
 *    - picks nested fields using dot notation
 *    - handles undefined path gracefully (omits it)
 *    - handles null/non-object input (returns as-is)
 *    - does not include unrequested fields
 *
 *  applyFilter
 *    - filters the `data` array when body has an array envelope
 *    - filters the `data` object when body has an object envelope
 *    - preserves top-level non-data fields (success, count, meta)
 *    - filters the body directly when there is no `data` envelope
 *    - passes non-object bodies through unchanged
 *
 *  fieldFilterMiddleware (Express middleware)
 *    - passes through when no ?fields param is present
 *    - passes through when ?fields is blank
 *    - returns 400 for an invalid field path (injection chars, dots-only)
 *    - returns 400 when a BLOCKED_FIELDS key is requested
 *    - applies field filtering to res.json output
 *    - sets X-Fields-Applied: true header when filtering
 *    - handles dot-notation field paths end-to-end
 *    - does not set the header when no filtering occurs
 *
 *  Security: BLOCKED_FIELDS enforcement
 *    - password, secret, privateKey, secretKey are rejected
 *    - blocked fields inside nested objects are stripped by filterObject
 *      (they are not in the path list so are never included in output)
 */

const {
  fieldFilterMiddleware,
  filterObject,
  applyFilter,
  isValidFieldPath,
} = require('../../src/middleware/fieldFilter');

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Create a minimal Express-like req/res pair.
 *
 * @param {string|undefined} fieldsParam  - value of req.query.fields
 * @param {object}           resBody      - the object res.json will be called with
 */
function makeReqRes(fieldsParam, resBody = {}) {
  const req = {
    query: fieldsParam !== undefined ? { fields: fieldsParam } : {},
  };

  const captured = {
    status: 200,
    headers: {},
    body: null,
  };

  const res = {
    _captured: captured,
    setHeader(key, value) { captured.headers[key] = value; },
    status(code) { captured.status = code; return this; },
    json(body) { captured.body = body; return this; },
  };

  return { req, res, captured };
}

/**
 * Run the middleware and return a promise that resolves with {next, captured}.
 * `next` is true when next() was called, false when the middleware short-circuited.
 */
function runMiddleware(fieldsParam, resBody = {}) {
  return new Promise((resolve) => {
    const { req, res, captured } = makeReqRes(fieldsParam, resBody);
    const middleware = fieldFilterMiddleware();

    let nextCalled = false;
    const next = () => { nextCalled = true; resolve({ nextCalled, captured, res }); };

    const result = middleware(req, res, next);

    // If the middleware returned synchronously (error path) without calling next
    if (!nextCalled) {
      // For the 400 paths, res.json was called synchronously
      resolve({ nextCalled: false, captured, res });
    }
  });
}

// ─── isValidFieldPath ─────────────────────────────────────────────────────────

describe('isValidFieldPath()', () => {
  it('accepts simple alphanumeric field names', () => {
    expect(isValidFieldPath('id')).toBe(true);
    expect(isValidFieldPath('amount')).toBe(true);
    expect(isValidFieldPath('createdAt')).toBe(true);
  });

  it('accepts underscore-separated field names', () => {
    expect(isValidFieldPath('tx_hash')).toBe(true);
    expect(isValidFieldPath('api_key_id')).toBe(true);
  });

  it('accepts dot-notation paths', () => {
    expect(isValidFieldPath('wallet.address')).toBe(true);
    expect(isValidFieldPath('donor.wallet.publicKey')).toBe(true);
  });

  it('rejects empty strings', () => {
    expect(isValidFieldPath('')).toBe(false);
  });

  it('rejects non-string inputs', () => {
    expect(isValidFieldPath(null)).toBe(false);
    expect(isValidFieldPath(undefined)).toBe(false);
    expect(isValidFieldPath(42)).toBe(false);
  });

  it('rejects paths with injection characters', () => {
    expect(isValidFieldPath('id;DROP TABLE')).toBe(false);
    expect(isValidFieldPath('field<script>')).toBe(false);
    expect(isValidFieldPath('../secret')).toBe(false);
    expect(isValidFieldPath('a b')).toBe(false);
  });

  it('rejects empty segment in path (trailing dot)', () => {
    expect(isValidFieldPath('wallet.')).toBe(false);
    expect(isValidFieldPath('.id')).toBe(false);
  });
});

// ─── filterObject ─────────────────────────────────────────────────────────────

describe('filterObject()', () => {
  it('returns only the requested top-level fields', () => {
    const obj = { id: 1, amount: 50, status: 'completed', internalCode: 'X' };
    const result = filterObject(obj, [['id'], ['amount']]);
    expect(result).toEqual({ id: 1, amount: 50 });
    expect(result).not.toHaveProperty('status');
    expect(result).not.toHaveProperty('internalCode');
  });

  it('returns nested values using dot-notation segment arrays', () => {
    const obj = { id: 1, wallet: { address: 'GABC', balance: 100 } };
    const result = filterObject(obj, [['id'], ['wallet', 'address']]);
    expect(result).toEqual({ id: 1, wallet: { address: 'GABC' } });
    expect(result.wallet).not.toHaveProperty('balance');
  });

  it('omits a path when the value does not exist in the source object', () => {
    const obj = { id: 1 };
    const result = filterObject(obj, [['id'], ['nonexistent']]);
    expect(result).toEqual({ id: 1 });
    expect(result).not.toHaveProperty('nonexistent');
  });

  it('handles deeply nested paths', () => {
    const obj = { a: { b: { c: { d: 'deep' } } } };
    const result = filterObject(obj, [['a', 'b', 'c', 'd']]);
    expect(result).toEqual({ a: { b: { c: { d: 'deep' } } } });
  });

  it('returns null as-is (not an object)', () => {
    expect(filterObject(null, [['id']])).toBeNull();
  });

  it('returns undefined as-is', () => {
    expect(filterObject(undefined, [['id']])).toBeUndefined();
  });

  it('returns arrays as-is (not wrapped in object filter)', () => {
    const arr = [1, 2, 3];
    expect(filterObject(arr, [['id']])).toBe(arr);
  });

  it('returns a new object (does not mutate the source)', () => {
    const obj = { id: 1, name: 'test' };
    const result = filterObject(obj, [['id']]);
    expect(result).not.toBe(obj);
    expect(obj).toHaveProperty('name'); // original untouched
  });

  it('handles a path that traverses through a null intermediate', () => {
    const obj = { wallet: null };
    const result = filterObject(obj, [['wallet', 'address']]);
    // The nested path cannot be resolved; the parent key is omitted
    expect(result).not.toHaveProperty('wallet');
  });
});

// ─── applyFilter ─────────────────────────────────────────────────────────────

describe('applyFilter()', () => {
  const fieldPaths = [['id'], ['amount']];

  it('filters each item in a data array envelope', () => {
    const body = {
      success: true,
      data: [
        { id: 1, amount: 10, secret: 'shhh' },
        { id: 2, amount: 20, secret: 'shhh' },
      ],
    };
    const result = applyFilter(body, fieldPaths);
    expect(result.success).toBe(true);
    expect(result.data).toHaveLength(2);
    expect(result.data[0]).toEqual({ id: 1, amount: 10 });
    expect(result.data[1]).toEqual({ id: 2, amount: 20 });
  });

  it('filters a single object in a data envelope', () => {
    const body = {
      success: true,
      data: { id: 5, amount: 100, internalRef: 'X' },
    };
    const result = applyFilter(body, fieldPaths);
    expect(result.data).toEqual({ id: 5, amount: 100 });
    expect(result.data).not.toHaveProperty('internalRef');
  });

  it('preserves top-level envelope fields (success, count, meta)', () => {
    const body = {
      success: true,
      count: 2,
      meta: { page: 1 },
      data: [{ id: 1, amount: 5, status: 'ok' }],
    };
    const result = applyFilter(body, fieldPaths);
    expect(result.success).toBe(true);
    expect(result.count).toBe(2);
    expect(result.meta).toEqual({ page: 1 });
  });

  it('filters the body directly when there is no data envelope', () => {
    const body = { id: 7, amount: 77, status: 'pending' };
    const result = applyFilter(body, fieldPaths);
    expect(result).toEqual({ id: 7, amount: 77 });
    expect(result).not.toHaveProperty('status');
  });

  it('passes non-object bodies through unchanged', () => {
    expect(applyFilter(null, fieldPaths)).toBeNull();
    expect(applyFilter('string', fieldPaths)).toBe('string');
    expect(applyFilter(42, fieldPaths)).toBe(42);
  });

  it('handles a body with data: null gracefully', () => {
    const body = { success: true, data: null };
    const result = applyFilter(body, fieldPaths);
    expect(result.data).toBeNull();
  });
});

// ─── fieldFilterMiddleware — pass-through paths ───────────────────────────────

describe('fieldFilterMiddleware() — pass-through', () => {
  it('calls next() immediately when no ?fields param is present', async () => {
    const { nextCalled } = await runMiddleware(undefined);
    expect(nextCalled).toBe(true);
  });

  it('calls next() when ?fields is an empty string', async () => {
    const { nextCalled } = await runMiddleware('');
    expect(nextCalled).toBe(true);
  });

  it('calls next() when ?fields is whitespace only', async () => {
    const { nextCalled } = await runMiddleware('   ');
    expect(nextCalled).toBe(true);
  });

  it('does NOT set X-Fields-Applied header when pass-through occurs', async () => {
    const { captured } = await runMiddleware(undefined);
    expect(captured.headers['X-Fields-Applied']).toBeUndefined();
  });
});

// ─── fieldFilterMiddleware — validation errors ────────────────────────────────

describe('fieldFilterMiddleware() — validation errors', () => {
  it('returns 400 for a field path with injection characters', async () => {
    const { captured, nextCalled } = await runMiddleware('id;DROP TABLE users');
    expect(nextCalled).toBe(false);
    expect(captured.status).toBe(400);
    expect(captured.body.success).toBe(false);
    expect(captured.body.error.code).toBe('INVALID_FIELD_PATH');
  });

  it('returns 400 for a field path with spaces', async () => {
    const { captured, nextCalled } = await runMiddleware('id,bad field');
    expect(nextCalled).toBe(false);
    expect(captured.status).toBe(400);
  });

  it('returns 400 for a path with an empty segment (trailing dot)', async () => {
    const { captured, nextCalled } = await runMiddleware('wallet.');
    expect(nextCalled).toBe(false);
    expect(captured.status).toBe(400);
  });

  it('returns 400 for a leading-dot path', async () => {
    const { captured, nextCalled } = await runMiddleware('.secret');
    expect(nextCalled).toBe(false);
    expect(captured.status).toBe(400);
  });

  // BLOCKED_FIELDS
  it('returns 400 when "password" is requested via ?fields', async () => {
    const { captured, nextCalled } = await runMiddleware('password');
    expect(nextCalled).toBe(false);
    expect(captured.status).toBe(400);
    expect(captured.body.error.code).toBe('INVALID_FIELD_PATH');
    expect(captured.body.error.message).toMatch(/password/);
  });

  it('returns 400 when "secret" is requested via ?fields', async () => {
    const { captured, nextCalled } = await runMiddleware('secret');
    expect(nextCalled).toBe(false);
    expect(captured.status).toBe(400);
  });

  it('returns 400 when "privateKey" is requested via ?fields', async () => {
    const { captured, nextCalled } = await runMiddleware('privateKey');
    expect(nextCalled).toBe(false);
    expect(captured.status).toBe(400);
  });

  it('returns 400 when "secretKey" is requested via ?fields', async () => {
    const { captured, nextCalled } = await runMiddleware('secretKey');
    expect(nextCalled).toBe(false);
    expect(captured.status).toBe(400);
  });

  it('returns 400 even when a blocked field is mixed with valid ones', async () => {
    const { captured, nextCalled } = await runMiddleware('id,password,amount');
    expect(nextCalled).toBe(false);
    expect(captured.status).toBe(400);
  });
});

// ─── fieldFilterMiddleware — filtering behaviour ──────────────────────────────

describe('fieldFilterMiddleware() — filtering behaviour', () => {
  it('strips unrequested top-level fields from the response', async () => {
    const { nextCalled, res } = await runMiddleware('id,amount');
    expect(nextCalled).toBe(true);

    // Call the wrapped res.json to trigger filtering
    res.json({ id: 1, amount: 50, status: 'pending', internalCode: 'X' });
    expect(res._captured.body).toEqual({ id: 1, amount: 50 });
    expect(res._captured.body).not.toHaveProperty('status');
    expect(res._captured.body).not.toHaveProperty('internalCode');
  });

  it('sets X-Fields-Applied: true when filtering is active', async () => {
    const { res } = await runMiddleware('id');
    res.json({ id: 1, amount: 50 });
    expect(res._captured.headers['X-Fields-Applied']).toBe('true');
  });

  it('filters nested fields using dot notation', async () => {
    const { res } = await runMiddleware('id,wallet.address');

    res.json({
      id: 1,
      wallet: { address: 'GABC', balance: 100, privateKey: 'should-not-appear' },
      amount: 50,
    });

    expect(res._captured.body.id).toBe(1);
    expect(res._captured.body.wallet).toEqual({ address: 'GABC' });
    expect(res._captured.body.wallet).not.toHaveProperty('balance');
    expect(res._captured.body.wallet).not.toHaveProperty('privateKey');
    expect(res._captured.body).not.toHaveProperty('amount');
  });

  it('filters items inside a data array envelope', async () => {
    const { res } = await runMiddleware('id,status');

    res.json({
      success: true,
      data: [
        { id: 1, status: 'active', secret: 'hidden' },
        { id: 2, status: 'pending', secret: 'hidden' },
      ],
    });

    const { body } = res._captured;
    expect(body.success).toBe(true);
    expect(body.data).toHaveLength(2);
    expect(body.data[0]).toEqual({ id: 1, status: 'active' });
    expect(body.data[1]).toEqual({ id: 2, status: 'pending' });
  });

  it('filters a data object envelope', async () => {
    const { res } = await runMiddleware('id,name');

    res.json({
      success: true,
      data: { id: 99, name: 'Alice', internalId: 'XYZZY' },
    });

    const { body } = res._captured;
    expect(body.data).toEqual({ id: 99, name: 'Alice' });
    expect(body.data).not.toHaveProperty('internalId');
  });

  it('handles multiple comma-separated fields', async () => {
    const { res } = await runMiddleware('id,amount,status,createdAt');

    res.json({ id: 3, amount: 10, status: 'ok', createdAt: '2024-01-01', extra: 'drop' });

    expect(res._captured.body).toEqual({
      id: 3,
      amount: 10,
      status: 'ok',
      createdAt: '2024-01-01',
    });
  });

  it('handles a single requested field', async () => {
    const { res } = await runMiddleware('id');
    res.json({ id: 7, name: 'Bob', amount: 100 });
    expect(res._captured.body).toEqual({ id: 7 });
  });

  it('returns an empty object when none of the requested fields exist in the response', async () => {
    const { res } = await runMiddleware('nonexistent,alsoMissing');
    res.json({ id: 1, amount: 50 });
    expect(res._captured.body).toEqual({});
  });
});

// ─── Security: blocked fields are never included in filtered output ───────────

describe('Security: blocked fields never appear in filtered output', () => {
  it('a request for valid fields never surfaces the password field', async () => {
    const { res } = await runMiddleware('id,name');

    res.json({ id: 1, name: 'Alice', password: 'hunter2' });

    // password was not requested and should not be in the output
    expect(res._captured.body).not.toHaveProperty('password');
    expect(res._captured.body).toEqual({ id: 1, name: 'Alice' });
  });

  it('a request for valid nested fields never surfaces sibling blocked fields', async () => {
    const { res } = await runMiddleware('id,user.name');

    res.json({
      id: 1,
      user: { name: 'Bob', password: 'secret123' },
    });

    expect(res._captured.body.user).toEqual({ name: 'Bob' });
    expect(res._captured.body.user).not.toHaveProperty('password');
  });
});
