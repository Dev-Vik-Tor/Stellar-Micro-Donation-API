/**
 * Startup Diagnostics Tests
 *
 * Verify that startup logs:
 * 1. Emit a single structured config summary at startup
 * 2. Never leak secrets or sensitive values
 * 3. Are machine-parseable and concise
 *
 * Issue #1227: Add startup/readiness logging that summarizes effective configuration (redacted)
 */

const startupDiagnostics = require('../../src/utils/startupDiagnostics');
const { maskSensitiveData, STELLAR_SECRET_PATTERN } = require('../../src/utils/dataMasker');
const config = require('../../src/config');

// Known secret patterns that must NEVER appear in logs
const SECRET_PATTERNS = [
  /S[A-Z2-7]{55}/g,  // Stellar secret keys
  /Bearer\s+[A-Za-z0-9._-]+/gi,  // Bearer tokens
  /password\s*[:=]\s*[^\s,}]+/gi,  // Password assignments
  /api[_-]key\s*[:=]\s*[^\s,}]+/gi,  // API key assignments
];

// List of test secret values for verification (simulated, not real)
const TEST_SECRETS = {
  stellarSecret: 'SBZWZ7T3FQNFGSQJ7M5IXEDQ5ZPFYAIYXRRHXFLDKFPQCFP7Y4KXBWVI',
  apiKey: 'test_api_key_1234567890abcdefghijklmnop',
  password: 'SuperSecurePassword123!@#',
  databaseUrl: 'postgresql://user:password@localhost:5432/db',
};

describe('Startup Diagnostics - No Secret Leaks', () => {
  let consoleLogSpy;
  let consoleInfoSpy;

  beforeEach(() => {
    consoleLogSpy = jest.spyOn(console, 'log').mockImplementation();
    consoleInfoSpy = jest.spyOn(console, 'info').mockImplementation();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('Environment Info', () => {
    it('should provide safe environment information', () => {
      const envInfo = startupDiagnostics.getEnvironmentInfo();

      expect(envInfo).toHaveProperty('mode');
      expect(envInfo).toHaveProperty('isProduction');
      expect(envInfo).toHaveProperty('isDevelopment');
      expect(envInfo).toHaveProperty('isTest');
      expect(envInfo).toHaveProperty('port');
      expect(envInfo).toHaveProperty('version');

      // Verify no secret keys are present
      const envStr = JSON.stringify(envInfo);
      expect(envStr).not.toMatch(STELLAR_SECRET_PATTERN);
      SECRET_PATTERNS.forEach(pattern => {
        expect(envStr).not.toMatch(pattern);
      });
    });
  });

  describe('Features Info', () => {
    it('should provide safe features information', () => {
      const featuresInfo = startupDiagnostics.getFeaturesInfo();

      expect(featuresInfo).toHaveProperty('mockStellar');
      expect(featuresInfo).toHaveProperty('debugMode');
      expect(featuresInfo).toHaveProperty('encryption');

      // Verify encryption key is never exposed
      const featuresStr = JSON.stringify(featuresInfo);
      expect(featuresStr).not.toContain(process.env.ENCRYPTION_KEY);
      expect(featuresStr).not.toMatch(STELLAR_SECRET_PATTERN);
    });

    it('should indicate encryption presence without exposing the key', () => {
      const featuresInfo = startupDiagnostics.getFeaturesInfo();

      // Should report configured state, never the actual key
      expect(featuresInfo.encryption).toHaveProperty('enabled');
      expect(featuresInfo.encryption).toHaveProperty('requiredInProduction');

      // Key should never be in the output
      const featuresStr = JSON.stringify(featuresInfo);
      if (process.env.ENCRYPTION_KEY) {
        expect(featuresStr).not.toContain(process.env.ENCRYPTION_KEY);
      }
    });

    it('should report HSM/KMS configuration without exposing credentials', () => {
      const featuresInfo = startupDiagnostics.getFeaturesInfo();

      // Should report configured state, not actual values
      if (featuresInfo.hsm) {
        expect(typeof featuresInfo.hsm.slotConfigured).toBe('boolean');
        expect(typeof featuresInfo.hsm.pinConfigured).toBe('boolean');
        expect(featuresInfo.hsm).not.toHaveProperty('HSM_SLOT_ID');
        expect(featuresInfo.hsm).not.toHaveProperty('HSM_PIN');
      }

      if (featuresInfo.kms) {
        expect(typeof featuresInfo.kms.providerConfigured).toBe('boolean');
        expect(typeof featuresInfo.kms.keyConfigured).toBe('boolean');
        expect(featuresInfo.kms).not.toHaveProperty('KMS_PROVIDER');
        expect(featuresInfo.kms).not.toHaveProperty('KMS_KEY_ID');
      }
    });
  });

  describe('Network Info', () => {
    it('should provide safe network information', () => {
      const networkInfo = startupDiagnostics.getNetworkInfo();

      expect(networkInfo).toHaveProperty('stellar');
      expect(networkInfo).toHaveProperty('database');

      // Verify no credentials in output
      const networkStr = JSON.stringify(networkInfo);
      expect(networkStr).not.toMatch(STELLAR_SECRET_PATTERN);
    });

    it('should sanitize Horizon URL to remove credentials', () => {
      const networkInfo = startupDiagnostics.getNetworkInfo();

      const horizonUrl = networkInfo.stellar.horizonUrl;
      // Should not contain credentials
      expect(horizonUrl).not.toMatch(/@/); // User:pass separator
      expect(horizonUrl).not.toMatch(/:[^\/]+@/); // password:@ pattern
    });
  });

  describe('Services Info', () => {
    it('should provide safe services configuration', () => {
      const servicesInfo = startupDiagnostics.getServicesInfo();

      expect(servicesInfo).toHaveProperty('apiKeys');
      expect(servicesInfo).toHaveProperty('donationLimits');

      // Report count, not actual keys
      expect(typeof servicesInfo.apiKeys.configured).toBe('boolean');
      expect(typeof servicesInfo.apiKeys.count).toBe('number');

      const servicesStr = JSON.stringify(servicesInfo);
      expect(servicesStr).not.toMatch(STELLAR_SECRET_PATTERN);
    });
  });

  describe('System Health', () => {
    it('should provide safe system health information', () => {
      const systemHealth = startupDiagnostics.getSystemHealth();

      expect(systemHealth).toHaveProperty('nodeVersion');
      expect(systemHealth).toHaveProperty('platform');
      expect(systemHealth).toHaveProperty('arch');
      expect(systemHealth).toHaveProperty('memory');
      expect(systemHealth).toHaveProperty('uptime');
      expect(systemHealth).toHaveProperty('database');

      const healthStr = JSON.stringify(systemHealth);
      expect(healthStr).not.toMatch(STELLAR_SECRET_PATTERN);
    });
  });

  describe('Secret Leak Scanning', () => {
    it('should detect and mask Stellar secret keys in data', () => {
      const dataWithSecret = {
        config: 'value',
        secret: TEST_SECRETS.stellarSecret,
        nested: {
          sender_secret: TEST_SECRETS.stellarSecret
        }
      };

      const masked = maskSensitiveData(dataWithSecret);
      const maskedStr = JSON.stringify(masked);

      expect(maskedStr).not.toContain(TEST_SECRETS.stellarSecret);
      expect(maskedStr).toContain('[REDACTED]');
    });

    it('should detect and mask API keys in data', () => {
      const dataWithApiKey = {
        apiKey: TEST_SECRETS.apiKey,
        api_key: TEST_SECRETS.apiKey,
        'X-API-Key': TEST_SECRETS.apiKey,
      };

      const masked = maskSensitiveData(dataWithApiKey);
      const maskedStr = JSON.stringify(masked);

      expect(maskedStr).not.toContain(TEST_SECRETS.apiKey);
      expect(maskedStr).toContain('[REDACTED]');
    });

    it('should detect and mask passwords in data', () => {
      const dataWithPassword = {
        password: TEST_SECRETS.password,
        db_password: TEST_SECRETS.password,
      };

      const masked = maskSensitiveData(dataWithPassword);
      const maskedStr = JSON.stringify(masked);

      expect(maskedStr).not.toContain(TEST_SECRETS.password);
      expect(maskedStr).toContain('[REDACTED]');
    });

    it('should detect and mask database connection strings', () => {
      const dataWithDbUrl = {
        DATABASE_URL: TEST_SECRETS.databaseUrl,
        database_url: TEST_SECRETS.databaseUrl,
      };

      const masked = maskSensitiveData(dataWithDbUrl);
      const maskedStr = JSON.stringify(masked);

      expect(maskedStr).not.toContain(TEST_SECRETS.databaseUrl);
      expect(maskedStr).not.toContain('password');
      expect(maskedStr).toContain('[REDACTED]');
    });
  });

  describe('Startup Logging', () => {
    it('should log startup diagnostics without blocking', async () => {
      // Mock console to capture output
      const logs = [];
      const originalLog = console.log;
      console.log = jest.fn((msg) => {
        logs.push(msg);
      });

      try {
        // This should log but not throw
        await startupDiagnostics.logStartupDiagnostics();

        // Should have logged something
        expect(logs.length).toBeGreaterThan(0);

        // Verify no secrets in all logs
        const allLogsStr = logs.join('\n');
        expect(allLogsStr).not.toMatch(STELLAR_SECRET_PATTERN);

        // Verify critical markers are present
        expect(allLogsStr).toMatch(/STARTUP/i);
      } finally {
        console.log = originalLog;
      }
    });

    it('should produce machine-parseable output', () => {
      const envInfo = startupDiagnostics.getEnvironmentInfo();
      const featuresInfo = startupDiagnostics.getFeaturesInfo();
      const networkInfo = startupDiagnostics.getNetworkInfo();

      // Should be serializable to JSON
      expect(() => {
        JSON.stringify({
          environment: envInfo,
          features: featuresInfo,
          network: networkInfo,
        });
      }).not.toThrow();
    });

    it('should provide concise output', () => {
      const envInfo = startupDiagnostics.getEnvironmentInfo();
      const featuresInfo = startupDiagnostics.getFeaturesInfo();
      const networkInfo = startupDiagnostics.getNetworkInfo();

      // Each section should be compact (not deeply nested)
      const envStr = JSON.stringify(envInfo);
      const featuresStr = JSON.stringify(featuresInfo);
      const networkStr = JSON.stringify(networkInfo);

      // Reasonable size limits for startup logs
      expect(envStr.length).toBeLessThan(500);
      expect(featuresStr.length).toBeLessThan(1000);
      expect(networkStr.length).toBeLessThan(1000);
    });
  });

  describe('Shutdown Logging', () => {
    it('should log shutdown diagnostics safely', () => {
      const logs = [];
      console.log = jest.fn((msg) => {
        logs.push(msg);
      });

      startupDiagnostics.logShutdownDiagnostics('SIGTERM');

      const allLogsStr = logs.join('\n');
      expect(allLogsStr).toMatch(/SHUTDOWN|SIGTERM/i);
      expect(allLogsStr).not.toMatch(STELLAR_SECRET_PATTERN);
    });
  });
});
