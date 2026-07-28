'use strict';

/**
 * Tests for request signing feature (issue #311).
 *
 * Covers:
 *  - sign() / verify() unit tests
 *  - Replay attack prevention (expired timestamps)
 *  - Tampered payload detection
 *  - Constant-time comparison (no timing oracle)
 *  - Middleware integration: signing_required keys rejected without valid sig
 *  - Middleware integration: keys without signing_required work without sig
 *  - Client SDK example produces valid signatures
 */

const crypto = require('crypto');
const request = require('supertest');

const { sign, verify, hashBody, buildCanonicalString, SIGNATURE_MAX_AGE_MS } = require('../../src/utils/requestSigner');
const apiKeysModel = require('../../src/models/apiKeys');
const db = require('../../src/utils/database');

// ─── helpers ────────────────────────────────────────────────────────────────

function nowSec() { return Math.floor(Date.now() / 1000); }

function makeSecret() { return crypto.randomBytes(32).toString('hex'); }

// Build a valid signed header set
function buildHeaders(secret, method, path, body = '') {
  const timestamp = String(nowSec());
  const { signature } = sign({ secret, method, path, timestamp, body });
  return { 'x-timestamp': timestamp, 'x-signature': signature };
}

// ─── Unit: hashBody ──────────────────────────────────────────────────────────

describe('hashBody', () => {
  it('returns consistent hex digest for same input', () => {
    const h1 = hashBody('hello');
    const h2 = hashBody('hello');
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
  });

  it('treats empty string and undefined as the same', () => {
    expect(hashBody('')).toBe(hashBody(undefined));
  });

  it('produces different hashes for different inputs', () => {
    expect(hashBody('a')).not.toBe(hashBody('b'));
  });
});

// ─── Unit: buildCanonicalString ──────────────────────────────────────────────

describe('buildCanonicalString', () => {
  it('joins parts with newlines', () => {
    const s = buildCanonicalString('POST', '/donations', '1700000000', 'abc123');
    expect(s).toBe('POST\n/donations\n1700000000\nabc123');
  });

  it('uppercases the method', () => {
    const s = buildCanonicalString('post', '/x', '1', 'h');
    expect(s.startsWith('POST\n')).toBe(true);
  });
});

// ─── Unit: sign ─────────────────────────────────────────────────────────────

describe('sign', () => {
  const secret = makeSecret();

  it('returns a hex signature and the same timestamp', () => {
    const ts = String(nowSec());
    const result = sign({ secret, method: 'POST', path: '/donations', timestamp: ts, body: '{}' });
    expect(result.signature).toMatch(/^[0-9a-f]{64}$/);
    expect(result.timestamp).toBe(ts);
  });

  it('produces different signatures for different methods', () => {
    const ts = String(nowSec());
    const a = sign({ secret, method: 'GET',  path: '/x', timestamp: ts });
    const b = sign({ secret, method: 'POST', path: '/x', timestamp: ts });
    expect(a.signature).not.toBe(b.signature);
  });

  it('produces different signatures for different paths', () => {
    const ts = String(nowSec());
    const a = sign({ secret, method: 'GET', path: '/a', timestamp: ts });
    const b = sign({ secret, method: 'GET', path: '/b', timestamp: ts });
    expect(a.signature).not.toBe(b.signature);
  });

  it('produces different signatures for different bodies', () => {
    const ts = String(nowSec());
    const a = sign({ secret, method: 'POST', path: '/x', timestamp: ts, body: '{"a":1}' });
    const b = sign({ secret, method: 'POST', path: '/x', timestamp: ts, body: '{"a":2}' });
    expect(a.signature).not.toBe(b.signature);
  });

  it('produces different signatures for different secrets', () => {
    const ts = String(nowSec());
    const a = sign({ secret: makeSecret(), method: 'POST', path: '/x', timestamp: ts });
    const b = sign({ secret: makeSecret(), method: 'POST', path: '/x', timestamp: ts });
    expect(a.signature).not.toBe(b.signature);
  });
});

// ─── Unit: verify ────────────────────────────────────────────────────────────

describe('verify', () => {
  const secret = makeSecret();

  it('returns valid=true for a correctly signed request', () => {
    const ts = String(nowSec());
    const { signature } = sign({ secret, method: 'POST', path: '/donations', timestamp: ts, body: '{}' });
    const result = verify({ secret, method: 'POST', path: '/donations', timestamp: ts, signature, body: '{}' });
    expect(result.valid).toBe(true);
  });

  it('returns valid=false when signature is missing', () => {
    const ts = String(nowSec());
    const result = verify({ secret, method: 'GET', path: '/x', timestamp: ts, signature: undefined });
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/missing/i);
  });

  it('returns valid=false when timestamp is missing', () => {
    const result = verify({ secret, method: 'GET', path: '/x', timestamp: undefined, signature: 'abc' });
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/missing/i);
  });

  it('returns valid=false for a tampered body', () => {
    const ts = String(nowSec());
    const { signature } = sign({ secret, method: 'POST', path: '/donations', timestamp: ts, body: '{"amount":"10"}' });
    const result = verify({ secret, method: 'POST', path: '/donations', timestamp: ts, signature, body: '{"amount":"999"}' });
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/mismatch/i);
  });

  it('returns valid=false for a tampered path', () => {
    const ts = String(nowSec());
    const { signature } = sign({ secret, method: 'POST', path: '/donations', timestamp: ts });
    const result = verify({ secret, method: 'POST', path: '/wallets', timestamp: ts, signature });
    expect(result.valid).toBe(false);
  });

  it('returns valid=false for a tampered method', () => {
    const ts = String(nowSec());
    const { signature } = sign({ secret, method: 'POST', path: '/x', timestamp: ts });
    const result = verify({ secret, method: 'GET', path: '/x', timestamp: ts, signature });
    expect(result.valid).toBe(false);
  });

  it('returns valid=false for a wrong secret', () => {
    const ts = String(nowSec());
    const { signature } = sign({ secret, method: 'POST', path: '/x', timestamp: ts });
    const result = verify({ secret: makeSecret(), method: 'POST', path: '/x', timestamp: ts, signature });
    expect(result.valid).toBe(false);
  });

  // ── Replay attack prevention ──────────────────────────────────────────────

  it('rejects a timestamp older than 5 minutes', () => {
    const oldTs = String(nowSec() - 301); // 5 min + 1 sec ago
    const { signature } = sign({ secret, method: 'GET', path: '/x', timestamp: oldTs });
    const result = verify({ secret, method: 'GET', path: '/x', timestamp: oldTs, signature });
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/expired/i);
  });

  it('accepts a timestamp exactly at the boundary (4m59s old)', () => {
    const ts = String(nowSec() - 299);
    const { signature } = sign({ secret, method: 'GET', path: '/x', timestamp: ts });
    const result = verify({ secret, method: 'GET', path: '/x', timestamp: ts, signature });
    expect(result.valid).toBe(true);
  });

  it('rejects a timestamp more than 30s in the future', () => {
    const futureTs = String(nowSec() + 60);
    const { signature } = sign({ secret, method: 'GET', path: '/x', timestamp: futureTs });
    const result = verify({ secret, method: 'GET', path: '/x', timestamp: futureTs, signature });
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/expired|future/i);
  });

  it('rejects a non-numeric timestamp', () => {
    const result = verify({ secret, method: 'GET', path: '/x', timestamp: 'not-a-number', signature: 'abc' });
    expect(result.valid).toBe(false);
  });

  it('supports nowMs override for deterministic testing', () => {
    const fixedNow = 1700000000000; // ms
    const ts = String(Math.floor(fixedNow / 1000));
    const { signature } = sign({ secret, method: 'GET', path: '/x', timestamp: ts });
    // 1 second later — still valid
    const result = verify({ secret, method: 'GET', path: '/x', timestamp: ts, signature, nowMs: fixedNow + 1000 });
    expect(result.valid).toBe(true);
    // 6 minutes later — expired
    const expired = verify({ secret, method: 'GET', path: '/x', timestamp: ts, signature, nowMs: fixedNow + 6 * 60 * 1000 });
    expect(expired.valid).toBe(false);
  });

  // ── Constant-time comparison ──────────────────────────────────────────────

  it('does not short-circuit on first byte mismatch (constant-time)', () => {
    // We cannot measure timing in unit tests, but we can verify that a
    // signature of wrong length is still rejected without throwing.
    const ts = String(nowSec());
    const result = verify({ secret, method: 'GET', path: '/x', timestamp: ts, signature: 'a' });
    expect(result.valid).toBe(false);
  });

  it('rejects an all-zero signature of correct length', () => {
    const ts = String(nowSec());
    const zeroSig = '0'.repeat(64);
    const result = verify({ secret, method: 'GET', path: '/x', timestamp: ts, signature: zeroSig });
    expect(result.valid).toBe(false);
  });
});

// ─── Integration: middleware ─────────────────────────────────────────────────

describe('requireApiKey middleware with signing_required', () => {
  let app;
  let signingKey;    // raw key value
  let signingSecret; // key secret for HMAC
  let normalKey;     // key without signing_required

  beforeAll(async () => {
    await db.run(`
      CREATE TABLE IF NOT EXISTS api_keys (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        key_hash TEXT NOT NULL UNIQUE,
        key_prefix TEXT NOT NULL,
        name TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'user',
        status TEXT NOT NULL DEFAULT 'active',
        created_by TEXT,
        metadata TEXT,
        expires_at INTEGER,
        last_used_at INTEGER,
        deprecated_at INTEGER,
        revoked_at INTEGER,
        created_at INTEGER NOT NULL,
        grace_period_days INTEGER NOT NULL DEFAULT 30,
        rotated_to_id INTEGER,
        signing_required INTEGER NOT NULL DEFAULT 0,
        key_secret TEXT
      )
    `);
    // Ensure new columns exist on pre-existing tables (idempotent)
    for (const stmt of [
      `ALTER TABLE api_keys ADD COLUMN signing_required INTEGER NOT NULL DEFAULT 0`,
      `ALTER TABLE api_keys ADD COLUMN key_secret TEXT`,
    ]) {
      try { await db.run(stmt); } catch (_) { /* column already exists */ }
    }

    const signingKeyInfo = await apiKeysModel.createApiKey({
      name: 'Signing Test Key',
      role: 'user',
      createdBy: 'signing-test',
      signingRequired: true,
    });
    signingKey = signingKeyInfo.key;
    signingSecret = signingKeyInfo.keySecret;

    const normalKeyInfo = await apiKeysModel.createApiKey({
      name: 'Normal Test Key',
      role: 'user',
      createdBy: 'signing-test',
      signingRequired: false,
    });
    normalKey = normalKeyInfo.key;

    // Build a minimal express app with the middleware and a test route
    const express = require('express');
    const requireApiKey = require('../../src/middleware/apiKey');
    app = express();
    app.use(express.json({
      verify: (req, _res, buf) => { req.rawBody = buf.toString('utf8'); }
    }));
    app.get('/test', requireApiKey, (req, res) => res.json({ ok: true }));
    app.post('/test', requireApiKey, (req, res) => res.json({ ok: true }));
  });

  afterAll(async () => {
    await db.run(`DELETE FROM api_keys WHERE created_by = 'signing-test'`);
  });

  it('rejects request to signing_required key with no signature headers', async () => {
    const res = await request(app)
      .get('/test')
      .set('x-api-key', signingKey);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_SIGNATURE');
  });

  it('rejects request with expired timestamp', async () => {
    const oldTs = String(nowSec() - 400);
    const { signature } = sign({ secret: signingSecret, method: 'GET', path: '/test', timestamp: oldTs });
    const res = await request(app)
      .get('/test')
      .set('x-api-key', signingKey)
      .set('x-timestamp', oldTs)
      .set('x-signature', signature);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_SIGNATURE');
  });

  it('rejects request with tampered body', async () => {
    const ts = String(nowSec());
    const originalBody = JSON.stringify({ amount: '10' });
    const { signature } = sign({ secret: signingSecret, method: 'POST', path: '/test', timestamp: ts, body: originalBody });
    const res = await request(app)
      .post('/test')
      .set('x-api-key', signingKey)
      .set('x-timestamp', ts)
      .set('x-signature', signature)
      .set('Content-Type', 'application/json')
      .send({ amount: '999' }); // different body
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_SIGNATURE');
  });

  it('rejects request with wrong secret', async () => {
    const ts = String(nowSec());
    const { signature } = sign({ secret: makeSecret(), method: 'GET', path: '/test', timestamp: ts });
    const res = await request(app)
      .get('/test')
      .set('x-api-key', signingKey)
      .set('x-timestamp', ts)
      .set('x-signature', signature);
    expect(res.status).toBe(401);
  });

  it('accepts a correctly signed GET request', async () => {
    const ts = String(nowSec());
    const { signature } = sign({ secret: signingSecret, method: 'GET', path: '/test', timestamp: ts });
    const nonce = crypto.randomBytes(16).toString('hex');
    const res = await request(app)
      .get('/test')
      .set('x-api-key', signingKey)
      .set('x-timestamp', ts)
      .set('x-signature', signature)
      .set('x-nonce', nonce);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('accepts a correctly signed POST request with body', async () => {
    const body = JSON.stringify({ amount: '10' });
    const ts = String(nowSec());
    const { signature } = sign({ secret: signingSecret, method: 'POST', path: '/test', timestamp: ts, body });
    const nonce = crypto.randomBytes(16).toString('hex');
    const res = await request(app)
      .post('/test')
      .set('x-api-key', signingKey)
      .set('x-timestamp', ts)
      .set('x-signature', signature)
      .set('x-nonce', nonce)
      .set('Content-Type', 'application/json')
      .send(body);
    expect(res.status).toBe(200);
  });

  it('allows normal key (signing_required=false) without any signature headers', async () => {
    const res = await request(app)
      .get('/test')
      .set('x-api-key', normalKey);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('rejects missing API key entirely', async () => {
    const res = await request(app).get('/test');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('rejects invalid API key', async () => {
    const res = await request(app)
      .get('/test')
      .set('x-api-key', 'totally-invalid-key');
    expect(res.status).toBe(401);
  });
});

// ─── Integration: createApiKey with signingRequired ──────────────────────────

describe('createApiKey with signingRequired', () => {
  beforeAll(async () => {
    for (const stmt of [
      `ALTER TABLE api_keys ADD COLUMN signing_required INTEGER NOT NULL DEFAULT 0`,
      `ALTER TABLE api_keys ADD COLUMN key_secret TEXT`,
    ]) {
      try { await db.run(stmt); } catch (_) { /* already exists */ }
    }
  });

  afterAll(async () => {
    await db.run(`DELETE FROM api_keys WHERE created_by = 'signing-model-test'`);
  });

  it('creates a key with signingRequired=true and returns keySecret', async () => {
    const info = await apiKeysModel.createApiKey({
      name: 'Signing Model Test',
      role: 'user',
      createdBy: 'signing-model-test',
      signingRequired: true,
    });
    expect(info.signingRequired).toBe(true);
    expect(info.keySecret).toMatch(/^[0-9a-f]{64}$/);
  });

  it('creates a key with signingRequired=false by default', async () => {
    const info = await apiKeysModel.createApiKey({
      name: 'Normal Model Test',
      role: 'user',
      createdBy: 'signing-model-test',
    });
    expect(info.signingRequired).toBe(false);
  });

  it('validateApiKey returns signingRequired and keySecret', async () => {
    const created = await apiKeysModel.createApiKey({
      name: 'Validate Test',
      role: 'user',
      createdBy: 'signing-model-test',
      signingRequired: true,
    });
    const validated = await apiKeysModel.validateApiKey(created.key);
    expect(validated.signingRequired).toBe(true);
    expect(validated.keySecret).toBe(created.keySecret);
  });
});

// ─── Client SDK example ──────────────────────────────────────────────────────

describe('SignedApiClient (examples/signedClient.js)', () => {
  const SignedApiClient = require('../../examples/signedClient');

  it('produces a valid signature for a GET request', () => {
    const secret = makeSecret();
    const client = new SignedApiClient({ baseUrl: 'http://localhost:3000', apiKey: 'k', apiSecret: secret });
    const ts = String(nowSec());
    const sig = client._sign('GET', '/donations', ts, '');
    const result = verify({ secret, method: 'GET', path: '/donations', timestamp: ts, signature: sig });
    expect(result.valid).toBe(true);
  });

  it('produces a valid signature for a POST request with body', () => {
    const secret = makeSecret();
    const client = new SignedApiClient({ baseUrl: 'http://localhost:3000', apiKey: 'k', apiSecret: secret });
    const body = JSON.stringify({ amount: '10' });
    const ts = String(nowSec());
    const sig = client._sign('POST', '/donations', ts, body);
    const result = verify({ secret, method: 'POST', path: '/donations', timestamp: ts, signature: sig, body });
    expect(result.valid).toBe(true);
  });

  it('produces different signatures for different requests', () => {
    const secret = makeSecret();
    const client = new SignedApiClient({ baseUrl: 'http://localhost:3000', apiKey: 'k', apiSecret: secret });
    const ts = String(nowSec());
    const s1 = client._sign('GET', '/donations', ts, '');
    const s2 = client._sign('GET', '/wallets', ts, '');
    expect(s1).not.toBe(s2);
  });
});

// ─── SignedApiClient — real HTTP request() integration ────────────────────────
//
// These tests inject a mock fetch and exercise SignedApiClient end-to-end:
// they verify that the X-API-Key / X-Timestamp / X-Signature / X-Nonce
// headers are attached, the signature is valid for the canonical string the
// server would see, the body is JSON-serialized correctly, query params are
// appended, and the response is parsed as JSON.
describe('SignedApiClient (request() HTTP integration)', () => {
  const SignedApiClient = require('../../examples/signedClient');

  // Build a fake fetch that records every call and returns a configurable
  // response. Returns { fetch, getCalls } where getCalls() is an array of
  // { url, opts } pairs in invocation order.
  function makeMockFetch(responseFactory) {
    const calls = [];
    const mockFetch = async (url, opts) => {
      calls.push({ url, opts });
      return {
        status: 200,
        ok: true,
        url,
        headers: {
          get(name) { return name.toLowerCase() === 'content-type' ? 'application/json' : null; },
          forEach(cb) { cb('application/json', 'content-type'); },
        },
        json: async () => responseFactory(calls),
        text: async () => JSON.stringify(responseFactory(calls)),
      };
    };
    return { fetch: mockFetch, getCalls: () => calls };
  }

  // Convenience: assert the first mock call has the expected property. Helps
  // avoid subtle bugs where `getCalls[0]` accesses a character index on the
  // function rather than the first invocation.
  function firstCall(getCalls) {
    const arr = getCalls();
    expect(arr.length).toBeGreaterThan(0);
    return arr[0];
  }

  it('sends GET with signed headers and a signature the server can verify', async () => {
    const secret = makeSecret();
    const apiKey = 'k_test';
    const { fetch: mockFetch, getCalls } = makeMockFetch(() => ({ ok: true }));

    const client = new SignedApiClient({
      baseUrl: 'http://localhost:3000/api/v1',
      apiKey,
      apiSecret: secret,
      fetch: mockFetch,
    });
    await client.get('/donations/recent?limit=5');

    const calls = getCalls();
    expect(calls).toHaveLength(1);
    const call = calls[0];

    // The full URL should include the mount prefix and the literal query string.
    expect(call.url).toBe('http://localhost:3000/api/v1/donations/recent?limit=5');

    // All 4 required signing headers must be attached.
    expect(call.opts.method).toBe('GET');
    expect(call.opts.headers['X-API-Key']).toBe(apiKey);
    expect(call.opts.headers['X-Timestamp']).toMatch(/^\d{10}$/);
    expect(call.opts.headers['X-Signature']).toMatch(/^[0-9a-f]{64}$/);
    expect(call.opts.headers['X-Nonce']).toBeDefined();
    expect(typeof call.opts.headers['X-Nonce']).toBe('string');
    expect(call.opts.headers['X-Nonce'].length).toBeGreaterThanOrEqual(8);

    // Signature must be valid for what the server would see as req.originalUrl.
    const result = verify({
      secret,
      method: 'GET',
      path: '/api/v1/donations/recent?limit=5',
      timestamp: call.opts.headers['X-Timestamp'],
      signature: call.opts.headers['X-Signature'],
    });
    expect(result.valid).toBe(true);
  });

  it('JSON-serializes a POST body and signs the exact raw bytes', async () => {
    const secret = makeSecret();
    const { fetch: mockFetch, getCalls } = makeMockFetch(() => ({ success: true }));
    const client = new SignedApiClient({
      baseUrl: 'http://localhost:3000/api/v1',
      apiKey: 'k',
      apiSecret: secret,
      fetch: mockFetch,
    });

    const body = { recipientId: 'Gr…', senderId: 'Ga…', amount: '10' };
    await client.post('/donations', body);

    const call = getCalls()[0];
    expect(call.opts.method).toBe('POST');
    expect(call.opts.headers['Content-Type']).toBe('application/json');
    expect(call.opts.body).toBe(JSON.stringify(body));

    // The signature must be computed over the exact raw body the server receives.
    const result = verify({
      secret,
      method: 'POST',
      path: '/api/v1/donations',
      timestamp: call.opts.headers['X-Timestamp'],
      signature: call.opts.headers['X-Signature'],
      body: JSON.stringify(body),
    });
    expect(result.valid).toBe(true);
  });

  it('appends query parameters via opts.query and signs the resulting path+query', async () => {
    const secret = makeSecret();
    const { fetch: mockFetch, getCalls } = makeMockFetch(() => []);
    const client = new SignedApiClient({
      baseUrl: 'http://localhost:3000/api/v1',
      apiKey: 'k',
      apiSecret: secret,
      fetch: mockFetch,
    });
    await client.get('/donations/recent', { query: { limit: 10, type: 'gift' } });

    const call = getCalls()[0];
    // URL.searchParams sorts by insertion order; here we inserted limit first.
    expect(call.url).toContain('http://localhost:3000/api/v1/donations/recent');
    expect(call.url).toContain('limit=10');
    expect(call.url).toContain('type=gift');

    const result = verify({
      secret,
      method: 'GET',
      path: call.url.replace('http://localhost:3000', ''),
      timestamp: call.opts.headers['X-Timestamp'],
      signature: call.opts.headers['X-Signature'],
    });
    expect(result.valid).toBe(true);
  });

  it('returns parsed JSON data and a status flag', async () => {
    const payload = { success: true, data: { id: 1 } };
    const { fetch: mockFetch } = makeMockFetch(() => payload);
    const client = new SignedApiClient({
      baseUrl: 'http://localhost:3000/api/v1',
      apiKey: 'k',
      apiSecret: makeSecret(),
      fetch: mockFetch,
    });
    const res = await client.get('/wallets');
    expect(res.status).toBe(200);
    expect(res.ok).toBe(true);
    expect(res.data).toEqual(payload);
  });

  it('rejects unsupported HTTP methods', async () => {
    const { fetch: mockFetch, getCalls } = makeMockFetch(() => ({}));
    const client = new SignedApiClient({
      baseUrl: 'http://localhost:3000/api/v1',
      apiKey: 'k',
      apiSecret: makeSecret(),
      fetch: mockFetch,
    });
    await expect(client.request('FOO', '/x')).rejects.toThrow(/unsupported/i);
    expect(getCalls()).toHaveLength(0);
  });

  it('supports the convenience wrappers get/post/put/patch/delete/head', async () => {
    const { fetch: mockFetch, getCalls } = makeMockFetch(() => ({}));
    const client = new SignedApiClient({
      baseUrl: 'http://localhost:3000/api/v1',
      apiKey: 'k',
      apiSecret: makeSecret(),
      fetch: mockFetch,
    });
    await client.get('/a');
    await client.post('/a', { x: 1 });
    await client.put('/a', { x: 2 });
    await client.patch('/a', { x: 3 });
    await client.delete('/a');
    await client.head('/a');
    expect(getCalls().map((c) => c.opts.method)).toEqual(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']);
  });

  it('generates a fresh nonce for each request (replay protection)', async () => {
    const { fetch: mockFetch, getCalls } = makeMockFetch(() => ({}));
    const client = new SignedApiClient({
      baseUrl: 'http://localhost:3000/api/v1',
      apiKey: 'k',
      apiSecret: makeSecret(),
      fetch: mockFetch,
    });
    await client.get('/a');
    await client.get('/a');
    const [a, b] = getCalls().map((c) => c.opts.headers['X-Nonce']);
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    expect(a).not.toBe(b);
  });

  it('allows custom defaultHeaders and a custom nonce generator (for deterministic tests)', async () => {
    let counter = 0;
    const { fetch: mockFetch, getCalls } = makeMockFetch(() => ({}));
    const client = new SignedApiClient({
      baseUrl: 'http://localhost:3000/api/v1',
      apiKey: 'k',
      apiSecret: makeSecret(),
      fetch: mockFetch,
      defaultHeaders: { 'X-Demo-Header': 'demo' },
      generateNonce: () => `nonce-${++counter}`,
    });
    await client.get('/a');
    const call = getCalls()[0];
    expect(call.opts.headers['X-Demo-Header']).toBe('demo');
    expect(call.opts.headers['X-Nonce']).toBe('nonce-1');
  });
});
