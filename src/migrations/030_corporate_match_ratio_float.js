'use strict';

/**
 * Migration 030: Change matchRatio from INTEGER to REAL to support fractional match ratios
 *
 * Corporate donation-matching programs commonly use fractional rates like
 * 0.5x (50%), 1.5x (150%), etc. The current INTEGER type prevents this.
 */

exports.name = '030_corporate_match_ratio_float';

exports.up = async (db) => {
  // SQLite doesn't support ALTER COLUMN type directly
  // We need to recreate the table with the new column type
  const columns = await db.all('PRAGMA table_info(corporate_employers)');
  const matchRatioColumn = columns.find(c => c.name === 'matchRatio');
  
  if (matchRatioColumn && matchRatioColumn.type.toUpperCase() === 'INTEGER') {
    // Create temporary table with REAL matchRatio
    await db.run(`
      CREATE TABLE corporate_employers_new (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        matchRatio REAL NOT NULL,
        annualCap REAL NOT NULL,
        addedAt TEXT NOT NULL
      )
    `);
    
    // Copy data from old table
    await db.run(`
      INSERT INTO corporate_employers_new (id, name, matchRatio, annualCap, addedAt)
      SELECT id, name, CAST(matchRatio AS REAL), annualCap, addedAt
      FROM corporate_employers
    `);
    
    // Drop old table
    await db.run('DROP TABLE corporate_employers');
    
    // Rename new table
    await db.run('ALTER TABLE corporate_employers_new RENAME TO corporate_employers');
  }
  
  // Ensure indexes exist
  await db.run('CREATE INDEX IF NOT EXISTS idx_corporate_employers_id ON corporate_employers(id)');
};

exports.down = async (db) => {
  // Revert back to INTEGER type if needed
  const columns = await db.all('PRAGMA table_info(corporate_employers)');
  const matchRatioColumn = columns.find(c => c.name === 'matchRatio');
  
  if (matchRatioColumn && matchRatioColumn.type.toUpperCase() === 'REAL') {
    // Create temporary table with INTEGER matchRatio
    await db.run(`
      CREATE TABLE corporate_employers_new (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        matchRatio INTEGER NOT NULL,
        annualCap REAL NOT NULL,
        addedAt TEXT NOT NULL
      )
    `);
    
    // Copy data from old table, rounding matchRatio to nearest integer
    await db.run(`
      INSERT INTO corporate_employers_new (id, name, matchRatio, annualCap, addedAt)
      SELECT id, name, ROUND(matchRatio), annualCap, addedAt
      FROM corporate_employers
    `);
    
    // Drop old table
    await db.run('DROP TABLE corporate_employers');
    
    // Rename new table
    await db.run('ALTER TABLE corporate_employers_new RENAME TO corporate_employers');
  }
};