/**
 * CorporateMatchingService
 * Manages employer allowlist, match ratios, annual caps, and the claim workflow.
 * State is persisted to the database (fixes #1134).
 */

const crypto = require('crypto');
const db = require('../utils/database');

class CorporateMatchingService {
  constructor(stellarService = null) {
    this.stellarService = stellarService;
  }

  // ─── Employer Management ────────────────────────────────────────────────────

  async addEmployer(employerId, name, matchRatio, annualCap) {
    if (!employerId || !name) throw new Error('employerId and name are required');
    if (typeof matchRatio !== 'number' || matchRatio <= 0 || matchRatio > 10) {
      throw new Error('matchRatio must be a positive number between 0.01 and 10');
    }
    if (!annualCap || annualCap <= 0) throw new Error('annualCap must be a positive number');

    const addedAt = new Date().toISOString();
    await db.run(
      `INSERT INTO corporate_employers (id, name, matchRatio, annualCap, addedAt)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name=excluded.name, matchRatio=excluded.matchRatio,
         annualCap=excluded.annualCap`,
      [employerId, name, matchRatio, annualCap, addedAt]
    );
    return { employerId, name, matchRatio, annualCap, addedAt };
  }

  async listEmployers() {
    const rows = await db.all('SELECT * FROM corporate_employers');
    return rows.map(r => ({ employerId: r.id, name: r.name, matchRatio: r.matchRatio, annualCap: r.annualCap, addedAt: r.addedAt }));
  }

  async isEmployerAllowed(employerId) {
    const row = await db.get('SELECT id FROM corporate_employers WHERE id = ?', [employerId]);
    return Boolean(row);
  }

  // ─── Annual Cap Tracking ─────────────────────────────────────────────────────

  async getYearlyMatchedAmount(donorId, employerId) {
    const year = new Date().getFullYear();
    const yearStart = `${year}-01-01T00:00:00.000Z`;
    const yearEnd = `${year + 1}-01-01T00:00:00.000Z`;
    const row = await db.get(
      `SELECT COALESCE(SUM(matchAmount), 0) as total FROM corporate_claims
       WHERE donorId = ? AND employerId = ? AND status = 'approved'
         AND createdAt >= ? AND createdAt < ?`,
      [donorId, employerId, yearStart, yearEnd]
    );
    return row ? row.total : 0;
  }

  // ─── Claim Workflow ──────────────────────────────────────────────────────────

  async submitClaim(donorId, employerId, donationAmount) {
    if (!donorId) throw new Error('donorId is required');
    if (!(await this.isEmployerAllowed(employerId))) throw new Error(`Employer '${employerId}' is not in the allowlist`);
    if (!donationAmount || donationAmount <= 0) throw new Error('donationAmount must be a positive number');

    const employer = await db.get('SELECT * FROM corporate_employers WHERE id = ?', [employerId]);
    const matchAmount = donationAmount * employer.matchRatio;

    const alreadyMatched = await this.getYearlyMatchedAmount(donorId, employerId);
    const remaining = employer.annualCap - alreadyMatched;
    if (remaining <= 0) {
      throw new Error(`Annual cap of ${employer.annualCap} XLM reached for employer '${employerId}'`);
    }

    const effectiveMatch = Math.min(matchAmount, remaining);
    const id = crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex');
    const createdAt = new Date().toISOString();

    await db.run(
      `INSERT INTO corporate_claims (id, donorId, employerId, donationAmount, matchAmount, status, createdAt)
       VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
      [id, donorId, employerId, donationAmount, effectiveMatch, createdAt]
    );
    return { id, donorId, employerId, donationAmount, matchAmount: effectiveMatch, status: 'pending', createdAt };
  }

  async listClaims(status) {
    const rows = status
      ? await db.all('SELECT * FROM corporate_claims WHERE status = ?', [status])
      : await db.all('SELECT * FROM corporate_claims');
    return rows;
  }

  async approveClaim(claimId, sourcePublicKey, donorPublicKey) {
    const claim = await db.get('SELECT * FROM corporate_claims WHERE id = ?', [claimId]);
    if (!claim) throw new Error(`Claim '${claimId}' not found`);
    if (claim.status !== 'pending') throw new Error(`Claim is already ${claim.status}`);

    const employer = await db.get('SELECT * FROM corporate_employers WHERE id = ?', [claim.employerId]);
    const alreadyMatched = await this.getYearlyMatchedAmount(claim.donorId, claim.employerId);
    if (alreadyMatched + claim.matchAmount > employer.annualCap) {
      await db.run(
        `UPDATE corporate_claims SET status='rejected', reviewedAt=?, rejectReason=? WHERE id=?`,
        [new Date().toISOString(), 'Annual cap exceeded at approval time', claimId]
      );
      return await db.get('SELECT * FROM corporate_claims WHERE id = ?', [claimId]);
    }

    let txId = null;
    if (this.stellarService) {
      const result = await this.stellarService.sendPayment(
        sourcePublicKey, donorPublicKey, claim.matchAmount,
        `Corporate match for donation by ${claim.donorId}`
      );
      txId = result.hash || result.transactionId;
    }

    const reviewedAt = new Date().toISOString();
    await db.run(
      `UPDATE corporate_claims SET status='approved', reviewedAt=?, txId=? WHERE id=?`,
      [reviewedAt, txId, claimId]
    );
    return await db.get('SELECT * FROM corporate_claims WHERE id = ?', [claimId]);
  }

  async rejectClaim(claimId, reason) {
    const claim = await db.get('SELECT * FROM corporate_claims WHERE id = ?', [claimId]);
    if (!claim) throw new Error(`Claim '${claimId}' not found`);
    if (claim.status !== 'pending') throw new Error(`Claim is already ${claim.status}`);

    await db.run(
      `UPDATE corporate_claims SET status='rejected', reviewedAt=?, rejectReason=? WHERE id=?`,
      [new Date().toISOString(), reason || null, claimId]
    );
    return await db.get('SELECT * FROM corporate_claims WHERE id = ?', [claimId]);
  }
}

module.exports = CorporateMatchingService;
