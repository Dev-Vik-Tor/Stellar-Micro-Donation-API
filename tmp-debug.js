process.env.ENCRYPTION_KEY_1 = 'wallet-test-key-v1';
process.env.ENCRYPTION_KEY_VERSION = '1';
const Database = require('./src/utils/database');
(async () => {
  try {
    await Database.run('DELETE FROM wallets');
    await Database.run(`
      CREATE TABLE IF NOT EXISTS wallets (
        id TEXT PRIMARY KEY,
        address TEXT NOT NULL UNIQUE,
        label TEXT,
        ownerName TEXT,
        notes TEXT,
        leaderboard_visibility INTEGER DEFAULT 1,
        last_synced_at TEXT,
        last_cursor TEXT,
        createdAt TEXT NOT NULL,
        updatedAt TEXT,
        deletedAt TEXT,
        label_encrypted INTEGER DEFAULT 0,
        notes_encrypted INTEGER DEFAULT 0
      )
    `);
    const Wallet = require('./src/models/wallet');
    const res = await Wallet.create({ id: 'wallet-state-test', address: 'GSTATE', label: 'Original Label' });
    console.log('created', res);
  } catch (err) {
    console.error('err', err);
    console.error('message', err && err.message);
    console.error('cause', err && err.cause);
    console.error('causeMsg', err && err.cause && err.cause.message);
    console.error('stack', err && err.stack);
    process.exitCode = 1;
  }
})();
