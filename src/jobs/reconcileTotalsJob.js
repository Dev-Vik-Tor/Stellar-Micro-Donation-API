'use strict';

/**
 * Periodic reconciliation job for DonationTotalsRepository.
 *
 * Recomputes per-recipient totals from the source-of-truth transactions table
 * and corrects any drift in the pre-aggregated donation_totals table.
 * Coordinated via scheduler lock so only one instance runs at a time.
 */

const DonationTotalsRepository = require('../services/DonationTotalsRepository');
const log = require('../utils/log');
const leaderElection = require('../utils/leaderElection');

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const LOCK_NAME = 'reconcile_totals_job';

let _timer = null;
const _repo = new DonationTotalsRepository();

async function runOnce() {
  const isLeader = await leaderElection.acquireLease(LOCK_NAME, DEFAULT_INTERVAL_MS * 2);
  if (!isLeader) {
    log.debug('RECONCILE_TOTALS_JOB', 'Skipping reconciliation tick — lease held by another instance');
    return;
  }

  try {
    const result = await _repo.reconcile();
    log.info('RECONCILE_TOTALS_JOB', 'Reconciliation complete', result);
  } catch (err) {
    log.error('RECONCILE_TOTALS_JOB', 'Reconciliation failed', { error: err.message });
  }
}

function start(intervalMs = DEFAULT_INTERVAL_MS) {
  if (_timer) return;
  _timer = setInterval(runOnce, intervalMs);
  if (_timer.unref) _timer.unref();
  log.info('RECONCILE_TOTALS_JOB', 'Reconciliation job started', { intervalMs });
}

function stop() {
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
  }
}

module.exports = { start, stop, runOnce };
