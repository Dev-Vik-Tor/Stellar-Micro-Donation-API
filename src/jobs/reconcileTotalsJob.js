'use strict';

/**
 * Periodic reconciliation job for DonationTotalsRepository.
 *
 * Recomputes per-recipient totals from the source-of-truth transactions table
 * and corrects any drift in the pre-aggregated donation_totals table.
 * Coordinated via scheduler lock so only one instance runs at a time.
 *
 * Uses timerRegistry.createInterval() (issue #1375) so the interval is
 * centrally tracked and automatically torn down by timerRegistry.clearAll()
 * during graceful shutdown. The explicit stop() method also clears the handle
 * for callers that need to stop the job outside of a full shutdown sequence.
 */

const DonationTotalsRepository = require('../services/DonationTotalsRepository');
const timerRegistry = require('../utils/timerRegistry');
const log = require('../utils/log');

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

/** Handle returned by timerRegistry.createInterval — used by stop(). */
let _timerHandle = null;
const _repo = new DonationTotalsRepository();

async function runOnce() {
  try {
    const result = await _repo.reconcile();
    log.info('RECONCILE_TOTALS_JOB', 'Reconciliation complete', result);
  } catch (err) {
    log.error('RECONCILE_TOTALS_JOB', 'Reconciliation failed', { error: err.message });
  }
}

/**
 * Start the reconciliation job.
 *
 * @param {number} [intervalMs=DEFAULT_INTERVAL_MS] - How often to reconcile.
 */
function start(intervalMs = DEFAULT_INTERVAL_MS) {
  if (_timerHandle) return;
  _timerHandle = timerRegistry.createInterval(runOnce, intervalMs, 'reconcile-totals-job');
  // Unref so this timer alone never prevents the process from exiting cleanly
  _timerHandle.unref();
  log.info('RECONCILE_TOTALS_JOB', 'Reconciliation job started', { intervalMs });
}

/**
 * Stop the reconciliation job and clear the timer from the registry.
 * Safe to call even if the job was never started.
 */
function stop() {
  if (_timerHandle) {
    _timerHandle.clear();
    _timerHandle = null;
  }
}

module.exports = { start, stop, runOnce };
