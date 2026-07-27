'use strict';

/**
 * PledgeFulfillmentService — atomically fulfills all pending pledges when a
 * campaign reaches its goal, and exposes the expiry logic used by the worker.
 *
 * Atomicity: SQLite serialises writes, so a single UPDATE inside a transaction
 * is sufficient to prevent double-fulfillment without SELECT FOR UPDATE.
 */

const Database = require('../utils/database');
const Pledge = require('../models/Pledge');
const WebhookService = require('./WebhookService');
const log = require('../utils/log');

/**
 * Called after any donation is recorded against a campaign.
 * If current_amount >= goal_amount, fulfills all pending pledges atomically.
 *
 * @param {number} campaignId
 * @returns {Promise<{fulfilled: number}>}
 */
async function checkAndFulfill(campaignId) {
  const campaign = await Database.get(
    `SELECT id, goal_amount, current_amount FROM campaigns WHERE id = ?`,
    [campaignId]
  );

  if (!campaign || campaign.current_amount < campaign.goal_amount) {
    return { fulfilled: 0 };
  }

  // Atomic update — only rows still 'pending' are touched
  await Database.run(
    `UPDATE pledges SET status = 'fulfilled'
     WHERE campaign_id = ? AND status = 'pending'`,
    [campaignId]
  );

  // Get only newly fulfilled pledges (those without webhook_sent_at)
  const newlyFulfilled = await Pledge.getNewlyFulfilledPledges(campaignId);

  // Send webhooks and mark them as sent
  for (const pledge of newlyFulfilled) {
    try {
      await WebhookService.deliver('pledge.fulfilled', { pledge });
      await Pledge.markWebhookSent(pledge.id);
    } catch (error) {
      log.error('PLEDGE', `Failed to deliver webhook for pledge ${pledge.id}: ${error.message}`);
      // Don't mark as sent if delivery failed
    }
  }

  log.info('PLEDGE', `Fulfilled ${newlyFulfilled.length} pledges for campaign ${campaignId}`);
  return { fulfilled: newlyFulfilled.length };
}

/**
 * Expire all pending pledges whose expires_at has passed.
 * Called by the expiry worker every minute.
 *
 * @param {string} [now] - ISO timestamp (injectable for testing)
 * @returns {Promise<{expired: number}>}
 */
async function expireOverdue(now = new Date().toISOString()) {
  const changed = await Pledge.expireOverdue(now);

  if (changed > 0) {
    // Get only newly expired pledges (those without webhook_sent_at)
    const newlyExpired = await Pledge.getNewlyExpiredPledges(now);
    
    // Send webhooks and mark them as sent
    for (const pledge of newlyExpired) {
      try {
        await WebhookService.deliver('pledge.expired', { pledge });
        await Pledge.markWebhookSent(pledge.id);
      } catch (error) {
        log.error('PLEDGE', `Failed to deliver webhook for expired pledge ${pledge.id}: ${error.message}`);
        // Don't mark as sent if delivery failed
      }
    }
    
    log.info('PLEDGE', `Expired ${changed} overdue pledges, sent ${newlyExpired.length} webhooks`);
  }

  return { expired: changed };
}

module.exports = { checkAndFulfill, expireOverdue };
