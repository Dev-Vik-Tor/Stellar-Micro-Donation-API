const express = require('express');
const request = require('supertest');
const Database = require('../../src/utils/database');
const corsMiddleware = require('../../src/middleware/cors');

describe('CORS Allowlist Rules Integration (Issue #1324)', () => {
  let app;

  beforeAll(async () => {
    await Database.run(`
      CREATE TABLE IF NOT EXISTS cors_rules (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        origin      TEXT    NOT NULL UNIQUE,
        active      INTEGER NOT NULL DEFAULT 1,
        description TEXT,
        createdAt   DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `, []);
  });

  beforeEach(async () => {
    corsMiddleware.invalidateCache();
    await Database.run('DELETE FROM cors_rules').catch(() => {});
    app = express();
    app.use(express.json());
    // Bypass auth guards for testing admin route
    app.use((req, res, next) => {
      req.user = { role: 'admin' };
      req.apiKey = { role: 'admin' };
      next();
    });
    app.use('/admin/cors/rules', require('../../src/routes/admin/corsRules'));
    app.use('/api', corsMiddleware.corsHandler, (req, res) => res.json({ ok: true }));
  });

  it('should allow CORS request after adding an origin via /admin/cors/rules', async () => {
    const origin = 'https://partner-portal.example.com';

    // Before adding rule: origin is not in allowlist
    const resBefore = await request(app)
      .get('/api/test')
      .set('Origin', origin);
    expect(resBefore.headers['access-control-allow-origin']).toBeUndefined();

    // Add CORS rule via admin API
    const createRes = await request(app)
      .post('/admin/cors/rules')
      .send({ origin, description: 'Partner web application' });
    expect(createRes.status).toBe(201);
    expect(createRes.body.success).toBe(true);

    // After adding rule: origin should now be permitted by CORS middleware
    const resAfter = await request(app)
      .get('/api/test')
      .set('Origin', origin);
    expect(resAfter.headers['access-control-allow-origin']).toBe(origin);
  });
});
