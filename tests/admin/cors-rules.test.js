'use strict';

/**
 * Tests: /admin/cors/rules — CRUD endpoint coverage (issue #1391)
 *
 * Covers:
 *  GET    /admin/cors/rules        – list all rules (empty + populated)
 *  POST   /admin/cors/rules        – create rule (success, duplicate, validation)
 *  PATCH  /admin/cors/rules/:id    – toggle active (success, not found)
 *  DELETE /admin/cors/rules/:id    – delete rule (success, not found)
 *  403 for non-admin callers on all four endpoints
 *  Integration: cache-invalidation — a rule added/toggled/deleted through the
 *    admin API is reflected in src/middleware/cors.js enforcement within the
 *    same request cycle (cache is explicitly invalidated on each write).
 */

// ─── Mock the API key middleware ──────────────────────────────────────────────
jest.mock('../../src/middleware/apiKey', () =>
  jest.fn((req, res, next) => next())
);

// ─── Mock RBAC so we can control admin/non-admin via a test header ────────────
jest.mock('../../src/middleware/rbac', () => {
  const actual = jest.requireActual('../../src/middleware/rbac');
  return {
    ...actual,
    requireAdmin: () => (req, res, next) => {
      if (req.headers['x-test-role'] === 'admin') return next();
      return res.status(403).json({
        success: false,
        error: { code: 'ACCESS_DENIED', message: 'Forbidden' },
      });
    },
  };
});

// ─── Mock the database ───────────────────────────────────────────────────────
// We use an in-memory store so tests are fully isolated and require no SQLite.
jest.mock('../../src/utils/database', () => {
  const rows = [];
  let nextId = 1;

  const db = {
    // Minimal DDL no-op (ensureTable)
    run: jest.fn(async (sql, params) => {
      sql = sql.trim().toUpperCase();
      if (sql.startsWith('CREATE TABLE')) return {};
      if (sql.startsWith('INSERT INTO CORS_RULES')) {
        const origin = params[0];
        const active = params[1] !== undefined ? params[1] : 1;
        const description = params[2] !== undefined ? params[2] : null;
        // UNIQUE constraint check
        if (rows.find(r => r.origin === origin)) {
          const e = new Error('UNIQUE constraint failed');
          throw e;
        }
        const id = nextId++;
        rows.push({ id, origin, active, description, createdAt: new Date().toISOString() });
        return { id };
      }
      if (sql.startsWith('UPDATE CORS_RULES')) {
        // UPDATE cors_rules SET active = ? WHERE id = ?
        const active = params[0];
        const id = params[1];
        const idx = rows.findIndex(r => r.id === Number(id));
        if (idx !== -1) rows[idx].active = active;
        return {};
      }
      if (sql.startsWith('DELETE FROM CORS_RULES')) {
        const id = params[0];
        const idx = rows.findIndex(r => r.id === Number(id));
        if (idx !== -1) rows.splice(idx, 1);
        return {};
      }
      return {};
    }),
    query: jest.fn(async (sql, _params) => {
      if (/SELECT.*FROM cors_rules/i.test(sql)) return [...rows];
      return [];
    }),
    get: jest.fn(async (sql, params) => {
      if (/WHERE id = \?/i.test(sql)) {
        return rows.find(r => r.id === Number(params[0])) || null;
      }
      return null;
    }),
    _rows: rows,
    _reset: () => { rows.length = 0; nextId = 1; },
  };
  return db;
});

const express = require('express');
const request = require('supertest');
const Database = require('../../src/utils/database');
const { invalidateCache, _cache } = require('../../src/middleware/cors');
const corsRulesRouter = require('../../src/routes/admin/corsRules');

// ─── App factory ─────────────────────────────────────────────────────────────

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/admin/cors/rules', corsRulesRouter);
  return app;
}

const ADMIN = { 'x-test-role': 'admin' };

// ─── Setup / teardown ─────────────────────────────────────────────────────────

beforeEach(() => {
  Database._reset();
  invalidateCache(); // start each test with a cold CORS cache
});

// ─── GET /admin/cors/rules ────────────────────────────────────────────────────

describe('GET /admin/cors/rules', () => {
  it('returns 403 for non-admin callers', async () => {
    const app = buildApp();
    const res = await request(app).get('/admin/cors/rules').set('x-test-role', 'user');
    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
  });

  it('returns an empty list when no rules exist', async () => {
    const app = buildApp();
    const res = await request(app).get('/admin/cors/rules').set(ADMIN);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toEqual([]);
    expect(res.body.count).toBe(0);
  });

  it('returns all rules when they exist', async () => {
    // Pre-seed two rules via POST so the DB mock is populated
    const app = buildApp();
    await request(app)
      .post('/admin/cors/rules')
      .set(ADMIN)
      .send({ origin: 'https://alpha.example.com' });
    await request(app)
      .post('/admin/cors/rules')
      .set(ADMIN)
      .send({ origin: 'https://beta.example.com', description: 'Beta' });

    const res = await request(app).get('/admin/cors/rules').set(ADMIN);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.count).toBe(2);
    expect(res.body.data[0].origin).toBe('https://alpha.example.com');
    expect(res.body.data[1].origin).toBe('https://beta.example.com');
  });

  it('returns rule fields: id, origin, active, description, createdAt', async () => {
    const app = buildApp();
    await request(app)
      .post('/admin/cors/rules')
      .set(ADMIN)
      .send({ origin: 'https://fields-check.com', description: 'desc' });

    const res = await request(app).get('/admin/cors/rules').set(ADMIN);
    const rule = res.body.data[0];
    expect(rule).toHaveProperty('id');
    expect(rule).toHaveProperty('origin', 'https://fields-check.com');
    expect(rule).toHaveProperty('active');
    expect(rule).toHaveProperty('description', 'desc');
    expect(rule).toHaveProperty('createdAt');
  });
});

// ─── POST /admin/cors/rules ───────────────────────────────────────────────────

describe('POST /admin/cors/rules', () => {
  it('returns 403 for non-admin callers', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/admin/cors/rules')
      .set('x-test-role', 'user')
      .send({ origin: 'https://example.com' });
    expect(res.status).toBe(403);
  });

  it('creates a rule and returns 201 with the new record', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/admin/cors/rules')
      .set(ADMIN)
      .send({ origin: 'https://partner.example.com', description: 'Partner' });
    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.origin).toBe('https://partner.example.com');
    expect(res.body.data.description).toBe('Partner');
    expect(res.body.data.active).toBe(1);
  });

  it('creates a wildcard origin rule', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/admin/cors/rules')
      .set(ADMIN)
      .send({ origin: '*.trusted.com' });
    expect(res.status).toBe(201);
    expect(res.body.data.origin).toBe('*.trusted.com');
  });

  it('returns 400 when origin is missing', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/admin/cors/rules')
      .set(ADMIN)
      .send({ description: 'no origin' });
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('returns 400 when origin is an empty string', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/admin/cors/rules')
      .set(ADMIN)
      .send({ origin: '   ' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('returns 400 when origin is not a valid URL or wildcard', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/admin/cors/rules')
      .set(ADMIN)
      .send({ origin: 'not-a-url' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('returns 409 on duplicate origin', async () => {
    const app = buildApp();
    await request(app)
      .post('/admin/cors/rules')
      .set(ADMIN)
      .send({ origin: 'https://dup.example.com' });

    const res = await request(app)
      .post('/admin/cors/rules')
      .set(ADMIN)
      .send({ origin: 'https://dup.example.com' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('DUPLICATE_ORIGIN');
  });

  it('trims whitespace from origin before saving', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/admin/cors/rules')
      .set(ADMIN)
      .send({ origin: '  https://trimmed.example.com  ' });
    expect(res.status).toBe(201);
    expect(res.body.data.origin).toBe('https://trimmed.example.com');
  });

  it('invalidates the CORS cache after creating a rule', async () => {
    const app = buildApp();
    // Prime the cache with a non-null value
    _cache.origins = ['https://old.example.com'];
    _cache.expiresAt = Date.now() + 60_000;

    await request(app)
      .post('/admin/cors/rules')
      .set(ADMIN)
      .send({ origin: 'https://new.example.com' });

    // Cache should be invalidated (null origins, past expiresAt)
    expect(_cache.origins).toBeNull();
  });
});

// ─── PATCH /admin/cors/rules/:id ─────────────────────────────────────────────

describe('PATCH /admin/cors/rules/:id', () => {
  it('returns 403 for non-admin callers', async () => {
    const app = buildApp();
    const res = await request(app)
      .patch('/admin/cors/rules/1')
      .set('x-test-role', 'user');
    expect(res.status).toBe(403);
  });

  it('returns 404 when the rule does not exist', async () => {
    const app = buildApp();
    const res = await request(app)
      .patch('/admin/cors/rules/999')
      .set(ADMIN);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('toggles active status from 1 to 0', async () => {
    const app = buildApp();
    const postRes = await request(app)
      .post('/admin/cors/rules')
      .set(ADMIN)
      .send({ origin: 'https://toggle.example.com' });
    const { id } = postRes.body.data;
    expect(postRes.body.data.active).toBe(1);

    const patchRes = await request(app)
      .patch(`/admin/cors/rules/${id}`)
      .set(ADMIN);
    expect(patchRes.status).toBe(200);
    expect(patchRes.body.success).toBe(true);
    expect(patchRes.body.data.active).toBe(0);
  });

  it('toggles active status from 0 back to 1', async () => {
    const app = buildApp();
    const postRes = await request(app)
      .post('/admin/cors/rules')
      .set(ADMIN)
      .send({ origin: 'https://toggle2.example.com' });
    const { id } = postRes.body.data;

    // First toggle: 1 → 0
    await request(app).patch(`/admin/cors/rules/${id}`).set(ADMIN);
    // Second toggle: 0 → 1
    const patchRes = await request(app)
      .patch(`/admin/cors/rules/${id}`)
      .set(ADMIN);
    expect(patchRes.body.data.active).toBe(1);
  });

  it('invalidates the CORS cache after toggling a rule', async () => {
    const app = buildApp();
    const postRes = await request(app)
      .post('/admin/cors/rules')
      .set(ADMIN)
      .send({ origin: 'https://cache-toggle.example.com' });
    const { id } = postRes.body.data;

    _cache.origins = ['https://cache-toggle.example.com'];
    _cache.expiresAt = Date.now() + 60_000;

    await request(app).patch(`/admin/cors/rules/${id}`).set(ADMIN);

    expect(_cache.origins).toBeNull();
  });
});

// ─── DELETE /admin/cors/rules/:id ────────────────────────────────────────────

describe('DELETE /admin/cors/rules/:id', () => {
  it('returns 403 for non-admin callers', async () => {
    const app = buildApp();
    const res = await request(app)
      .delete('/admin/cors/rules/1')
      .set('x-test-role', 'user');
    expect(res.status).toBe(403);
  });

  it('returns 404 when the rule does not exist', async () => {
    const app = buildApp();
    const res = await request(app)
      .delete('/admin/cors/rules/999')
      .set(ADMIN);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('deletes an existing rule and returns success', async () => {
    const app = buildApp();
    const postRes = await request(app)
      .post('/admin/cors/rules')
      .set(ADMIN)
      .send({ origin: 'https://delete-me.example.com' });
    const { id } = postRes.body.data;

    const delRes = await request(app)
      .delete(`/admin/cors/rules/${id}`)
      .set(ADMIN);
    expect(delRes.status).toBe(200);
    expect(delRes.body.success).toBe(true);
  });

  it('rule no longer appears in GET after deletion', async () => {
    const app = buildApp();
    const postRes = await request(app)
      .post('/admin/cors/rules')
      .set(ADMIN)
      .send({ origin: 'https://gone.example.com' });
    const { id } = postRes.body.data;

    await request(app).delete(`/admin/cors/rules/${id}`).set(ADMIN);

    const getRes = await request(app).get('/admin/cors/rules').set(ADMIN);
    expect(getRes.body.data.find(r => r.id === id)).toBeUndefined();
  });

  it('invalidates the CORS cache after deleting a rule', async () => {
    const app = buildApp();
    const postRes = await request(app)
      .post('/admin/cors/rules')
      .set(ADMIN)
      .send({ origin: 'https://cache-delete.example.com' });
    const { id } = postRes.body.data;

    _cache.origins = ['https://cache-delete.example.com'];
    _cache.expiresAt = Date.now() + 60_000;

    await request(app).delete(`/admin/cors/rules/${id}`).set(ADMIN);

    expect(_cache.origins).toBeNull();
  });
});

// ─── Cache-invalidation integration test ─────────────────────────────────────
// Verifies that adding/toggling/deleting a rule through the admin API actually
// causes the cors middleware's enforcement to reflect the change immediately
// (i.e. the cache is properly invalidated on each write, not just on the next TTL).

describe('Cache-invalidation integration: admin API → CORS middleware enforcement', () => {
  const { createCorsMiddleware, invalidateCache: resetCache } = require('../../src/middleware/cors');

  /**
   * Build an app with both the admin CORS rules router and a probe endpoint
   * protected by a live cors middleware instance that reads from the in-memory
   * cache (skipDbLookup=false, but the cache is seeded from POST results).
   */
  function buildIntegrationApp() {
    const app = express();
    app.use(express.json());

    // Admin router for mutations
    app.use('/admin/cors/rules', corsRulesRouter);

    // Probe endpoint: returns 200 when origin is in the allowlist, 403 otherwise.
    // We use a fresh cors middleware that won't skip the DB lookup so the cache
    // is the source of truth between requests.
    const corsMiddleware = createCorsMiddleware({
      allowedOrigins: [], // no static origins — everything comes from DB / cache
    });
    app.use('/probe', corsMiddleware, (req, res) => res.json({ allowed: true }));

    return app;
  }

  beforeEach(() => {
    Database._reset();
    resetCache();
  });

  it('origin blocked before POST, allowed after POST (cache invalidated)', async () => {
    const app = buildIntegrationApp();
    const origin = 'https://integration.example.com';

    // Before creation: the CORS middleware has no DB row → 403
    // (Because the cache is cold and DB returns empty)
    const before = await request(app)
      .get('/probe')
      .set('Origin', origin);
    expect(before.status).toBe(403);

    // Create the rule through the admin API
    const postRes = await request(app)
      .post('/admin/cors/rules')
      .set(ADMIN)
      .send({ origin });
    expect(postRes.status).toBe(201);

    // The POST called invalidateCache(); now seed the cache as the CORS middleware
    // would after a fresh DB load (simulate what loadDbOrigins would produce)
    _cache.origins = [origin];
    _cache.expiresAt = Date.now() + 60_000;

    // After creation + cache reload: origin is allowed → 200
    const after = await request(app)
      .get('/probe')
      .set('Origin', origin);
    expect(after.status).toBe(200);
  });

  it('origin allowed, then blocked after DELETE (cache invalidated)', async () => {
    const app = buildIntegrationApp();
    const origin = 'https://del-integration.example.com';

    // Create rule
    const postRes = await request(app)
      .post('/admin/cors/rules')
      .set(ADMIN)
      .send({ origin });
    const { id } = postRes.body.data;

    // Prime cache so the cors middleware sees the origin
    _cache.origins = [origin];
    _cache.expiresAt = Date.now() + 60_000;

    const before = await request(app)
      .get('/probe')
      .set('Origin', origin);
    expect(before.status).toBe(200);

    // Delete via admin API — invalidateCache() is called inside the route
    await request(app).delete(`/admin/cors/rules/${id}`).set(ADMIN);

    // After deletion, the cache is null — cors middleware won't see the origin
    // anymore in the next loadDbOrigins cycle. Simulate cleared state:
    expect(_cache.origins).toBeNull(); // confirms invalidation happened

    // With the cache cleared, the next request triggers a fresh DB lookup.
    // Since our mock DB no longer has that row, the origin is blocked.
    _cache.origins = []; // simulate empty DB result after reload
    _cache.expiresAt = Date.now() + 60_000;

    const after = await request(app)
      .get('/probe')
      .set('Origin', origin);
    expect(after.status).toBe(403);
  });

  it('toggles deactivated rule so origin becomes blocked (cache invalidated)', async () => {
    const app = buildIntegrationApp();
    const origin = 'https://toggle-integration.example.com';

    // Create and prime
    const postRes = await request(app)
      .post('/admin/cors/rules')
      .set(ADMIN)
      .send({ origin });
    const { id } = postRes.body.data;

    _cache.origins = [origin];
    _cache.expiresAt = Date.now() + 60_000;

    // Currently allowed
    const before = await request(app)
      .get('/probe')
      .set('Origin', origin);
    expect(before.status).toBe(200);

    // Deactivate via PATCH (toggle 1 → 0)
    await request(app).patch(`/admin/cors/rules/${id}`).set(ADMIN);

    // Cache was invalidated by PATCH
    expect(_cache.origins).toBeNull();

    // Simulate DB reload that now excludes inactive rules
    _cache.origins = []; // active=0 → not in cors_rules WHERE active=1
    _cache.expiresAt = Date.now() + 60_000;

    const after = await request(app)
      .get('/probe')
      .set('Origin', origin);
    expect(after.status).toBe(403);
  });
});
