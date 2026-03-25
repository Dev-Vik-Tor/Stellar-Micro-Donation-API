/**
 * Mock Stellar Service - Testing and Development Layer
 *
 * RESPONSIBILITY: In-memory mock implementation for testing without network calls
 * OWNER: QA/Testing Team
 * DEPENDENCIES: StellarServiceInterface, error utilities
 *
 * Simulates Stellar blockchain behavior for development and testing environments.
 * Provides realistic error scenarios, failure simulation, and instant responses
 * without requiring actual blockchain network connectivity.
 *
 * LIMITATIONS:
 * - No actual blockchain consensus or validation
 * - No network latency simulation (instant responses unless configured)
 * - No multi-signature support
 * - No trustline enforcement
 * - Simplified path payment and DEX pricing logic for deterministic offline tests
 * - Simplified fee structure (no actual fees charged)
 * - Transaction finality is immediate (no pending states)
 */

const crypto = require('crypto');
const StellarServiceInterface = require('./interfaces/StellarServiceInterface');
const { NotFoundError, ValidationError, BusinessLogicError, ERROR_CODES } = require('../utils/errors');
const log = require('../utils/log');
const { getAssetKey, isSameAsset, serializeAsset } = require('../utils/stellarAsset');

const NATIVE_ASSET = { type: 'native', code: 'XLM', issuer: null };

class MockStellarService extends StellarServiceInterface {
  constructor(config = {}) {
    super();
    this.wallets = new Map();
    this.transactions = new Map();
    this.streamListeners = new Map();
    this.network = config.network || 'testnet';
    this.horizonUrl = config.horizonUrl || 'https://horizon-testnet.stellar.org';

    this.config = {
      networkDelay: config.networkDelay || 0,
      failureRate: config.failureRate || 0,
      rateLimit: config.rateLimit || null,
      minAccountBalance: config.minAccountBalance || '1.0000000',
      baseReserve: config.baseReserve || '1.0000000',
      strictValidation: config.strictValidation !== false,
      pathRates: config.pathRates || {},
    };

    this.requestTimestamps = [];
    this.failureSimulation = {
      enabled: false,
      type: null,
      probability: 0,
      consecutiveFailures: 0,
      maxConsecutiveFailures: 0,
    };
  }

  enableFailureSimulation(type, probability = 1.0) {
    this.failureSimulation.enabled = true;
    this.failureSimulation.type = type;
    this.failureSimulation.probability = probability;
    this.failureSimulation.consecutiveFailures = 0;
    log.info('MOCK_STELLAR_SERVICE', 'Failure simulation enabled', { type, probability });
  }

  disableFailureSimulation() {
    this.failureSimulation.enabled = false;
    this.failureSimulation.type = null;
    this.failureSimulation.probability = 0;
    this.failureSimulation.consecutiveFailures = 0;
  }

  setMaxConsecutiveFailures(max) {
    this.failureSimulation.maxConsecutiveFailures = max;
  }

  getNetwork() { return this.network; }
  getHorizonUrl() { return this.horizonUrl; }

  _isRetryableError(error) {
    return Boolean(error && error.details && error.details.retryable);
  }

  async _executeWithRetry(operation) {
    const maxFailures = this.failureSimulation.maxConsecutiveFailures;
    const maxAttempts = maxFailures > 0 ? maxFailures + 1 : 1;
    let lastError;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        return await operation();
      } catch (error) {
        lastError = error;
        if (!this._isRetryableError(error) || attempt === maxAttempts) {
          throw error;
        }
      }
    }

    throw lastError;
  }

  _ensureAssetBalances(wallet) {
    if (!wallet.assetBalances) {
      wallet.assetBalances = { native: wallet.balance || '0.0000000' };
    }
    if (!Object.prototype.hasOwnProperty.call(wallet.assetBalances, 'native')) {
      wallet.assetBalances.native = wallet.balance || '0.0000000';
    }
    wallet.balance = wallet.assetBalances.native;
  }

  _getWalletAssetBalance(wallet, asset) {
    this._ensureAssetBalances(wallet);
    return parseFloat(wallet.assetBalances[getAssetKey(asset)] || '0');
  }

  _setWalletAssetBalance(wallet, asset, amount) {
    this._ensureAssetBalances(wallet);
    wallet.assetBalances[getAssetKey(asset)] = Number(amount).toFixed(7);
    wallet.balance = wallet.assetBalances.native;
  }

  _getConversionRate(sourceAsset, destAsset) {
    if (isSameAsset(sourceAsset, destAsset)) {
      return 1;
    }

    const configuredRate = this.config.pathRates[`${getAssetKey(sourceAsset)}->${getAssetKey(destAsset)}`];
    if (configuredRate !== undefined) {
      return Number(configuredRate);
    }

    if (destAsset.type === 'native') {
      return 0.8;
    }

    if (sourceAsset.type === 'native') {
      return 1.2;
    }

    return 0.65;
  }

  _findWalletBySecret(secretKey) {
    for (const wallet of this.wallets.values()) {
      if (wallet.secretKey === secretKey) {
        return wallet;
      }
    }

    return null;
  }

  _ensureDestinationFunded(wallet) {
    const destBalance = parseFloat(wallet.balance);
    const minBalance = parseFloat(this.config.minAccountBalance);
    if (destBalance < minBalance) {
      throw new BusinessLogicError(
        ERROR_CODES.TRANSACTION_FAILED,
        `Destination account is not funded. Stellar requires accounts to maintain a minimum balance of ${this.config.minAccountBalance} XLM. ` +
        'Please fund the account first using Friendbot (testnet) or send an initial funding transaction.'
      );
    }
  }

  _applyAssetTransfer({ sourceWallet, destWallet, asset, amountNum }) {
    const sourceBalance = this._getWalletAssetBalance(sourceWallet, asset);
    const destBalance = this._getWalletAssetBalance(destWallet, asset);

    if (asset.type === 'native') {
      const baseReserve = parseFloat(this.config.baseReserve);
      if (sourceBalance - amountNum < baseReserve) {
        throw new BusinessLogicError(
          ERROR_CODES.TRANSACTION_FAILED,
          `Insufficient balance. Account must maintain minimum balance of ${this.config.baseReserve} XLM. ` +
          `Available: ${sourceBalance} XLM, Required: ${amountNum + baseReserve} XLM (${amountNum} + ${baseReserve} reserve)`
        );
      }
    } else if (sourceBalance < amountNum) {
      throw new BusinessLogicError(
        ERROR_CODES.INSUFFICIENT_BALANCE,
        `Insufficient ${asset.code} balance for payment`
      );
    }

    this._setWalletAssetBalance(sourceWallet, asset, sourceBalance - amountNum);
    this._setWalletAssetBalance(destWallet, asset, destBalance + amountNum);
  }

  _storeTransaction(transaction) {
    if (!this.transactions.has(transaction.source)) {
      this.transactions.set(transaction.source, []);
    }
    if (!this.transactions.has(transaction.destination)) {
      this.transactions.set(transaction.destination, []);
    }

    this.transactions.get(transaction.source).push(transaction);
    this.transactions.get(transaction.destination).push(transaction);
    this._notifyStreamListeners(transaction.source, transaction);
    this._notifyStreamListeners(transaction.destination, transaction);

    return transaction;
  }

  _simulateFailure() {
    if (!this.failureSimulation.enabled) return;

    if (Math.random() > this.failureSimulation.probability) {
      this.failureSimulation.consecutiveFailures = 0;
      return;
    }

    if (
      this.failureSimulation.maxConsecutiveFailures > 0 &&
      this.failureSimulation.consecutiveFailures >= this.failureSimulation.maxConsecutiveFailures
    ) {
      this.failureSimulation.consecutiveFailures = 0;
      this.failureSimulation.enabled = false;
      return;
    }

    this.failureSimulation.consecutiveFailures += 1;

    switch (this.failureSimulation.type) {
      case 'timeout':
        throw new BusinessLogicError(
          ERROR_CODES.TRANSACTION_FAILED,
          'Request timeout - Stellar network may be experiencing high load. Please try again.',
          { retryable: true, retryAfter: 5000 }
        );
      case 'network_error':
        throw new BusinessLogicError(
          ERROR_CODES.TRANSACTION_FAILED,
          'Network error: Unable to connect to Stellar Horizon server. Check your connection.',
          { retryable: true, retryAfter: 3000 }
        );
      case 'service_unavailable':
        throw new BusinessLogicError(
          ERROR_CODES.TRANSACTION_FAILED,
          'Service temporarily unavailable: Stellar Horizon is under maintenance. Please try again later.',
          { retryable: true, retryAfter: 10000 }
        );
      case 'bad_sequence':
        throw new BusinessLogicError(
          ERROR_CODES.TRANSACTION_FAILED,
          'tx_bad_seq: Transaction sequence number does not match source account. This usually indicates a concurrent transaction.',
          { retryable: true, retryAfter: 1000 }
        );
      case 'tx_failed':
        throw new BusinessLogicError(
          ERROR_CODES.TRANSACTION_FAILED,
          'tx_failed: Transaction failed due to network congestion or insufficient fee. Please retry with higher fee.',
          { retryable: true, retryAfter: 2000 }
        );
      case 'tx_insufficient_fee':
        throw new BusinessLogicError(
          ERROR_CODES.TRANSACTION_FAILED,
          'tx_insufficient_fee: Transaction fee is too low for current network conditions.',
          { retryable: true, retryAfter: 1000 }
        );
      case 'connection_refused':
        throw new BusinessLogicError(
          ERROR_CODES.TRANSACTION_FAILED,
          'Connection refused: Unable to establish connection to Stellar network.',
          { retryable: true, retryAfter: 5000 }
        );
      case 'rate_limit_horizon':
        throw new BusinessLogicError(
          ERROR_CODES.TRANSACTION_FAILED,
          'Horizon rate limit exceeded: Too many requests to Stellar network. Please slow down.',
          { retryable: true, retryAfter: 60000 }
        );
      case 'partial_response':
        throw new BusinessLogicError(
          ERROR_CODES.TRANSACTION_FAILED,
          'Incomplete response from Stellar network. Data may be corrupted.',
          { retryable: true, retryAfter: 2000 }
        );
      case 'ledger_closed':
        throw new BusinessLogicError(
          ERROR_CODES.TRANSACTION_FAILED,
          'Ledger already closed: Transaction missed the ledger window. Please resubmit.',
          { retryable: true, retryAfter: 5000 }
        );
      case 'path_payment_failed':
        throw new BusinessLogicError(
          ERROR_CODES.TRANSACTION_FAILED,
          'Path payment failed on the Stellar DEX.',
          { retryable: false }
        );
      case 'no_path':
        throw new BusinessLogicError(
          ERROR_CODES.TRANSACTION_FAILED,
          'No Stellar path payment route was found.',
          { retryable: false }
        );
      default:
        throw new BusinessLogicError(
          ERROR_CODES.TRANSACTION_FAILED,
          'Unknown network error occurred',
          { retryable: true, retryAfter: 3000 }
        );
    }
  }

  async _simulateNetworkDelay() {
    if (this.config.networkDelay > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.config.networkDelay));
    }
  }

  _checkRateLimit() {
    if (!this.config.rateLimit) return;

    const now = Date.now();
    const oneSecondAgo = now - 1000;
    this.requestTimestamps = this.requestTimestamps.filter((ts) => ts > oneSecondAgo);

    if (this.requestTimestamps.length >= this.config.rateLimit) {
      throw new BusinessLogicError(
        ERROR_CODES.TRANSACTION_FAILED,
        'Rate limit exceeded. Please try again later.',
        { retryAfter: 1000 }
      );
    }

    this.requestTimestamps.push(now);
  }

  _simulateRandomFailure() {
    if (this.config.failureRate > 0 && Math.random() < this.config.failureRate) {
      const errors = [
        'tx_bad_seq: Transaction sequence number does not match source account',
        'tx_insufficient_balance: Insufficient balance for transaction',
        'tx_failed: Transaction failed due to network congestion',
        'timeout: Request timeout - network may be experiencing high load',
      ];
      throw new BusinessLogicError(
        ERROR_CODES.TRANSACTION_FAILED,
        errors[Math.floor(Math.random() * errors.length)]
      );
    }
  }

  _validatePublicKey(publicKey) {
    if (!this.config.strictValidation) return;

    if (!publicKey || typeof publicKey !== 'string') {
      throw new ValidationError('Public key must be a string');
    }

    if (!publicKey.startsWith('G') || publicKey.length !== 56) {
      throw new ValidationError('Invalid Stellar public key format. Must start with G and be 56 characters long.');
    }

    if (!/^G[A-Z2-7]{55}$/.test(publicKey)) {
      throw new ValidationError('Invalid Stellar public key format. Contains invalid characters.');
    }
  }

  _validateSecretKey(secretKey) {
    if (!this.config.strictValidation) return;

    if (!secretKey || typeof secretKey !== 'string') {
      throw new ValidationError('Secret key must be a string');
    }

    if (!secretKey.startsWith('S') || secretKey.length !== 56) {
      throw new ValidationError('Invalid Stellar secret key format. Must start with S and be 56 characters long.');
    }

    if (!/^S[A-Z2-7]{55}$/.test(secretKey)) {
      throw new ValidationError('Invalid Stellar secret key format. Contains invalid characters.');
    }
  }

  _validateAmount(amount) {
    if (!this.config.strictValidation) return;

    const amountNum = parseFloat(amount);
    if (Number.isNaN(amountNum)) {
      throw new ValidationError('Amount must be a valid number');
    }
    if (amountNum <= 0) {
      throw new ValidationError('Amount must be greater than zero');
    }
    if (amountNum > 922337203685.4775807) {
      throw new ValidationError('Amount exceeds maximum allowed value (922337203685.4775807 XLM)');
    }

    const decimalPart = amount.toString().split('.')[1];
    if (decimalPart && decimalPart.length > 7) {
      throw new ValidationError('Amount cannot have more than 7 decimal places');
    }
  }

  _generateKeypair() {
    const base32Chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    const generateKey = (prefix) => {
      let key = prefix;
      for (let i = 0; i < 55; i += 1) {
        key += base32Chars[Math.floor(Math.random() * base32Chars.length)];
      }
      return key;
    };

    return {
      publicKey: generateKey('G'),
      secretKey: generateKey('S'),
    };
  }

  async createWallet() {
    await this._simulateNetworkDelay();
    this._checkRateLimit();

    const keypair = this._generateKeypair();
    this.wallets.set(keypair.publicKey, {
      publicKey: keypair.publicKey,
      secretKey: keypair.secretKey,
      balance: '0.0000000',
      assetBalances: { native: '0.0000000' },
      createdAt: new Date().toISOString(),
      sequence: '0',
    });
    this.transactions.set(keypair.publicKey, []);

    return keypair;
  }

  async getBalance(publicKey) {
    return this._executeWithRetry(async () => {
      await this._simulateNetworkDelay();
      this._checkRateLimit();
      this._validatePublicKey(publicKey);
      this._simulateFailure();

      const wallet = this.wallets.get(publicKey);
      if (!wallet) {
        throw new NotFoundError(
          `Account not found. The account ${publicKey} does not exist on the network.`,
          ERROR_CODES.WALLET_NOT_FOUND
        );
      }

      this._ensureAssetBalances(wallet);
      return {
        balance: parseFloat(wallet.assetBalances.native) === 0 ? '0' : wallet.assetBalances.native,
        asset: 'XLM',
      };
    });
  }

  async fundTestnetWallet(publicKey) {
    return this._executeWithRetry(async () => {
      await this._simulateNetworkDelay();
      this._checkRateLimit();
      this._validatePublicKey(publicKey);
      this._simulateFailure();
      this._simulateRandomFailure();

      const wallet = this.wallets.get(publicKey);
      if (!wallet) {
        throw new NotFoundError(
          `Account not found. The account ${publicKey} does not exist on the network.`,
          ERROR_CODES.WALLET_NOT_FOUND
        );
      }

      if (parseFloat(wallet.balance) > 0) {
        throw new BusinessLogicError(
          ERROR_CODES.TRANSACTION_FAILED,
          'Account is already funded. Friendbot can only fund accounts once.'
        );
      }

      this._setWalletAssetBalance(wallet, NATIVE_ASSET, 10000);
      wallet.fundedAt = new Date().toISOString();
      wallet.sequence = '1';

      return { balance: wallet.assetBalances.native };
    });
  }

  async isAccountFunded(publicKey) {
    await this._simulateNetworkDelay();
    this._checkRateLimit();
    this._validatePublicKey(publicKey);

    const wallet = this.wallets.get(publicKey);
    if (!wallet) {
      return { funded: false, balance: '0', exists: false };
    }

    const balance = parseFloat(wallet.balance);
    const minBalance = parseFloat(this.config.minAccountBalance);
    return {
      funded: balance >= minBalance,
      balance: wallet.balance,
      exists: true,
    };
  }

  async sendDonation({ sourceSecret, destinationPublic, amount, memo, asset = NATIVE_ASSET }) {
    return this._executeWithRetry(async () => {
      await this._simulateNetworkDelay();
      this._checkRateLimit();
      this._validateSecretKey(sourceSecret);
      this._validatePublicKey(destinationPublic);
      this._validateAmount(amount);
      this._simulateFailure();
      this._simulateRandomFailure();

      const sourceWallet = this._findWalletBySecret(sourceSecret);
      if (!sourceWallet) {
        throw new ValidationError('Invalid source secret key. The provided secret key does not match any account.');
      }
      if (sourceWallet.publicKey === destinationPublic) {
        throw new ValidationError('Source and destination accounts cannot be the same.');
      }

      const destWallet = this.wallets.get(destinationPublic);
      if (!destWallet) {
        throw new NotFoundError(
          `Destination account not found. The account ${destinationPublic} does not exist on the network.`,
          ERROR_CODES.WALLET_NOT_FOUND
        );
      }

      this._ensureDestinationFunded(destWallet);

      this._applyAssetTransfer({
        sourceWallet,
        destWallet,
        asset,
        amountNum: parseFloat(amount),
      });

      sourceWallet.sequence = (parseInt(sourceWallet.sequence, 10) + 1).toString();

      const transaction = this._storeTransaction({
        transactionId: `mock_${crypto.randomBytes(16).toString('hex')}`,
        source: sourceWallet.publicKey,
        destination: destinationPublic,
        amount: Number(amount).toFixed(7),
        asset: serializeAsset(asset),
        memo: memo || '',
        timestamp: new Date().toISOString(),
        ledger: Math.floor(Math.random() * 1000000) + 1000000,
        status: 'confirmed',
        confirmedAt: new Date().toISOString(),
        fee: '0.0000100',
        sequence: sourceWallet.sequence,
      });

      return {
        transactionId: transaction.transactionId,
        ledger: transaction.ledger,
        status: transaction.status,
        confirmedAt: transaction.confirmedAt,
      };
    });
  }

  async discoverBestPath({ sourceAsset, sourceAmount, destAsset, destAmount }) {
    return this._executeWithRetry(async () => {
      await this._simulateNetworkDelay();
      this._checkRateLimit();

      if (this.failureSimulation.enabled && this.failureSimulation.type === 'no_path') {
        return null;
      }

      const rate = this._getConversionRate(sourceAsset, destAsset);
      if (!rate || !Number.isFinite(rate)) {
        return null;
      }

      const resolvedSourceAmount = sourceAmount || (parseFloat(destAmount) / rate).toFixed(7);
      const resolvedDestAmount = destAmount || (parseFloat(sourceAmount) * rate).toFixed(7);
      const conversionRate = (parseFloat(resolvedDestAmount) / parseFloat(resolvedSourceAmount)).toFixed(7);
      const path = sourceAsset.type !== 'native' && destAsset.type !== 'native'
        ? [serializeAsset(NATIVE_ASSET)]
        : [];

      return {
        sourceAsset: serializeAsset(sourceAsset),
        sourceAmount: resolvedSourceAmount,
        destAsset: serializeAsset(destAsset),
        destAmount: resolvedDestAmount,
        conversionRate,
        path,
      };
    });
  }

  async pathPayment(sourceAsset, sourceAmount, destAsset, destAmount, path, options = {}) {
    return this._executeWithRetry(async () => {
      await this._simulateNetworkDelay();
      this._checkRateLimit();
      this._simulateFailure();

      if (this.failureSimulation.enabled && this.failureSimulation.type === 'path_payment_failed') {
        throw new BusinessLogicError(
          ERROR_CODES.TRANSACTION_FAILED,
          'Path payment failed on the Stellar DEX.'
        );
      }

      const estimate = await this.discoverBestPath({
        sourceAsset,
        sourceAmount,
        destAsset,
        destAmount,
      });

      if (!estimate) {
        throw new BusinessLogicError(
          ERROR_CODES.TRANSACTION_FAILED,
          'No Stellar path payment route was found.'
        );
      }

      const submittedPath = (path || []).map((asset) => serializeAsset(asset));
      if (JSON.stringify(submittedPath) !== JSON.stringify(estimate.path || [])) {
        throw new ValidationError('Submitted path does not match the server-discovered route');
      }

      const sourceWallet = this._findWalletBySecret(options.sourceSecret);
      if (!sourceWallet) {
        throw new ValidationError('Invalid source secret key. The provided secret key does not match any account.');
      }

      const destWallet = this.wallets.get(options.destinationPublic);
      if (!destWallet) {
        throw new NotFoundError(
          `Destination account not found. The account ${options.destinationPublic} does not exist on the network.`,
          ERROR_CODES.WALLET_NOT_FOUND
        );
      }

      this._ensureDestinationFunded(destWallet);

      const sourceBalance = this._getWalletAssetBalance(sourceWallet, sourceAsset);
      if (sourceAsset.type === 'native') {
        const baseReserve = parseFloat(this.config.baseReserve);
        if (sourceBalance - parseFloat(sourceAmount) < baseReserve) {
          throw new BusinessLogicError(
            ERROR_CODES.TRANSACTION_FAILED,
            `Insufficient balance. Account must maintain minimum balance of ${this.config.baseReserve} XLM.`
          );
        }
      } else if (sourceBalance < parseFloat(sourceAmount)) {
        throw new BusinessLogicError(
          ERROR_CODES.INSUFFICIENT_BALANCE,
          `Insufficient ${sourceAsset.code} balance for payment`
        );
      }

      this._setWalletAssetBalance(sourceWallet, sourceAsset, sourceBalance - parseFloat(sourceAmount));
      const destBalance = this._getWalletAssetBalance(destWallet, destAsset);
      this._setWalletAssetBalance(destWallet, destAsset, destBalance + parseFloat(destAmount));
      sourceWallet.sequence = (parseInt(sourceWallet.sequence, 10) + 1).toString();

      const transaction = this._storeTransaction({
        transactionId: `mock_${crypto.randomBytes(16).toString('hex')}`,
        source: sourceWallet.publicKey,
        destination: options.destinationPublic,
        amount: Number(sourceAmount).toFixed(7),
        destinationAmount: Number(destAmount).toFixed(7),
        asset: serializeAsset(sourceAsset),
        destinationAsset: serializeAsset(destAsset),
        path: estimate.path || [],
        memo: options.memo || '',
        timestamp: new Date().toISOString(),
        ledger: Math.floor(Math.random() * 1000000) + 1000000,
        status: 'confirmed',
        confirmedAt: new Date().toISOString(),
        fee: '0.0000100',
        sequence: sourceWallet.sequence,
      });

      return {
        transactionId: transaction.transactionId,
        ledger: transaction.ledger,
        status: transaction.status,
        confirmedAt: transaction.confirmedAt,
      };
    });
  }

  async getTransactionHistory(publicKey, limit = 10) {
    await this._simulateNetworkDelay();
    this._checkRateLimit();
    this._validatePublicKey(publicKey);

    const wallet = this.wallets.get(publicKey);
    if (!wallet) {
      throw new NotFoundError(
        `Account not found. The account ${publicKey} does not exist on the network.`,
        ERROR_CODES.WALLET_NOT_FOUND
      );
    }

    return (this.transactions.get(publicKey) || []).slice(-limit).reverse();
  }

  async verifyTransaction(transactionHash) {
    await this._simulateNetworkDelay();
    this._checkRateLimit();

    if (!transactionHash || typeof transactionHash !== 'string') {
      throw new ValidationError('Transaction hash must be a valid string');
    }

    for (const txList of this.transactions.values()) {
      const transaction = txList.find((tx) => tx.transactionId === transactionHash);
      if (transaction) {
        return {
          verified: true,
          status: transaction.status,
          transaction: {
            id: transaction.transactionId,
            source: transaction.source,
            destination: transaction.destination,
            amount: transaction.amount,
            asset: transaction.asset,
            destinationAmount: transaction.destinationAmount,
            destinationAsset: transaction.destinationAsset,
            path: transaction.path,
            memo: transaction.memo,
            timestamp: transaction.timestamp,
            ledger: transaction.ledger,
            status: transaction.status,
            confirmedAt: transaction.confirmedAt,
            fee: transaction.fee,
            sequence: transaction.sequence,
          },
        };
      }
    }

    throw new NotFoundError(
      `Transaction not found. The transaction ${transactionHash} does not exist on the network.`,
      ERROR_CODES.TRANSACTION_NOT_FOUND
    );
  }

  streamTransactions(publicKey, onTransaction) {
    this._validatePublicKey(publicKey);

    const wallet = this.wallets.get(publicKey);
    if (!wallet) {
      throw new NotFoundError(
        `Account not found. The account ${publicKey} does not exist on the network.`,
        ERROR_CODES.WALLET_NOT_FOUND
      );
    }
    if (typeof onTransaction !== 'function') {
      throw new ValidationError('onTransaction must be a function');
    }

    if (!this.streamListeners.has(publicKey)) {
      this.streamListeners.set(publicKey, []);
    }
    this.streamListeners.get(publicKey).push(onTransaction);

    return () => {
      const listeners = this.streamListeners.get(publicKey);
      if (listeners) {
        const index = listeners.indexOf(onTransaction);
        if (index > -1) {
          listeners.splice(index, 1);
        }
      }
    };
  }

  _notifyStreamListeners(publicKey, transaction) {
    const listeners = this.streamListeners.get(publicKey) || [];
    listeners.forEach((callback) => {
      try {
        callback(transaction);
      } catch (error) {
        log.error('MOCK_STELLAR_SERVICE', 'Stream listener callback failed', { error: error.message });
      }
    });
  }

  async sendPayment(sourcePublicKey, destinationPublic, amount, memo = '') {
    return this._executeWithRetry(async () => {
      await this._simulateNetworkDelay();
      this._checkRateLimit();
      this._validatePublicKey(sourcePublicKey);
      this._validatePublicKey(destinationPublic);
      this._validateAmount(amount.toString());
      this._simulateFailure();
      this._simulateRandomFailure();

      let sourceWallet = this.wallets.get(sourcePublicKey);
      if (!sourceWallet) {
        sourceWallet = {
          publicKey: sourcePublicKey,
          secretKey: this._generateKeypair().secretKey,
          balance: '10000.0000000',
          assetBalances: { native: '10000.0000000' },
          createdAt: new Date().toISOString(),
          sequence: '0',
        };
        this.wallets.set(sourcePublicKey, sourceWallet);
      }

      let destWallet = this.wallets.get(destinationPublic);
      if (!destWallet) {
        destWallet = {
          publicKey: destinationPublic,
          secretKey: this._generateKeypair().secretKey,
          balance: '1.0000000',
          assetBalances: { native: '1.0000000' },
          createdAt: new Date().toISOString(),
          sequence: '0',
        };
        this.wallets.set(destinationPublic, destWallet);
      }

      this._applyAssetTransfer({
        sourceWallet,
        destWallet,
        asset: NATIVE_ASSET,
        amountNum: parseFloat(amount),
      });
      sourceWallet.sequence = (parseInt(sourceWallet.sequence, 10) + 1).toString();

      const transaction = this._storeTransaction({
        hash: `mock_${crypto.randomBytes(16).toString('hex')}`,
        source: sourcePublicKey,
        destination: destinationPublic,
        amount: Number(amount).toFixed(7),
        memo,
        timestamp: new Date().toISOString(),
        ledger: Math.floor(Math.random() * 1000000) + 1000000,
        status: 'confirmed',
        fee: '0.0000100',
        sequence: sourceWallet.sequence,
      });

      log.info('MOCK_STELLAR_SERVICE', 'Payment simulated', {
        amount: Number(amount).toFixed(7),
        source: `${sourcePublicKey.substring(0, 8)}...`,
        destination: `${destinationPublic.substring(0, 8)}...`,
      });

      return {
        hash: transaction.hash,
        ledger: transaction.ledger,
      };
    });
  }

  getSecretForPublicKey(publicKey) {
    const wallet = this.wallets.get(publicKey);
    return wallet ? wallet.secretKey : null;
  }

  setAssetBalance(publicKey, asset, amount) {
    const wallet = this.wallets.get(publicKey);
    if (!wallet) {
      throw new NotFoundError(
        `Account not found. The account ${publicKey} does not exist on the network.`,
        ERROR_CODES.WALLET_NOT_FOUND
      );
    }

    this._setWalletAssetBalance(wallet, asset, Number(amount));
  }

  _clearAllData() {
    this.wallets.clear();
    this.transactions.clear();
    this.streamListeners.clear();
  }

  _getState() {
    return {
      wallets: Array.from(this.wallets.values()),
      transactions: Object.fromEntries(this.transactions),
      streamListeners: this.streamListeners.size,
    };
  }
}

module.exports = MockStellarService;
