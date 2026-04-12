/**
 * @fileoverview Service Worker (script de fondo) de la extensión.
 *
 * Este es el punto central de la extensión. Actúa como intermediario entre el popup
 * (interfaz de usuario) y las APIs de GitHub/GitLab. Todas las operaciones pesadas
 * (autenticación, llamadas a APIs, gestión de caché) se ejecutan aquí.
 *
 * Responsabilidades principales:
 * 1. Escuchar mensajes del popup y ejecutar la acción correspondiente.
 * 2. Gestionar la autenticación (conectar/desconectar proveedores).
 * 3. Obtener y cachear contribuciones y actividad de ambos proveedores.
 * 4. Manejar errores de autorización (tokens expirados) de forma transparente.
 * 5. Refrescar datos periódicamente cada hora mediante chrome.alarms.
 *
 * Protocolo de mensajes (popup -> background):
 *   { type: 'AUTH_GITHUB' }                    -> Iniciar autenticación con GitHub
 *   { type: 'AUTH_GITLAB', baseUrl }            -> Iniciar autenticación con GitLab
 *   { type: 'DISCONNECT', provider }            -> Desconectar un proveedor
 *   { type: 'GET_AUTH_STATE' }                  -> Consultar qué proveedores están conectados
 *   { type: 'FETCH_CONTRIBUTIONS', provider }   -> Obtener contribuciones de un proveedor
 *   { type: 'FETCH_ALL_CONTRIBUTIONS' }         -> Obtener contribuciones de todos los proveedores
 *   { type: 'FETCH_ALL_ACTIVITY' }              -> Obtener actividad de todos los proveedores
 *   { type: 'FETCH_COMMIT_DETAIL', ... }        -> Obtener detalles de un commit
 *
 * Flujo de datos:
 *   Popup envía mensaje -> handleMessage() lo procesa -> llama a las APIs/caché
 *   -> devuelve resultado al popup via sendResponse().
 */

import { authenticateGitHub, authenticateGitLab, getAuthState, removeToken, getToken, revokeGitHubGrant } from './lib/auth.js';
import { fetchGitHubContributions, fetchGitHubActivity, fetchGitHubCommitDetail, fetchGitHubUserOrgs, fetchGitHubGroupActivity } from './lib/github-api.js';
import { fetchGitLabContributions, fetchGitLabActivity, fetchGitLabCommitDetail, fetchGitLabUserGroups, fetchGitLabGroupActivity } from './lib/gitlab-api.js';
import { getCached, setCache, clearCache, clearCacheByPrefix } from './lib/cache.js';

/**
 * Listener principal de mensajes del popup.
 * Cada mensaje se procesa de forma asíncrona y la respuesta se envía via sendResponse().
 * Retorna `true` para indicar a Chrome que sendResponse será llamado de forma asíncrona.
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message).then(sendResponse).catch(err => {
    // En caso de error, enviar el mensaje de error al popup
    sendResponse({ error: err.message });
  });
  // Retornar true es NECESARIO para mantener el canal de sendResponse abierto
  // en llamadas asíncronas (si no, Chrome cierra el canal inmediatamente)
  return true;
});

/**
 * Enrutador de mensajes: dirige cada tipo de mensaje a la función correspondiente.
 *
 * @param {Object} message - Mensaje recibido del popup.
 * @param {string} message.type - Tipo de operación a realizar.
 * @returns {Promise<Object>} Resultado de la operación.
 * @throws {Error} Si el tipo de mensaje no es reconocido.
 */
async function handleMessage(message) {
  switch (message.type) {
    // Autenticación con GitHub
    case 'AUTH_GITHUB':
      await authenticateGitHub();
      return { success: true };

    // Autenticación con GitLab (soporta URL personalizada para instancias self-hosted)
    case 'AUTH_GITLAB': {
      const baseUrl = message.baseUrl || 'https://gitlab.com';
      await authenticateGitLab(baseUrl);
      return { success: true };
    }

    // Desconexión de un proveedor: revocar grant, eliminar token, caché y datos asociados
    case 'DISCONNECT': {
      // Revocar la autorización OAuth en GitHub para que la próxima conexión pida permisos
      if (message.provider === 'github') {
        const token = await getToken('github');
        if (token) await revokeGitHubGrant(token);
      }
      await removeToken(message.provider);
      // Limpiar la caché de contribuciones y actividad del proveedor
      await clearCache(`${message.provider}_contributions`);
      await clearCache(`${message.provider}_activity`);
      // Limpiar datos específicos del proveedor (username, proyectos, grupos, actividad de grupos)
      if (message.provider === 'gitlab') {
        await chrome.storage.local.remove(['gitlab_username', 'gitlab_projects']);
        await clearCache('gitlab_user_groups');
        await clearCacheByPrefix('group_activity_gl_');
      }
      if (message.provider === 'github') {
        await chrome.storage.local.remove('github_username');
        await clearCache('github_user_orgs');
        await clearCacheByPrefix('group_activity_gh_');
      }
      return { success: true };
    }

    // Consultar el estado de autenticación de todos los proveedores
    case 'GET_AUTH_STATE':
      return getAuthState();

    // Obtener contribuciones de un proveedor específico
    case 'FETCH_CONTRIBUTIONS':
      return fetchContributions(message.provider, message.forceRefresh);

    // Obtener contribuciones de TODOS los proveedores conectados
    case 'FETCH_ALL_CONTRIBUTIONS':
      return fetchAllContributions(message.forceRefresh);

    // Obtener actividad reciente de TODOS los proveedores conectados
    case 'FETCH_ALL_ACTIVITY':
      return fetchAllActivity(message.forceRefresh);

    // Obtener detalles de un commit específico
    case 'FETCH_COMMIT_DETAIL':
      return fetchCommitDetail(message.provider, message.repo, message.sha, message.projectId);

    // Obtener la lista de orgs/grupos del usuario para todos los proveedores conectados
    case 'FETCH_USER_GROUPS':
      return fetchAllUserGroups(message.forceRefresh);

    // Obtener la actividad de un grupo/org específico
    case 'FETCH_GROUP_ACTIVITY':
      return fetchGroupActivity(message.provider, message.ref, message.forceRefresh);

    default:
      throw new Error(`Unknown message type: ${message.type}`);
  }
}

/**
 * Obtiene las contribuciones de un proveedor específico con soporte de caché.
 *
 * Estrategia de caché:
 * 1. Si no se fuerza refresco, intentar servir datos del caché.
 * 2. Si el caché falla o está expirado, llamar a la API.
 * 3. Si la API falla y hay datos obsoletos en caché, servirlos como fallback.
 * 4. Si el error es UNAUTHORIZED, eliminar el token (sesión expirada).
 *
 * @param {string} provider - Proveedor ('github' o 'gitlab').
 * @param {boolean} [forceRefresh=false] - Si es true, ignorar el caché y llamar a la API.
 * @returns {Promise<{data: Object, fromCache: boolean, stale?: boolean}>}
 *   - data: Los datos de contribuciones { "YYYY-MM-DD": conteo }.
 *   - fromCache: true si los datos vienen del caché.
 *   - stale: true si los datos del caché están expirados (fallback por error de API).
 * @throws {Error} Si la API falla y no hay datos en caché como respaldo.
 */
async function fetchContributions(provider, forceRefresh = false) {
  const cacheKey = `${provider}_contributions`;

  // Paso 1: Intentar servir datos del caché si no se fuerza refresco
  if (!forceRefresh) {
    const cached = await getCached(cacheKey);
    if (cached) return { data: cached, fromCache: true };
  }

  try {
    // Paso 2: Llamar a la API del proveedor correspondiente
    const data = provider === 'github'
      ? await fetchGitHubContributions()
      : await fetchGitLabContributions();
    // Guardar los datos frescos en caché
    await setCache(cacheKey, data);
    return { data, fromCache: false };
  } catch (err) {
    // Paso 4: Si el token expiró, eliminarlo para forzar re-autenticación
    if (err.message === 'UNAUTHORIZED') {
      await removeToken(provider);
      throw err;
    }
    // Paso 3: Si la API falla por otra razón, intentar servir datos obsoletos del caché
    const stale = await getCached(cacheKey);
    if (stale) return { data: stale, fromCache: true, stale: true };
    // Si no hay datos de respaldo, propagar el error
    throw err;
  }
}

/**
 * Obtiene las contribuciones de TODOS los proveedores conectados en paralelo.
 *
 * Los errores de cada proveedor se capturan individualmente para que un fallo
 * en un proveedor no afecte al otro. Los errores se reportan como campos
 * separados (githubError, gitlabError) en el resultado.
 *
 * @param {boolean} [forceRefresh=false] - Si es true, ignorar el caché.
 * @returns {Promise<{github: Object|null, gitlab: Object|null, githubError?: string, gitlabError?: string}>}
 */
async function fetchAllContributions(forceRefresh = false) {
  const authState = await getAuthState();
  const result = { github: null, gitlab: null };
  const promises = [];

  // Lanzar las peticiones en paralelo para cada proveedor conectado
  if (authState.github) {
    promises.push(
      fetchContributions('github', forceRefresh)
        .then(r => { result.github = r; })
        .catch(err => { result.githubError = err.message; })
    );
  }
  if (authState.gitlab) {
    promises.push(
      fetchContributions('gitlab', forceRefresh)
        .then(r => { result.gitlab = r; })
        .catch(err => { result.gitlabError = err.message; })
    );
  }

  // Esperar a que ambas peticiones terminen (éxito o error)
  await Promise.all(promises);
  return result;
}

/**
 * Obtiene la actividad reciente de un proveedor específico con soporte de caché.
 * La estrategia de caché es idéntica a fetchContributions().
 *
 * @param {string} provider - Proveedor ('github' o 'gitlab').
 * @param {boolean} [forceRefresh=false] - Si es true, ignorar el caché.
 * @returns {Promise<{data: Array, fromCache: boolean, stale?: boolean}>}
 *   - data: Arreglo de elementos de actividad normalizados.
 *   - fromCache: true si los datos vienen del caché.
 *   - stale: true si son datos obsoletos del caché (fallback).
 * @throws {Error} Si la API falla y no hay datos de respaldo.
 */
async function fetchActivity(provider, forceRefresh = false) {
  const cacheKey = `${provider}_activity`;

  if (!forceRefresh) {
    const cached = await getCached(cacheKey);
    if (cached) return { data: cached, fromCache: true };
  }

  try {
    const data = provider === 'github'
      ? await fetchGitHubActivity()
      : await fetchGitLabActivity();
    await setCache(cacheKey, data);
    return { data, fromCache: false };
  } catch (err) {
    if (err.message === 'UNAUTHORIZED') {
      await removeToken(provider);
      throw err;
    }
    // Intentar servir datos obsoletos como respaldo
    const stale = await getCached(cacheKey);
    if (stale) return { data: stale, fromCache: true, stale: true };
    throw err;
  }
}

/**
 * Obtiene la actividad de TODOS los proveedores conectados en paralelo.
 * Misma estrategia que fetchAllContributions(): errores individuales por proveedor.
 *
 * @param {boolean} [forceRefresh=false] - Si es true, ignorar el caché.
 * @returns {Promise<{github: Object|null, gitlab: Object|null, githubError?: string, gitlabError?: string}>}
 */
async function fetchAllActivity(forceRefresh = false) {
  const authState = await getAuthState();
  const result = { github: null, gitlab: null };
  const promises = [];

  if (authState.github) {
    promises.push(
      fetchActivity('github', forceRefresh)
        .then(r => { result.github = r; })
        .catch(err => { result.githubError = err.message; })
    );
  }
  if (authState.gitlab) {
    promises.push(
      fetchActivity('gitlab', forceRefresh)
        .then(r => { result.gitlab = r; })
        .catch(err => { result.gitlabError = err.message; })
    );
  }

  await Promise.all(promises);
  return result;
}

/**
 * Obtiene la lista de orgs/grupos de un proveedor con soporte de caché.
 * Misma estrategia de caché que fetchContributions/fetchActivity: try cache,
 * llamar API, setCache, fallback stale en error, UNAUTHORIZED → removeToken.
 *
 * @param {string} provider - Proveedor ('github' o 'gitlab').
 * @param {boolean} [forceRefresh=false] - Si es true, ignora el caché.
 * @returns {Promise<{data: Array, fromCache: boolean, stale?: boolean}>}
 */
async function fetchUserGroups(provider, forceRefresh = false) {
  const cacheKey = provider === 'github' ? 'github_user_orgs' : 'gitlab_user_groups';

  if (!forceRefresh) {
    const cached = await getCached(cacheKey);
    if (cached) return { data: cached, fromCache: true };
  }

  try {
    const data = provider === 'github'
      ? await fetchGitHubUserOrgs()
      : await fetchGitLabUserGroups();
    await setCache(cacheKey, data);
    return { data, fromCache: false };
  } catch (err) {
    if (err.message === 'UNAUTHORIZED') {
      await removeToken(provider);
      throw err;
    }
    const stale = await getCached(cacheKey);
    if (stale) return { data: stale, fromCache: true, stale: true };
    throw err;
  }
}

/**
 * Obtiene los grupos de TODOS los proveedores conectados en paralelo.
 * Los errores de cada proveedor se capturan individualmente para que un fallo
 * en uno no afecte al otro (mismo patrón que fetchAllContributions/fetchAllActivity).
 *
 * @param {boolean} [forceRefresh=false] - Si es true, ignorar el caché.
 * @returns {Promise<{github: Object|null, gitlab: Object|null, githubError?: string, gitlabError?: string}>}
 */
async function fetchAllUserGroups(forceRefresh = false) {
  const authState = await getAuthState();
  const result = { github: null, gitlab: null };
  const promises = [];

  if (authState.github) {
    promises.push(
      fetchUserGroups('github', forceRefresh)
        .then(r => { result.github = r; })
        .catch(err => { result.githubError = err.message; })
    );
  }
  if (authState.gitlab) {
    promises.push(
      fetchUserGroups('gitlab', forceRefresh)
        .then(r => { result.gitlab = r; })
        .catch(err => { result.gitlabError = err.message; })
    );
  }

  await Promise.all(promises);
  return result;
}

/**
 * Obtiene la actividad reciente de un grupo/org específico, con soporte de caché.
 * La clave de caché es única por grupo: `group_activity_{gh|gl}_{ref}`.
 *
 * @param {string} provider - Proveedor ('github' o 'gitlab').
 * @param {string|number} ref - Login de la org (GitHub) o id del grupo (GitLab).
 * @param {boolean} [forceRefresh=false] - Si es true, ignora el caché.
 * @returns {Promise<{data: Array, fromCache: boolean, stale?: boolean}>}
 */
async function fetchGroupActivity(provider, ref, forceRefresh = false) {
  const shortProv = provider === 'github' ? 'gh' : 'gl';
  const cacheKey = `group_activity_${shortProv}_${ref}`;

  if (!forceRefresh) {
    const cached = await getCached(cacheKey);
    // Backwards-compat: items normalizados antes de agregar el campo `actor` no
    // tienen esa propiedad. Si detectamos un cache en ese formato antiguo, lo
    // tratamos como obsoleto para forzar un re-fetch y poder mostrar el autor.
    if (cached && (!Array.isArray(cached) || cached.length === 0 || cached.some(it => it && 'actor' in it))) {
      return { data: cached, fromCache: true };
    }
  }

  try {
    const data = provider === 'github'
      ? await fetchGitHubGroupActivity(ref)
      : await fetchGitLabGroupActivity(ref);
    await setCache(cacheKey, data);
    return { data, fromCache: false };
  } catch (err) {
    if (err.message === 'UNAUTHORIZED') {
      await removeToken(provider);
      throw err;
    }
    const stale = await getCached(cacheKey);
    if (stale) return { data: stale, fromCache: true, stale: true };
    throw err;
  }
}

/**
 * Obtiene los detalles de un commit específico del proveedor correspondiente.
 * Delega la llamada a la función específica de GitHub o GitLab.
 *
 * @param {string} provider - Proveedor ('github' o 'gitlab').
 * @param {string} repo - Nombre del repositorio (usado por GitHub: 'owner/repo').
 * @param {string} sha - Hash SHA del commit.
 * @param {number|string} [projectId] - ID del proyecto (usado por GitLab).
 * @returns {Promise<Object>} Detalles del commit (sha, message, author, date, url, stats, files).
 */
async function fetchCommitDetail(provider, repo, sha, projectId) {
  if (provider === 'github') {
    return fetchGitHubCommitDetail(repo, sha);
  }
  // GitLab usa el ID numérico del proyecto en vez del nombre del repo
  return fetchGitLabCommitDetail(projectId, sha);
}

/**
 * Alarma periódica para refrescar datos automáticamente cada 60 minutos.
 * Esto mantiene los datos actualizados incluso si el usuario no abre el popup.
 */
chrome.alarms.create('refresh-contributions', { periodInMinutes: 60 });

/**
 * Listener de alarmas: cuando la alarma de refresco se activa,
 * actualiza contribuciones y actividad de todos los proveedores.
 * Los errores se silencian ya que es una operación en segundo plano.
 */
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'refresh-contributions') {
    try {
      await fetchAllContributions(true);  // Forzar refresco desde la API
      await fetchAllActivity(true);
    } catch { /* Silenciar errores en la actualización de fondo */ }
  }
});
