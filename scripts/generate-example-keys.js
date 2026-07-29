#!/usr/bin/env node
/* eslint-disable no-console */

/**
 * Generate 3 valid Stellar Ed25519 public keys for use as sample/test data
 * in `examples/API_CURL_EXAMPLES.md` and `examples/Stellar-Micro-Donation-API.postman_collection.json`.
 *
 * These keys are TEST DATA ONLY and must never be funded with real assets.
 *
 * Usage:
 *   node scripts/generate-example-keys.js
 *
 * Prints three lines:
 *   DONOR_PUBLIC_KEY=...
 *   RECIPIENT_PUBLIC_KEY=...
 *   WALLET_PUBLIC_KEY=...
 *
 * Each key is verified with StellarSdk.StrKey.isValidEd25519PublicKey() before
 * being printed so you can paste the output straight into the example files
 * without re-running validation.
 */

const StellarSdk = require('stellar-sdk');

if (!StellarSdk || !StellarSdk.Keypair || !StellarSdk.StrKey) {
  console.error('stellar-sdk is required. Install it: npm install stellar-sdk');
  process.exit(1);
}

const labels = ['DONOR_PUBLIC_KEY', 'RECIPIENT_PUBLIC_KEY', 'WALLET_PUBLIC_KEY'];
const out = {};

for (const label of labels) {
  // Keypair.random() pulls entropy from the OS CSPRNG and derives the public
  // keypair from a 32-byte ed25519 seed. No network access required.
  const keypair = StellarSdk.Keypair.random();
  const publicKey = keypair.publicKey();
  const valid = StellarSdk.StrKey.isValidEd25519PublicKey(publicKey);
  if (!valid) {
    console.error(`Generated key failed checksum validation: ${publicKey}`);
    process.exit(2);
  }
  out[label] = publicKey;
}

for (const label of labels) {
  console.log(`${label}=${out[label]}`);
}
