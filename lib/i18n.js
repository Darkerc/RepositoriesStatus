/**
 * @fileoverview Modulo de internacionalizacion (i18n) de la extension.
 *
 * Proporciona traduccion dinamica de cadenas sin necesidad de reiniciar la extension.
 * Soporta deteccion automatica del idioma del navegador, cambio manual en runtime,
 * y fallback a ingles cuando una clave no existe en el idioma activo.
 *
 * Uso:
 *   import { initI18n, t, setLocale, getLocale, translatePage } from './i18n.js';
 *   await initI18n();
 *   t('popup.title');                        // => "Contributions"
 *   t('status.loadFailed', { error: '...' }) // => "Failed to load contributions: ..."
 */

const SUPPORTED_LOCALES = ['en', 'es', 'zh'];
const DEFAULT_LOCALE = 'en';

let currentLocale = DEFAULT_LOCALE;
const dictionaries = {};
let initialized = false;

/**
 * Inicializa el sistema i18n: detecta idioma, carga diccionarios.
 * Debe llamarse una vez antes de usar t().
 * Es idempotente: llamadas subsecuentes retornan inmediatamente.
 *
 * @returns {Promise<string>} El codigo de locale resuelto.
 */
export async function initI18n() {
  if (initialized) return currentLocale;

  // 1. Buscar preferencia guardada
  let locale = null;
  try {
    const result = await chrome.storage.local.get('user_locale');
    if (result.user_locale && SUPPORTED_LOCALES.includes(result.user_locale)) {
      locale = result.user_locale;
    }
  } catch { /* storage no disponible, continuar con deteccion */ }

  // 2. Detectar idioma del navegador
  if (!locale) {
    const languages = navigator.languages || [navigator.language];
    for (const lang of languages) {
      const code = lang.split('-')[0].toLowerCase();
      if (SUPPORTED_LOCALES.includes(code)) {
        locale = code;
        break;
      }
    }
  }

  // 3. Fallback a ingles
  currentLocale = locale || DEFAULT_LOCALE;

  // Cargar diccionario del locale activo
  await loadDictionary(currentLocale);

  // Cargar ingles como fallback si no es el locale activo
  if (currentLocale !== DEFAULT_LOCALE) {
    await loadDictionary(DEFAULT_LOCALE);
  }

  initialized = true;
  return currentLocale;
}

/**
 * Carga un diccionario de locale si no esta ya cargado.
 *
 * @param {string} locale - Codigo de locale ('en', 'es', 'zh').
 */
async function loadDictionary(locale) {
  if (dictionaries[locale]) return;

  try {
    const module = await import(`../locales/${locale}.js`);
    dictionaries[locale] = module.default;
  } catch {
    dictionaries[locale] = {};
  }
}

/**
 * Traduce una clave, interpolando placeholders {nombre}.
 * Cadena de fallback: locale actual -> ingles -> la clave misma.
 *
 * @param {string} key - Clave de traduccion (ej: "popup.title").
 * @param {Object.<string, string|number>} [params] - Valores para placeholders.
 * @returns {string} Cadena traducida e interpolada.
 */
export function t(key, params) {
  let str = dictionaries[currentLocale]?.[key]
         ?? dictionaries[DEFAULT_LOCALE]?.[key]
         ?? key;

  if (params) {
    for (const [name, value] of Object.entries(params)) {
      str = str.replaceAll(`{${name}}`, String(value));
    }
  }
  return str;
}

/**
 * Cambia el idioma activo en runtime.
 * Carga el diccionario si es necesario, guarda la preferencia y re-traduce la pagina.
 *
 * @param {string} locale - Codigo de locale ('en', 'es', 'zh').
 */
export async function setLocale(locale) {
  if (!SUPPORTED_LOCALES.includes(locale)) locale = DEFAULT_LOCALE;

  await loadDictionary(locale);
  currentLocale = locale;

  try {
    await chrome.storage.local.set({ user_locale: locale });
  } catch { /* ignorar si storage no esta disponible */ }

  translatePage();
}

/**
 * Retorna el codigo de locale activo.
 *
 * @returns {string} Codigo de locale ('en', 'es', 'zh').
 */
export function getLocale() {
  return currentLocale;
}

/**
 * Traduce todos los elementos del DOM que tengan atributos data-i18n.
 * Soporta: data-i18n (textContent), data-i18n-title (title), data-i18n-placeholder (placeholder).
 */
export function translatePage() {
  if (typeof document === 'undefined') return;

  document.querySelectorAll('[data-i18n]').forEach(el => {
    el.textContent = t(el.getAttribute('data-i18n'));
  });

  document.querySelectorAll('[data-i18n-title]').forEach(el => {
    el.title = t(el.getAttribute('data-i18n-title'));
  });

  document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
    el.placeholder = t(el.getAttribute('data-i18n-placeholder'));
  });

  document.documentElement.lang = currentLocale;
}
