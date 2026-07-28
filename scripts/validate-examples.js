#!/usr/bin/env node
/* eslint-disable-next-line */

/**
 * validate-examples.js
 *
 * CI guard for `examples/` directory. Fails (exit 1) if:
 *  - Any embedded Stellar public key fails StellarSdk.StrKey.isValidEd25519PublicKey()
 *  - Any embedded Stellar public key contains non-ASCII bytes (Cyrillic homoglyphs,
 *    zero-width characters, etc.) — see issue #1428
 *  - Any request body uses a known-wrong field name (e.g. `publicKey` for the
 *    Create Wallet body, `recipientId` for the custodial donation path,
 *    `donorId` / `recipientId` for the recurring-schedule body)
 *
 * Usage:
 *   node scripts/validate-examples.js
 *
 * Exit codes:
 *   0 — all checks passed
 *   1 — one or more checks failed (printed to stderr)
 *   2 — missing dependency (stellar-sdk)
 */

const fs = require('fs');
const path = require('path');

let StellarSdk;
try {
  StellarSdk = require('stellar-sdk');
} catch (err) {
  console.error('stellar-sdk is required. Install it: npm install stellar-sdk');
  process.exit(2);
}

const ROOT = path.resolve(__dirname, '..');
const MD_FILE = path.join(ROOT, 'examples', 'API_CURL_EXAMPLES.md');
const POSTMAN_FILE = path.join(ROOT, 'examples', 'Stellar-Micro-Donation-API.postman_collection.json');

const failures = [];
function fail(label, detail) {
  failures.push({ label, detail });
  console.error(`  ✗ ${label}: ${detail}`);
}

/**
 * Validate a single Stellar public key string:
 *  - Pure ASCII (rejects Cyrillic homoglyphs, zero-width chars, etc.)
 *  - Exactly 56 characters
 *  - Passes StellarSdk.StrKey.isValidEd25519PublicKey()
 */
function checkKey(label, key) {
  if (typeof key !== 'string' || key.length === 0) {
    fail(label, `expected non-empty string, got ${typeof key}`);
    return;
  }
  let hasNonAscii = false;
  for (let i = 0; i < key.length; i++) {
    if (key.charCodeAt(i) >= 128) {
      hasNonAscii = true;
      break;
    }
  }
  if (hasNonAscii) {
    const codes = [];
    for (let i = 0; i < key.length; i++) {
      if (key.charCodeAt(i) >= 128) {
        const hex = key.charCodeAt(i).toString(16).padStart(4, '0').toUpperCase();
        codes.push(`U+${hex}`);
      }
    }
    fail(label, `non-ASCII bytes [${codes.slice(0, 3).join(', ')}${codes.length > 3 ? ', ...' : ''}]: ${key}`);
    return;
  }
  if (key.length !== 56) {
    fail(label, `expected 56 chars, got ${key.length}: ${key}`);
    return;
  }
  if (!StellarSdk.StrKey.isValidEd25519PublicKey(key)) {
    fail(label, `failed StellarSdk.StrKey.isValidEd25519PublicKey(): ${key}`);
    return;
  }
  console.log(`  ✓ ${label}: ${key}`);
}

/**
 * Find lines like  NAME="value"  or  NAME=value  inside a markdown file and
 * return the { name, value } pairs. Used to extract DONOR_PUBLIC_KEY=… from
 * the bash setup block.
 */
function extractBashExports(markdown) {
  const out = {};
  // Parse line-by-line, avoiding regexes entirely so the security plugin
  // can't false-flag them. We support both  export NAME="value"  and
  //  NAME="value"  forms; values must be double-quoted.
  for (const rawLine of markdown.split('\n')) {
    const line = rawLine.trim();
    let body = line;
    if (body.startsWith('export ')) body = body.slice('export '.length).trim();
    else if (body.startsWith('export\t')) body = body.slice('export\t'.length).trim();
    const eqIdx = body.indexOf('=');
    if (eqIdx <= 0) continue;
    const name = body.slice(0, eqIdx).trim();
    if (!/^[A-Z_][A-Z0-9_]*$/.test(name)) continue;
    const valueRaw = body.slice(eqIdx + 1).trim();
    if (valueRaw.length < 2 || valueRaw[0] !== '"' || valueRaw[valueRaw.length - 1] !== '"') {
      continue;
    }
    out[name] = valueRaw.slice(1, -1);
  }
  return out;
}

/**
 * Locate the first JSON-looking body inside a `### Some Title` markdown
 * section. Returns the parsed object or null if none is found.
 */
function findSectionBody(markdown, label) {
  // Scan line-by-line rather than using a multi-line regex: this is the
  // most ReDoS-safe approach and also more readable. The label values
  // ('Create Wallet', 'Create Donation', 'Create Recurring Donation
  // Schedule') are static ASCII strings.
  const lines = markdown.split(/\r?\n/);
  let inSection = false;
  let inFence = false;
  const collected = [];
  for (const line of lines) {
    if (!inSection) {
      if (line.startsWith('### ') && line.slice(4).trim() === label) {
        inSection = true;
      }
      continue;
    }
    if (inFence) {
      if (line.trim().startsWith('```')) {
        // End of the code block.
        const text = collected.join('\n').trim();
        if (!text.startsWith('{') && !text.startsWith('[')) return null;
        try {
          return JSON.parse(text);
        } catch (_) {
          return null;
        }
      }
      collected.push(line);
      continue;
    }
    if (line.trim().startsWith('```') && collected.length === 0) {
      inFence = true;
    }
  }
  return null;
}

function checkMarkdown() {
  console.log(`Validating ${path.relative(ROOT, MD_FILE)}:`);
  if (!fs.existsSync(MD_FILE)) {
    fail('examples/API_CURL_EXAMPLES.md', 'file does not exist');
    return;
  }
  const md = fs.readFileSync(MD_FILE, 'utf8');
  const exports_ = extractBashExports(md);
  const expectedKeys = ['DONOR_PUBLIC_KEY', 'RECIPIENT_PUBLIC_KEY', 'WALLET_PUBLIC_KEY'];
  for (const k of expectedKeys) {
    if (!(k in exports_)) {
      fail(`API_CURL_EXAMPLES.md:${k}`, 'no `export NAME="..."` definition found in setup block');
    } else {
      checkKey(`API_CURL_EXAMPLES.md:${k}`, exports_[k]);
    }
  }

  const walletBody = findSectionBody(md, 'Create Wallet');
  if (walletBody) {
    if (Object.prototype.hasOwnProperty.call(walletBody, 'publicKey')) {
      fail('API_CURL_EXAMPLES.md:Create Wallet', 'must use "address" (not "publicKey")');
    } else if (!Object.prototype.hasOwnProperty.call(walletBody, 'address')) {
      fail('API_CURL_EXAMPLES.md:Create Wallet', 'missing required "address" field');
    }
  }

  // The custodial donation body is the FIRST "### Create Donation" section.
  // It may or may not exist depending on whether the markdown includes both
  // a custodial and a non-custodial example. Check the first match.
  const donateBody = findSectionBody(md, 'Create Donation');
  if (donateBody) {
    if (Object.prototype.hasOwnProperty.call(donateBody, 'recipientId')) {
      fail('API_CURL_EXAMPLES.md:Create Donation', 'must use "receiverId" (not "recipientId") for the custodial path');
    }
  }

  const streamBody = findSectionBody(md, 'Create Recurring Donation Schedule');
  if (streamBody) {
    if (Object.prototype.hasOwnProperty.call(streamBody, 'donorId')) {
      fail('API_CURL_EXAMPLES.md:Create Recurring Donation Schedule', 'must use "donorPublicKey" (not "donorId")');
    }
    if (Object.prototype.hasOwnProperty.call(streamBody, 'recipientId')) {
      fail('API_CURL_EXAMPLES.md:Create Recurring Donation Schedule', 'must use "recipientPublicKey" (not "recipientId")');
    }
  }
}

function walkCollectionItems(items) {
  if (!Array.isArray(items)) return;
  for (const item of items) {
    if (item && item.item) {
      walkCollectionItems(item.item);
      continue;
    }
    if (!item || !item.request) continue;
    const req = item.request;
    const url = (req.url && (typeof req.url === 'string' ? req.url : req.url.raw)) || '';
    const body = (req.body && typeof req.body.raw === 'string') ? req.body.raw : '';
    if (!body.includes('{')) continue;
    let obj = null;
    try { obj = JSON.parse(body); } catch (_) { /* skip non-JSON bodies */ }
    if (!obj || typeof obj !== 'object') continue;

    if (/\/wallets(\?|$)/.test(url) && !/\/wallets\/[^/]+\/transactions/.test(url)) {
      if (Object.prototype.hasOwnProperty.call(obj, 'publicKey')) {
        fail(`postman:${item.name || 'Create Wallet'}`, '/wallets body must use "address" (not "publicKey")');
      }
      if (!Object.prototype.hasOwnProperty.call(obj, 'address')) {
        fail(`postman:${item.name || 'Create Wallet'}`, '/wallets body missing required "address" field');
      }
    }

    if (/\/donations(\?|$)/.test(url) && !/\/donations\//.test(url)) {
      if (Object.prototype.hasOwnProperty.call(obj, 'recipientId') &&
          Object.prototype.hasOwnProperty.call(obj, 'senderId')) {
        fail(`postman:${item.name || 'Create Donation'}`, 'POST /donations body must use "receiverId" (not "recipientId") when using senderId');
      }
      if (Object.prototype.hasOwnProperty.call(obj, 'recipientId') &&
          Object.prototype.hasOwnProperty.call(obj, 'donor')) {
        fail(`postman:${item.name || 'Create Donation'}`, 'POST /donations body must use "recipient" (not "recipientId") when using donor');
      }
    }

    if (/\/stream\/create(\?|$)/.test(url)) {
      if (Object.prototype.hasOwnProperty.call(obj, 'donorId')) {
        fail(`postman:${item.name || 'Create Recurring'}`, '/stream/create body must use "donorPublicKey" (not "donorId")');
      }
      if (Object.prototype.hasOwnProperty.call(obj, 'recipientId')) {
        fail(`postman:${item.name || 'Create Recurring'}`, '/stream/create body must use "recipientPublicKey" (not "recipientId")');
      }
    }
  }
}

function checkPostman() {
  console.log(`\nValidating ${path.relative(ROOT, POSTMAN_FILE)}:`);
  if (!fs.existsSync(POSTMAN_FILE)) {
    fail('examples/Stellar-Micro-Donation-API.postman_collection.json', 'file does not exist');
    return;
  }
  let collection;
  try {
    collection = JSON.parse(fs.readFileSync(POSTMAN_FILE, 'utf8'));
  } catch (err) {
    fail('examples/Stellar-Micro-Donation-API.postman_collection.json', `JSON parse error: ${err.message}`);
    return;
  }
  const variables = Array.isArray(collection.variable) ? collection.variable : [];
  const byKey = {};
  for (const v of variables) {
    if (v && typeof v.key === 'string') byKey[v.key] = v.value;
  }
  const expectedVars = ['DONOR_PUBLIC_KEY', 'RECIPIENT_PUBLIC_KEY', 'WALLET_PUBLIC_KEY'];
  for (const k of expectedVars) {
    if (!(k in byKey)) {
      fail(`postman:${k}`, 'variable not defined in collection');
    } else {
      checkKey(`postman:${k}`, byKey[k]);
    }
  }
  walkCollectionItems(collection.item);
}

function main() {
  checkMarkdown();
  checkPostman();
  console.log('');
  if (failures.length === 0) {
    console.log('✓ All example files pass validation');
    process.exit(0);
  } else {
    console.error(`✗ ${failures.length} validation error(s):`);
    for (const f of failures) console.error(`  - ${f.label}: ${f.detail}`);
    process.exit(1);
  }
}

main();
