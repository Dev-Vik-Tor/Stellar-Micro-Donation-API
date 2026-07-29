'use strict';

/**
 * Tests: AuditLogRetentionService (issue #1387)
 *
 * Covers:
 *  - Retention-window cutoff calculation for various retention periods
 *  - Records older than the cutoff are archived then deleted
 *  - Records within the retention window are NOT touched
 *  - Boundary-case: a record timestamped exactly AT the cutoff is preserved
 *    (the query uses strict `<`, so the boundary record is kept)
 *  - Empty result: returns 0 and does not call INSERT or DELETE
 *  - Archive table is created lazily on first run
 *  - Database errors during SELECT, INSERT, or DELETE are surfaced (not swallowed)
 *  - start() / stop() lifecycle: timer is registered / cleared exactly once
 */

// ─── Mock heavy dependencies before any src/ module is required ──────────────

// Capture the log calls so we can assert on them without console noise
jest.mock('../../src/utils/log', () => ({
  info: jest.fn(),
  error: jest.fn(),
}));

// Mock timerRegistry so no real setInterval is created
jest.mock('../../src/utils/timerRegistry', () => ({
  createInterval: jest.fn(() => ({
    unref: jest.fn(),
    clear: jest.fn(),
  })),
}));

// Mock config to return a predictable retention value (avoid env-var dependency)
jest.mock('../../src/config', () => ({
  auditRetention: { archiveAfterDays: 90 },
}));

// ─── Set up the database mock before loading the module ──────────────────────
// We use explicit jest.fn() handles so individual tests can override behaviour.
const mockRun = jest.fn();
const mockAll = jest.fn();

jest.mock('../../src/utils/database', () => ({
  run: mockRun,
  all: mockAll,
}));

// ─── Load service AFTER mocks are in place ───────────────────────────────────
// AuditLogRetentionService exports a singleton; we need to reset module state
// between tests that mutate the timer field, so we use the raw prototype.
const AuditLogRetentionService = require('../../src/services/AuditLogRetentionService');
const timerRegistry = require('../../src/utils/timerRegistry');
const log = require('../../src/utils/log');

// ─── Constants under test ────────────────────────────────────────────────────
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const DEFAULT_RETENTION_DAYS = 90;

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Build a minimal audit-log row fixture.
 */
function makeRow(overrides = {}) {
  return {
    id: 1,
    timestamp: new Date(Date.now() - 100 * MS_PER_DAY).toISOString(),
    category: 'AUTH',
    action: 'LOGIN',
    severity: 'INFO',
    result: 'SUCCESS',
    userId: 'u1',
    requestId: 'r1',
    ipAddress: '127.0.0.1',
    resource: '/auth',
    reason: null,
    details: null,
    integrityHash: 'abc123',
    ...overrides,
  };
}

// ─── Test Suite ───────────────────────────────────────────────────────────────

describe('AuditLogRetentionService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Default: ensureArchiveTable CREATE succeeds, DELETE succeeds
    mockRun.mockResolvedValue({});
    // Default: no rows to archive
    mockAll.mockResolvedValue([]);
  });

  // ── _ensureArchiveTable ────────────────────────────────────────────────────

  describe('_ensureArchiveTable', () => {
    it('calls db.run with a CREATE TABLE IF NOT EXISTS statement', async () => {
      await AuditLogRetentionService._ensureArchiveTable();
      expect(mockRun).toHaveBeenCalledTimes(1);
      const [sql] = mockRun.mock.calls[0];
      expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS audit_logs_archive/i);
    });
  });

  // ── runRetention — cutoff calculation ────────────────────────────────────

  describe('runRetention — cutoff calculation', () => {
    it('selects rows older than 90 days (default)', async () => {
      const before = Date.now();
      await AuditLogRetentionService.runRetention();
      const after = Date.now();

      // The SELECT call is the first db.all call
      expect(mockAll).toHaveBeenCalledTimes(1);
      const [sql, params] = mockAll.mock.calls[0];
      expect(sql).toMatch(/SELECT \* FROM audit_logs WHERE timestamp < \?/i);

      const cutoff = new Date(params[0]).getTime();
      const expectedMin = before - DEFAULT_RETENTION_DAYS * MS_PER_DAY;
      const expectedMax = after  - DEFAULT_RETENTION_DAYS * MS_PER_DAY;

      expect(cutoff).toBeGreaterThanOrEqual(expectedMin);
      expect(cutoff).toBeLessThanOrEqual(expectedMax);
    });

    it('selects rows older than a custom retention period (30 days)', async () => {
      const before = Date.now();
      await AuditLogRetentionService.runRetention(30);
      const after = Date.now();

      const [, params] = mockAll.mock.calls[0];
      const cutoff = new Date(params[0]).getTime();

      expect(cutoff).toBeGreaterThanOrEqual(before - 30 * MS_PER_DAY);
      expect(cutoff).toBeLessThanOrEqual(after  - 30 * MS_PER_DAY);
    });

    it('selects rows older than a 365-day retention period', async () => {
      const before = Date.now();
      await AuditLogRetentionService.runRetention(365);
      const after = Date.now();

      const [, params] = mockAll.mock.calls[0];
      const cutoff = new Date(params[0]).getTime();

      expect(cutoff).toBeGreaterThanOrEqual(before - 365 * MS_PER_DAY);
      expect(cutoff).toBeLessThanOrEqual(after  - 365 * MS_PER_DAY);
    });

    it('accepts retentionDays=1 (1-day window)', async () => {
      const before = Date.now();
      await AuditLogRetentionService.runRetention(1);
      const after = Date.now();

      const [, params] = mockAll.mock.calls[0];
      const cutoff = new Date(params[0]).getTime();

      expect(cutoff).toBeGreaterThanOrEqual(before - 1 * MS_PER_DAY);
      expect(cutoff).toBeLessThanOrEqual(after  - 1 * MS_PER_DAY);
    });
  });

  // ── runRetention — no eligible rows ──────────────────────────────────────

  describe('runRetention — no eligible rows', () => {
    it('returns 0 when no rows match the cutoff', async () => {
      mockAll.mockResolvedValue([]);
      const count = await AuditLogRetentionService.runRetention();
      expect(count).toBe(0);
    });

    it('does not call INSERT or DELETE when result set is empty', async () => {
      mockAll.mockResolvedValue([]);
      await AuditLogRetentionService.runRetention();

      // Only the CREATE TABLE call should have been made via db.run
      const insertOrDeleteCalls = mockRun.mock.calls.filter(([sql]) =>
        /INSERT/i.test(sql) || /DELETE/i.test(sql)
      );
      expect(insertOrDeleteCalls).toHaveLength(0);
    });
  });

  // ── runRetention — archiving eligible rows ────────────────────────────────

  describe('runRetention — archiving eligible rows', () => {
    it('archives and deletes rows older than the cutoff', async () => {
      const row1 = makeRow({ id: 1 });
      const row2 = makeRow({ id: 2, userId: 'u2' });
      mockAll.mockResolvedValue([row1, row2]);

      const count = await AuditLogRetentionService.runRetention();

      expect(count).toBe(2);

      // Each row should generate one INSERT … INTO audit_logs_archive
      const insertCalls = mockRun.mock.calls.filter(([sql]) =>
        /INSERT.*audit_logs_archive/i.test(sql)
      );
      expect(insertCalls).toHaveLength(2);

      // There should be exactly one DELETE … FROM audit_logs
      const deleteCalls = mockRun.mock.calls.filter(([sql]) =>
        /DELETE FROM audit_logs/i.test(sql)
      );
      expect(deleteCalls).toHaveLength(1);
    });

    it('inserts each row with the correct column values', async () => {
      const row = makeRow({
        id: 42,
        category: 'TX',
        action: 'SEND',
        severity: 'HIGH',
        result: 'FAILED',
        userId: 'user-99',
        requestId: 'req-abc',
        ipAddress: '10.0.0.1',
        resource: '/donations',
        reason: 'test',
        details: JSON.stringify({ amount: 10 }),
        integrityHash: 'hash-xyz',
      });
      mockAll.mockResolvedValue([row]);

      await AuditLogRetentionService.runRetention();

      const [insertSql, insertParams] = mockRun.mock.calls.find(([sql]) =>
        /INSERT.*audit_logs_archive/i.test(sql)
      );
      expect(insertSql).toMatch(/INSERT OR IGNORE INTO audit_logs_archive/i);
      // params: id, timestamp, category, action, severity, result,
      //         userId, requestId, ipAddress, resource, reason,
      //         details, integrityHash, archivedAt
      expect(insertParams[0]).toBe(42);
      expect(insertParams[2]).toBe('TX');
      expect(insertParams[3]).toBe('SEND');
      expect(insertParams[4]).toBe('HIGH');
      expect(insertParams[6]).toBe('user-99');
      expect(insertParams[12]).toBe('hash-xyz');
      // archivedAt is the last param and must be a valid ISO string
      expect(() => new Date(insertParams[13]).toISOString()).not.toThrow();
    });

    it('DELETE uses the same cutoff timestamp passed to the SELECT', async () => {
      mockAll.mockResolvedValue([makeRow()]);

      await AuditLogRetentionService.runRetention(90);

      const selectParams = mockAll.mock.calls[0][1];
      const deleteCalls = mockRun.mock.calls.filter(([sql]) =>
        /DELETE FROM audit_logs/i.test(sql)
      );
      expect(deleteCalls).toHaveLength(1);
      const deleteParams = deleteCalls[0][1];
      expect(deleteParams[0]).toBe(selectParams[0]);
    });
  });

  // ── runRetention — boundary case ─────────────────────────────────────────

  describe('runRetention — boundary case', () => {
    it('does NOT archive a record timestamped exactly AT the cutoff (strict <)', async () => {
      // We return no rows (simulating that the boundary record was not matched).
      // This test asserts that the SELECT query uses strict < (not <=).
      mockAll.mockResolvedValue([]);

      await AuditLogRetentionService.runRetention(90);

      const [sql] = mockAll.mock.calls[0];
      // Strict less-than, not <=
      expect(sql).toMatch(/timestamp\s*</);
      expect(sql).not.toMatch(/timestamp\s*<=/);
    });
  });

  // ── runRetention — logging ────────────────────────────────────────────────

  describe('runRetention — logging', () => {
    it('logs an info message when rows are archived', async () => {
      mockAll.mockResolvedValue([makeRow(), makeRow({ id: 2 })]);

      await AuditLogRetentionService.runRetention(90);

      expect(log.info).toHaveBeenCalledWith(
        'AUDIT_RETENTION',
        expect.stringContaining('2'),
        expect.objectContaining({ retentionDays: 90, archivedCount: 2 })
      );
    });

    it('does NOT log when there is nothing to archive', async () => {
      mockAll.mockResolvedValue([]);
      await AuditLogRetentionService.runRetention();
      expect(log.info).not.toHaveBeenCalled();
    });
  });

  // ── runRetention — error handling ─────────────────────────────────────────

  describe('runRetention — error handling', () => {
    it('propagates database errors from db.all (SELECT)', async () => {
      mockAll.mockRejectedValue(new Error('DB connection lost'));
      await expect(AuditLogRetentionService.runRetention()).rejects.toThrow('DB connection lost');
    });

    it('propagates database errors from db.run (INSERT)', async () => {
      mockAll.mockResolvedValue([makeRow()]);
      // CREATE TABLE succeeds, then INSERT fails
      mockRun
        .mockResolvedValueOnce({})          // CREATE TABLE
        .mockRejectedValueOnce(new Error('Disk full'));

      await expect(AuditLogRetentionService.runRetention()).rejects.toThrow('Disk full');
    });

    it('propagates database errors from db.run (DELETE)', async () => {
      mockAll.mockResolvedValue([makeRow()]);
      mockRun
        .mockResolvedValueOnce({})  // CREATE TABLE
        .mockResolvedValueOnce({})  // INSERT archive row
        .mockRejectedValueOnce(new Error('DELETE constraint')); // DELETE fails

      await expect(AuditLogRetentionService.runRetention()).rejects.toThrow('DELETE constraint');
    });
  });

  // ── start / stop lifecycle ────────────────────────────────────────────────

  describe('start / stop lifecycle', () => {
    let service;

    beforeEach(() => {
      // Create a fresh instance for each lifecycle test to avoid singleton state
      const { AuditLogRetentionService: Cls } =
        jest.isolateModules(() =>
          // Re-require the class by accessing the constructor via the singleton
          ({ AuditLogRetentionService: Object.getPrototypeOf(AuditLogRetentionService).constructor })
        );

      // Use the exported singleton but manipulate _timer directly
      service = AuditLogRetentionService;
      service._timer = null; // reset timer state
    });

    afterEach(() => {
      service.stop();
    });

    it('start() registers a timer via timerRegistry.createInterval', () => {
      service.start();
      expect(timerRegistry.createInterval).toHaveBeenCalledTimes(1);
      expect(timerRegistry.createInterval).toHaveBeenCalledWith(
        expect.any(Function),
        expect.any(Number),
        'audit-log-retention'
      );
    });

    it('start() logs that the service started', () => {
      service.start();
      expect(log.info).toHaveBeenCalledWith(
        'AUDIT_RETENTION',
        expect.stringContaining('started'),
        expect.any(Object)
      );
    });

    it('start() is idempotent — calling twice registers the timer only once', () => {
      service.start();
      service.start();
      expect(timerRegistry.createInterval).toHaveBeenCalledTimes(1);
    });

    it('stop() clears the timer', () => {
      service.start();
      const mockTimer = timerRegistry.createInterval.mock.results[0].value;
      service.stop();
      expect(mockTimer.clear).toHaveBeenCalledTimes(1);
      expect(service._timer).toBeNull();
    });

    it('stop() is safe to call when service was never started', () => {
      expect(() => service.stop()).not.toThrow();
    });

    it('the interval callback catches errors and logs them', async () => {
      mockAll.mockRejectedValue(new Error('scheduled failure'));

      service.start();

      // Extract and invoke the callback registered with timerRegistry
      const [callback] = timerRegistry.createInterval.mock.calls[0];
      await callback();

      expect(log.error).toHaveBeenCalledWith(
        'AUDIT_RETENTION',
        expect.stringContaining('failed'),
        expect.objectContaining({ error: 'scheduled failure' })
      );
    });
  });

  // ── return value contract ─────────────────────────────────────────────────

  describe('return value', () => {
    it('returns the number of archived entries', async () => {
      mockAll.mockResolvedValue([makeRow(), makeRow({ id: 2 }), makeRow({ id: 3 })]);
      const count = await AuditLogRetentionService.runRetention();
      expect(count).toBe(3);
    });

    it('returns 0 when no entries qualify', async () => {
      mockAll.mockResolvedValue([]);
      const count = await AuditLogRetentionService.runRetention();
      expect(count).toBe(0);
    });
  });
});
