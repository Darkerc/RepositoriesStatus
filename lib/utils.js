/**
 * @fileoverview Módulo de utilidades generales para la extensión.
 *
 * Proporciona funciones auxiliares usadas en toda la extensión:
 * - Generación de cadenas aleatorias criptográficamente seguras (para PKCE y estados OAuth)
 * - Codificación Base64-URL (necesaria para los desafíos PKCE)
 * - Hash SHA-256 (usado para generar el code_challenge de PKCE)
 * - Formato y manipulación de fechas (para el heatmap y la actividad)
 * - Parseo de parámetros de URL (para extraer códigos de autorización OAuth)
 *
 * Este módulo NO tiene dependencias externas y es importado por auth.js, heatmap.js, etc.
 */

/**
 * Genera una cadena aleatoria criptográficamente segura de la longitud dada.
 * Se usa para crear verificadores de código PKCE y parámetros de estado OAuth.
 *
 * Flujo: genera bytes aleatorios -> los codifica en Base64-URL.
 *
 * @param {number} [length=64] - Cantidad de bytes aleatorios a generar.
 * @returns {string} Cadena codificada en Base64-URL (sin padding).
 */
export function generateRandomString(length = 64) {
  // Crear un arreglo de bytes aleatorios usando la API Web Crypto
  const array = new Uint8Array(length);
  crypto.getRandomValues(array);
  // Convertir los bytes a una representación segura para URLs
  return base64UrlEncode(array);
}

/**
 * Codifica un Uint8Array en formato Base64-URL (sin padding '=').
 *
 * La codificación Base64-URL reemplaza los caracteres '+' y '/' del Base64 estándar
 * por '-' y '_' respectivamente, y elimina el padding '='. Esto es necesario
 * para los flujos PKCE de OAuth2, donde el code_challenge debe ser URL-safe.
 *
 * @param {Uint8Array|ArrayBuffer} buffer - Los bytes a codificar.
 * @returns {string} Cadena codificada en Base64-URL sin padding.
 */
export function base64UrlEncode(buffer) {
  // Asegurar que trabajamos con un Uint8Array
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);

  // Convertir cada byte a su carácter correspondiente para poder usar btoa()
  let binary = '';
  for (const b of bytes) {
    binary += String.fromCharCode(b);
  }

  // Codificar en Base64 y luego transformar a formato URL-safe
  return btoa(binary)
    .replace(/\+/g, '-')   // '+' -> '-' (URL-safe)
    .replace(/\//g, '_')   // '/' -> '_' (URL-safe)
    .replace(/=+$/, '');   // Eliminar padding '='
}

/**
 * Calcula el hash SHA-256 de una cadena de texto plano.
 * Se usa para generar el code_challenge a partir del code_verifier en el flujo PKCE.
 *
 * @param {string} plain - La cadena de texto a hashear.
 * @returns {Promise<ArrayBuffer>} El hash SHA-256 como ArrayBuffer.
 */
export async function sha256(plain) {
  // Codificar la cadena a bytes UTF-8 antes de hashear
  const encoder = new TextEncoder();
  return crypto.subtle.digest('SHA-256', encoder.encode(plain));
}

/**
 * Formatea un objeto Date a una cadena con formato 'YYYY-MM-DD'.
 * Este formato es el que usan las APIs de GitHub y GitLab para las fechas de contribuciones.
 *
 * @param {Date} date - El objeto Date a formatear.
 * @returns {string} Fecha formateada como 'YYYY-MM-DD' (ej: '2025-03-15').
 */
export function formatDate(date) {
  const y = date.getFullYear();
  // getMonth() devuelve 0-11, sumamos 1 para obtener 1-12
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * Obtiene el nombre abreviado (en inglés) de un mes a partir de su índice.
 * Se usa para las etiquetas de los meses en el heatmap SVG.
 *
 * @param {number} index - Índice del mes (0 = Enero, 11 = Diciembre).
 * @returns {string} Nombre abreviado del mes (ej: 'Jan', 'Feb', etc.).
 */
export function monthName(index) {
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return months[index];
}

/**
 * Genera un arreglo con las fechas de los últimos 365 días (incluyendo hoy).
 * Las fechas se devuelven ordenadas de la más antigua a la más reciente.
 * Se usa para construir las celdas del heatmap de contribuciones.
 *
 * @returns {string[]} Arreglo de cadenas con formato 'YYYY-MM-DD', desde hace 364 días hasta hoy.
 */
export function getLast365Days() {
  const days = [];
  const today = new Date();

  // Iterar desde 364 días atrás hasta hoy (365 días en total)
  for (let i = 364; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(today.getDate() - i);
    days.push(formatDate(d));
  }
  return days;
}

/**
 * Parsea los parámetros de consulta (query string) de una URL de redirección OAuth.
 * Se usa para extraer el 'code' y 'state' de la respuesta del servidor de autorización.
 *
 * @param {string} url - La URL completa de redirección (ej: 'https://...?code=abc&state=xyz').
 * @returns {Object.<string, string>} Objeto con los pares clave-valor de los parámetros.
 */
export function parseQueryParams(url) {
  const params = {};
  // Extraer la parte del query string (sin el '?' inicial)
  const queryString = new URL(url).search.substring(1);

  // Separar cada par clave=valor y decodificar los componentes URI
  for (const pair of queryString.split('&')) {
    const [key, value] = pair.split('=');
    if (key) params[decodeURIComponent(key)] = decodeURIComponent(value || '');
  }
  return params;
}
