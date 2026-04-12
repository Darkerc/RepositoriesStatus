/**
 * @fileoverview Módulo de caché con expiración basada en tiempo (TTL).
 *
 * Proporciona un sistema de caché simple usando chrome.storage.local para almacenar
 * datos de contribuciones y actividad con una marca de tiempo. Los datos se consideran
 * válidos durante 1 hora (CACHE_TTL_MS) después de ser almacenados.
 *
 * Estructura de cada entrada en caché:
 *   { data: <datos_almacenados>, timestamp: <milisegundos_epoch> }
 *
 * Se usa para:
 * - Evitar llamadas innecesarias a las APIs de GitHub/GitLab.
 * - Mostrar datos inmediatamente al abrir el popup (mientras se cargan datos frescos).
 * - Servir datos obsoletos cuando las APIs fallan (mejor experiencia de usuario).
 *
 * Claves de caché utilizadas en la extensión:
 *   - 'github_contributions': datos del heatmap de GitHub
 *   - 'gitlab_contributions': datos del heatmap de GitLab
 *   - 'github_activity': feed de actividad de GitHub
 *   - 'gitlab_activity': feed de actividad de GitLab
 */

/** @const {number} Tiempo de vida de la caché en milisegundos (1 hora = 60 min * 60 seg * 1000 ms) */
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hora

/**
 * Obtiene datos del caché si existen y no han expirado.
 *
 * Flujo: lee la entrada del storage -> verifica si existe -> verifica si el TTL
 * no ha sido superado -> retorna los datos o null.
 *
 * @param {string} key - Clave de la entrada en caché (ej: 'github_contributions').
 * @returns {Promise<Object|null>} Los datos almacenados, o null si no existen o han expirado.
 */
export async function getCached(key) {
  const result = await chrome.storage.local.get(key);
  const entry = result[key];

  // Si no existe la entrada, retornar null
  if (!entry) return null;
  // Si ha pasado más tiempo que el TTL, considerar los datos como expirados
  if (Date.now() - entry.timestamp > CACHE_TTL_MS) return null;

  return entry.data;
}

/**
 * Almacena datos en el caché con una marca de tiempo actual.
 * La marca de tiempo se usa después para verificar si los datos han expirado.
 *
 * @param {string} key - Clave bajo la cual almacenar los datos (ej: 'github_contributions').
 * @param {*} data - Los datos a almacenar (contribuciones, actividad, etc.).
 * @returns {Promise<void>}
 */
export async function setCache(key, data) {
  await chrome.storage.local.set({
    [key]: {
      data,                  // Los datos propiamente dichos
      timestamp: Date.now(), // Momento exacto del almacenamiento
    },
  });
}

/**
 * Elimina una entrada específica del caché.
 * Se usa al desconectar un proveedor para limpiar sus datos almacenados.
 *
 * @param {string} key - Clave de la entrada a eliminar (ej: 'github_contributions').
 * @returns {Promise<void>}
 */
export async function clearCache(key) {
  await chrome.storage.local.remove(key);
}

/**
 * Elimina todas las entradas del caché cuya clave comienza con un prefijo dado.
 * Útil cuando hay múltiples claves dinámicas que comparten un prefijo común
 * (por ejemplo, la actividad cacheada por cada grupo/org del usuario).
 *
 * @param {string} prefix - Prefijo de las claves a eliminar (ej: 'group_activity_gh_').
 * @returns {Promise<void>}
 */
export async function clearCacheByPrefix(prefix) {
  const all = await chrome.storage.local.get(null);
  const keys = Object.keys(all).filter(k => k.startsWith(prefix));
  if (keys.length > 0) await chrome.storage.local.remove(keys);
}
