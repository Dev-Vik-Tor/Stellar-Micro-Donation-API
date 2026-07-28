'use strict';

/**
 * HSMSigningProvider test suite (Issue #1393)
 *
 * The HSM provider is currently a deliberate stub that throws
 * HsmNotImplementedError to fail loudly at startup rather than
 * silently falling back to software signing. These tests verify:
 *
 *  1. Interface contract — HSMSigningProvider exports the same interface
 *     as SoftwareSigningProvider (method names, method count).
 *  2. Constructor behaviour — throws HsmNotImplementedError immediately
 *     on construction (fail-fast at startup).
 *  3. Error contract — HsmNotImplementedError has the right name, code,
 *     and is an instance of Error.
 *  4. No silent fallback — attempting to use any method also throws
 *     (defensive, in case the constructor guard is bypassed in future).
 *  5. Interface-conformance parity — both providers declare the same
 *     public method names (sign, getPublicKey, healthCheck) so callers
 *     can treat them interchangeably.
 *  6. Module export shape — module exports both the class and the error class.
 */

const SoftwareSigningProvider = require('../../src/services/signing/SoftwareSigningProvider');
const SigningProvider = require('../../src/services/signing/SigningProvider');

// ─── Helper ───────────────────────────────────────────────────────────────────

/**
 * Bypass the constructor guard and create a raw HSMSigningProvider instance
 * so we can test the method-level throws in isolation.
 * We do this by temporarily replacing the constructor body via Object.create
 * on the prototype, which avoids calling super() with the throw.
 */
function bypassConstructorAndInstantiate(HSMSigningProvider) {
  const instance = Object.create(HSMSigningProvider.prototype);
  return instance;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('HSMSigningProvider — module shape', () => {
  it('exports the HSMSigningProvider class as the default export', () => {
    const HSMSigningProvider = require('../../src/services/signing/HSMSigningProvider');
    expect(typeof HSMSigningProvider).toBe('function');
  });

  it('exports HsmNotImplementedError as a named export', () => {
    const { HsmNotImplementedError } = require('../../src/services/signing/HSMSigningProvider');
    expect(typeof HsmNotImplementedError).toBe('function');
  });

  it('HsmNotImplementedError is a subclass of Error', () => {
    const { HsmNotImplementedError } = require('../../src/services/signing/HSMSigningProvider');
    const err = Object.create(HsmNotImplementedError.prototype);
    expect(err).toBeInstanceOf(Error);
  });
});

describe('HSMSigningProvider — constructor fails fast', () => {
  it('throws HsmNotImplementedError when instantiated', () => {
    const HSMSigningProvider = require('../../src/services/signing/HSMSigningProvider');
    expect(() => new HSMSigningProvider()).toThrow();
  });

  it('throws specifically a HsmNotImplementedError (not a generic Error)', () => {
    const HSMSigningProvider = require('../../src/services/signing/HSMSigningProvider');
    const { HsmNotImplementedError } = require('../../src/services/signing/HSMSigningProvider');
    let caught;
    try { new HSMSigningProvider(); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(HsmNotImplementedError);
  });

  it('thrown error has name "HsmNotImplementedError"', () => {
    const HSMSigningProvider = require('../../src/services/signing/HSMSigningProvider');
    let caught;
    try { new HSMSigningProvider(); } catch (e) { caught = e; }
    expect(caught.name).toBe('HsmNotImplementedError');
  });

  it('thrown error has code "HSM_NOT_IMPLEMENTED"', () => {
    const HSMSigningProvider = require('../../src/services/signing/HSMSigningProvider');
    let caught;
    try { new HSMSigningProvider(); } catch (e) { caught = e; }
    expect(caught.code).toBe('HSM_NOT_IMPLEMENTED');
  });

  it('thrown error message mentions SIGNING_PROVIDER=software', () => {
    const HSMSigningProvider = require('../../src/services/signing/HSMSigningProvider');
    let caught;
    try { new HSMSigningProvider(); } catch (e) { caught = e; }
    expect(caught.message).toMatch(/software/i);
  });

  it('also throws when config object is passed', () => {
    const HSMSigningProvider = require('../../src/services/signing/HSMSigningProvider');
    expect(() => new HSMSigningProvider({ slot: 0, pin: '1234' })).toThrow();
  });
});

describe('HSMSigningProvider — method-level throws (defensive)', () => {
  let instance;

  beforeEach(() => {
    const HSMSigningProvider = require('../../src/services/signing/HSMSigningProvider');
    instance = bypassConstructorAndInstantiate(HSMSigningProvider);
  });

  it('sign() throws HsmNotImplementedError', async () => {
    const { HsmNotImplementedError } = require('../../src/services/signing/HSMSigningProvider');
    await expect(instance.sign({}, 'KEY_ID')).rejects.toBeInstanceOf(HsmNotImplementedError);
  });

  it('getPublicKey() throws HsmNotImplementedError', async () => {
    const { HsmNotImplementedError } = require('../../src/services/signing/HSMSigningProvider');
    await expect(instance.getPublicKey('KEY_ID')).rejects.toBeInstanceOf(HsmNotImplementedError);
  });

  it('healthCheck() returns false (documented stub behaviour)', async () => {
    // healthCheck is the only method that does NOT throw — it returns false
    // so a health-check probe can detect that the HSM is not configured.
    await expect(instance.healthCheck()).resolves.toBe(false);
  });
});

describe('HSMSigningProvider — interface-conformance parity with SoftwareSigningProvider', () => {
  const REQUIRED_METHODS = ['sign', 'getPublicKey', 'healthCheck'];

  it('SoftwareSigningProvider implements all required interface methods', () => {
    const sw = new SoftwareSigningProvider();
    for (const method of REQUIRED_METHODS) {
      expect(typeof sw[method]).toBe('function');
    }
  });

  it('HSMSigningProvider prototype declares all required interface methods', () => {
    const HSMSigningProvider = require('../../src/services/signing/HSMSigningProvider');
    for (const method of REQUIRED_METHODS) {
      expect(typeof HSMSigningProvider.prototype[method]).toBe('function');
    }
  });

  it('HSMSigningProvider is a subclass of SigningProvider', () => {
    const HSMSigningProvider = require('../../src/services/signing/HSMSigningProvider');
    expect(HSMSigningProvider.prototype).toBeInstanceOf(SigningProvider);
  });

  it('SoftwareSigningProvider is also a subclass of SigningProvider', () => {
    const sw = new SoftwareSigningProvider();
    expect(sw).toBeInstanceOf(SigningProvider);
  });

  it('both providers expose the same public method names', () => {
    const HSMSigningProvider = require('../../src/services/signing/HSMSigningProvider');
    const hsmMethods = REQUIRED_METHODS.filter(
      m => typeof HSMSigningProvider.prototype[m] === 'function'
    );
    const swMethods = REQUIRED_METHODS.filter(
      m => typeof SoftwareSigningProvider.prototype[m] === 'function'
    );
    expect(hsmMethods.sort()).toEqual(swMethods.sort());
  });
});

describe('HSMSigningProvider — signing provider index integration', () => {
  const ORIGINAL_ENV = process.env.SIGNING_PROVIDER;

  afterEach(() => {
    if (ORIGINAL_ENV === undefined) {
      delete process.env.SIGNING_PROVIDER;
    } else {
      process.env.SIGNING_PROVIDER = ORIGINAL_ENV;
    }
    // Clear require cache so getSigningProvider re-reads env
    jest.resetModules();
  });

  it('getSigningProvider("software") returns a SoftwareSigningProvider instance', () => {
    process.env.SIGNING_PROVIDER = 'software';
    jest.resetModules();
    const { getSigningProvider, SoftwareSigningProvider: SW } =
      require('../../src/services/signing/index');
    const provider = getSigningProvider();
    expect(provider).toBeInstanceOf(SW);
  });

  it('getSigningProvider("hsm") throws HsmNotImplementedError', () => {
    process.env.SIGNING_PROVIDER = 'hsm';
    jest.resetModules();
    const { getSigningProvider } = require('../../src/services/signing/index');
    const { HsmNotImplementedError } = require('../../src/services/signing/HSMSigningProvider');
    expect(() => getSigningProvider()).toThrow(HsmNotImplementedError);
  });

  it('getSigningProvider with unknown value throws an informative error', () => {
    process.env.SIGNING_PROVIDER = 'quantum';
    jest.resetModules();
    const { getSigningProvider } = require('../../src/services/signing/index');
    expect(() => getSigningProvider()).toThrow(/quantum/i);
  });

  it('defaults to software provider when SIGNING_PROVIDER is unset', () => {
    delete process.env.SIGNING_PROVIDER;
    jest.resetModules();
    const { getSigningProvider, SoftwareSigningProvider: SW } =
      require('../../src/services/signing/index');
    const provider = getSigningProvider();
    expect(provider).toBeInstanceOf(SW);
  });
});
