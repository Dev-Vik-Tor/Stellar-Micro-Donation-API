'use strict';

/**
 * Migration: Store pledge amounts as INTEGER stroops instead of REAL XLM.
 *
 * This mirrors the existing transaction precision migration and prevents the
 * same IEEE-754 rounding drift for pledge comparisons and campaign totals.
 */

const STROOPS_PER_XLM = 10_000_000;

exports.name = '038_pledges_amount_stroops';

exports.up = async (db) => {
  try {
    await db.run(`ALTER TABLE pledges ADD COLUMN amount_stroops INTEGER`);
  } catch (_) { /* column already exists */ }

  await db.run(
    `UPDATE pledges SET amount_stroops = CAST(ROUND(amount * ${STROOPS_PER_XLM}) AS INTEGER)`
  );

  await db.run(`DROP TABLE IF EXISTS pledges_new`);
  await db.run(`
    CREATE TABLE pledges_new (
      id TEXT PRIMARY KEY,
      campaign_id INTEGER NOT NULL,
      donor_wallet_id TEXT NOT NULL,
      amount INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK(status IN ('pending','fulfilled','expired','cancelled')),
      expires_at DATETIME NOT NULL,
      cancel_reason TEXT,
      cancelled_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (campaign_id) REFERENCES campaigns(id)
    )
  `);

  await db.run(`
    INSERT INTO pledges_new (
      id, campaign_id, donor_wallet_id, amount, status, expires_at,
      cancel_reason, cancelled_at, created_at
    )
    SELECT id, campaign_id, donor_wallet_id, amount_stroops, status, expires_at,
           cancel_reason, cancelled_at, created_at
    FROM pledges
  `);

  await db.run(`DROP TABLE pledges`);
  await db.run(`ALTER TABLE pledges_new RENAME TO pledges`);

  await db.run(`
    CREATE INDEX IF NOT EXISTS idx_pledges_campaign ON pledges(campaign_id)
  `);
  await db.run(`
    CREATE INDEX IF NOT EXISTS idx_pledges_status ON pledges(status)
  `);
  await db.run(`
    CREATE INDEX IF NOT EXISTS idx_pledges_expires ON pledges(expires_at)
  `);

  console.log('✓ Migrated pledges.amount from REAL (XLM) to INTEGER (stroops)');
};

exports.down = async (db) => {
  await db.run(`DROP TABLE IF EXISTS pledges_old`);
  await db.run(`
    CREATE TABLE pledges_old (
      id TEXT PRIMARY KEY,
      campaign_id INTEGER NOT NULL,
      donor_wallet_id TEXT NOT NULL,
      amount REAL NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK(status IN ('pending','fulfilled','expired','cancelled')),
      expires_at DATETIME NOT NULL,
      cancel_reason TEXT,
      cancelled_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (campaign_id) REFERENCES campaigns(id)
    )
  `);

  await db.run(`
    INSERT INTO pledges_old (
      id, campaign_id, donor_wallet_id, amount, status, expires_at,
      cancel_reason, cancelled_at, created_at
    )
    SELECT id, campaign_id, donor_wallet_id,
           CAST(amount AS REAL) / ${STROOPS_PER_XLM}, status, expires_at,
           cancel_reason, cancelled_at, created_at
    FROM pledges
  `);

  await db.run(`DROP TABLE pledges`);
  await db.run(`ALTER TABLE pledges_old RENAME TO pledges`);

  await db.run(`
    CREATE INDEX IF NOT EXISTS idx_pledges_campaign ON pledges(campaign_id)
  `);
  await db.run(`
    CREATE INDEX IF NOT EXISTS idx_pledges_status ON pledges(status)
  `);
  await db.run(`
    CREATE INDEX IF NOT EXISTS idx_pledges_expires ON pledges(expires_at)
  `);

  console.log('✓ Rolled back pledges.amount from INTEGER (stroops) to REAL (XLM)');
};
