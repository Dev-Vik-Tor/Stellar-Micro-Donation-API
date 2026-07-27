const Translation = require('../models/translation');
const log = require('./log');

// In-memory cache
let translationCache = {};
let lastCacheUpdate = 0;
const CACHE_TTL = 60 * 1000; // 60 seconds (as per acceptance criteria)

const loadTranslations = async () => {
  const now = Date.now();
  
  // Return cache if still valid
  if (now - lastCacheUpdate < CACHE_TTL && Object.keys(translationCache).length > 0) {
    return translationCache;
  }

  try {
    const translations = await Translation.find({});
    translationCache = {};

    translations.forEach((doc) => {
      translationCache[doc.key] = doc.translations || {};
    });

    lastCacheUpdate = now;
    log.info('I18N', 'Loaded translation keys from DB', { count: Object.keys(translationCache).length });
    
    return translationCache;
  } catch (error) {
    log.error('I18N', 'Failed to load translations from DB', { error: error.message });
    return translationCache; // fallback to existing cache
  }
};

/**
 * Get translation for a key and language
 * @param {string} key - Translation key (e.g. "error.validation.required")
 * @param {string} lang - Language code (en, es, fr, pt, etc.)
 * @returns {string} Translated string or fallback
 */
const t = async (key, lang = 'en') => {
  const translations = await loadTranslations();
  
  const langTranslations = translations[key] || {};
  
  // Return requested language
  if (langTranslations[lang]) {
    return langTranslations[lang];
  }
  
  // Fallback to English
  if (langTranslations['en']) {
    return langTranslations['en'];
  }
  
  // Ultimate fallback
  return key;
};

/**
 * Get all translations for a specific language
 */
const getAllForLanguage = async (lang = 'en') => {
  const translations = await loadTranslations();
  const result = {};
  
  Object.keys(translations).forEach(key => {
    result[key] = translations[key][lang] || translations[key]['en'] || key;
  });
  
  return result;
};

// ─── Static error-message localisation ──────────────────────────────────────
// Synchronous, dependency-free catalogue used by the error handler to localise
// standard API error responses (separate from the DB-backed dynamic `t` above).

const SUPPORTED_LANGUAGES = ['en', 'es', 'fr', 'pt'];

const MESSAGES = {
  // ── Validation errors ────────────────────────────────────────────────────
  VALIDATION_ERROR:       { en: 'Validation error',                       es: 'Error de validación',                    fr: 'Erreur de validation',                             pt: 'Erro de validação' },
  INVALID_REQUEST:        { en: 'Invalid request',                        es: 'Solicitud inválida',                     fr: 'Requête invalide',                                 pt: 'Requisição inválida' },
  INVALID_LIMIT:          { en: 'Invalid limit value',                    es: 'Valor de límite inválido',               fr: 'Valeur de limite invalide',                        pt: 'Valor de limite inválido' },
  INVALID_OFFSET:         { en: 'Invalid offset value',                   es: 'Valor de desplazamiento inválido',       fr: 'Valeur de décalage invalide',                      pt: 'Valor de deslocamento inválido' },
  INVALID_DATE_FORMAT:    { en: 'Invalid date format',                    es: 'Formato de fecha inválido',              fr: 'Format de date invalide',                          pt: 'Formato de data inválido' },
  INVALID_AMOUNT:         { en: 'Invalid amount',                         es: 'Monto inválido',                         fr: 'Montant invalide',                                 pt: 'Valor inválido' },
  INVALID_FREQUENCY:      { en: 'Invalid frequency',                      es: 'Frecuencia inválida',                    fr: 'Fréquence invalide',                               pt: 'Frequência inválida' },
  MISSING_REQUIRED_FIELD: { en: 'Missing required field',                 es: 'Campo obligatorio faltante',             fr: 'Champ obligatoire manquant',                       pt: 'Campo obrigatório ausente' },
  IDEMPOTENCY_KEY_REQUIRED:{ en: 'Idempotency key is required',           es: 'Se requiere clave de idempotencia',      fr: 'Clé d\'idempotence requise',                       pt: 'Chave de idempotência obrigatória' },
  INVALID_SCHEMA_VERSION: { en: 'Invalid schema version',                 es: 'Versión de esquema inválida',            fr: 'Version de schéma invalide',                       pt: 'Versão de esquema inválida' },

  // ── Authentication / Authorisation errors ────────────────────────────────
  UNAUTHORIZED:             { en: 'Unauthorized',                         es: 'No autorizado',                          fr: 'Non autorisé',                                     pt: 'Não autorizado' },
  ACCESS_DENIED:            { en: 'Access denied',                        es: 'Acceso denegado',                        fr: 'Accès refusé',                                     pt: 'Acesso negado' },
  FORBIDDEN:                { en: 'Forbidden',                            es: 'Prohibido',                              fr: 'Interdit',                                         pt: 'Proibido' },
  INSUFFICIENT_PERMISSIONS: { en: 'Insufficient permissions',             es: 'Permisos insuficientes',                 fr: 'Permissions insuffisantes',                        pt: 'Permissões insuficientes' },
  INVALID_API_KEY:          { en: 'Invalid API key',                      es: 'Clave de API inválida',                  fr: 'Clé API invalide',                                 pt: 'Chave de API inválida' },

  // ── Not found errors ─────────────────────────────────────────────────────
  NOT_FOUND:             { en: 'Resource not found',                      es: 'Recurso no encontrado',                  fr: 'Ressource introuvable',                            pt: 'Recurso não encontrado' },
  WALLET_NOT_FOUND:      { en: 'Wallet not found',                        es: 'Billetera no encontrada',                fr: 'Portefeuille introuvable',                         pt: 'Carteira não encontrada' },
  TRANSACTION_NOT_FOUND: { en: 'Transaction not found',                   es: 'Transacción no encontrada',              fr: 'Transaction introuvable',                          pt: 'Transação não encontrada' },
  USER_NOT_FOUND:        { en: 'User not found',                          es: 'Usuario no encontrado',                  fr: 'Utilisateur introuvable',                          pt: 'Usuário não encontrado' },
  DONATION_NOT_FOUND:    { en: 'Donation not found',                      es: 'Donación no encontrada',                 fr: 'Don introuvable',                                  pt: 'Doação não encontrada' },
  ENDPOINT_NOT_FOUND:    { en: 'Endpoint not found',                      es: 'Punto final no encontrado',              fr: 'Point de terminaison introuvable',                 pt: 'Endpoint não encontrado' },
  METHOD_NOT_ALLOWED:    { en: 'Method not allowed',                      es: 'Método no permitido',                    fr: 'Méthode non autorisée',                            pt: 'Método não permitido' },

  // ── Conflict / Duplicate errors ───────────────────────────────────────────
  DUPLICATE_ERROR:       { en: 'Duplicate resource',                      es: 'Recurso duplicado',                      fr: 'Ressource en double',                              pt: 'Recurso duplicado' },
  DUPLICATE_TRANSACTION: { en: 'Duplicate transaction',                   es: 'Transacción duplicada',                  fr: 'Transaction en double',                            pt: 'Transação duplicada' },
  DUPLICATE_DONATION:    { en: 'Duplicate donation',                      es: 'Donación duplicada',                     fr: 'Don en double',                                    pt: 'Doação duplicada' },
  RESOURCE_CONFLICT:     { en: 'Resource conflict',                       es: 'Conflicto de recurso',                   fr: 'Conflit de ressource',                             pt: 'Conflito de recurso' },

  // ── Business logic errors ────────────────────────────────────────────────
  INSUFFICIENT_BALANCE:     { en: 'Insufficient balance',                 es: 'Saldo insuficiente',                     fr: 'Solde insuffisant',                                pt: 'Saldo insuficiente' },
  TRANSACTION_FAILED:       { en: 'Transaction failed',                   es: 'Transacción fallida',                    fr: 'Transaction échouée',                              pt: 'Transação falhou' },
  INVALID_STATE_TRANSITION: { en: 'Invalid state transition',             es: 'Transición de estado inválida',          fr: 'Transition d\'état invalide',                      pt: 'Transição de estado inválida' },
  FEE_BUMP_MAX_ATTEMPTS:    { en: 'Fee bump max attempts reached',        es: 'Se alcanzaron los intentos máximos de aumento de tarifa', fr: 'Nombre maximal de tentatives de majoration de frais atteint', pt: 'Número máximo de tentativas de aumento de taxa atingido' },
  FEE_BUMP_EXCEEDS_CAP:     { en: 'Fee bump exceeds cap',                 es: 'El aumento de tarifa supera el límite',  fr: 'Majoration de frais dépassant le plafond',         pt: 'Aumento de taxa excede o limite' },
  FEE_BUMP_INVALID_STATE:   { en: 'Invalid state for fee bump',           es: 'Estado inválido para aumento de tarifa', fr: 'État invalide pour majoration de frais',           pt: 'Estado inválido para aumento de taxa' },
  FEE_BUMP_NO_ENVELOPE:     { en: 'No transaction envelope for fee bump', es: 'Sin sobre de transacción para aumento de tarifa', fr: 'Aucune enveloppe de transaction pour la majoration', pt: 'Sem envelope de transação para aumento de taxa' },
  FEE_BUMP_FAILED:          { en: 'Fee bump failed',                      es: 'Falló el aumento de tarifa',             fr: 'Échec de la majoration de frais',                  pt: 'Aumento de taxa falhou' },

  // ── Routing errors ───────────────────────────────────────────────────────
  ROUTING_STRATEGY_REQUIRED:  { en: 'Routing strategy is required',       es: 'Se requiere una estrategia de enrutamiento', fr: 'Stratégie de routage requise',                 pt: 'Estratégia de roteamento é obrigatória' },
  INVALID_ROUTING_STRATEGY:   { en: 'Invalid routing strategy',           es: 'Estrategia de enrutamiento inválida',    fr: 'Stratégie de routage invalide',                    pt: 'Estratégia de roteamento inválida' },
  POOL_NAME_REQUIRED:         { en: 'Pool name is required',              es: 'El nombre del grupo es obligatorio',     fr: 'Le nom du pool est requis',                        pt: 'Nome do pool é obrigatório' },
  POOL_NOT_FOUND:             { en: 'Pool not found',                     es: 'Grupo no encontrado',                    fr: 'Pool introuvable',                                 pt: 'Pool não encontrado' },
  POOL_EMPTY:                 { en: 'Pool is empty',                      es: 'El grupo está vacío',                    fr: 'Le pool est vide',                                 pt: 'O pool está vazio' },
  POOL_ALREADY_EXISTS:        { en: 'Pool already exists',                es: 'El grupo ya existe',                     fr: 'Le pool existe déjà',                              pt: 'O pool já existe' },
  RECIPIENT_NOT_IN_POOL:      { en: 'Recipient not in pool',              es: 'El destinatario no está en el grupo',    fr: 'Destinataire absent du pool',                      pt: 'Destinatário não está no pool' },
  DONOR_COORDINATES_REQUIRED: { en: 'Donor coordinates are required',     es: 'Se requieren coordenadas del donante',   fr: 'Les coordonnées du donneur sont requises',         pt: 'Coordenadas do doador são obrigatórias' },
  NO_ELIGIBLE_RECIPIENTS:     { en: 'No eligible recipients found',       es: 'No se encontraron destinatarios elegibles', fr: 'Aucun destinataire éligible trouvé',            pt: 'Nenhum destinatário elegível encontrado' },
  NO_ACTIVE_CAMPAIGNS:        { en: 'No active campaigns found',          es: 'No se encontraron campañas activas',     fr: 'Aucune campagne active trouvée',                   pt: 'Nenhuma campanha ativa encontrada' },
  RECIPIENT_ACCOUNT_NOT_FOUND:{ en: 'Recipient account not found',        es: 'Cuenta del destinatario no encontrada',  fr: 'Compte du destinataire introuvable',               pt: 'Conta do destinatário não encontrada' },

  // ── Rate limiting errors ─────────────────────────────────────────────────
  RATE_LIMIT_EXCEEDED: { en: 'Rate limit exceeded',                       es: 'Límite de tasa excedido',                fr: 'Limite de débit dépassée',                         pt: 'Limite de taxa excedido' },

  // ── Server errors ────────────────────────────────────────────────────────
  INTERNAL_ERROR:         { en: 'Internal server error',                  es: 'Error interno del servidor',             fr: 'Erreur interne du serveur',                        pt: 'Erro interno do servidor' },
  DATABASE_ERROR:         { en: 'Database error',                         es: 'Error de base de datos',                 fr: 'Erreur de base de données',                        pt: 'Erro de banco de dados' },
  VERIFICATION_FAILED:    { en: 'Verification failed',                    es: 'Verificación fallida',                   fr: 'Échec de la vérification',                         pt: 'Verificação falhou' },
  SERVICE_UNAVAILABLE:    { en: 'Service unavailable',                    es: 'Servicio no disponible',                 fr: 'Service indisponible',                             pt: 'Serviço indisponível' },
  STELLAR_NETWORK_ERROR:  { en: 'Stellar network error',                  es: 'Error de red de Stellar',                fr: 'Erreur réseau Stellar',                            pt: 'Erro de rede Stellar' },
  EXTERNAL_SERVICE_ERROR: { en: 'External service error',                 es: 'Error de servicio externo',              fr: 'Erreur de service externe',                        pt: 'Erro de serviço externo' },
  NOT_IMPLEMENTED:        { en: 'Not implemented',                        es: 'No implementado',                        fr: 'Non implémenté',                                   pt: 'Não implementado' },
};

/**
 * Resolve the best supported language from an Accept-Language header value.
 * Falls back to 'en' when nothing supported is requested.
 * @param {string|undefined|null} acceptLanguage
 * @returns {string} A supported language code.
 */
function parseLanguage(acceptLanguage) {
  if (!acceptLanguage || typeof acceptLanguage !== 'string') return 'en';

  const ranked = acceptLanguage
    .split(',')
    .map((part) => {
      const [tag, ...params] = part.trim().split(';');
      const qParam = params.find((p) => p.trim().startsWith('q='));
      const q = qParam ? parseFloat(qParam.trim().slice(2)) : 1;
      const base = (tag || '').trim().toLowerCase().split('-')[0];
      return { base, q: Number.isFinite(q) ? q : 1 };
    })
    .filter((e) => e.base)
    .sort((a, b) => b.q - a.q);

  for (const entry of ranked) {
    if (SUPPORTED_LANGUAGES.includes(entry.base)) return entry.base;
  }
  return 'en';
}

/**
 * Get a localised standard error message.
 * @param {string} key - Message key (e.g. 'VALIDATION_ERROR').
 * @param {string} [lang='en'] - Language code; unsupported languages fall back to English.
 * @returns {string|null} The localised message, or null when the key is unknown.
 */
function getMessage(key, lang = 'en') {
  const entry = MESSAGES[key];
  if (!entry) return null;
  return entry[lang] || entry.en;
}

module.exports = {
  t,
  getAllForLanguage,
  loadTranslations, // exported for admin usage
  parseLanguage,
  getMessage,
  SUPPORTED_LANGUAGES,
  MESSAGES,
};