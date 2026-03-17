/**
 * @fileoverview Módulo de comunicación con la API de GitLab.
 *
 * Encapsula todas las llamadas a la API de GitLab necesarias para la extensión:
 * - Obtener contribuciones del último año (endpoint calendar.json).
 * - Obtener el feed de actividad reciente del usuario (API REST v4).
 * - Obtener detalles de commits individuales incluyendo diff (API REST v4).
 * - Resolver nombres de proyectos a partir de IDs (con caché).
 *
 * Soporta instancias self-hosted de GitLab: la URL base se lee de chrome.storage.sync
 * y puede ser configurada por el usuario en la página de opciones.
 *
 * Flujo de datos:
 *   Token almacenado + URL base -> llamada a API GitLab -> datos crudos -> normalización
 *   -> datos en formato común con GitHub para mostrar en el popup.
 *
 * Dependencias: auth.js (obtención de tokens).
 */

import { getToken } from './auth.js';

/**
 * Obtiene la URL base de la instancia de GitLab configurada por el usuario.
 * Si no se ha configurado una URL personalizada, usa gitlab.com por defecto.
 * La URL se almacena en chrome.storage.sync (se sincroniza entre dispositivos).
 *
 * @returns {Promise<string>} URL base de GitLab (ej: 'https://gitlab.com' o 'https://gitlab.empresa.com').
 */
async function getGitLabBaseUrl() {
  const result = await chrome.storage.sync.get('gitlab_base_url');
  return result.gitlab_base_url || 'https://gitlab.com';
}

/**
 * Obtiene el nombre de usuario de GitLab del usuario autenticado.
 * El resultado se cachea en chrome.storage.local para evitar llamadas repetidas.
 *
 * @param {string} baseUrl - URL base de la instancia de GitLab.
 * @param {string} token - Token de acceso OAuth.
 * @returns {Promise<string>} Nombre de usuario de GitLab.
 * @throws {Error} 'UNAUTHORIZED' si el token es inválido (HTTP 401).
 * @throws {Error} Error de API si la llamada falla.
 */
async function fetchGitLabUsername(baseUrl, token) {
  // Verificar si el username ya está en caché
  const cached = await chrome.storage.local.get('gitlab_username');
  if (cached.gitlab_username) return cached.gitlab_username;

  // Llamar a la API /user para obtener los datos del usuario autenticado
  const response = await fetch(`${baseUrl}/api/v4/user`, {
    headers: { 'Authorization': `Bearer ${token}` },
  });

  if (response.status === 401) throw new Error('UNAUTHORIZED');
  if (!response.ok) throw new Error(`GitLab user API error: ${response.status}`);

  const user = await response.json();
  // Cachear el username para futuras consultas
  await chrome.storage.local.set({ gitlab_username: user.username });
  return user.username;
}

/**
 * Obtiene los datos de contribuciones de GitLab del último año.
 * Usa el endpoint calendar.json que devuelve directamente un mapa fecha->conteo.
 *
 * A diferencia de GitHub (que usa GraphQL), GitLab expone un endpoint REST simple
 * que retorna los datos en el formato que necesitamos: { "YYYY-MM-DD": conteo }.
 *
 * @returns {Promise<Object.<string, number>>} Objeto normalizado { "YYYY-MM-DD": conteo }.
 * @throws {Error} 'Not authenticated with GitLab' si no hay token almacenado.
 * @throws {Error} 'UNAUTHORIZED' si el token es inválido (HTTP 401).
 * @throws {Error} 'RATE_LIMITED' si se excedió el límite de peticiones (HTTP 429).
 */
export async function fetchGitLabContributions() {
  const token = await getToken('gitlab');
  if (!token) throw new Error('Not authenticated with GitLab');

  const baseUrl = await getGitLabBaseUrl();
  // Necesitamos el username para el endpoint de calendario de contribuciones
  const username = await fetchGitLabUsername(baseUrl, token);

  // El endpoint calendar.json devuelve directamente el mapa de contribuciones
  const response = await fetch(
    `${baseUrl}/users/${encodeURIComponent(username)}/calendar.json`,
    { headers: { 'Authorization': `Bearer ${token}` } }
  );

  if (response.status === 401) throw new Error('UNAUTHORIZED');
  if (!response.ok) {
    // GitLab usa HTTP 429 para rate limiting (a diferencia de GitHub que usa 403)
    if (response.status === 429) throw new Error('RATE_LIMITED');
    throw new Error(`GitLab calendar API error: ${response.status}`);
  }

  // La respuesta ya viene en el formato { "YYYY-MM-DD": conteo }
  return response.json();
}

/**
 * Obtiene los eventos de actividad reciente del usuario de GitLab.
 * Los eventos se normalizan a un formato común con GitHub.
 *
 * Proceso adicional: los eventos de GitLab solo incluyen project_id, no el nombre
 * del repositorio, así que necesitamos resolver los nombres de proyecto por separado.
 *
 * @returns {Promise<Array<Object>>} Arreglo de elementos de actividad normalizados.
 * @throws {Error} 'Not authenticated with GitLab' si no hay token.
 * @throws {Error} 'UNAUTHORIZED' si el token es inválido.
 */
export async function fetchGitLabActivity() {
  const token = await getToken('gitlab');
  if (!token) throw new Error('Not authenticated with GitLab');

  const baseUrl = await getGitLabBaseUrl();

  // Obtener los últimos 30 eventos del usuario
  const response = await fetch(
    `${baseUrl}/api/v4/events?per_page=30`,
    { headers: { 'Authorization': `Bearer ${token}` } }
  );

  if (response.status === 401) throw new Error('UNAUTHORIZED');
  if (!response.ok) throw new Error(`GitLab events API error: ${response.status}`);

  const events = await response.json();

  // Recopilar los IDs únicos de proyectos para resolver sus nombres
  // Los eventos de GitLab solo traen project_id, no el nombre del repo
  const projectIds = [...new Set(events.map(e => e.project_id).filter(Boolean))];
  const projectMap = await fetchProjectNames(baseUrl, token, projectIds);

  // Normalizar los eventos al formato común
  return normalizeGitLabEvents(events, projectMap, baseUrl);
}

/**
 * Resuelve los nombres de proyectos a partir de sus IDs numéricos.
 * Los nombres se cachean en chrome.storage.local para evitar llamadas repetidas.
 *
 * Para evitar el rate limiting de la API, se limita a resolver máximo 10 proyectos
 * por llamada. Los proyectos que no se puedan resolver se muestran como 'project/{id}'.
 *
 * @param {string} baseUrl - URL base de la instancia de GitLab.
 * @param {string} token - Token de acceso OAuth.
 * @param {number[]} projectIds - Arreglo de IDs de proyectos a resolver.
 * @returns {Promise<Object.<number, string>>} Mapa de { projectId: 'namespace/proyecto' }.
 */
async function fetchProjectNames(baseUrl, token, projectIds) {
  const map = {};
  // Leer los proyectos ya cacheados previamente
  const cached = await chrome.storage.local.get('gitlab_projects');
  const cachedProjects = cached.gitlab_projects || {};

  // Identificar qué proyectos aún no están en caché
  const toFetch = projectIds.filter(id => !cachedProjects[id]);

  // Obtener los proyectos faltantes en paralelo (máximo 10 para evitar rate limits)
  const promises = toFetch.slice(0, 10).map(async (id) => {
    try {
      // ?simple=true reduce la cantidad de datos devueltos por la API
      const resp = await fetch(`${baseUrl}/api/v4/projects/${id}?simple=true`, {
        headers: { 'Authorization': `Bearer ${token}` },
      });
      if (resp.ok) {
        const proj = await resp.json();
        // Guardar el path completo del proyecto (ej: 'usuario/mi-proyecto')
        cachedProjects[id] = proj.path_with_namespace;
      }
    } catch { /* Ignorar errores individuales para no bloquear los demás */ }
  });

  await Promise.all(promises);
  // Actualizar la caché con los proyectos recién obtenidos
  await chrome.storage.local.set({ gitlab_projects: cachedProjects });

  // Construir el mapa de resultados, usando fallback para los no resueltos
  for (const id of projectIds) {
    map[id] = cachedProjects[id] || `project/${id}`;
  }
  return map;
}

/**
 * Normaliza los eventos crudos de la API de GitLab a un formato uniforme.
 *
 * Los eventos de GitLab tienen una estructura diferente a los de GitHub:
 * - Usan action_name en vez de event.type.
 * - Los push se identifican por la presencia de push_data.
 * - Los merge requests, issues, etc. se identifican por target_type.
 *
 * @param {Array<Object>} events - Eventos crudos de la API de GitLab.
 * @param {Object.<number, string>} projectMap - Mapa de IDs de proyecto a nombres.
 * @param {string} baseUrl - URL base de GitLab (para construir URLs de recursos).
 * @returns {Array<Object>} Eventos normalizados al formato común.
 */
function normalizeGitLabEvents(events, projectMap, baseUrl) {
  const items = [];
  for (const event of events) {
    // Resolver el nombre del repositorio a partir del project_id
    const repo = projectMap[event.project_id] || `project/${event.project_id}`;
    // Campos base comunes a todos los tipos de evento
    const base = {
      id: `gl-${event.id}`,      // Prefijo 'gl-' para evitar colisiones con IDs de GitHub
      provider: 'gitlab',
      repo,
      date: event.created_at,
    };

    const action = event.action_name;

    // Clasificar el evento según su contenido (GitLab no tiene un campo 'type' uniforme)
    if (event.push_data) {
      // Evento de push (contiene datos del commit)
      items.push({
        ...base,
        type: 'commit',
        title: event.push_data.commit_title || 'Push',
        commits: [{
          sha: event.push_data.commit_to,
          message: event.push_data.commit_title || '',
        }],
        projectId: event.project_id, // Se necesita para obtener detalles del commit
      });
    } else if (event.target_type === 'MergeRequest') {
      // Evento de Merge Request (equivalente al Pull Request de GitHub)
      items.push({
        ...base,
        type: 'merge_request',
        title: event.target_title || 'Merge Request',
        action,
        number: event.target_iid, // IID es el número visible del MR dentro del proyecto
        url: `${baseUrl}/${repo}/-/merge_requests/${event.target_iid}`,
        description: '',
      });
    } else if (event.target_type === 'Issue') {
      // Evento de Issue
      items.push({
        ...base,
        type: 'issue',
        title: event.target_title || 'Issue',
        action,
        number: event.target_iid,
        url: `${baseUrl}/${repo}/-/issues/${event.target_iid}`,
        description: '',
      });
    } else if (event.target_type === 'Note' || event.target_type === 'DiffNote') {
      // Comentario (Note) o comentario en diff (DiffNote)
      items.push({
        ...base,
        type: 'comment',
        title: `Comment on: ${event.target_title || 'item'}`,
        description: event.note?.body?.substring(0, 300) || '',
      });
    } else if (action === 'joined' || action === 'left') {
      // Unirse o salir de un proyecto
      items.push({
        ...base,
        type: 'other',
        title: `${action} ${repo}`,
      });
    } else {
      // Cualquier otro tipo de actividad no manejada explícitamente
      items.push({
        ...base,
        type: 'other',
        title: `${action || 'Activity'} on ${event.target_type || 'project'}`,
      });
    }
  }
  return items;
}

/**
 * Obtiene los detalles de un commit específico de GitLab, incluyendo los archivos modificados (diff).
 *
 * Hace dos llamadas en paralelo:
 * 1. Datos del commit (mensaje, autor, fecha, estadísticas).
 * 2. Diff del commit (archivos modificados).
 *
 * Nota: a diferencia de GitHub, GitLab usa el ID numérico del proyecto en vez del nombre del repo.
 * Además, el diff de GitLab no incluye estadísticas de líneas por archivo, por lo que
 * additions y deletions se establecen en 0.
 *
 * @param {number|string} projectId - ID numérico del proyecto en GitLab.
 * @param {string} sha - Hash SHA del commit.
 * @returns {Promise<Object>} Detalles del commit con la estructura:
 *   { sha, message, author, date, url, stats, files: [{filename, status, additions, deletions}] }
 * @throws {Error} 'Not authenticated with GitLab' si no hay token.
 * @throws {Error} Error de API si el commit no existe o no es accesible.
 */
export async function fetchGitLabCommitDetail(projectId, sha) {
  const token = await getToken('gitlab');
  if (!token) throw new Error('Not authenticated with GitLab');

  const baseUrl = await getGitLabBaseUrl();

  // Obtener información del commit y su diff en paralelo para mayor velocidad
  const [commitResp, diffResp] = await Promise.all([
    fetch(`${baseUrl}/api/v4/projects/${projectId}/repository/commits/${sha}`, {
      headers: { 'Authorization': `Bearer ${token}` },
    }),
    fetch(`${baseUrl}/api/v4/projects/${projectId}/repository/commits/${sha}/diff`, {
      headers: { 'Authorization': `Bearer ${token}` },
    }),
  ]);

  if (!commitResp.ok) throw new Error(`GitLab commit API error: ${commitResp.status}`);

  const commit = await commitResp.json();
  // Si el diff falla, usar un arreglo vacío en vez de lanzar error
  const diffs = diffResp.ok ? await diffResp.json() : [];

  // Normalizar al formato estándar de detalle de commit
  return {
    sha: commit.id,
    message: commit.message,
    author: commit.author_name,
    date: commit.created_at,
    url: commit.web_url,
    stats: commit.stats,  // { additions, deletions, total }
    // Mapear cada diff a nuestro formato, determinando el estado del archivo
    files: diffs.map(d => ({
      filename: d.new_path,
      // Determinar el estado del archivo basándose en los flags del diff
      status: d.new_file ? 'added' : d.deleted_file ? 'removed' : d.renamed_file ? 'renamed' : 'modified',
      additions: 0,  // GitLab no proporciona estadísticas por archivo en el diff
      deletions: 0,
    })),
  };
}
