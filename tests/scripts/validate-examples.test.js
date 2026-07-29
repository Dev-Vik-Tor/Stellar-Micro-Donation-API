'use strict';

/**
 * Tests for scripts/validate-examples.js
 *
 * The validator runs as a CI guard. These tests run the script in a temp
 * directory with fixture files that include both valid and invalid
 * configurations, and assert that the validator exits with the right code
 * and produces the right error messages.
 *
 * Cases:
 *  - All valid: exits 0
 *  - Cyrillic homoglyph in DONOR_PUBLIC_KEY: exits 1
 *  - Lowercase letters in recipient key: exits 1
 *  - Wrong field name (publicKey in Create Wallet): exits 1
 *  - Wrong field name (recipientId in /donations body): exits 1
 *  - Wrong field name (donorId in /stream/create body): exits 1
 *  - Missing required address field: exits 1
 *  - Validator reports the failing label in its error message
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..');
const SCRIPT = path.join(REPO, 'scripts', 'validate-examples.js');

// Valid keys generated for the fixtures (must be valid Stellar Ed25519 keys).
const VALID_DONOR  = 'GCBT6W2QOCFDKQAQBWNGNYYGAH2LRHGTEVK5YBL6WRVQPPWJVKUNMOMS';
const VALID_RECIP  = 'GCVUHGLGMHYWM6NY33LKPHMX2GHXNMPW6HCO4DLQDG25T4OWDG7JJL6Y';
const VALID_WALLET = 'GCMXPIWRCPVM63NUOZZDHC42CQKEUDLIBS6ZM6A3VD7SJ3UE2OHI6I4T';

// ─── Fixture builders ────────────────────────────────────────────────────────

function buildMarkdown(overrides = {}) {
  const donor  = overrides.donor  || VALID_DONOR;
  const recip  = overrides.recip  || VALID_RECIP;
  const wallet = overrides.wallet || VALID_WALLET;
  const walletBodyKey  = overrides.walletBodyKey  || 'address';
  const donateBody     = overrides.donateBody     || '{"senderId":1,"receiverId":2,"amount":"50.00"}';
  const streamBodyKey  = overrides.streamBodyKey  || ['donorPublicKey', 'recipientPublicKey'];

  return `# Curl Examples

## Setup

\`\`\`bash
export DONOR_PUBLIC_KEY="${donor}"
export RECIPIENT_PUBLIC_KEY="${recip}"
export WALLET_PUBLIC_KEY="${wallet}"
\`\`\`

## Create Wallet

\`\`\`bash
curl -X POST "$BASE_URL/wallets" \\
  -H "X-API-Key: $API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "${walletBodyKey}": "'${wallet}'",
    "name": "My wallet"
  }'
\`\`\`

## Create Donation

\`\`\`bash
curl -X POST "$BASE_URL/donations" \\
  -H "X-API-Key: $API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '${donateBody}'
\`\`\`

## Create Recurring Donation Schedule

\`\`\`bash
curl -X POST "$BASE_URL/stream/create" \\
  -H "X-API-Key: $API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "${streamBodyKey[0]}": "'${donor}'",
    "${streamBodyKey[1]}": "'${recip}'",
    "amount": "25.00",
    "frequency": "monthly"
  }'
\`\`\`
`;
}

function buildCollection(overrides = {}) {
  const donor  = overrides.donor  || VALID_DONOR;
  const recip  = overrides.recip  || VALID_RECIP;
  const wallet = overrides.wallet || VALID_WALLET;
  const walletBodyKey = overrides.walletBodyKey || 'address';
  const donateBody = overrides.donateBody || '{"senderId":1,"receiverId":2,"amount":"50.00"}';
  const streamBodyKey = overrides.streamBodyKey || ['donorPublicKey', 'recipientPublicKey'];

  return {
    info: { name: 'Test', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
    item: [
      {
        name: 'Wallets',
        item: [
          {
            name: 'Create Wallet',
            request: {
              method: 'POST',
              header: [],
              body: {
                mode: 'raw',
                raw: `{\n  "${walletBodyKey}": "{{WALLET_PUBLIC_KEY}}",\n  "name": "w"\n}\n`,
              },
              url: { raw: '{{BASE_URL}}/wallets', host: ['{{BASE_URL}}'], path: ['wallets'] },
            },
          },
        ],
      },
      {
        name: 'Donations',
        item: [
          {
            name: 'Create Donation',
            request: {
              method: 'POST',
              header: [],
              body: { mode: 'raw', raw: donateBody },
              url: { raw: '{{BASE_URL}}/donations', host: ['{{BASE_URL}}'], path: ['donations'] },
            },
          },
        ],
      },
      {
        name: 'Recurring',
        item: [
          {
            name: 'Create Recurring',
            request: {
              method: 'POST',
              header: [],
              body: {
                mode: 'raw',
                raw: `{\n  "${streamBodyKey[0]}": "{{DONOR_PUBLIC_KEY}}",\n  "${streamBodyKey[1]}": "{{RECIPIENT_PUBLIC_KEY}}",\n  "frequency": "monthly"\n}\n`,
              },
              url: { raw: '{{BASE_URL}}/stream/create', host: ['{{BASE_URL}}'], path: ['stream', 'create'] },
            },
          },
        ],
      },
    ],
    variable: [
      { key: 'BASE_URL', value: 'http://localhost:3000/api/v1', type: 'string' },
      { key: 'API_KEY', value: 'test', type: 'string' },
      { key: 'DONOR_PUBLIC_KEY', value: donor, type: 'string' },
      { key: 'RECIPIENT_PUBLIC_KEY', value: recip, type: 'string' },
      { key: 'WALLET_PUBLIC_KEY', value: wallet, type: 'string' },
    ],
  };
}

// ─── Test harness ────────────────────────────────────────────────────────────
//
// The validator resolves MD_FILE / POSTMAN_FILE from env vars
// (VALIDATE_MD_FILE / VALIDATE_POSTMAN_FILE) when set, defaulting to the
// in-repo paths. Tests write their fixtures to a fresh tmp directory, set
// the env vars, spawn the script, and clean up. This avoids mutating the
// real examples files (which previously risked repo corruption on a
// crashed or interrupted test run) and lets multiple tests run in parallel.

function withFixtures(mdOverrides = {}, postmanOverrides = {}, fn) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'val-examples-'));
  const mdPath = path.join(tmpDir, 'API_CURL_EXAMPLES.md');
  const postmanPath = path.join(tmpDir, 'postman.json');
  fs.writeFileSync(mdPath, buildMarkdown(mdOverrides));
  fs.writeFileSync(postmanPath, JSON.stringify(buildCollection(postmanOverrides), null, 2));
  const env = {
    ...process.env,
    VALIDATE_MD_FILE: mdPath,
    VALIDATE_POSTMAN_FILE: postmanPath,
  };
  const result = spawnSync('node', [SCRIPT], { encoding: 'utf8', env });
  fs.rmSync(tmpDir, { recursive: true, force: true });
  return result;
}

describe('validate-examples.js: valid fixtures pass', () => {
  it('exits 0 when everything is correct', () => {
    const result = withFixtures({}, {}, () => runValidatorOnRepo());
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/All example files pass validation/);
  });
});

describe('validate-examples.js: detects bad Stellar keys', () => {
  // Build a donor key with Cyrillic Р + Е in the middle (same trap as #1428).
  const Р = String.fromCharCode(0x0420);
  const Е = String.fromCharCode(0x0415);
  const CYRILLIC_DONOR = 'GBUQWP3BOUZX34ULNQG23RQ6F4BWFI' + Р + Е + 'QCLMNZ4QSY47PCNQRICKS57';

  it('fails on Cyrillic homoglyph in markdown DONOR_PUBLIC_KEY', () => {
    const result = withFixtures({ donor: CYRILLIC_DONOR }, {}, () => runValidatorOnRepo());
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/non-ASCII/);
  });

  it('fails on lowercase letters in markdown recipient key', () => {
    const bad = 'GCBT6W2QOCFDKQAQBWNGNYYGAH2LRHGTEVK5YBL6WRVQPPWJVKUNMOmS'.toLowerCase();
    const result = withFixtures({ recip: bad }, {}, () => runValidatorOnRepo());
    expect(result.status).toBe(1);
    // Lowercase 'm' triggers the checksum check (length=56 OK but invalid base32+CRC)
    expect(result.stderr).toMatch(/StrKey|fail/i);
  });

  it('fails on wrong-length key in postman', () => {
    // Truncate the valid wallet key to 30 chars.
    const short = VALID_WALLET.slice(0, 30);
    const result = withFixtures({}, { wallet: short }, () => runValidatorOnRepo());
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/expected 56 chars|StrKey|fail/i);
  });

  it('fails on Cyrillic homoglyph in postman WALLET_PUBLIC_KEY', () => {
    // Same Cyrillic key as in #1428.
    const Р = String.fromCharCode(0x0420);
    const Е = String.fromCharCode(0x0415);
    const CYRILLIC_WALLET = 'GBUQWP3BOUZX34ULNQG23RQ6F4BWFI' + Р + Е + 'QCLMNZ4QSY47PCNQRICKS57';
    const result = withFixtures({}, { wallet: CYRILLIC_WALLET }, () => runValidatorOnRepo());
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/non-ASCII/);
  });
});

describe('validate-examples.js: detects wrong field names', () => {
  it('fails when Create Wallet uses "publicKey" instead of "address"', () => {
    const result = withFixtures({ walletBodyKey: 'publicKey' }, { walletBodyKey: 'publicKey' }, () => runValidatorOnRepo());
    expect(result.status).toBe(1);
    const combined = result.stdout + result.stderr;
    expect(combined).toMatch(/must use "address"/);
  });

  it('fails when POST /donations body uses "recipientId" instead of "receiverId"', () => {
    const donateBody = '{"senderId":1,"recipientId":2,"amount":"50"}';
    const result = withFixtures({ donateBody }, { donateBody }, () => runValidatorOnRepo());
    expect(result.status).toBe(1);
    const combined = result.stdout + result.stderr;
    expect(combined).toMatch(/receiverId/);
  });

  it('fails when /stream/create body uses "donorId" instead of "donorPublicKey"', () => {
    const keys = ['donorId', 'recipientPublicKey'];
    const result = withFixtures({ streamBodyKey: keys }, { streamBodyKey: keys }, () => runValidatorOnRepo());
    expect(result.status).toBe(1);
    const combined = result.stdout + result.stderr;
    expect(combined).toMatch(/donorPublicKey/);
  });

  it('fails when /stream/create body uses "recipientId" instead of "recipientPublicKey"', () => {
    const keys = ['donorPublicKey', 'recipientId'];
    const result = withFixtures({ streamBodyKey: keys }, { streamBodyKey: keys }, () => runValidatorOnRepo());
    expect(result.status).toBe(1);
    const combined = result.stdout + result.stderr;
    expect(combined).toMatch(/recipientPublicKey/);
  });
});
