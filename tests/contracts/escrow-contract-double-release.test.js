'use strict';

/**
 * Tests for EscrowContract — issue #1339
 * Verifies that the _released flag is respected by both release() and deposit(),
 * closing the double-release / double-spend window.
 */

const EscrowContract = require('../../src/contracts/EscrowContract');

describe('EscrowContract', () => {
  // ── Constructor ────────────────────────────────────────────────────────────

  describe('constructor', () => {
    it('creates an escrow with the specified goal amount', () => {
      const escrow = new EscrowContract(100);
      const state = escrow.getState();
      expect(state.goalAmount).toBe(100);
      expect(state.balance).toBe(0);
      expect(state.released).toBe(false);
    });

    it('throws when goalAmount is zero', () => {
      expect(() => new EscrowContract(0)).toThrow('goalAmount must be positive');
    });

    it('throws when goalAmount is negative', () => {
      expect(() => new EscrowContract(-1)).toThrow('goalAmount must be positive');
    });

    it('throws when goalAmount is non-finite', () => {
      expect(() => new EscrowContract(Infinity)).toThrow('goalAmount must be positive');
      expect(() => new EscrowContract(NaN)).toThrow('goalAmount must be positive');
    });
  });

  // ── deposit() ─────────────────────────────────────────────────────────────

  describe('deposit()', () => {
    it('accepts a valid deposit and updates balance', () => {
      const escrow = new EscrowContract(100);
      const result = escrow.deposit('donor1', 50);
      expect(result.donorId).toBe('donor1');
      expect(result.amount).toBe(50);
      expect(result.newBalance).toBe(50);
      expect(escrow.getState().balance).toBe(50);
    });

    it('accumulates multiple deposits from the same donor', () => {
      const escrow = new EscrowContract(100);
      escrow.deposit('donor1', 30);
      escrow.deposit('donor1', 40);
      expect(escrow.getState().donors['donor1']).toBe(70);
    });

    it('tracks deposits from different donors independently', () => {
      const escrow = new EscrowContract(100);
      escrow.deposit('donor1', 60);
      escrow.deposit('donor2', 40);
      const state = escrow.getState();
      expect(state.donors['donor1']).toBe(60);
      expect(state.donors['donor2']).toBe(40);
      expect(state.balance).toBe(100);
    });

    it('throws when amount is zero', () => {
      const escrow = new EscrowContract(100);
      expect(() => escrow.deposit('donor1', 0)).toThrow('amount must be positive');
    });

    it('throws when amount is negative', () => {
      const escrow = new EscrowContract(100);
      expect(() => escrow.deposit('donor1', -10)).toThrow('amount must be positive');
    });

    it('throws when amount is not a number', () => {
      const escrow = new EscrowContract(100);
      expect(() => escrow.deposit('donor1', '50')).toThrow('amount must be positive');
    });

    // ── Post-release deposit guard ─────────────────────────────────────────

    it('rejects a deposit after the escrow has been released', () => {
      const escrow = new EscrowContract(100);
      escrow.deposit('donor1', 100);
      escrow.release('recipient1');

      expect(() => escrow.deposit('donor1', 50)).toThrow(
        'Escrow already released; deposits are no longer accepted'
      );
    });

    it('does not change state when a post-release deposit is rejected', () => {
      const escrow = new EscrowContract(100);
      escrow.deposit('donor1', 100);
      escrow.release('recipient1');

      const stateBefore = escrow.getState();

      try {
        escrow.deposit('donor2', 50);
      } catch (_) {
        // expected
      }

      const stateAfter = escrow.getState();
      expect(stateAfter.balance).toBe(stateBefore.balance);
      expect(stateAfter.released).toBe(true);
    });
  });

  // ── release() ─────────────────────────────────────────────────────────────

  describe('release()', () => {
    it('succeeds when the goal is exactly met', () => {
      const escrow = new EscrowContract(100);
      escrow.deposit('donor1', 100);
      const result = escrow.release('recipient1');

      expect(result.recipientId).toBe('recipient1');
      expect(result.amount).toBe(100);
      expect(result.events).toHaveLength(1);
      expect(result.events[0].type).toBe('release');
      expect(result.events[0].data.amount).toBe(100);
    });

    it('succeeds when balance exceeds the goal', () => {
      const escrow = new EscrowContract(100);
      escrow.deposit('donor1', 150);
      const result = escrow.release('recipient1');
      expect(result.amount).toBe(150);
    });

    it('sets released to true after a successful release', () => {
      const escrow = new EscrowContract(100);
      escrow.deposit('donor1', 100);
      escrow.release('recipient1');
      expect(escrow.getState().released).toBe(true);
    });

    it('zeroes the balance after release', () => {
      const escrow = new EscrowContract(100);
      escrow.deposit('donor1', 100);
      escrow.release('recipient1');
      expect(escrow.getState().balance).toBe(0);
    });

    it('throws when the goal has not been reached', () => {
      const escrow = new EscrowContract(100);
      escrow.deposit('donor1', 50);
      expect(() => escrow.release('recipient1')).toThrow('Goal not yet reached');
    });

    it('throws when called on an empty escrow', () => {
      const escrow = new EscrowContract(100);
      expect(() => escrow.release('recipient1')).toThrow('Goal not yet reached');
    });

    // ── Double-release guard (the core issue #1339 fix) ───────────────────

    it('throws on a second release() call — no double-spend', () => {
      const escrow = new EscrowContract(100);
      escrow.deposit('donor1', 100);
      escrow.release('recipient1'); // first release succeeds

      expect(() => escrow.release('recipient1')).toThrow(
        'Escrow already released; double-release is not allowed'
      );
    });

    it('second release() does not fire another payout event', () => {
      const escrow = new EscrowContract(100);
      escrow.deposit('donor1', 100);
      const firstResult = escrow.release('recipient1');
      expect(firstResult.events[0].data.amount).toBe(100);

      let caughtError = null;
      try {
        escrow.release('recipient1');
      } catch (err) {
        caughtError = err;
      }

      expect(caughtError).not.toBeNull();
      expect(caughtError.message).toMatch(/double-release/);
    });

    it('reproduces the exact double-spend scenario from the issue report', () => {
      // Scenario: deposit 100 (goal 100), release(), then deposit 100 again,
      // then call release() a second time — must be rejected.
      const escrow = new EscrowContract(100);

      escrow.deposit('donor1', 100);
      const firstRelease = escrow.release('recipient1');
      expect(firstRelease.amount).toBe(100); // first payout is legitimate

      // This deposit should be rejected now that the escrow is released
      expect(() => escrow.deposit('donor1', 100)).toThrow(
        'Escrow already released; deposits are no longer accepted'
      );

      // Even if a deposit somehow got through, a second release must throw
      expect(() => escrow.release('recipient1')).toThrow(
        'Escrow already released; double-release is not allowed'
      );
    });
  });

  // ── getState() ────────────────────────────────────────────────────────────

  describe('getState()', () => {
    it('returns a snapshot (not a live reference) of the donors map', () => {
      const escrow = new EscrowContract(100);
      escrow.deposit('donor1', 50);
      const state1 = escrow.getState();
      escrow.deposit('donor2', 50);
      const state2 = escrow.getState();

      expect(Object.keys(state1.donors)).toHaveLength(1);
      expect(Object.keys(state2.donors)).toHaveLength(2);
    });
  });
});
