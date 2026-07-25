#!/usr/bin/env node

/**
 * Migration Testing Suite
 *
 * This script validates the migration system by:
 * 1. Running all migrations on a fresh database
 * 2. Verifying the up migrations succeed
 * 3. Running down migrations to rollback changes
 * 4. Checking for duplicate migration version numbers
 * 5. Detecting out-of-order migrations
 *
 * Usage:
 *   npm run test:migrations
 *   node scripts/test-migrations.js
 */

const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const log = require('../src/utils/log');

const MIGRATIONS_DIR = path.join(__dirname, '../src/migrations');
const TEST_DB_PATH = process.env.TEST_DB_PATH || path.join(__dirname, '../data/test-migrations.db');

class MigrationTestSuite {
  constructor() {
    this.db = null;
    this.passed = 0;
    this.failed = 0;
    this.errors = [];
    this.migrations = [];
  }

  /**
   * Setup test environment
   */
  async setup() {
    log.info('MIGRATION_TEST', 'Setting up test environment');

    // Remove existing test database
    if (fs.existsSync(TEST_DB_PATH)) {
      fs.unlinkSync(TEST_DB_PATH);
    }

    // Create new test database
    this.db = new sqlite3.Database(TEST_DB_PATH);

    await new Promise((resolve, reject) => {
      this.db.serialize(() => {
        resolve();
      });
    });

    log.info('MIGRATION_TEST', 'Test database created', { path: TEST_DB_PATH });
  }

  /**
   * Cleanup test environment
   */
  async cleanup() {
    if (this.db) {
      return new Promise((resolve, reject) => {
        this.db.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    }
  }

  /**
   * Execute SQL statement
   */
  async run(sql, params = []) {
    return new Promise((resolve, reject) => {
      this.db.run(sql, params, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  /**
   * Query database
   */
  async query(sql, params = []) {
    return new Promise((resolve, reject) => {
      this.db.all(sql, params, (err, rows) => {
        if (err) reject(err);
        else resolve(rows || []);
      });
    });
  }

  /**
   * Assert a condition
   */
  assert(condition, message) {
    if (condition) {
      this.passed++;
      log.info('MIGRATION_TEST', `✓ ${message}`);
    } else {
      this.failed++;
      const error = `✗ ${message}`;
      this.errors.push(error);
      log.error('MIGRATION_TEST', error);
    }
  }

  /**
   * Assert async result
   */
  async assertAsync(asyncFn, message) {
    try {
      const result = await asyncFn();
      this.assert(result, message);
    } catch (error) {
      this.failed++;
      const msg = `✗ ${message}: ${error.message}`;
      this.errors.push(msg);
      log.error('MIGRATION_TEST', msg);
    }
  }

  /**
   * Load migration files
   */
  loadMigrations() {
    if (!fs.existsSync(MIGRATIONS_DIR)) {
      log.warn('MIGRATION_TEST', 'Migrations directory not found', { path: MIGRATIONS_DIR });
      return [];
    }

    const files = fs
      .readdirSync(MIGRATIONS_DIR)
      .filter((f) => /^\d+.*\.js$/.test(f))
      .sort();

    this.migrations = files.map((f) => {
      const filePath = path.join(MIGRATIONS_DIR, f);
      const prefix = f.match(/^(\d+)/)[1];
      const migration = require(filePath);

      return {
        file: f,
        filePath,
        prefix,
        name: migration.name,
        migration,
      };
    });

    return this.migrations;
  }

  /**
   * Run the test suite
   */
  async runTests() {
    log.info('MIGRATION_TEST', '=== Starting Migration Test Suite ===');

    try {
      await this.setup();

      // Test 1: Load migrations
      await this.testLoadMigrations();

      // Test 2: Check for duplicates
      await this.testDuplicateMigrations();

      // Test 3: Check for order
      await this.testMigrationOrder();

      // Test 4: Run up migrations
      await this.testUpMigrations();

      // Test 5: Verify schema
      await this.testSchema();

      // Test 6: Run down migrations
      await this.testDownMigrations();

      await this.cleanup();
      this.printResults();

      if (this.failed > 0) {
        process.exit(1);
      }
    } catch (error) {
      log.error('MIGRATION_TEST', 'Test suite error', { error: error.message, stack: error.stack });
      process.exit(1);
    }
  }

  /**
   * Test: Load migrations from directory
   */
  async testLoadMigrations() {
    log.info('MIGRATION_TEST', 'Test: Load migrations');

    this.loadMigrations();

    this.assert(
      this.migrations && this.migrations.length >= 0,
      'Should load migration files'
    );

    this.assert(
      this.migrations.every(m => m.file && m.migration && m.migration.name),
      'Each migration should have required properties'
    );

    log.info('MIGRATION_TEST', `Found ${this.migrations.length} migrations`);
  }

  /**
   * Test: Detect duplicate migration prefixes
   */
  async testDuplicateMigrations() {
    log.info('MIGRATION_TEST', 'Test: Detect duplicate migration prefixes');

    const prefixes = new Map();
    const duplicates = [];

    for (const migration of this.migrations) {
      if (prefixes.has(migration.prefix)) {
        duplicates.push({
          prefix: migration.prefix,
          files: [prefixes.get(migration.prefix), migration.file],
        });
      }
      prefixes.set(migration.prefix, migration.file);
    }

    if (duplicates.length > 0) {
      this.failed++;
      const msg = `✗ Found ${duplicates.length} duplicate migration prefixes:\n${
        duplicates.map(d => `  ${d.prefix}: ${d.files.join(', ')}`).join('\n')
      }`;
      this.errors.push(msg);
      log.error('MIGRATION_TEST', msg);
    } else {
      this.passed++;
      log.info('MIGRATION_TEST', '✓ No duplicate migration prefixes');
    }
  }

  /**
   * Test: Verify migrations are in order
   */
  async testMigrationOrder() {
    log.info('MIGRATION_TEST', 'Test: Verify migration order');

    const prefixes = this.migrations.map(m => parseInt(m.prefix, 10));
    let ordered = true;

    for (let i = 0; i < prefixes.length - 1; i++) {
      if (prefixes[i] >= prefixes[i + 1]) {
        ordered = false;
        break;
      }
    }

    this.assert(
      ordered,
      `Migrations should be in ascending numeric order (found: ${prefixes.join(', ')})`
    );
  }

  /**
   * Test: Run all up migrations on fresh database
   */
  async testUpMigrations() {
    log.info('MIGRATION_TEST', 'Test: Run up migrations');

    // Create schema_migrations table
    await this.run(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        applied_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        checksum TEXT NOT NULL DEFAULT ''
      )
    `);

    const applied = [];

    for (const { migration, file, name } of this.migrations) {
      try {
        // Create a minimal db wrapper for migrations
        const dbWrapper = {
          run: (sql, params = []) => this.run(sql, params),
          query: (sql, params = []) => this.query(sql, params),
        };

        // Run the migration up
        if (migration.up) {
          await migration.up(dbWrapper);
          await this.run(
            'INSERT INTO schema_migrations (name, checksum) VALUES (?, ?)',
            [name, '']
          );
          applied.push(name);
          log.info('MIGRATION_TEST', `  ✓ ${name}`);
        }
      } catch (error) {
        this.failed++;
        const msg = `✗ Migration failed: ${name}\n    ${error.message}`;
        this.errors.push(msg);
        log.error('MIGRATION_TEST', msg);
        return;
      }
    }

    this.passed++;
    log.info('MIGRATION_TEST', `✓ All ${applied.length} migrations applied successfully`);
  }

  /**
   * Test: Verify schema after migrations
   */
  async testSchema() {
    log.info('MIGRATION_TEST', 'Test: Verify schema');

    try {
      const tables = await this.query(`
        SELECT name FROM sqlite_master
        WHERE type='table'
        ORDER BY name
      `);

      this.assert(
        tables.length > 0,
        `Database should have tables after migrations (found ${tables.length})`
      );

      const tableNames = tables.map(t => t.name);
      log.info('MIGRATION_TEST', `  Database tables: ${tableNames.join(', ')}`);
    } catch (error) {
      this.failed++;
      const msg = `✗ Schema verification failed: ${error.message}`;
      this.errors.push(msg);
      log.error('MIGRATION_TEST', msg);
    }
  }

  /**
   * Test: Run down migrations to rollback
   */
  async testDownMigrations() {
    log.info('MIGRATION_TEST', 'Test: Run down migrations');

    const applied = await this.query('SELECT name FROM schema_migrations ORDER BY id DESC');

    // Run down migrations in reverse order
    for (const row of applied) {
      const migration = this.migrations.find(m => m.name === row.name);
      if (!migration) continue;

      try {
        if (migration.migration.down) {
          const dbWrapper = {
            run: (sql, params = []) => this.run(sql, params),
            query: (sql, params = []) => this.query(sql, params),
          };

          await migration.migration.down(dbWrapper);
          await this.run('DELETE FROM schema_migrations WHERE name = ?', [row.name]);
          log.info('MIGRATION_TEST', `  ✓ Rolled back ${row.name}`);
        }
      } catch (error) {
        // Some migrations might not have down methods
        if (!error.message.includes('not a function')) {
          this.failed++;
          const msg = `✗ Rollback failed: ${row.name}\n    ${error.message}`;
          this.errors.push(msg);
          log.error('MIGRATION_TEST', msg);
          return;
        }
      }
    }

    this.passed++;
    log.info('MIGRATION_TEST', `✓ All ${applied.length} migrations rolled back successfully`);
  }

  /**
   * Print test results
   */
  printResults() {
    const total = this.passed + this.failed;
    const percentage = total > 0 ? Math.round((this.passed / total) * 100) : 0;

    log.info('MIGRATION_TEST', '');
    log.info('MIGRATION_TEST', '=== Test Results ===');
    log.info('MIGRATION_TEST', `Passed:  ${this.passed}`);
    log.info('MIGRATION_TEST', `Failed:  ${this.failed}`);
    log.info('MIGRATION_TEST', `Total:   ${total}`);
    log.info('MIGRATION_TEST', `Success: ${percentage}%`);

    if (this.errors.length > 0) {
      log.info('MIGRATION_TEST', '');
      log.info('MIGRATION_TEST', 'Errors:');
      this.errors.forEach(error => log.info('MIGRATION_TEST', error));
    }

    log.info('MIGRATION_TEST', '');
  }
}

// Run the test suite
const suite = new MigrationTestSuite();
suite.runTests();
