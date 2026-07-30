/**
 * Permissions Model — Schema Validation Tests (#1363)
 *
 * PURPOSE
 * ───────
 * Validate that the roles.json configuration file is structurally sound before
 * it is used for RBAC decisions.  These tests exercise the validateRolesConfig()
 * function directly, covering every schema rule.
 *
 * SCHEMA RULES (src/models/permissions.js → validateRolesConfig)
 * ──────────────────────────────────────────────────────────────
 * 1. Root must be a non-null object
 * 2. Must contain a "roles" array
 * 3. The "roles" array must not be empty
 * 4. Each role must be a non-null object
 * 5. Each role must have a non-empty string "name"
 * 6. Each role must have a "permissions" array (non-empty)
 * 7. Each permission must be a string
 * 8. Each permission must be "*" or match "resource:action" format
 * 9. Malformed but non-critical permission patterns produce warnings (not errors)
 */

'use strict';

const { validateRolesConfig, loadRolesConfig } = require('../../src/models/permissions');

// ─── Valid config ─────────────────────────────────────────────────────────────

const VALID_CONFIG = {
  roles: [
    { name: 'admin', permissions: ['*'] },
    { name: 'user', permissions: ['donations:create', 'donations:read', 'wallets:read'] },
    { name: 'guest', permissions: ['donations:read', 'stats:read'] },
  ],
};

// ─── validateRolesConfig ──────────────────────────────────────────────────────

describe('validateRolesConfig', () => {

  // ── Root-level checks ─────────────────────────────────────────────────────

  describe('root-level structure', () => {
    test('returns valid for a well-formed config', () => {
      const result = validateRolesConfig(VALID_CONFIG);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    test('rejects null', () => {
      const result = validateRolesConfig(null);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Roles configuration must be a non-null object');
    });

    test('rejects undefined', () => {
      const result = validateRolesConfig(undefined);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Roles configuration must be a non-null object');
    });

    test('rejects a plain array', () => {
      const result = validateRolesConfig([]);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Roles configuration must be a non-null object');
    });

    test('rejects a string', () => {
      const result = validateRolesConfig('not-an-object');
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Roles configuration must be a non-null object');
    });

    test('rejects a number', () => {
      const result = validateRolesConfig(42);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Roles configuration must be a non-null object');
    });
  });

  // ── roles array checks ────────────────────────────────────────────────────

  describe('roles array', () => {
    test('rejects config with no roles key', () => {
      const result = validateRolesConfig({});
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Roles configuration must contain a "roles" array');
    });

    test('rejects roles when not an array', () => {
      const result = validateRolesConfig({ roles: 'not-an-array' });
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Roles configuration must contain a "roles" array');
    });

    test('rejects roles when it is a null', () => {
      const result = validateRolesConfig({ roles: null });
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Roles configuration must contain a "roles" array');
    });

    test('rejects an empty roles array', () => {
      const result = validateRolesConfig({ roles: [] });
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('The "roles" array must not be empty');
    });
  });

  // ── Role object checks ────────────────────────────────────────────────────

  describe('role objects', () => {
    test('rejects a role that is null', () => {
      const result = validateRolesConfig({ roles: [null] });
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Role at index 0 must be a non-null object');
    });

    test('rejects a role that is a string', () => {
      const result = validateRolesConfig({ roles: ['admin'] });
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Role at index 0 must be a non-null object');
    });

    test('rejects a role that is an array', () => {
      const result = validateRolesConfig({ roles: [['admin', ['*']]] });
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Role at index 0 must be a non-null object');
    });
  });

  // ── Role name checks ──────────────────────────────────────────────────────

  describe('role name', () => {
    test('rejects a role without a name', () => {
      const result = validateRolesConfig({ roles: [{ permissions: ['*'] }] });
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Role at index 0 must have a non-empty string "name"');
    });

    test('rejects a role with a number as name', () => {
      const result = validateRolesConfig({ roles: [{ name: 123, permissions: ['*'] }] });
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Role at index 0 must have a non-empty string "name"');
    });

    test('rejects a role with an empty string name', () => {
      const result = validateRolesConfig({ roles: [{ name: '', permissions: ['*'] }] });
      expect(result.valid).toBe(false);
      // Empty string is falsy in JS, so it's caught by the "must have a non-empty string" check
      expect(result.errors.length).toBeGreaterThanOrEqual(1);
      expect(result.errors[0]).toMatch(/must have a non-empty string "name"/);
    });

    test('rejects a role with a whitespace-only name', () => {
      const result = validateRolesConfig({ roles: [{ name: '   ', permissions: ['*'] }] });
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Role at index 0 has an empty "name"');
    });

    test('rejects a role with null name', () => {
      const result = validateRolesConfig({ roles: [{ name: null, permissions: ['*'] }] });
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Role at index 0 must have a non-empty string "name"');
    });
  });

  // ── Permissions array checks ──────────────────────────────────────────────

  describe('permissions array', () => {
    test('rejects a role without a permissions key', () => {
      const result = validateRolesConfig({ roles: [{ name: 'admin' }] });
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Role "admin" must have a "permissions" array');
    });

    test('rejects a role with non-array permissions', () => {
      const result = validateRolesConfig({ roles: [{ name: 'admin', permissions: '*' }] });
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Role "admin" must have a "permissions" array');
    });

    test('rejects a role with permissions as null', () => {
      const result = validateRolesConfig({ roles: [{ name: 'admin', permissions: null }] });
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Role "admin" must have a "permissions" array');
    });

    test('rejects a role with an empty permissions array', () => {
      const result = validateRolesConfig({ roles: [{ name: 'admin', permissions: [] }] });
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Role "admin" has an empty "permissions" array');
    });
  });

  // ── Permission string checks ──────────────────────────────────────────────

  describe('permission string format', () => {
    test('accepts wildcard permission (*)', () => {
      const result = validateRolesConfig({ roles: [{ name: 'admin', permissions: ['*'] }] });
      expect(result.valid).toBe(true);
    });

    test('accepts valid resource:action format', () => {
      const result = validateRolesConfig({ roles: [{ name: 'user', permissions: ['donations:create'] }] });
      expect(result.valid).toBe(true);
    });

    test('accepts resource wildcard (donations:*)', () => {
      const result = validateRolesConfig({ roles: [{ name: 'user', permissions: ['donations:*'] }] });
      expect(result.valid).toBe(true);
    });

    test('accepts permissions with hyphens and underscores', () => {
      const result = validateRolesConfig({ roles: [{ name: 'test', permissions: ['my-resource:my_action'] }] });
      expect(result.valid).toBe(true);
    });

    test('rejects a permission that is a number', () => {
      const result = validateRolesConfig({ roles: [{ name: 'admin', permissions: [42] }] });
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Role "admin", permission at index 0 must be a string, got number');
    });

    test('rejects a permission that is null', () => {
      const result = validateRolesConfig({ roles: [{ name: 'admin', permissions: [null] }] });
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Role "admin", permission at index 0 must be a string, got object');
    });

    test('rejects a permission that is an object', () => {
      const result = validateRolesConfig({ roles: [{ name: 'admin', permissions: [{}] }] });
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Role "admin", permission at index 0 must be a string, got object');
    });
  });

  // ── Warning-level checks (non-critical format issues) ─────────────────────

  describe('permission format validation', () => {
    test('rejects a permission without colon', () => {
      const result = validateRolesConfig({ roles: [{ name: 'test', permissions: ['invalidformat'] }] });
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Role "test", permission "invalidformat" at index 0 must be "*" or match expected format "resource:action"');
    });

    test('rejects a permission with empty action', () => {
      const result = validateRolesConfig({ roles: [{ name: 'test', permissions: ['resource:'] }] });
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Role "test", permission "resource:" at index 0 must be "*" or match expected format "resource:action"');
    });

    test('rejects a permission with empty resource', () => {
      const result = validateRolesConfig({ roles: [{ name: 'test', permissions: [':action'] }] });
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Role "test", permission ":action" at index 0 must be "*" or match expected format "resource:action"');
    });
  });

  test('rejects duplicate role names', () => {
    const config = {
      roles: [
        { name: 'admin', permissions: ['*'] },
        { name: 'admin', permissions: ['donations:read'] }
      ]
    };
    const result = validateRolesConfig(config);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Duplicate role name "admin" detected');
  });

  // ── Multiple roles, mixed errors ──────────────────────────────────────────

  describe('multiple roles with errors', () => {
    test('collects errors from multiple invalid roles', () => {
      const config = {
        roles: [
          { name: 'admin', permissions: ['*'] },
          { name: '', permissions: ['donations:read'] },
          { name: 'user', permissions: [] },
          { name: 'guest' },
        ],
      };
      const result = validateRolesConfig(config);
      expect(result.valid).toBe(false);
      // Should have at least 2 errors: empty name + empty permissions + missing permissions
      expect(result.errors.length).toBeGreaterThanOrEqual(3);
    });
  });
});

// ─── loadRolesConfig integration ─────────────────────────────────────────────

describe('loadRolesConfig integration', () => {
  test('loads and returns the current roles.json file', () => {
    const config = loadRolesConfig();
    expect(config).toHaveProperty('roles');
    expect(Array.isArray(config.roles)).toBe(true);
    expect(config.roles.length).toBeGreaterThan(0);
  });

  test('returned config passes validation', () => {
    const config = loadRolesConfig();
    const result = validateRolesConfig(config);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  test('contains expected roles', () => {
    const config = loadRolesConfig();
    const roleNames = config.roles.map(r => r.name);
    expect(roleNames).toContain('admin');
    expect(roleNames).toContain('user');
    expect(roleNames).toContain('guest');
  });
});
