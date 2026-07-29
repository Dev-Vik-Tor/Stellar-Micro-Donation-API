'use strict';

/**
 * Tests: src/utils/stellarErrorHandler.js (issue #1389)
 *
 * Covers every classification branch in StellarErrorHandler.handle() and
 * the StellarErrorHandler.wrap() convenience wrapper. No real network calls
 * are made — all errors are constructed in-process.
 *
 * Classification matrix tested:
 *  NETWORK_ERROR       — ENOTFOUND / ECONNREFUSED
 *  NETWORK_TIMEOUT     — timeout / ETIMEDOUT
 *  INSUFFICIENT_BALANCE— "insufficient" / "underfunded"
 *  INVALID_DESTINATION — "destination" / "not found"
 *  ACCOUNT_NOT_FUNDED  — "not funded" / "op_no_destination"
 *  INVALID_CREDENTIALS — "Invalid source" / "secret key"
 *  TRANSACTION_FAILED  — "tx_failed" / "transaction failed"
 *  WALLET_NOT_FOUND    — "Wallet not found"
 *  INVALID_TRANSACTION — "must be different"
 *  TRANSACTION_NOT_FOUND — "Transaction not found"
 *  STELLAR_ERROR       — unknown / unrecognized error
 *
 * Each classification is verified for:
 *  - correct status code
 *  - correct error code
 *  - presence of a human-readable message
 *
 * wrap():
 *  - resolves to the operation result on success
 *  - re-throws the classified error object on failure
 */

// ─── Mock the logger so no noise appears in test output ──────────────────────
jest.mock('../../src/utils/log', () => ({
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
}));

const StellarErrorHandler = require('../../src/utils/stellarErrorHandler');

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Build an Error with an optional message and optional response body.
 */
function makeError(message, responseData = undefined) {
  const err = new Error(message);
  if (responseData !== undefined) {
    err.response = { data: responseData };
  }
  return err;
}

// ─── StellarErrorHandler.handle() ────────────────────────────────────────────

describe('StellarErrorHandler.handle()', () => {
  // ── Network errors ──────────────────────────────────────────────────────────

  describe('Network connectivity errors', () => {
    it('classifies ENOTFOUND as NETWORK_ERROR with status 503', () => {
      const result = StellarErrorHandler.handle(makeError('getaddrinfo ENOTFOUND horizon.stellar.org'));
      expect(result.status).toBe(503);
      expect(result.code).toBe('NETWORK_ERROR');
      expect(result.message).toBeTruthy();
    });

    it('classifies ECONNREFUSED as NETWORK_ERROR with status 503', () => {
      const result = StellarErrorHandler.handle(makeError('connect ECONNREFUSED 127.0.0.1:11626'));
      expect(result.status).toBe(503);
      expect(result.code).toBe('NETWORK_ERROR');
      expect(result.message).toBeTruthy();
    });

    it('classifies "timeout" messages as NETWORK_TIMEOUT with status 504', () => {
      const result = StellarErrorHandler.handle(makeError('Request timeout after 30000ms'));
      expect(result.status).toBe(504);
      expect(result.code).toBe('NETWORK_TIMEOUT');
      expect(result.message).toBeTruthy();
    });

    it('classifies ETIMEDOUT as NETWORK_TIMEOUT with status 504', () => {
      const result = StellarErrorHandler.handle(makeError('connection ETIMEDOUT 192.168.1.1:443'));
      expect(result.status).toBe(504);
      expect(result.code).toBe('NETWORK_TIMEOUT');
      expect(result.message).toBeTruthy();
    });
  });

  // ── Balance errors ──────────────────────────────────────────────────────────

  describe('Balance / funding errors', () => {
    it('classifies "insufficient" message as INSUFFICIENT_BALANCE with status 400', () => {
      const result = StellarErrorHandler.handle(makeError('Account has insufficient funds'));
      expect(result.status).toBe(400);
      expect(result.code).toBe('INSUFFICIENT_BALANCE');
      expect(result.message).toBeTruthy();
    });

    it('classifies "underfunded" as INSUFFICIENT_BALANCE with status 400', () => {
      const result = StellarErrorHandler.handle(makeError('op_underfunded: not enough XLM'));
      expect(result.status).toBe(400);
      expect(result.code).toBe('INSUFFICIENT_BALANCE');
      expect(result.message).toBeTruthy();
    });
  });

  // ── Destination / account errors ────────────────────────────────────────────

  describe('Destination / account errors', () => {
    it('classifies "destination" message as INVALID_DESTINATION with status 400', () => {
      const result = StellarErrorHandler.handle(makeError('Invalid destination account'));
      expect(result.status).toBe(400);
      expect(result.code).toBe('INVALID_DESTINATION');
      expect(result.message).toBeTruthy();
    });

    it('classifies "not found" message as INVALID_DESTINATION with status 400', () => {
      const result = StellarErrorHandler.handle(makeError('Account not found on network'));
      expect(result.status).toBe(400);
      expect(result.code).toBe('INVALID_DESTINATION');
      expect(result.message).toBeTruthy();
    });

    it('classifies "not funded" as ACCOUNT_NOT_FUNDED with status 400', () => {
      const result = StellarErrorHandler.handle(makeError('Account is not funded'));
      expect(result.status).toBe(400);
      expect(result.code).toBe('ACCOUNT_NOT_FUNDED');
      expect(result.message).toBeTruthy();
    });

    it('classifies "op_no_destination" as ACCOUNT_NOT_FUNDED with status 400', () => {
      const result = StellarErrorHandler.handle(makeError('Transaction failed: op_no_destination'));
      expect(result.status).toBe(400);
      expect(result.code).toBe('ACCOUNT_NOT_FUNDED');
      expect(result.message).toBeTruthy();
    });
  });

  // ── Credential errors ───────────────────────────────────────────────────────

  describe('Credential errors', () => {
    it('classifies "Invalid source" as INVALID_CREDENTIALS with status 400', () => {
      const result = StellarErrorHandler.handle(makeError('Invalid source account'));
      expect(result.status).toBe(400);
      expect(result.code).toBe('INVALID_CREDENTIALS');
      expect(result.message).toBeTruthy();
    });

    it('classifies "secret key" message as INVALID_CREDENTIALS with status 400', () => {
      const result = StellarErrorHandler.handle(makeError('Malformed secret key provided'));
      expect(result.status).toBe(400);
      expect(result.code).toBe('INVALID_CREDENTIALS');
      expect(result.message).toBeTruthy();
    });
  });

  // ── Transaction failures ────────────────────────────────────────────────────

  describe('Transaction failures', () => {
    it('classifies "tx_failed" as TRANSACTION_FAILED with status 400', () => {
      const result = StellarErrorHandler.handle(makeError('Transaction result: tx_failed'));
      expect(result.status).toBe(400);
      expect(result.code).toBe('TRANSACTION_FAILED');
      expect(result.message).toBeTruthy();
    });

    it('classifies "transaction failed" as TRANSACTION_FAILED with status 400', () => {
      const result = StellarErrorHandler.handle(makeError('The transaction failed on Stellar'));
      expect(result.status).toBe(400);
      expect(result.code).toBe('TRANSACTION_FAILED');
      expect(result.message).toBeTruthy();
    });
  });

  // ── Domain-specific errors ──────────────────────────────────────────────────

  describe('Domain-specific errors', () => {
    it('classifies "Wallet not found" as WALLET_NOT_FOUND with status 404', () => {
      const result = StellarErrorHandler.handle(makeError('Wallet not found for key GABCD'));
      expect(result.status).toBe(404);
      expect(result.code).toBe('WALLET_NOT_FOUND');
      expect(result.message).toMatch(/Wallet not found/);
    });

    it('classifies "must be different" as INVALID_TRANSACTION with status 400', () => {
      const result = StellarErrorHandler.handle(makeError('Sender and recipient must be different'));
      expect(result.status).toBe(400);
      expect(result.code).toBe('INVALID_TRANSACTION');
      expect(result.message).toBeTruthy();
    });

    it('classifies "Transaction not found" as TRANSACTION_NOT_FOUND with status 404', () => {
      const result = StellarErrorHandler.handle(makeError('Transaction not found in ledger'));
      expect(result.status).toBe(404);
      expect(result.code).toBe('TRANSACTION_NOT_FOUND');
      expect(result.message).toBeTruthy();
    });
  });

  // ── Default / unknown errors ────────────────────────────────────────────────

  describe('Unknown / unrecognized errors', () => {
    it('returns STELLAR_ERROR with status 500 for unrecognized messages', () => {
      const result = StellarErrorHandler.handle(makeError('Some completely unknown blockchain error'));
      expect(result.status).toBe(500);
      expect(result.code).toBe('STELLAR_ERROR');
      expect(result.message).toBeTruthy();
    });

    it('returns STELLAR_ERROR for an error with an empty message', () => {
      const result = StellarErrorHandler.handle(makeError(''));
      expect(result.status).toBe(500);
      expect(result.code).toBe('STELLAR_ERROR');
    });

    it('handles an error with no .message property gracefully', () => {
      const errNoMessage = {};
      const result = StellarErrorHandler.handle(errNoMessage);
      expect(result).toHaveProperty('status');
      expect(result).toHaveProperty('code');
      expect(result).toHaveProperty('message');
    });
  });

  // ── Return shape contract ───────────────────────────────────────────────────

  describe('Return shape contract', () => {
    it('always returns an object with status, code, and message properties', () => {
      const errors = [
        makeError('ENOTFOUND example.com'),
        makeError('timeout'),
        makeError('insufficient funds'),
        makeError('destination invalid'),
        makeError('not funded'),
        makeError('Invalid source'),
        makeError('tx_failed'),
        makeError('Wallet not found'),
        makeError('must be different'),
        makeError('Transaction not found'),
        makeError('completely unknown error xyz'),
      ];

      for (const err of errors) {
        const result = StellarErrorHandler.handle(err);
        expect(result).toHaveProperty('status');
        expect(result).toHaveProperty('code');
        expect(result).toHaveProperty('message');
        expect(typeof result.status).toBe('number');
        expect(typeof result.code).toBe('string');
        expect(typeof result.message).toBe('string');
      }
    });

    it('accepts an optional context parameter without changing the classification', () => {
      const result = StellarErrorHandler.handle(makeError('ENOTFOUND stellar.org'), 'sendDonation');
      expect(result.code).toBe('NETWORK_ERROR');
    });

    it('uses default context "operation" when no context is provided', () => {
      // Simply verifying it does not throw when context is omitted
      expect(() => StellarErrorHandler.handle(makeError('ENOTFOUND x'))).not.toThrow();
    });
  });

  // ── Logging side-effect ─────────────────────────────────────────────────────

  describe('Logging side-effect', () => {
    const log = require('../../src/utils/log');

    beforeEach(() => jest.clearAllMocks());

    it('calls log.error with the STELLAR_ERROR_HANDLER category', () => {
      StellarErrorHandler.handle(makeError('some error'), 'testContext');
      expect(log.error).toHaveBeenCalledWith(
        'STELLAR_ERROR_HANDLER',
        expect.stringContaining('testContext'),
        expect.any(Object)
      );
    });
  });
});

// ─── StellarErrorHandler.wrap() ───────────────────────────────────────────────

describe('StellarErrorHandler.wrap()', () => {
  it('returns the operation result when the operation resolves', async () => {
    const result = await StellarErrorHandler.wrap(
      async () => ({ txHash: 'abc123', ledger: 100 }),
      'sendDonation'
    );
    expect(result).toEqual({ txHash: 'abc123', ledger: 100 });
  });

  it('re-throws a classified error object when the operation rejects', async () => {
    await expect(
      StellarErrorHandler.wrap(
        async () => { throw new Error('ECONNREFUSED 127.0.0.1:11626'); },
        'getBalance'
      )
    ).rejects.toMatchObject({
      status: 503,
      code: 'NETWORK_ERROR',
    });
  });

  it('re-throws TRANSACTION_FAILED when the operation throws a tx_failed error', async () => {
    await expect(
      StellarErrorHandler.wrap(
        async () => { throw new Error('tx_failed: bad sequence'); },
        'submitTransaction'
      )
    ).rejects.toMatchObject({
      status: 400,
      code: 'TRANSACTION_FAILED',
    });
  });

  it('re-throws STELLAR_ERROR for unrecognized errors', async () => {
    await expect(
      StellarErrorHandler.wrap(
        async () => { throw new Error('Completely unrecognised error zzz'); },
        'unknown'
      )
    ).rejects.toMatchObject({
      status: 500,
      code: 'STELLAR_ERROR',
    });
  });

  it('passes the operation result through when it is a falsy value', async () => {
    const result = await StellarErrorHandler.wrap(async () => null, 'getNull');
    expect(result).toBeNull();
  });
});
