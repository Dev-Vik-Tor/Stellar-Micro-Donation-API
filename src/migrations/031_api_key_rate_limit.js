'use strict';

exports.name = '031_api_key_rate_limit';

exports.up = async (db) => {
  await db.run(`
    ALTER TABLE api_keys ADD COLUMN rate_limit_per_minute INTEGER DEFAULT NULL
  `);
};

exports.down = async (db) => {
  // SQLite does not support DROP COLUMN in older versions; recreate table without the column.
  // We use an explicit CREATE TABLE statement (not CREATE TABLE ... AS SELECT) so that the
  // PRIMARY KEY / AUTOINCREMENT designation, NOT NULL constraints, UNIQUE constraints, and
  // indexes are all faithfully preserved on the restored table.
  await db.run(`
    CREATE TABLE api_keys_backup (
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
      key_secret TEXT,
      allowed_ips TEXT,
      monthly_quota INTEGER,
      quota_used INTEGER NOT NULL DEFAULT 0,
      quota_reset_at INTEGER,
      tenant_id TEXT NOT NULL DEFAULT 'default',
      notification_email TEXT,
      last_expiry_notification_sent_at INTEGER
    )
  `);
  await db.run(`
    INSERT INTO api_keys_backup (
      id, key_hash, key_prefix, name, role, status, created_by, metadata,
      expires_at, last_used_at, deprecated_at, revoked_at, created_at,
      grace_period_days, rotated_to_id, signing_required, key_secret,
      allowed_ips, monthly_quota, quota_used, quota_reset_at, tenant_id,
      notification_email, last_expiry_notification_sent_at
    )
    SELECT
      id, key_hash, key_prefix, name, role, status, created_by, metadata,
      expires_at, last_used_at, deprecated_at, revoked_at, created_at,
      grace_period_days, rotated_to_id, signing_required, key_secret,
      allowed_ips, monthly_quota, quota_used, quota_reset_at, tenant_id,
      notification_email, last_expiry_notification_sent_at
    FROM api_keys
  `);
  await db.run(`DROP TABLE api_keys`);
  await db.run(`ALTER TABLE api_keys_backup RENAME TO api_keys`);
  // Restore the indexes that were present before this migration ran.
  await db.run(`CREATE INDEX IF NOT EXISTS idx_api_keys_key_hash ON api_keys(key_hash)`);
  await db.run(`CREATE INDEX IF NOT EXISTS idx_api_keys_status ON api_keys(status)`);
};
