'use strict';

/**
 * Parity contract test for StellarPayments vs MockPayments — Issue #1303.
 *
 * Asserts that every public method defined on MockPayments also exists on
 * StellarPayments with the same declared arity, so the class of drift where
 * a method works in dev/test (mock) but throws TypeError in production (real)
 * is caught automatically in CI.
 *
 * This test was introduced to guard against the specific regression where
 * `sendPayment` was present on MockPayments but absent on StellarPayments,
 * causing a silent production-only failure in three independent callers.
 */

const StellarPayments = require('../../src/services/stellar/payments');
const MockPayments = require('../../src/services/mock/payments');

// ── helpers ──────────────────────────────────────────────────────────────────

/** Collect all own method names from a class prototype, excluding constructor. */
function getOwnMethods(Cls) {
  return Object.getOwnPropertyNames(Cls.prototype).filter(
    (name) => name !== 'constructor' && typeof Cls.prototype[name] === 'function'
  );
}

// ── build method surface maps ─────────────────────────────────────────────────

const mockMethods = getOwnMethods(MockPayments);
const realMethods = new Set(getOwnMethods(StellarPayments));

// ── documented divergences ───────────────────────────────────────────────────
//
// Methods that intentionally exist only on MockPayments (e.g. test-only
// helpers) can be listed here. Any entry NOT in this set that is missing from
// StellarPayments will fail the parity check.
//
// To close a gap: implement the method on StellarPayments and remove the entry.
const MOCK_ONLY_METHODS = new Set([
  // simulateTransaction exists only on the mock; real service has no equivalent
  // offline simulation utility.
  'simulateTransaction',
]);

// ── parity matrix ─────────────────────────────────────────────────────────────

describe('StellarPayments ⇄ MockPayments method-surface parity (#1303)', () => {

  describe('every MockPayments method also exists on StellarPayments', () => {
    test.each(mockMethods.map((name) => [name]))(
      '%s() — present on both implementations',
      (methodName) => {
        if (MOCK_ONLY_METHODS.has(methodName)) {
          // Documented mock-only helper — intentionally absent from real impl.
          expect(MOCK_ONLY_METHODS.has(methodName)).toBe(true);
          return;
        }

        expect(realMethods.has(methodName)).toBe(true);
      }
    );
  });

  describe('method arity agreement', () => {
    test.each(
      mockMethods
        .filter((name) => !MOCK_ONLY_METHODS.has(name) && realMethods.has(name))
        .map((name) => [name])
    )(
      '%s() — declared arity matches between mock and real',
      (methodName) => {
        const mockArity = MockPayments.prototype[methodName].length;
        const realArity = StellarPayments.prototype[methodName].length;
        expect(realArity).toBe(mockArity);
      }
    );
  });

  // ── focused regression guard for #1303 ─────────────────────────────────────

  describe('sendPayment() — #1303 regression guard', () => {
    test('StellarPayments has sendPayment() as an own method', () => {
      expect(typeof StellarPayments.prototype.sendPayment).toBe('function');
      // Must be an own method, not inherited from a base class.
      expect(
        Object.prototype.hasOwnProperty.call(StellarPayments.prototype, 'sendPayment')
      ).toBe(true);
    });

    test('MockPayments has sendPayment() as an own method', () => {
      expect(typeof MockPayments.prototype.sendPayment).toBe('function');
      expect(
        Object.prototype.hasOwnProperty.call(MockPayments.prototype, 'sendPayment')
      ).toBe(true);
    });

    test('sendPayment() arity agrees between mock and real', () => {
      expect(StellarPayments.prototype.sendPayment.length).toBe(
        MockPayments.prototype.sendPayment.length
      );
    });

    test('mock sendPayment() accepts (sourcePublicKey, destinationPublic, amount, memo) and returns a hash', async () => {
      const MockStellarService = require('../../src/services/MockStellarService');
      const svc = new MockStellarService({ network: 'testnet' });
      const payments = svc.payments; // MockPayments instance attached by MockStellarService

      const srcKey = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';
      const dstKey = 'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';

      const result = await payments.sendPayment(srcKey, dstKey, '10', 'test memo');

      expect(result).toEqual(
        expect.objectContaining({
          hash: expect.any(String),
          ledger: expect.any(Number),
        })
      );
    });
  });
});
