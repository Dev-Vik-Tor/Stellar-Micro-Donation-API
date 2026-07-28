'use strict';

/**
 * Tests for migration 029_check_constraints_monetary (Issue #1360)
 *
 * Asserts that each CHECK constraint added by the migration actually rejects
 * negative (or zero-where-inappropriate) values at the database level, not
 * just at the application layer. Uses an isolated in-memory SQLite database
 * so these tests are fully self-contained and never touch the real data file.
 */

const sqlite3 = require('sqlite3').verbose();
const migration = require('../../src/migrations/029_check_constraints_monetary');

// ─── In-memory DB helpers ─────────────────────────────────────────────────────

function openDb() {
  const sqlite = new sqlite3.Database(':memory:');

  const run = (sql, params = []) =>
    new Promise((resolve, reject) =>
      sqlite.run(sql, params, function (err) {
        if (err) return reject(err);
        resolve({ lastID: this.lastID, changes: this.changes });
      })
    );

  const query = (sql, params = []) =>
    new Promise((resolve, reject) =>
      sqlite.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)))
    );

  const close = () => new Promise((res) => sqlite.close(res));

  return { run, query, close };
}

// ─── Schema bootstrap (pre-migration state — no CHECK constraints) ────────────

async function bootstrapPreMigrationSchema(db) {
  // users table as it exists before migration 029
  await db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id                     INTEGER PRIMARY KEY AUTOINCREMENT,
      publicKey              TEXT NOT NULL UNIQUE,
      encryptedSecret        TEXT,
      createdAt              DATETIME DEFAULT CURRENT_TIMESTAMP,
      deleted_at             DATETIME DEFAULT NULL,
      daily_limit            REAL DEFAULT NULL,
      monthly_limit          REAL DEFAULT NULL,
      per_transaction_limit  REAL DEFAULT NULL,
      tenant_id              TEXT NOT NULL DEFAULT 'default'
    )
  `);

  // campaigns table as it exists before migration 029
  await db.run(`
    CREATE TABLE IF NOT EXISTS campaigns (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      name           TEXT NOT NULL,
      description    TEXT,
      goal_amount    REAL NOT NULL,
      current_amount REAL DEFAULT 0,
      start_date     DATETIME,
      end_date       DATETIME,
      status         TEXT DEFAULT 'active',
      created_by     INTEGER,
      createdAt      DATETIME DEFAULT CURRENT_TIMESTAMP,
      updatedAt      DATETIME DEFAULT CURRENT_TIMESTAMP,
      deleted_at     DATETIME DEFAULT NULL,
      tenant_id      TEXT NOT NULL DEFAULT 'default'
    )
  `);

  // pledges table as it exists before migration 029
  await db.run(`
    CREATE TABLE IF NOT EXISTS pledges (
      id              TEXT PRIMARY KEY,
      campaign_id     INTEGER NOT NULL,
      donor_wallet_id TEXT NOT NULL,
      amount          REAL NOT NULL,
      status          TEXT NOT NULL DEFAULT 'pending'
                        CHECK(status IN ('pending','fulfilled','expired','cancelled')),
      expires_at      DATETIME NOT NULL,
      cancel_reason   TEXT,
      cancelled_at    DATETIME,
      created_at      DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
}

// ─── Test suite ───────────────────────────────────────────────────────────────

describe('migration 029 — CHECK constraints on monetary/limit columns', () => {
  let db;

  beforeEach(async () => {
    db = openDb();
    await bootstrapPreMigrationSchema(db);
    // Run the migration under test
    await migration.up(db);
  });

  afterEach(async () => {
    await db.close();
  });

  // ── pledges.amount ─────────────────────────────────────────────────────────

  describe('pledges.amount', () => {
    const futureDate = new Date(Date.now() + 86400000).toISOString();

    it('rejects a negative pledge amount', async () => {
      await expect(
        db.run(
          `INSERT INTO pledges (id, campaign_id, donor_wallet_id, amount, expires_at)
           VALUES ('p1', 1, 'WALLET', -1.0, ?)`,
          [futureDate]
        )
      ).rejects.toThrow(/CHECK constraint failed/i);
    });

    it('rejects a zero pledge amount', async () => {
      await expect(
        db.run(
          `INSERT INTO pledges (id, campaign_id, donor_wallet_id, amount, expires_at)
           VALUES ('p2', 1, 'WALLET', 0, ?)`,
          [futureDate]
        )
      ).rejects.toThrow(/CHECK constraint failed/i);
    });

    it('accepts a positive pledge amount', async () => {
      await expect(
        db.run(
          `INSERT INTO pledges (id, campaign_id, donor_wallet_id, amount, expires_at)
           VALUES ('p3', 1, 'WALLET', 50.0, ?)`,
          [futureDate]
        )
      ).resolves.toBeDefined();
    });

    it('accepts the smallest representable positive float', async () => {
      await expect(
        db.run(
          `INSERT INTO pledges (id, campaign_id, donor_wallet_id, amount, expires_at)
           VALUES ('p4', 1, 'WALLET', 0.0000001, ?)`,
          [futureDate]
        )
      ).resolves.toBeDefined();
    });
  });

  // ── campaigns.goal_amount ─────────────────────────────────────────────────

  describe('campaigns.goal_amount', () => {
    it('rejects a negative goal_amount', async () => {
      await expect(
        db.run(
          `INSERT INTO campaigns (name, goal_amount) VALUES ('Test', -100)`
        )
      ).rejects.toThrow(/CHECK constraint failed/i);
    });

    it('rejects a zero goal_amount', async () => {
      await expect(
        db.run(
          `INSERT INTO campaigns (name, goal_amount) VALUES ('Test', 0)`
        )
      ).rejects.toThrow(/CHECK constraint failed/i);
    });

    it('accepts a positive goal_amount', async () => {
      await expect(
        db.run(
          `INSERT INTO campaigns (name, goal_amount) VALUES ('Test', 1000)`
        )
      ).resolves.toBeDefined();
    });
  });

  // ── campaigns.current_amount ──────────────────────────────────────────────

  describe('campaigns.current_amount', () => {
    it('rejects a negative current_amount', async () => {
      await expect(
        db.run(
          `INSERT INTO campaigns (name, goal_amount, current_amount) VALUES ('Test', 100, -1)`
        )
      ).rejects.toThrow(/CHECK constraint failed/i);
    });

    it('accepts zero current_amount (campaign just started)', async () => {
      await expect(
        db.run(
          `INSERT INTO campaigns (name, goal_amount, current_amount) VALUES ('Test', 100, 0)`
        )
      ).resolves.toBeDefined();
    });

    it('accepts a positive current_amount', async () => {
      await expect(
        db.run(
          `INSERT INTO campaigns (name, goal_amount, current_amount) VALUES ('Test', 100, 50)`
        )
      ).resolves.toBeDefined();
    });

    it('rejects UPDATE that would make current_amount negative', async () => {
      await db.run(
        `INSERT INTO campaigns (name, goal_amount, current_amount) VALUES ('Test', 100, 50)`
      );
      const rows = await db.query(`SELECT id FROM campaigns WHERE name = 'Test'`);
      const id = rows[0].id;
      await expect(
        db.run(`UPDATE campaigns SET current_amount = -10 WHERE id = ?`, [id])
      ).rejects.toThrow(/CHECK constraint failed/i);
    });
  });

  // ── users.daily_limit ─────────────────────────────────────────────────────

  describe('users.daily_limit', () => {
    it('rejects a negative daily_limit', async () => {
      await expect(
        db.run(
          `INSERT INTO users (publicKey, daily_limit) VALUES ('GKEY1', -100)`
        )
      ).rejects.toThrow(/CHECK constraint failed/i);
    });

    it('accepts NULL daily_limit (no limit)', async () => {
      await expect(
        db.run(
          `INSERT INTO users (publicKey, daily_limit) VALUES ('GKEY2', NULL)`
        )
      ).resolves.toBeDefined();
    });

    it('accepts zero daily_limit (effectively blocks all donations)', async () => {
      await expect(
        db.run(
          `INSERT INTO users (publicKey, daily_limit) VALUES ('GKEY3', 0)`
        )
      ).resolves.toBeDefined();
    });

    it('accepts a positive daily_limit', async () => {
      await expect(
        db.run(
          `INSERT INTO users (publicKey, daily_limit) VALUES ('GKEY4', 500.0)`
        )
      ).resolves.toBeDefined();
    });
  });

  // ── users.monthly_limit ───────────────────────────────────────────────────

  describe('users.monthly_limit', () => {
    it('rejects a negative monthly_limit', async () => {
      await expect(
        db.run(
          `INSERT INTO users (publicKey, monthly_limit) VALUES ('GMKEY1', -200)`
        )
      ).rejects.toThrow(/CHECK constraint failed/i);
    });

    it('accepts NULL monthly_limit', async () => {
      await expect(
        db.run(
          `INSERT INTO users (publicKey, monthly_limit) VALUES ('GMKEY2', NULL)`
        )
      ).resolves.toBeDefined();
    });

    it('accepts zero monthly_limit', async () => {
      await expect(
        db.run(
          `INSERT INTO users (publicKey, monthly_limit) VALUES ('GMKEY3', 0)`
        )
      ).resolves.toBeDefined();
    });

    it('accepts a positive monthly_limit', async () => {
      await expect(
        db.run(
          `INSERT INTO users (publicKey, monthly_limit) VALUES ('GMKEY4', 1000.0)`
        )
      ).resolves.toBeDefined();
    });
  });

  // ── users.per_transaction_limit ───────────────────────────────────────────

  describe('users.per_transaction_limit', () => {
    it('rejects a negative per_transaction_limit', async () => {
      await expect(
        db.run(
          `INSERT INTO users (publicKey, per_transaction_limit) VALUES ('GPTKEY1', -50)`
        )
      ).rejects.toThrow(/CHECK constraint failed/i);
    });

    it('accepts NULL per_transaction_limit', async () => {
      await expect(
        db.run(
          `INSERT INTO users (publicKey, per_transaction_limit) VALUES ('GPTKEY2', NULL)`
        )
      ).resolves.toBeDefined();
    });

    it('accepts zero per_transaction_limit', async () => {
      await expect(
        db.run(
          `INSERT INTO users (publicKey, per_transaction_limit) VALUES ('GPTKEY3', 0)`
        )
      ).resolves.toBeDefined();
    });

    it('accepts a positive per_transaction_limit', async () => {
      await expect(
        db.run(
          `INSERT INTO users (publicKey, per_transaction_limit) VALUES ('GPTKEY4', 100.0)`
        )
      ).resolves.toBeDefined();
    });
  });

  // ── migration idempotency — existing valid data is preserved ──────────────

  describe('data preservation through migration', () => {
    it('preserves existing pledge rows with positive amounts', async () => {
      // Close db and start fresh to test data-preservation path
      await db.close();
      db = openDb();
      await bootstrapPreMigrationSchema(db);

      const futureDate = new Date(Date.now() + 86400000).toISOString();
      // Insert valid data BEFORE running migration
      await db.run(
        `INSERT INTO pledges (id, campaign_id, donor_wallet_id, amount, expires_at)
         VALUES ('existing1', 1, 'WALLET', 25.0, ?)`,
        [futureDate]
      );

      await migration.up(db);

      const rows = await db.query(`SELECT * FROM pledges WHERE id = 'existing1'`);
      expect(rows).toHaveLength(1);
      expect(rows[0].amount).toBe(25.0);
    });

    it('preserves existing campaign rows with valid amounts', async () => {
      await db.close();
      db = openDb();
      await bootstrapPreMigrationSchema(db);

      await db.run(
        `INSERT INTO campaigns (name, goal_amount, current_amount) VALUES ('Existing', 500, 100)`
      );

      await migration.up(db);

      const rows = await db.query(`SELECT * FROM campaigns WHERE name = 'Existing'`);
      expect(rows).toHaveLength(1);
      expect(rows[0].goal_amount).toBe(500);
      expect(rows[0].current_amount).toBe(100);
    });

    it('preserves existing user rows with valid limits', async () => {
      await db.close();
      db = openDb();
      await bootstrapPreMigrationSchema(db);

      await db.run(
        `INSERT INTO users (publicKey, daily_limit, monthly_limit, per_transaction_limit)
         VALUES ('GPRESERVE', 100, 500, 50)`
      );

      await migration.up(db);

      const rows = await db.query(`SELECT * FROM users WHERE publicKey = 'GPRESERVE'`);
      expect(rows).toHaveLength(1);
      expect(rows[0].daily_limit).toBe(100);
      expect(rows[0].monthly_limit).toBe(500);
      expect(rows[0].per_transaction_limit).toBe(50);
    });
  });

  // ── down migration restores unconstrained schema ──────────────────────────

  describe('down migration', () => {
    it('removes CHECK constraints — negative amounts accepted after rollback', async () => {
      await migration.down(db);

      // After rolling back, a negative pledge amount should be accepted again
      const futureDate = new Date(Date.now() + 86400000).toISOString();
      await expect(
        db.run(
          `INSERT INTO pledges (id, campaign_id, donor_wallet_id, amount, expires_at)
           VALUES ('rollback1', 1, 'WALLET', -1.0, ?)`,
          [futureDate]
        )
      ).resolves.toBeDefined();

      // And a negative campaign goal should be accepted after rollback
      await expect(
        db.run(
          `INSERT INTO campaigns (name, goal_amount) VALUES ('RollbackCampaign', -100)`
        )
      ).resolves.toBeDefined();
    });
  });
});
