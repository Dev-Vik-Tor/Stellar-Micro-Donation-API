/**
 * Log Sampling Tests
 *
 * Verify that error, security, and audit logs are NEVER sampled (dropped) regardless
 * of LOG_SAMPLE_RATE setting. Only debug/info logs should be subject to sampling.
 *
 * Issue #1226: Verify log sampling (LOG_SAMPLE_RATE) never drops error/security logs
 */

const log = require('../../src/utils/log');
const config = require('../../src/config');

describe('Log Sampling - Critical Logs Never Dropped', () => {
  let originalSampleRate;
  let consoleLogSpy;
  let consoleErrorSpy;
  let consoleWarnSpy;

  beforeEach(() => {
    consoleLogSpy = jest.spyOn(console, 'log').mockImplementation();
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation();
    consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('Error logs', () => {
    it('should never sample ERROR logs even with very low sample rate', () => {
      const testCount = 100;
      let errorLogCount = 0;

      // Reset the sample rate to very low (would drop 99% of logs if applied)
      const originalRate = config.logging.sampleRate;
      config.logging.sampleRate = 0.01; // 1% sample rate

      try {
        for (let i = 0; i < testCount; i++) {
          log.error('TEST_SCOPE', `Error message ${i}`, { index: i });
          if (consoleErrorSpy.mock.calls.length > errorLogCount) {
            errorLogCount++;
          }
        }

        // All 100 error logs should be emitted
        expect(errorLogCount).toBe(testCount);
        expect(consoleErrorSpy).toHaveBeenCalledTimes(testCount);
      } finally {
        config.logging.sampleRate = originalRate;
      }
    });

    it('should include error details in output', () => {
      log.error('ERROR_TEST', 'Critical error occurred', { errorCode: 'E001', severity: 'critical' });

      expect(consoleErrorSpy).toHaveBeenCalled();
      const output = consoleErrorSpy.mock.calls[0][0];
      expect(output).toContain('Critical error occurred');
      expect(output).toContain('ERROR_TEST');
    });
  });

  describe('Security logs', () => {
    it('should never sample security logs even with very low sample rate', () => {
      const testCount = 100;
      let securityLogCount = 0;

      const originalRate = config.logging.sampleRate;
      config.logging.sampleRate = 0.01; // 1% sample rate

      try {
        for (let i = 0; i < testCount; i++) {
          log.security('SECURITY', `Security event ${i}`, { eventType: 'auth_attempt', userId: `user-${i}` });
          if (consoleWarnSpy.mock.calls.length > securityLogCount) {
            securityLogCount++;
          }
        }

        // All security logs should be emitted
        expect(securityLogCount).toBe(testCount);
        expect(consoleWarnSpy).toHaveBeenCalledTimes(testCount);
      } finally {
        config.logging.sampleRate = originalRate;
      }
    });
  });

  describe('Audit logs', () => {
    it('should never sample audit logs even with very low sample rate', () => {
      const testCount = 100;
      let auditLogCount = 0;

      const originalRate = config.logging.sampleRate;
      config.logging.sampleRate = 0.01; // 1% sample rate

      try {
        for (let i = 0; i < testCount; i++) {
          log.audit('AUDIT', `Audit trail ${i}`, { action: 'resource_accessed', resourceId: `res-${i}` });
          if (consoleLogSpy.mock.calls.length > auditLogCount) {
            auditLogCount++;
          }
        }

        // All audit logs should be emitted
        expect(auditLogCount).toBe(testCount);
        expect(consoleLogSpy).toHaveBeenCalledTimes(testCount);
      } finally {
        config.logging.sampleRate = originalRate;
      }
    });
  });

  describe('Warn logs', () => {
    it('should never sample WARN logs', () => {
      const testCount = 100;
      let warnLogCount = 0;

      const originalRate = config.logging.sampleRate;
      config.logging.sampleRate = 0.01; // 1% sample rate

      try {
        for (let i = 0; i < testCount; i++) {
          log.warn('WARN_TEST', `Warning ${i}`, { severity: 'medium' });
          if (consoleWarnSpy.mock.calls.length > warnLogCount) {
            warnLogCount++;
          }
        }

        // All warn logs should be emitted
        expect(warnLogCount).toBe(testCount);
      } finally {
        config.logging.sampleRate = originalRate;
      }
    });
  });

  describe('Non-critical logs with sampling', () => {
    it('should not sample debug logs above current level, but sampling applies if log level allows', () => {
      // Note: Debug logs have SAMPLE_RATE applied in the dispatchLog function
      // However, in test environment the default level is INFO, so debug logs
      // won't be emitted unless debug mode is on. This test documents that behavior.

      const originalRate = config.logging.sampleRate;
      config.logging.sampleRate = 0.1; // 10% sample rate

      try {
        consoleLogSpy.mockClear();

        // Debug logs are filtered by level before sampling is considered
        // So we just verify they follow the normal level filtering behavior
        log.debug('DEBUG_TEST', 'Debug message', { index: 0 });

        // In test environment with INFO level, debug logs are not emitted
        // This is correct behavior - level filtering happens before sampling
        expect(consoleLogSpy).toHaveBeenCalledTimes(0);
      } finally {
        config.logging.sampleRate = originalRate;
      }
    });
  });

  describe('Sampling with metadata flags', () => {
    it('should respect _mustKeep flag to prevent sampling', () => {
      const originalRate = config.logging.sampleRate;
      config.logging.sampleRate = 0.01; // 1% sample rate

      try {
        consoleLogSpy.mockClear();

        const testCount = 50;
        for (let i = 0; i < testCount; i++) {
          log.info('TEST', `Must keep info ${i}`, { _mustKeep: true });
        }

        // All must-keep logs should be emitted
        expect(consoleLogSpy).toHaveBeenCalledTimes(testCount);
      } finally {
        config.logging.sampleRate = originalRate;
      }
    });

    it('should respect _isSecurityLog flag', () => {
      const originalRate = config.logging.sampleRate;
      config.logging.sampleRate = 0.01; // 1% sample rate

      try {
        consoleLogSpy.mockClear();

        const testCount = 50;
        for (let i = 0; i < testCount; i++) {
          log.info('TEST', `Security info ${i}`, { _isSecurityLog: true });
        }

        // All security-marked logs should be emitted (via console.log for INFO level)
        expect(consoleLogSpy).toHaveBeenCalledTimes(testCount);
      } finally {
        config.logging.sampleRate = originalRate;
      }
    });

    it('should respect _isAuditLog flag', () => {
      const originalRate = config.logging.sampleRate;
      config.logging.sampleRate = 0.01; // 1% sample rate

      try {
        consoleLogSpy.mockClear();

        const testCount = 50;
        for (let i = 0; i < testCount; i++) {
          log.info('TEST', `Audit info ${i}`, { _isAuditLog: true });
        }

        // All audit-marked logs should be emitted
        expect(consoleLogSpy).toHaveBeenCalledTimes(testCount);
      } finally {
        config.logging.sampleRate = originalRate;
      }
    });
  });
});
