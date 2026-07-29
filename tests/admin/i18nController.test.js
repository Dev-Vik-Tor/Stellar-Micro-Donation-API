'use strict';

/**
 * Tests: src/controllers/admin/i18nController.js (issue #1388)
 *
 * Unit-tests each exported controller function by calling it directly with
 * a synthetic req/res pair. The Translation model is fully mocked so no
 * database or network calls are made.
 *
 * Covers:
 *  getAllMessages
 *    - returns all translation keys with their translations from the cache
 *    - re-fetches from Translation model when the cache is stale
 *    - returns 500 on model error
 *
 *  updateTranslation
 *    - updates an existing translation document
 *    - creates a new document when the key does not exist
 *    - returns 400 when value is missing
 *    - returns 500 on model error
 *    - clears the cache so the next request reloads from storage
 *
 *  addLanguage
 *    - seeds all existing keys with the new language code
 *    - uses provided translation values when available, empty string otherwise
 *    - skips keys that already have the language code set
 *    - returns 400 when code is missing
 *    - returns 400 when name is missing
 *    - returns 500 on model error
 */

// ─── Mock the Translation model before loading the controller ─────────────────

const mockSave = jest.fn();
const mockFind = jest.fn();
const mockFindOne = jest.fn();

// We need a constructor mock so `new Translation(...)` works
const MockTranslation = jest.fn().mockImplementation(({ key, translations = {} }) => ({
  key,
  translations: new Map(Object.entries(translations)),
  updatedAt: Date.now(),
  save: mockSave,
}));
MockTranslation.find = mockFind;
MockTranslation.findOne = mockFindOne;

jest.mock('../../src/models/translation', () => MockTranslation);

// ─── Load the controller AFTER the mock is registered ────────────────────────

const controller = require('../../src/controllers/admin/i18nController');

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Build a minimal Express-like req object.
 */
function makeReq({ params = {}, body = {}, query = {} } = {}) {
  return { params, body, query };
}

/**
 * Build a minimal Express-like res object that captures calls.
 */
function makeRes() {
  const res = {
    _status: 200,
    _body: null,
    status(code) {
      this._status = code;
      return this;
    },
    json(body) {
      this._body = body;
      return this;
    },
  };
  return res;
}

/**
 * Build a TranslationDoc-like object the way the real model returns it.
 */
function makeDoc(key, translationsObj = {}) {
  return {
    key,
    translations: new Map(Object.entries(translationsObj)),
    updatedAt: Date.now(),
    save: mockSave,
  };
}

// ─── Before / after hooks ─────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
  mockSave.mockResolvedValue(undefined);
});

// ─── getAllMessages ────────────────────────────────────────────────────────────

describe('getAllMessages', () => {
  it('returns 200 with all translation keys and their translations', async () => {
    mockFind.mockResolvedValue([
      makeDoc('errors.notFound', { en: 'Not found', es: 'No encontrado' }),
      makeDoc('errors.unauthorized', { en: 'Unauthorized' }),
    ]);

    const req = makeReq();
    const res = makeRes();

    await controller.getAllMessages(req, res);

    expect(res._status).toBe(200);
    expect(res._body.success).toBe(true);
    expect(Array.isArray(res._body.messages)).toBe(true);
    expect(res._body.messages).toHaveLength(2);

    const keys = res._body.messages.map(m => m.key);
    expect(keys).toContain('errors.notFound');
    expect(keys).toContain('errors.unauthorized');
  });

  it('includes translations object for each message entry', async () => {
    mockFind.mockResolvedValue([
      makeDoc('welcome', { en: 'Welcome', fr: 'Bienvenue' }),
    ]);

    const req = makeReq();
    const res = makeRes();

    await controller.getAllMessages(req, res);

    const entry = res._body.messages[0];
    expect(entry.key).toBe('welcome');
    expect(entry.translations).toBeDefined();
  });

  it('returns 200 with empty messages array when no translations exist', async () => {
    mockFind.mockResolvedValue([]);

    const req = makeReq();
    const res = makeRes();

    await controller.getAllMessages(req, res);

    expect(res._body.success).toBe(true);
    expect(res._body.messages).toHaveLength(0);
  });

  it('returns 500 when the Translation model throws', async () => {
    mockFind.mockRejectedValue(new Error('DB unavailable'));

    const req = makeReq();
    const res = makeRes();

    await controller.getAllMessages(req, res);

    expect(res._status).toBe(500);
    expect(res._body.success).toBe(false);
    expect(res._body.error).toMatch('DB unavailable');
  });
});

// ─── updateTranslation ────────────────────────────────────────────────────────

describe('updateTranslation', () => {
  it('returns 400 when value is missing from request body', async () => {
    const req = makeReq({
      params: { lang: 'en', key: 'errors.notFound' },
      body: {},  // no value
    });
    const res = makeRes();

    await controller.updateTranslation(req, res);

    expect(res._status).toBe(400);
    expect(res._body.error).toMatch(/value is required/i);
  });

  it('updates an existing translation document and returns 200', async () => {
    const existingDoc = makeDoc('errors.notFound', { en: 'Not found' });
    mockFindOne.mockResolvedValue(existingDoc);

    const req = makeReq({
      params: { lang: 'en', key: 'errors.notFound' },
      body: { value: 'Resource not found' },
    });
    const res = makeRes();

    await controller.updateTranslation(req, res);

    expect(mockSave).toHaveBeenCalledTimes(1);
    expect(res._status).toBe(200);
    expect(res._body.success).toBe(true);
    expect(res._body.updated).toEqual({
      key: 'errors.notFound',
      lang: 'en',
      value: 'Resource not found',
    });
  });

  it('creates a new translation document when the key does not exist', async () => {
    mockFindOne.mockResolvedValue(null);

    const req = makeReq({
      params: { lang: 'fr', key: 'errors.newKey' },
      body: { value: 'Nouvelle valeur' },
    });
    const res = makeRes();

    await controller.updateTranslation(req, res);

    // MockTranslation constructor should have been called
    expect(MockTranslation).toHaveBeenCalledWith({
      key: 'errors.newKey',
      translations: {},
    });
    expect(mockSave).toHaveBeenCalledTimes(1);
    expect(res._body.success).toBe(true);
    expect(res._body.updated.key).toBe('errors.newKey');
    expect(res._body.updated.lang).toBe('fr');
  });

  it('sets the new value on the translations map', async () => {
    const doc = makeDoc('greeting', { en: 'Hello' });
    mockFindOne.mockResolvedValue(doc);

    const req = makeReq({
      params: { lang: 'es', key: 'greeting' },
      body: { value: 'Hola' },
    });
    const res = makeRes();

    await controller.updateTranslation(req, res);

    expect(doc.translations.get('es')).toBe('Hola');
  });

  it('returns 500 when findOne throws', async () => {
    mockFindOne.mockRejectedValue(new Error('Timeout'));

    const req = makeReq({
      params: { lang: 'en', key: 'foo' },
      body: { value: 'bar' },
    });
    const res = makeRes();

    await controller.updateTranslation(req, res);

    expect(res._status).toBe(500);
    expect(res._body.success).toBe(false);
  });

  it('returns 500 when save throws', async () => {
    const doc = makeDoc('greeting', { en: 'Hello' });
    mockFindOne.mockResolvedValue(doc);
    mockSave.mockRejectedValue(new Error('Write failed'));

    const req = makeReq({
      params: { lang: 'en', key: 'greeting' },
      body: { value: 'Hi' },
    });
    const res = makeRes();

    await controller.updateTranslation(req, res);

    expect(res._status).toBe(500);
    expect(res._body.success).toBe(false);
  });

  it('invalidates the in-memory cache so subsequent reads reload from storage', async () => {
    // Prime the cache with an initial getAllMessages call
    mockFind.mockResolvedValue([makeDoc('k', { en: 'old' })]);
    await controller.getAllMessages(makeReq(), makeRes());

    // Now update the translation
    const doc = makeDoc('k', { en: 'old' });
    mockFindOne.mockResolvedValue(doc);
    mockFind.mockResolvedValue([makeDoc('k', { en: 'new' })]);

    await controller.updateTranslation(
      makeReq({ params: { lang: 'en', key: 'k' }, body: { value: 'new' } }),
      makeRes()
    );

    // getAllMessages should re-fetch from the model (find called again)
    const callsBefore = mockFind.mock.calls.length;
    await controller.getAllMessages(makeReq(), makeRes());
    expect(mockFind.mock.calls.length).toBeGreaterThan(callsBefore);
  });
});

// ─── addLanguage ──────────────────────────────────────────────────────────────

describe('addLanguage', () => {
  it('returns 400 when code is missing', async () => {
    const req = makeReq({ body: { name: 'Spanish' } });
    const res = makeRes();

    await controller.addLanguage(req, res);

    expect(res._status).toBe(400);
    expect(res._body.error).toMatch(/code.*name/i);
  });

  it('returns 400 when name is missing', async () => {
    const req = makeReq({ body: { code: 'es' } });
    const res = makeRes();

    await controller.addLanguage(req, res);

    expect(res._status).toBe(400);
    expect(res._body.error).toMatch(/code.*name/i);
  });

  it('returns 201 and seeds all existing keys for the new language', async () => {
    const doc1 = makeDoc('greeting', { en: 'Hello' });
    const doc2 = makeDoc('farewell', { en: 'Goodbye' });

    // find({}, 'key') — returns key stubs
    mockFind.mockResolvedValue([{ key: 'greeting' }, { key: 'farewell' }]);
    // findOne for each key
    mockFindOne
      .mockResolvedValueOnce(doc1)
      .mockResolvedValueOnce(doc2);

    const req = makeReq({
      body: {
        code: 'es',
        name: 'Spanish',
        translations: { greeting: 'Hola' }, // farewell has no provided translation
      },
    });
    const res = makeRes();

    await controller.addLanguage(req, res);

    expect(res._status).toBe(201);
    expect(res._body.success).toBe(true);
    expect(res._body.message).toMatch(/es.*Spanish/i);

    // greeting should have been saved with 'Hola'
    expect(doc1.translations.get('es')).toBe('Hola');
    // farewell has no provided translation — falls back to empty string
    expect(doc2.translations.get('es')).toBe('');
    expect(mockSave).toHaveBeenCalledTimes(2);
  });

  it('skips a key that already has the new language set', async () => {
    // doc already has 'es'
    const doc = makeDoc('greeting', { en: 'Hello', es: 'Hola' });
    mockFind.mockResolvedValue([{ key: 'greeting' }]);
    mockFindOne.mockResolvedValue(doc);

    const req = makeReq({ body: { code: 'es', name: 'Spanish' } });
    const res = makeRes();

    await controller.addLanguage(req, res);

    // save should NOT have been called because 'es' already exists
    expect(mockSave).not.toHaveBeenCalled();
    expect(res._status).toBe(201);
  });

  it('handles an empty translation store (no existing keys)', async () => {
    mockFind.mockResolvedValue([]);

    const req = makeReq({ body: { code: 'pt', name: 'Portuguese' } });
    const res = makeRes();

    await controller.addLanguage(req, res);

    expect(res._status).toBe(201);
    expect(mockSave).not.toHaveBeenCalled();
  });

  it('returns 500 when Translation.find throws', async () => {
    mockFind.mockRejectedValue(new Error('Storage error'));

    const req = makeReq({ body: { code: 'de', name: 'German' } });
    const res = makeRes();

    await controller.addLanguage(req, res);

    expect(res._status).toBe(500);
    expect(res._body.success).toBe(false);
  });

  it('returns 500 when save throws for one of the documents', async () => {
    mockFind.mockResolvedValue([{ key: 'k1' }]);
    const doc = makeDoc('k1', { en: 'val' });
    mockFindOne.mockResolvedValue(doc);
    mockSave.mockRejectedValue(new Error('Write error'));

    const req = makeReq({ body: { code: 'ja', name: 'Japanese' } });
    const res = makeRes();

    await controller.addLanguage(req, res);

    expect(res._status).toBe(500);
    expect(res._body.success).toBe(false);
  });
});
