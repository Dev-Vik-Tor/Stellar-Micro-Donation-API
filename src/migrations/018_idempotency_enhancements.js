'use strict';

/**
 * Migration: Harden idempotency and deduplication persistence (#1088)
 *
 * 1. Add `apiKeyId` column to idempotency_keys (for per-tenant scoping, #891).
 * 2. Add `status` column ('pending' | 'completed') for atomic in-flight reserve.
 * 3. Recreate idempotency_keys with a composite UNIQUE(apiKeyId, idempotencyKey)
 *    constraint so that the same key reused by different tenants is not blocked.
 * 4. Create dedup_cache table for DB-backed content deduplication.
 */

exports.name = '018_idempotency_enhancements';

exports.up = async (db) => {
  // ── Step 1: Ensure idempotency_keys exists (in case migration 010 ran differently) ──
  await db.run(`
    CREATE TABLE IF NOT EXISTS idempotency_keys (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      idempotencyKey VARCHAR(255) NOT NULL UNIQUE,
      requestHash VARCHAR(64) NOT NULL,
      response TEXT NOT NULL DEFAULT '',
      userId INTEGER,
      createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      expiresAt DATETIME NOT NULL
    )
  `);

  // ── Step 2: Rebuild with composite unique constraint and new columns ──
  await db.run(`
    CREATE TABLE IF NOT EXISTS idempotency_keys_v2 (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      apiKeyId INTEGER,
      idempotencyKey VARCHAR(255) NOT NULL,
      requestHash VARCHAR(64) NOT NULL,
      response TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'completed',
      userId INTEGER,
      createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      expiresAt DATETIME NOT NULL,
      UNIQUE(apiKeyId, idempotencyKey)
    )
  `);

  // Copy existing rows; treat all existing records as 'completed'
  await db.run(`
    INSERT OR IGNORE INTO idempotency_keys_v2
      (id, apiKeyId, idempotencyKey, requestHash, response, status, userId, createdAt, expiresAt)
    SELECT
      id,
      NULL,
      idempotencyKey,
      requestHash,
      COALESCE(response, ''),
      'completed',
      userId,
      createdAt,
      expiresAt
    FROM idempotency_keys
  `);

  await db.run('DROP TABLE idempotency_keys');
  await db.run('ALTER TABLE idempotency_keys_v2 RENAME TO idempotency_keys');

  // ── Step 3: Indexes ──
  await db.run(`
    CREATE INDEX IF NOT EXISTS idx_idempotency_key_lookup
    ON idempotency_keys(apiKeyId, idempotencyKey)
  `);
  await db.run(`
    CREATE INDEX IF NOT EXISTS idx_idempotency_expires
    ON idempotency_keys(expiresAt)
  `);

  // ── Step 4: DB-backed dedup cache (replaces in-memory Map in deduplication middleware) ──
  // NOTE: SQLite's PRIMARY KEY clause only accepts plain column names — expressions
  // such as COALESCE(apiKeyId, '') are not valid DDL syntax and cause a parse error.
  // The NULL-safe composite uniqueness requirement is handled instead by:
  //   • a NOT NULL surrogate column `api_key_scope` that stores '' when apiKeyId is NULL, and
  //   • a composite PRIMARY KEY (fingerprint, api_key_scope) on plain column names.
  await db.run(`
    CREATE TABLE IF NOT EXISTS dedup_cache (
      fingerprint TEXT NOT NULL,
      apiKeyId TEXT,
      api_key_scope TEXT NOT NULL DEFAULT '',
      status_code INTEGER NOT NULL,
      body TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      expires_at DATETIME NOT NULL,
      PRIMARY KEY (fingerprint, api_key_scope)
    )
  `);

  await db.run(`
    CREATE INDEX IF NOT EXISTS idx_dedup_expires
    ON dedup_cache(expires_at)
  `);
};

exports.down = async (db) => {
  // Rebuild without new columns (best-effort; existing data is preserved)
  await db.run(`
    CREATE TABLE IF NOT EXISTS idempotency_keys_rollback (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      idempotencyKey VARCHAR(255) NOT NULL UNIQUE,
      requestHash VARCHAR(64) NOT NULL,
      response TEXT NOT NULL DEFAULT '',
      userId INTEGER,
      createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      expiresAt DATETIME NOT NULL
    )
  `);
  await db.run(`
    INSERT OR IGNORE INTO idempotency_keys_rollback
      (id, idempotencyKey, requestHash, response, userId, createdAt, expiresAt)
    SELECT id, idempotencyKey, requestHash, response, userId, createdAt, expiresAt
    FROM idempotency_keys
    WHERE status = 'completed'
  `);
  await db.run('DROP TABLE idempotency_keys');
  await db.run('ALTER TABLE idempotency_keys_rollback RENAME TO idempotency_keys');
  await db.run('DROP INDEX IF EXISTS idx_idempotency_key_lookup');
  await db.run('DROP INDEX IF EXISTS idx_idempotency_expires');
  await db.run('DROP TABLE IF EXISTS dedup_cache');
  await db.run('DROP INDEX IF EXISTS idx_dedup_expires');
};
