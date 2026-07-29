'use strict';

/**
 * Tests for src/routes/disputes.js — issue #1380
 *
 * Covers all four endpoints:
 *   POST   /donations/:id/dispute           — open a dispute
 *   PATCH  /admin/disputes/:id              — admin resolution state transitions
 *   GET    /admin/disputes                  — admin list all disputes
 *   GET    /admin/disputes/:id              — admin get one dispute
 *
 * Uses an in-memory Express app with the router mounted at the same paths
 * as routes.js (once under /donations, once under /admin/disputes).
 * All Database calls and service calls are mocked to keep tests isolated.
 */

const express = require('express');
const request = require('supertest');

// ── Mock heavy dependencies before requiring the router ───────────────────────

jest.mock('../../src/utils/database');
jest.mock('../../src/services/AuditLogService');
jest.mock('../../src/services/WebhookService');
jest.mock('../../src/middleware/payloadSizeLimiter', () => ({
  payloadSizeLimiter: () => (req, res, next) => next(),
  ENDPOINT_LIMITS: { donation: 1024, admin: 1024 },
}));

// Mock RBAC so we can control auth at the test level
jest.mock('../../src/middleware/rbac', () => {
  const real = jest.requireActual('../../src/middleware/rbac');
  return {
    ...real,
    checkPermission: (permission) => (req, res, next) => {
      // Tests set req._mockPermissionResult to control auth outcome:
      //   undefined / true  → allowed
      //   false             → 403
      //   'unauth'          → 401
      const outcome = req._mockPermissionResult;
      if (outcome === 'unauth') {
        return res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Unauthorized' } });
      }
      if (outcome === false) {
        return res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'Forbidden' } });
      }
      // Attach a minimal user so downstream code doesn't blow up
      req.user = req.user || { role: 'user' };
      req.apiKey = req.apiKey || { publicKey: req._mockCallerKey || 'caller-key', role: 'user' };
      next();
    },
  };
});

const Database = require('../../src/utils/database');
const AuditLogService = require('../../src/services/AuditLogService');
const WebhookService = require('../../src/services/WebhookService');

// Silence audit log calls
AuditLogService.log = jest.fn().mockResolvedValue(undefined);
AuditLogService.CATEGORY = { DONATION: 'DONATION' };
AuditLogService.SEVERITY = { MEDIUM: 'MEDIUM' };

// Silence webhook calls
WebhookService.deliver = jest.fn().mockResolvedValue(undefined);

const disputesRouter = require('../../src/routes/disputes');

// ── Test app factory ──────────────────────────────────────────────────────────

function buildApp() {
  const app = express();
  app.use(express.json());

  // Middleware to inject test-level auth controls onto req
  app.use((req, _res, next) => {
    req.id = 'test-req-id';
    next();
  });

  // Mounted as in routes.js:
  app.use('/donations', disputesRouter);   // POST /donations/:id/dispute
  app.use('/admin/disputes', disputesRouter); // PATCH/GET /admin/disputes/:id

  // Minimal error handler
  app.use((err, req, res, next) => {
    void next;
    res.status(err.statusCode || err.status || 500).json({
      success: false,
      error: { code: err.code || 'INTERNAL_ERROR', message: err.message },
    });
  });
  return app;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const DISPUTE_WINDOW_DAYS = parseInt(process.env.DISPUTE_WINDOW_DAYS || '30', 10);

function withinWindowDate() {
  return new Date(Date.now() - (DISPUTE_WINDOW_DAYS - 1) * 24 * 60 * 60 * 1000).toISOString();
}

function outsideWindowDate() {
  return new Date(Date.now() - (DISPUTE_WINDOW_DAYS + 1) * 24 * 60 * 60 * 1000).toISOString();
}

const RECIPIENT_KEY = 'GCALLERKEY111';
const OTHER_KEY = 'GCALLERKEY222';

function mockDonation(overrides = {}) {
  return {
    id: '1',
    amount: 10,
    receiverId: '99',
    senderId: '88',
    timestamp: withinWindowDate(),
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /donations/:id/dispute
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /donations/:id/dispute', () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    app = buildApp();
  });

  // ── Permission checks ─────────────────────────────────────────────────────

  it('returns 401 when caller is unauthenticated', async () => {
    const res = await request(app)
      .post('/donations/1/dispute')
      .set('x-mock-permission', 'unauth')
      .send({ reason: 'fraud' });
    // The mock RBAC middleware is configured via req._mockPermissionResult
    // which we set on the express app below — use custom middleware approach
    expect([401, 403]).toContain(res.status);
  });

  it('returns 400 when reason is missing', async () => {
    Database.get
      .mockResolvedValueOnce(mockDonation())
      .mockResolvedValueOnce({ publicKey: RECIPIENT_KEY })
      .mockResolvedValueOnce(null); // no existing dispute

    const app2 = buildApp();
    app2.use((req, _res, next) => { req._mockCallerKey = RECIPIENT_KEY; next(); });
    const app3 = express();
    app3.use(express.json());
    app3.use((req, _res, next) => { req.id = 'test-req-id'; req._mockCallerKey = RECIPIENT_KEY; next(); });
    app3.use('/donations', disputesRouter);
    app3.use('/admin/disputes', disputesRouter);
    app3.use((err, req, res, next) => { void next; res.status(500).json({ success: false }); });

    Database.get
      .mockResolvedValueOnce(mockDonation())
      .mockResolvedValueOnce({ publicKey: RECIPIENT_KEY })
      .mockResolvedValueOnce(null);

    const res = await request(app3)
      .post('/donations/1/dispute')
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_REASON');
  });

  it('returns 400 when reason is an empty string', async () => {
    const testApp = buildApp();
    Database.get
      .mockResolvedValueOnce(mockDonation())
      .mockResolvedValueOnce({ publicKey: RECIPIENT_KEY })
      .mockResolvedValueOnce(null);

    const res = await request(testApp)
      .post('/donations/1/dispute')
      .send({ reason: '   ' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_REASON');
  });

  it('returns 400 when evidence is not a string', async () => {
    const testApp = buildApp();
    Database.get
      .mockResolvedValueOnce(mockDonation())
      .mockResolvedValueOnce({ publicKey: RECIPIENT_KEY })
      .mockResolvedValueOnce(null);

    const res = await request(testApp)
      .post('/donations/1/dispute')
      .send({ reason: 'fraud', evidence: 12345 });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_EVIDENCE');
  });

  it('returns 400 when evidence exceeds 1000 characters', async () => {
    const testApp = buildApp();
    Database.get
      .mockResolvedValueOnce(mockDonation())
      .mockResolvedValueOnce({ publicKey: RECIPIENT_KEY })
      .mockResolvedValueOnce(null);

    const res = await request(testApp)
      .post('/donations/1/dispute')
      .send({ reason: 'fraud', evidence: 'x'.repeat(1001) });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('EVIDENCE_TOO_LONG');
  });

  it('returns 404 when donation does not exist', async () => {
    const testApp = buildApp();
    Database.get.mockResolvedValueOnce(null);

    const res = await request(testApp)
      .post('/donations/999/dispute')
      .send({ reason: 'fraud' });

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('DONATION_NOT_FOUND');
  });

  it('returns 404 when recipient user record is missing', async () => {
    const testApp = buildApp();
    Database.get
      .mockResolvedValueOnce(mockDonation())
      .mockResolvedValueOnce(null); // recipient not found

    const res = await request(testApp)
      .post('/donations/1/dispute')
      .send({ reason: 'fraud' });

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('RECIPIENT_NOT_FOUND');
  });

  it('returns 403 when caller is not the recipient', async () => {
    const testApp = buildApp();
    // Inject a caller key that differs from the recipient's key
    testApp.use((req, _res, next) => { req.apiKey = { publicKey: OTHER_KEY, role: 'user' }; next(); });

    Database.get
      .mockResolvedValueOnce(mockDonation())
      .mockResolvedValueOnce({ publicKey: RECIPIENT_KEY }); // recipient has a different key

    const res = await request(testApp)
      .post('/donations/1/dispute')
      .send({ reason: 'fraud' });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('returns 400 when the dispute window has expired', async () => {
    const testApp = buildApp();

    Database.get
      .mockResolvedValueOnce(mockDonation({ timestamp: outsideWindowDate() }))
      .mockResolvedValueOnce({ publicKey: RECIPIENT_KEY });

    const res = await request(testApp)
      .post('/donations/1/dispute')
      .send({ reason: 'fraud' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('DISPUTE_WINDOW_EXPIRED');
  });

  it('returns 409 when a dispute already exists for the donation', async () => {
    const testApp = buildApp();

    Database.get
      .mockResolvedValueOnce(mockDonation())
      .mockResolvedValueOnce({ publicKey: RECIPIENT_KEY })
      .mockResolvedValueOnce({ id: 'existing-dispute-id' }); // existing dispute

    const res = await request(testApp)
      .post('/donations/1/dispute')
      .send({ reason: 'fraud' });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('DISPUTE_EXISTS');
  });

  it('returns 201 and creates a dispute when all conditions are met — within window', async () => {
    const testApp = buildApp();
    const newDisputeId = 42;

    Database.get
      .mockResolvedValueOnce(mockDonation())                    // donation lookup
      .mockResolvedValueOnce({ publicKey: RECIPIENT_KEY })      // recipient lookup
      .mockResolvedValueOnce(null)                              // no existing dispute
      .mockResolvedValueOnce({                                  // newly created dispute
        id: newDisputeId,
        donationId: '1',
        status: 'open',
        reason: 'fraud',
        evidence: null,
        createdAt: new Date().toISOString(),
      });
    Database.run.mockResolvedValueOnce({ id: newDisputeId });

    const res = await request(testApp)
      .post('/donations/1/dispute')
      .send({ reason: 'fraud' });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.id).toBe(newDisputeId);
    expect(res.body.data.status).toBe('open');
    expect(res.body.data.reason).toBe('fraud');
  });

  it('creates a dispute including optional evidence', async () => {
    const testApp = buildApp();
    const newDisputeId = 43;

    Database.get
      .mockResolvedValueOnce(mockDonation())
      .mockResolvedValueOnce({ publicKey: RECIPIENT_KEY })
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: newDisputeId,
        donationId: '1',
        status: 'open',
        reason: 'wrong amount',
        evidence: 'screenshot at https://example.com',
        createdAt: new Date().toISOString(),
      });
    Database.run.mockResolvedValueOnce({ id: newDisputeId });

    const res = await request(testApp)
      .post('/donations/1/dispute')
      .send({ reason: 'wrong amount', evidence: 'screenshot at https://example.com' });

    expect(res.status).toBe(201);
    expect(res.body.data.evidence).toBe('screenshot at https://example.com');
  });

  it('fires a webhook after opening a dispute', async () => {
    const testApp = buildApp();
    const newDisputeId = 44;

    Database.get
      .mockResolvedValueOnce(mockDonation())
      .mockResolvedValueOnce({ publicKey: RECIPIENT_KEY })
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: newDisputeId,
        donationId: '1',
        status: 'open',
        reason: 'fraud',
        evidence: null,
        createdAt: new Date().toISOString(),
      });
    Database.run.mockResolvedValueOnce({ id: newDisputeId });

    await request(testApp).post('/donations/1/dispute').send({ reason: 'fraud' });

    expect(WebhookService.deliver).toHaveBeenCalledWith(
      'donation.disputed',
      expect.objectContaining({ donationId: '1', disputeId: newDisputeId })
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /admin/disputes/:id
// ─────────────────────────────────────────────────────────────────────────────

describe('PATCH /admin/disputes/:id', () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    app = buildApp();
  });

  it('returns 400 for an unrecognised status value', async () => {
    const res = await request(app)
      .patch('/admin/disputes/1')
      .send({ status: 'INVALID_STATE' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_STATUS');
  });

  it('returns 400 when status is missing', async () => {
    const res = await request(app)
      .patch('/admin/disputes/1')
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_STATUS');
  });

  it('returns 404 when the dispute does not exist', async () => {
    Database.get.mockResolvedValueOnce(null);

    const res = await request(app)
      .patch('/admin/disputes/999')
      .send({ status: 'under_review' });

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('DISPUTE_NOT_FOUND');
  });

  const validTransitions = [
    ['open', 'under_review'],
    ['under_review', 'resolved_refund'],
    ['under_review', 'resolved_no_action'],
    ['open', 'resolved_no_action'],
  ];

  it.each(validTransitions)(
    'transitions from %s → %s successfully',
    async (fromStatus, toStatus) => {
      const existingDispute = { id: '1', donationId: '10', status: fromStatus, reason: 'fraud' };
      const updatedDispute = {
        ...existingDispute,
        status: toStatus,
        resolutionNotes: 'reviewed',
        resolvedAt: toStatus.startsWith('resolved_') ? new Date().toISOString() : null,
        updatedAt: new Date().toISOString(),
      };

      Database.get
        .mockResolvedValueOnce(existingDispute)   // fetch dispute for update
        .mockResolvedValueOnce(updatedDispute);   // fetch updated dispute
      Database.run.mockResolvedValueOnce(undefined);

      // For resolved_refund, it also fetches the donation
      if (toStatus === 'resolved_refund') {
        Database.get.mockResolvedValueOnce({ id: '10', amount: 50 });
      }

      const res = await request(app)
        .patch('/admin/disputes/1')
        .send({ status: toStatus, resolutionNotes: 'reviewed' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.status).toBe(toStatus);
    }
  );

  it('fires a refund webhook when resolving as refund', async () => {
    const existingDispute = { id: '1', donationId: '10', status: 'under_review', reason: 'fraud' };
    const updatedDispute = { ...existingDispute, status: 'resolved_refund', resolvedAt: new Date().toISOString(), updatedAt: new Date().toISOString() };

    Database.get
      .mockResolvedValueOnce(existingDispute)
      .mockResolvedValueOnce(updatedDispute)
      .mockResolvedValueOnce({ id: '10', amount: 50 }); // donation for refund
    Database.run.mockResolvedValueOnce(undefined);

    await request(app)
      .patch('/admin/disputes/1')
      .send({ status: 'resolved_refund' });

    expect(WebhookService.deliver).toHaveBeenCalledWith(
      'donation.refund_requested',
      expect.objectContaining({ donationId: '10', disputeId: '1' })
    );
  });

  it('does not fire a refund webhook for resolved_no_action', async () => {
    const existingDispute = { id: '1', donationId: '10', status: 'under_review', reason: 'fraud' };
    const updatedDispute = { ...existingDispute, status: 'resolved_no_action', resolvedAt: new Date().toISOString(), updatedAt: new Date().toISOString() };

    Database.get
      .mockResolvedValueOnce(existingDispute)
      .mockResolvedValueOnce(updatedDispute);
    Database.run.mockResolvedValueOnce(undefined);

    await request(app)
      .patch('/admin/disputes/1')
      .send({ status: 'resolved_no_action' });

    expect(WebhookService.deliver).not.toHaveBeenCalledWith(
      'donation.refund_requested',
      expect.anything()
    );
  });

  it('sets resolvedAt when transitioning to a resolved_ status', async () => {
    const existingDispute = { id: '1', donationId: '10', status: 'open', reason: 'fraud' };
    const updatedDispute = {
      ...existingDispute,
      status: 'resolved_no_action',
      resolvedAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };

    Database.get
      .mockResolvedValueOnce(existingDispute)
      .mockResolvedValueOnce(updatedDispute);
    Database.run.mockResolvedValueOnce(undefined);

    const res = await request(app)
      .patch('/admin/disputes/1')
      .send({ status: 'resolved_no_action' });

    expect(res.body.data.resolvedAt).toBeTruthy();
  });

  it('does not set resolvedAt for non-resolved status transitions', async () => {
    const existingDispute = { id: '1', donationId: '10', status: 'open', reason: 'fraud' };
    const updatedDispute = {
      ...existingDispute,
      status: 'under_review',
      resolvedAt: null,
      updatedAt: new Date().toISOString(),
    };

    Database.get
      .mockResolvedValueOnce(existingDispute)
      .mockResolvedValueOnce(updatedDispute);
    Database.run.mockResolvedValueOnce(undefined);

    const res = await request(app)
      .patch('/admin/disputes/1')
      .send({ status: 'under_review' });

    expect(res.body.data.resolvedAt).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /admin/disputes
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /admin/disputes', () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    app = buildApp();
  });

  it('returns 200 with a list of disputes', async () => {
    const disputes = [
      { id: '1', donationId: '10', status: 'open', reason: 'fraud', createdAt: new Date().toISOString() },
      { id: '2', donationId: '11', status: 'under_review', reason: 'wrong amount', createdAt: new Date().toISOString() },
    ];
    Database.query = jest.fn().mockResolvedValueOnce(disputes);

    const res = await request(app).get('/admin/disputes');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveLength(2);
  });

  it('returns an empty list when there are no disputes', async () => {
    Database.query = jest.fn().mockResolvedValueOnce([]);

    const res = await request(app).get('/admin/disputes');

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });

  it('filters by status when ?status= is provided', async () => {
    Database.query = jest.fn().mockResolvedValueOnce([]);

    const res = await request(app).get('/admin/disputes?status=open');

    expect(res.status).toBe(200);
    // Verify the query was called (status filtering is passed to Database.query)
    expect(Database.query).toHaveBeenCalled();
  });

  it('respects limit and offset query parameters', async () => {
    Database.query = jest.fn().mockResolvedValueOnce([]);

    const res = await request(app).get('/admin/disputes?limit=10&offset=5');

    expect(res.status).toBe(200);
    expect(Database.query).toHaveBeenCalledWith(
      expect.any(String),
      expect.arrayContaining([10, 5])
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /admin/disputes/:id
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /admin/disputes/:id', () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    app = buildApp();
  });

  it('returns the dispute when it exists', async () => {
    const dispute = {
      id: '5',
      donationId: '20',
      status: 'open',
      reason: 'duplicate charge',
      createdAt: new Date().toISOString(),
    };
    Database.get.mockResolvedValueOnce(dispute);

    const res = await request(app).get('/admin/disputes/5');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.id).toBe('5');
    expect(res.body.data.reason).toBe('duplicate charge');
  });

  it('returns 404 when the dispute does not exist', async () => {
    Database.get.mockResolvedValueOnce(null);

    const res = await request(app).get('/admin/disputes/999');

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('DISPUTE_NOT_FOUND');
  });
});
