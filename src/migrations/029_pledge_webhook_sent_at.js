'use strict';

/**
 * Migration 029: Add webhook_sent_at column to pledges table
 *
 * This column tracks when webhooks were sent for pledge status changes
 * (fulfilled or expired) to prevent duplicate webhook deliveries.
 */

exports.name = '029_pledge_webhook_sent_at';

exports.up = async (db) => {
  // Add webhook_sent_at column only if missing
  const columns = await db.all('PRAGMA table_info(pledges)');
  const hasColumn = columns.some(c => c.name === 'webhook_sent_at');

  if (!hasColumn) {
    await db.run('ALTER TABLE pledges ADD COLUMN webhook_sent_at DATETIME');
  }

  // Create index for efficient querying of unsent webhooks
  await db.run(`
    CREATE INDEX IF NOT EXISTS idx_pledges_webhook_sent_at
    ON pledges(webhook_sent_at)
    WHERE webhook_sent_at IS NULL
  `);
};

exports.down = async (db) => {
  // Note: SQLite does not support DROP COLUMN on older versions
  // The column will remain but won't be used if migration is rolled back
  await db.run('DROP INDEX IF EXISTS idx_pledges_webhook_sent_at');
};