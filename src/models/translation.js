'use strict';

const Database = require('../utils/database');

const CREATE_TABLE = `
  CREATE TABLE IF NOT EXISTS translations (
    key         TEXT PRIMARY KEY,
    translations TEXT NOT NULL DEFAULT '{}',
    updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`;

async function initTable() {
  await Database.run(CREATE_TABLE);
}

class TranslationDoc {
  constructor({ key, translations = {}, updated_at } = {}) {
    this.key = key;
    this.translations = new Map(Object.entries(
      typeof translations === 'string' ? JSON.parse(translations) : translations
    ));
    this.updatedAt = updated_at ? new Date(updated_at) : new Date();
  }

  async save() {
    await initTable();
    const json = JSON.stringify(Object.fromEntries(this.translations));
    await Database.run(
      `INSERT INTO translations (key, translations, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET translations = excluded.translations, updated_at = excluded.updated_at`,
      [this.key, json, new Date(this.updatedAt).toISOString()]
    );
  }

  static async find(filter = {}, projection) {
    await initTable();

    const allowedColumns = ['key', 'translations', 'updated_at'];
    let selectClause = '*';

    if (projection) {
      let fields = [];
      if (Array.isArray(projection)) {
        fields = projection.filter(field => allowedColumns.includes(field));
      } else if (typeof projection === 'object' && projection !== null) {
        fields = Object.keys(projection).filter(
          field => allowedColumns.includes(field) && projection[field] !== 0
        );
      } else if (typeof projection === 'string' && allowedColumns.includes(projection)) {
        fields = [projection];
      }

      if (fields.length > 0) {
        selectClause = fields.map(field => `"${field}"`).join(', ');
      }
    }

    const filterEntries = Object.entries(filter || {}).filter(([, value]) => value !== undefined);
    const whereClauses = [];
    const params = [];

    for (const [field, value] of filterEntries) {
      if (!allowedColumns.includes(field)) continue;
      whereClauses.push(`"${field}" = ?`);
      params.push(value);
    }

    const sql = `SELECT ${selectClause} FROM translations${whereClauses.length ? ` WHERE ${whereClauses.join(' AND ')}` : ''}`;
    const rows = await Database.all(sql, params);
    return (rows || []).map(r => new TranslationDoc(r));
  }

  static async findOne(filter = {}) {
    await initTable();
    if (filter.key !== undefined) {
      const row = await Database.get(`SELECT * FROM translations WHERE key = ?`, [filter.key]);
      return row ? new TranslationDoc(row) : null;
    }
    const row = await Database.get(`SELECT * FROM translations LIMIT 1`);
    return row ? new TranslationDoc(row) : null;
  }
}

module.exports = TranslationDoc;
