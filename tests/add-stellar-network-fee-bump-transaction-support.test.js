const Transaction = require('../src/routes/models/transaction');
const path = require('path');

describe('Transaction Model Fee Bump Fields', () => {
  const TEST_DB = path.join(__dirname, '../data/test-fee-bump-model.json');

  beforeEach(() => {
    process.env.DB_JSON_PATH = TEST_DB;
    Transaction._clearAllData();
  });

  afterAll(() => {
    delete process.env.DB_JSON_PATH;
    const fs = require('fs');
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  });

  test('create() stores fee bump fields', () => {
    const tx = Transaction.create({
      amount: 10,
      donor: 'GDONOR',
      recipient: 'GRECIP',
      status: 'pending',
      envelopeXdr: 'AAAA==',
      feeBumpCount: 0,
      originalFee: 100,
      currentFee: 100,
    });

    expect(tx.envelopeXdr).toBe('AAAA==');
    expect(tx.feeBumpCount).toBe(0);
    expect(tx.originalFee).toBe(100);
    expect(tx.currentFee).toBe(100);
    expect(tx.lastFeeBumpAt).toBeNull();
  });

  test('updateFeeBumpData() updates fee bump metadata', () => {
    const tx = Transaction.create({
      amount: 10,
      donor: 'GDONOR',
      recipient: 'GRECIP',
      status: 'submitted',
      envelopeXdr: 'AAAA==',
      feeBumpCount: 0,
      originalFee: 100,
      currentFee: 100,
    });

    const updated = Transaction.updateFeeBumpData(tx.id, {
      feeBumpCount: 1,
      currentFee: 200,
      lastFeeBumpAt: '2026-03-25T00:00:00.000Z',
      envelopeXdr: 'BBBB==',
      stellarTxId: 'new_hash_123',
    });

    expect(updated.feeBumpCount).toBe(1);
    expect(updated.currentFee).toBe(200);
    expect(updated.lastFeeBumpAt).toBe('2026-03-25T00:00:00.000Z');
    expect(updated.envelopeXdr).toBe('BBBB==');
    expect(updated.stellarTxId).toBe('new_hash_123');
  });
});

describe('StellarService.buildAndSubmitFeeBumpTransaction()', () => {
  test('method exists and is not the base interface stub', () => {
    const StellarService = require('../src/services/StellarService');
    const StellarServiceInterface = require('../src/services/interfaces/StellarServiceInterface');
    const service = new StellarService({ network: 'testnet' });
    const baseInterface = new StellarServiceInterface();

    expect(typeof service.buildAndSubmitFeeBumpTransaction).toBe('function');
    expect(service.buildAndSubmitFeeBumpTransaction).not.toBe(
      baseInterface.buildAndSubmitFeeBumpTransaction
    );
  });
});

describe('MockStellarService.buildAndSubmitFeeBumpTransaction()', () => {
  const MockStellarService = require('../src/services/MockStellarService');
  let mockService;

  beforeEach(() => {
    mockService = new MockStellarService({ network: 'testnet' });
  });

  test('returns hash, ledger, fee, and envelopeXdr on success', async () => {
    const result = await mockService.buildAndSubmitFeeBumpTransaction(
      'mock_envelope_xdr_base64',
      200,
      'SCZANGBA5YHTNYVVV3C7CAZMCLXPILHSE6PGYAY7URFI5NUFQMK3Q7OV'
    );

    expect(result).toHaveProperty('hash');
    expect(result).toHaveProperty('ledger');
    expect(result.fee).toBe(200);
    expect(result).toHaveProperty('envelopeXdr');
    expect(result.hash).toMatch(/^mock_/);
  });

  test('simulates fee_bump_failure when enabled', async () => {
    mockService.enableFailureSimulation('fee_bump_failure', 1.0);

    await expect(
      mockService.buildAndSubmitFeeBumpTransaction('xdr', 200, 'SCZANGBA5YHTNYVVV3C7CAZMCLXPILHSE6PGYAY7URFI5NUFQMK3Q7OV')
    ).rejects.toThrow(/fee bump/i);
  });
});
