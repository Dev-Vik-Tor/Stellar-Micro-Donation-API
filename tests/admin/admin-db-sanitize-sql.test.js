const { sanitizeSql } = require('../../src/routes/admin/db');

describe('sanitizeSql', () => {
  it('should return raw SQL unchanged when params is empty or omitted', () => {
    const sql = 'SELECT * FROM users WHERE active = 1';
    expect(sanitizeSql(sql)).toBe(sql);
    expect(sanitizeSql(sql, [])).toBe(sql);
  });

  it('should substitute parameter values into ? placeholders in order', () => {
    const sql = 'SELECT * FROM transactions WHERE user_id = ? AND amount > ? AND status = ?';
    const params = [42, 100.5, 'completed'];
    const result = sanitizeSql(sql, params);

    expect(result).toBe("SELECT * FROM transactions WHERE user_id = 42 AND amount > 100.5 AND status = 'completed'");
  });

  it('should handle null, boolean, and escaped string parameters', () => {
    const sql = 'INSERT INTO audit_logs (user_id, action, error, is_admin) VALUES (?, ?, ?, ?)';
    const params = [1, "O'Reilly", null, true];
    const result = sanitizeSql(sql, params);

    expect(result).toBe("INSERT INTO audit_logs (user_id, action, error, is_admin) VALUES (1, 'O''Reilly', NULL, true)");
  });
});
