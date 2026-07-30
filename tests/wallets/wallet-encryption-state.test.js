const Database = require('../../src/utils/database');

describe('Wallet encryption state handling', () => {
  let Wallet;

  beforeEach(async () => {
    process.env.ENCRYPTION_KEY_1 = 'wallet-test-key-v1';
    process.env.ENCRYPTION_KEY_VERSION = '1';
    delete require.cache[require.resolve('../../src/models/wallet')];
    delete require.cache[require.resolve('../../src/services/EncryptionService')];
    Wallet = require('../../src/models/wallet');
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
  });

  afterEach(async () => {
    delete process.env.ENCRYPTION_KEY_1;
    delete process.env.ENCRYPTION_KEY_VERSION;
    delete require.cache[require.resolve('../../src/models/wallet')];
    delete require.cache[require.resolve('../../src/services/EncryptionService')];
    await Database.run('DELETE FROM wallets').catch(() => {});
  });

  test('fails loudly and preserves ciphertext when a key change happens before an update', async () => {
    const created = await Wallet.create({ id: 'wallet-state-test', address: 'GSTATE', label: 'Original Label' });

    const beforeRow = await Database.get('SELECT label, label_encrypted FROM wallets WHERE id = ?', [created.id]);
    expect(beforeRow.label_encrypted).toBe(1);
    expect(beforeRow.label).toMatch(/^v1:/);

    delete process.env.ENCRYPTION_KEY_1;
    delete process.env.ENCRYPTION_KEY;
    delete require.cache[require.resolve('../../src/models/wallet')];
    delete require.cache[require.resolve('../../src/services/EncryptionService')];
    Wallet = require('../../src/models/wallet');

    await expect(Wallet.update(created.id, { ownerName: 'New Owner' })).rejects.toThrow(/decrypt/i);

    const afterRow = await Database.get('SELECT label, label_encrypted FROM wallets WHERE id = ?', [created.id]);
    expect(afterRow.label).toBe(beforeRow.label);
    expect(afterRow.label_encrypted).toBe(1);
  });
});
