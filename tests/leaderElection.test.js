'use strict';

/**
 * Tests: src/utils/leaderElection.js
 *
 * All database calls are intercepted via jest.mock so these tests run without
 * any real SQLite connection.  Jest fake timers are used wherever lease expiry
 * depends on wall-clock time.
 */

// ─── Mock dependencies ────────────────────────────────────────────────────────

jest.mock('../src/utils/log', () => ({
  info:  jest.fn(),
  warn:  jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

// We mock the database module so every test can control what db.run / db.get
// return, without touching any real SQLite file.
const mockRun = jest.fn();
const mockGet = jest.fn();

jest.mock('../src/utils/database', () => ({
  run: (...args) => mockRun(...args),
  get: (...args) => mockGet(...args),
}));

// Import the named class (not the singleton) so we can create fresh instances
// with a known instanceId for each test.
const { LeaderElection } = require('../src/utils/leaderElection');

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeElection(instanceId = 'instance-A') {
  return new LeaderElection({ instanceId });
}

/** Resolve both db.run and db.get with typical "our row wins" values. */
function dbGrantsLease(election) {
  mockRun.mockResolvedValue(undefined); // INSERT … ON CONFLICT DO UPDATE — no rows returned
  mockGet.mockResolvedValue({ holder_id: election.instanceId });
}

/** Resolve db.run, but db.get returns a row held by a different instance. */
function dbDeniesLease(otherInstanceId = 'instance-B') {
  mockRun.mockResolvedValue(undefined);
  mockGet.mockResolvedValue({ holder_id: otherInstanceId });
}

// ─── Setup / Teardown ─────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

// ─── acquireLease — success ───────────────────────────────────────────────────

describe('LeaderElection.acquireLease — uncontested acquisition', () => {
  it('returns true when no other instance holds the lease', async () => {
    const election = makeElection('leader-1');
    dbGrantsLease(election);

    const result = await election.acquireLease('scheduler', 5000);
    expect(result).toBe(true);
  });

  it('calls db.run with the expected SQL pattern', async () => {
    const election = makeElection('leader-2');
    dbGrantsLease(election);

    await election.acquireLease('my-job', 10000);

    expect(mockRun).toHaveBeenCalledTimes(1);
    // The SQL should be an upsert / INSERT … ON CONFLICT
    const sql = mockRun.mock.calls[0][0];
    expect(sql).toMatch(/INSERT INTO scheduler_locks/i);
    expect(sql).toMatch(/ON CONFLICT/i);
  });

  it('queries db.get after the upsert to read the current holder', async () => {
    const election = makeElection('leader-3');
    dbGrantsLease(election);

    await election.acquireLease('job-a', 5000);

    expect(mockGet).toHaveBeenCalledTimes(1);
    const [sql, params] = mockGet.mock.calls[0];
    expect(sql).toMatch(/SELECT holder_id FROM scheduler_locks WHERE name = \?/i);
    expect(params).toEqual(['job-a']);
  });

  it('passes the correct name, instanceId, and TTL to db.run', async () => {
    const election = makeElection('instance-X');
    dbGrantsLease(election);

    const nowBefore = Date.now();
    await election.acquireLease('targeted-job', 3000);
    const nowAfter = Date.now();

    const params = mockRun.mock.calls[0][1];
    // params[0] = name, params[1] = instanceId, params[2] = acquired_at, params[3] = expires_at
    expect(params[0]).toBe('targeted-job');
    expect(params[1]).toBe('instance-X');
    expect(params[2]).toBeGreaterThanOrEqual(nowBefore);
    expect(params[2]).toBeLessThanOrEqual(nowAfter);
    expect(params[3]).toBeGreaterThanOrEqual(nowBefore + 3000);
    expect(params[3]).toBeLessThanOrEqual(nowAfter  + 3000);
  });
});

// ─── acquireLease — rejection ─────────────────────────────────────────────────

describe('LeaderElection.acquireLease — contested lease', () => {
  it('returns false when another instance holds a valid lease', async () => {
    const election = makeElection('instance-A');
    dbDeniesLease('instance-B');

    const result = await election.acquireLease('scheduler', 5000);
    expect(result).toBe(false);
  });

  it('calls db.get even when db.run succeeds (to confirm who holds the lock)', async () => {
    const election = makeElection('instance-A');
    dbDeniesLease('instance-C');

    await election.acquireLease('job', 5000);

    expect(mockGet).toHaveBeenCalledTimes(1);
  });

  it('returns false for a third instance when a second already holds the lease', async () => {
    const thirdInstance = makeElection('instance-C');
    dbDeniesLease('instance-A'); // db says instance-A holds it

    const result = await thirdInstance.acquireLease('exclusive-job', 5000);
    expect(result).toBe(false);
  });
});

// ─── acquireLease — renewal ───────────────────────────────────────────────────

describe('LeaderElection.acquireLease — lease renewal', () => {
  it('returns true when the same instance renews its own lease', async () => {
    const election = makeElection('renewer');
    // First acquisition
    dbGrantsLease(election);
    await election.acquireLease('job', 5000);

    // Renewal — db still reports we hold it
    jest.clearAllMocks();
    dbGrantsLease(election);
    const renewed = await election.acquireLease('job', 5000);

    expect(renewed).toBe(true);
  });

  it('updates expires_at with a later timestamp on each renewal', async () => {
    const election = makeElection('renewer-2');
    dbGrantsLease(election);

    const t1 = Date.now();
    await election.acquireLease('job', 5000);
    const expires1 = mockRun.mock.calls[0][1][3]; // params[3] = expires_at

    jest.clearAllMocks();
    jest.advanceTimersByTime(1000); // advance 1 second
    dbGrantsLease(election);

    await election.acquireLease('job', 5000);
    const expires2 = mockRun.mock.calls[0][1][3];

    // The second renewal should push the expiry further into the future
    expect(expires2).toBeGreaterThan(expires1);
  });
});

// ─── acquireLease — expiry ────────────────────────────────────────────────────

describe('LeaderElection.acquireLease — lease expiry', () => {
  it('allows a new instance to acquire after the previous lease expires', async () => {
    // Simulate: first holder had a lease that is now expired.
    // The DB atomic upsert will overwrite it — the new instance wins.
    const newInstance = makeElection('new-instance');
    dbGrantsLease(newInstance); // DB says new-instance is now the holder

    const result = await newInstance.acquireLease('expired-job', 5000);
    expect(result).toBe(true);
  });

  it('includes the current timestamp in the upsert so expired rows are overwritten', async () => {
    const election = makeElection('takeover-instance');
    dbGrantsLease(election);

    await election.acquireLease('stale-job', 5000);

    const params = mockRun.mock.calls[0][1];
    // The CASE WHEN conditions compare expires_at < ? — the ? must be ~ now
    // Params: [name, id, now, expires, now, id, now, id, now, id]
    const nowReference = params[4]; // first occurrence of "now" used in CASE WHEN
    expect(nowReference).toBeGreaterThan(0);
  });
});

// ─── acquireLease — fail-open behavior ───────────────────────────────────────

describe('LeaderElection.acquireLease — fail-open on DB error', () => {
  it('returns true when db.run throws (fail-open, not fail-closed)', async () => {
    mockRun.mockRejectedValue(new Error('SQLITE_BUSY'));
    const election = makeElection('survivor');

    const result = await election.acquireLease('critical-job', 5000);
    expect(result).toBe(true);
  });

  it('returns true when db.get throws after a successful db.run', async () => {
    mockRun.mockResolvedValue(undefined);
    mockGet.mockRejectedValue(new Error('connection lost'));

    const election = makeElection('survivor-2');
    const result = await election.acquireLease('critical-job-2', 5000);
    expect(result).toBe(true);
  });

  it('does not propagate DB errors — resolves rather than rejects', async () => {
    mockRun.mockRejectedValue(new Error('disk full'));
    const election = makeElection('no-throw');

    await expect(election.acquireLease('job', 5000)).resolves.toBeDefined();
  });
});

// ─── releaseLease ─────────────────────────────────────────────────────────────

describe('LeaderElection.releaseLease', () => {
  it('calls db.run with a DELETE statement for the correct name and holder_id', async () => {
    const election = makeElection('releasing-instance');
    mockRun.mockResolvedValue(undefined);

    await election.releaseLease('scheduler');

    expect(mockRun).toHaveBeenCalledTimes(1);
    const [sql, params] = mockRun.mock.calls[0];
    expect(sql).toMatch(/DELETE FROM scheduler_locks/i);
    expect(params[0]).toBe('scheduler');
    expect(params[1]).toBe('releasing-instance');
  });

  it('does not throw even when db.run rejects', async () => {
    mockRun.mockRejectedValue(new Error('db gone'));
    const election = makeElection('safe-release');

    await expect(election.releaseLease('any-job')).resolves.toBeUndefined();
  });

  it('resolves to undefined (fire-and-forget — non-critical)', async () => {
    mockRun.mockResolvedValue(undefined);
    const election = makeElection('clean-release');

    const result = await election.releaseLease('job-x');
    expect(result).toBeUndefined();
  });

  it('uses the correct holder_id (own instanceId, not another instance)', async () => {
    const election = makeElection('owner-instance');
    mockRun.mockResolvedValue(undefined);

    await election.releaseLease('shared-job');

    const params = mockRun.mock.calls[0][1];
    // Should NOT attempt to delete another instance's lock
    expect(params[1]).toBe('owner-instance');
  });
});

// ─── LeaderElection class — instanceId defaults ───────────────────────────────

describe('LeaderElection — instanceId defaults', () => {
  it('generates an instanceId from hostname and PID when none is provided', () => {
    const os = require('os');
    const election = new LeaderElection();
    expect(election.instanceId).toContain(os.hostname());
    expect(election.instanceId).toContain(String(process.pid));
  });

  it('uses the provided instanceId when supplied', () => {
    const election = new LeaderElection({ instanceId: 'my-custom-id' });
    expect(election.instanceId).toBe('my-custom-id');
  });

  it('two instances with different instanceIds are treated as distinct leaders', async () => {
    const electionA = makeElection('leader-A');
    const electionB = makeElection('leader-B');

    // A holds the lease
    dbGrantsLease(electionA);
    const aLeads = await electionA.acquireLease('job', 5000);
    expect(aLeads).toBe(true);

    // B is denied
    jest.clearAllMocks();
    dbDeniesLease('leader-A');
    const bLeads = await electionB.acquireLease('job', 5000);
    expect(bLeads).toBe(false);
  });
});

// ─── Singleton default export ─────────────────────────────────────────────────

describe('leaderElection singleton (default export)', () => {
  it('is an instance of LeaderElection', () => {
    const singleton = require('../src/utils/leaderElection');
    expect(singleton).toBeInstanceOf(LeaderElection);
  });

  it('exposes the LeaderElection class as a named export', () => {
    const exports = require('../src/utils/leaderElection');
    expect(exports.LeaderElection).toBe(LeaderElection);
  });
});
