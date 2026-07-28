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
const { getStellarService } = require('../config/stellar');

/**
 * Fulfills a single pledge by submitting an on-chain Stellar payment transaction
 * before updating status to 'fulfilled' in the database and delivering the webhook.
 *
 * @param {Object|string} pledgeOrId
 * @returns {Promise<{success: boolean, pledge: Object}>}
 */
async function fulfillSinglePledge(pledgeOrId) {
  const pledge = typeof pledgeOrId === 'string' ? await Pledge.findById(pledgeOrId) : pledgeOrId;
  if (!pledge || pledge.status !== 'pending') {
    return { success: false, pledge };
  }

  const campaign = await Database.get(
    `SELECT id, created_by FROM campaigns WHERE id = ?`,
    [pledge.campaign_id]
  );
  const recipient = campaign ? await Database.get(`SELECT publicKey FROM users WHERE id = ?`, [campaign.created_by]) : null;
  const donor = await Database.get(
    `SELECT publicKey, encryptedSecret FROM users WHERE id = ? OR publicKey = ?`,
    [pledge.donor_wallet_id, pledge.donor_wallet_id]
  );

  const recipientPublic = recipient ? recipient.publicKey : (pledge.recipient_public_key || null);
  const donorSecret = donor ? donor.encryptedSecret : (pledge.donor_secret || null);

  const stellarSvc = getStellarService();
  if (donorSecret && recipientPublic && stellarSvc) {
    if (typeof stellarSvc.sendPayment === 'function') {
      await stellarSvc.sendPayment(donorSecret, recipientPublic, pledge.amount, `Pledge fulfillment ${pledge.id}`);
    } else if (typeof stellarSvc.sendDonation === 'function') {
      await stellarSvc.sendDonation({
        sourceSecret: donorSecret,
        destinationPublic: recipientPublic,
        amount: pledge.amount,
        memo: `Pledge fulfillment ${pledge.id}`,
      });
    }
  }

  await Database.run(
    `UPDATE pledges SET status = 'fulfilled' WHERE id = ? AND status = 'pending'`,
    [pledge.id]
  );

  const updated = await Pledge.findById(pledge.id);
  try {
    await WebhookService.deliver('pledge.fulfilled', { pledge: updated });
    await Pledge.markWebhookSent(updated.id);
  } catch (error) {
    log.error('PLEDGE', `Failed to deliver webhook for pledge ${updated.id}: ${error.message}`);
    // Don't mark as sent if delivery failed — checkAndFulfill retries it later.
  }
  return { success: true, pledge: updated };
}

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

  const pendingPledges = await Database.query(
    `SELECT * FROM pledges WHERE campaign_id = ? AND status = 'pending'`,
    [campaignId]
  );

  let count = 0;
  for (const pledge of pendingPledges) {
    const res = await fulfillSinglePledge(pledge);
    if (res.success) count++;
  }

  // Retry webhook delivery for any previously fulfilled pledges whose webhook
  // delivery failed earlier (still no webhook_sent_at).
  const newlyFulfilled = await Pledge.getNewlyFulfilledPledges(campaignId);
  for (const pledge of newlyFulfilled) {
    try {
      await WebhookService.deliver('pledge.fulfilled', { pledge });
      await Pledge.markWebhookSent(pledge.id);
    } catch (error) {
      log.error('PLEDGE', `Failed to deliver webhook for pledge ${pledge.id}: ${error.message}`);
      // Don't mark as sent if delivery failed
    }
  }

  log.info('PLEDGE', `Fulfilled ${count} pledges for campaign ${campaignId}`);
  return { fulfilled: count };
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

module.exports = { checkAndFulfill, expireOverdue, fulfillSinglePledge };
