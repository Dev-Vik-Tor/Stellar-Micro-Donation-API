'use strict';

exports.name = '036_circuit_breaker_probe';

exports.up = async (db) => {
  // Add probeHolder for cross-instance half-open probe coordination.
  // Only the instance that wins the atomic UPDATE gets to run the probe.
  // Ignored silently if the column already exists.
  try {
    await db.run(`
      ALTER TABLE circuit_breaker_state ADD COLUMN probeHolder TEXT DEFAULT NULL
    `);
    console.log('✓ Added probeHolder column to circuit_breaker_state');
  } catch (err) {
    if (!err.message.includes('duplicate column')) throw err;
  }
};

exports.down = async (db) => {
  // SQLite does not support DROP COLUMN before 3.35.0; recreate the table.
  // Use CREATE TABLE + INSERT + DROP + RENAME so that the PRIMARY KEY
  // constraint on `name` is preserved in the restored table.
  // (The previous CREATE TABLE … AS SELECT pattern silently dropped all
  // column constraints including PRIMARY KEY — see issue #1356.)
  await db.run(`
    CREATE TABLE IF NOT EXISTS circuit_breaker_state_new (
      name TEXT PRIMARY KEY,
      state TEXT NOT NULL DEFAULT 'closed',
      failureCount INTEGER NOT NULL DEFAULT 0,
      lastFailureAt INTEGER,
      openedAt INTEGER
    )
  `);
  await db.run(`
    INSERT INTO circuit_breaker_state_new (name, state, failureCount, lastFailureAt, openedAt)
      SELECT name, state, failureCount, lastFailureAt, openedAt
      FROM circuit_breaker_state
  `);
  await db.run('DROP TABLE IF EXISTS circuit_breaker_state');
  await db.run('ALTER TABLE circuit_breaker_state_new RENAME TO circuit_breaker_state');
};
