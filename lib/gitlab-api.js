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
export async function fetchGitLabActivity({ page = 1 } = {}) {
  const token = await getToken('gitlab');
  if (!token) throw new Error('Not authenticated with GitLab');

  const baseUrl = await getGitLabBaseUrl();
  const perPage = 30;

  // Obtener los 30 eventos de la página solicitada
  const response = await fetch(
    `${baseUrl}/api/v4/events?per_page=${perPage}&page=${page}`,
    { headers: { 'Authorization': `Bearer ${token}` } }
  );

  if (response.status === 401) throw new Error('UNAUTHORIZED');
  if (!response.ok) throw new Error(`GitLab events API error: ${response.status}`);

  const events = await response.json();

  // Detectar si hay más páginas: GitLab incluye X-Next-Page; si no, usar el tamaño recibido.
  const nextPage = response.headers.get('X-Next-Page');
  const hasMore = nextPage ? nextPage.trim() !== '' : events.length >= perPage;

  // Recopilar los IDs únicos de proyectos para resolver sus nombres
  const projectIds = [...new Set(events.map(e => e.project_id).filter(Boolean))];
  const projectMap = await fetchProjectNames(baseUrl, token, projectIds);

  // Normalizar los eventos al formato común
  const items = normalizeGitLabEvents(events, projectMap, baseUrl);
  return { data: items, hasMore };
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
      // Autor del evento. Útil en la vista de grupos para identificar quién hizo qué.
      // En la vista de usuario todos los eventos son del propio usuario, así que el
      // campo está disponible pero no se renderiza.
      // GitLab expone tanto event.author.username como event.author_username — usamos
      // ambos como fallback porque no todos los endpoints devuelven la misma forma.
      actor: event.author?.username || event.author_username || event.author?.name || '',
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

// ── Actividad de grupos ──

/**
 * Obtiene los grupos a los que pertenece el usuario autenticado.
 * Se usa para poblar la lista de sub-tabs de la vista "Actividad de grupos".
 *
 * Requiere scope 'read_api' (ya solicitado en el flujo OAuth).
 * min_access_level=10 corresponde a Guest — incluye todos los grupos donde el usuario
 * es miembro directo.
 *
 * @returns {Promise<Array<{id: number, name: string, fullPath: string, webUrl: string}>>}
 * @throws {Error} 'Not authenticated with GitLab' si no hay token.
 * @throws {Error} 'UNAUTHORIZED' si el token es inválido (HTTP 401).
 */
export async function fetchGitLabUserGroups() {
  const token = await getToken('gitlab');
  if (!token) throw new Error('Not authenticated with GitLab');

  const baseUrl = await getGitLabBaseUrl();
  const response = await fetch(
    `${baseUrl}/api/v4/groups?min_access_level=10&per_page=100&order_by=name&sort=asc`,
    { headers: { 'Authorization': `Bearer ${token}` } }
  );

  if (response.status === 401) throw new Error('UNAUTHORIZED');
  if (!response.ok) throw new Error(`GitLab groups API error: ${response.status}`);

  const groups = await response.json();
  if (!Array.isArray(groups)) return [];

  return groups.map(g => ({
    id: g.id,
    name: g.name || g.full_path || String(g.id),
    fullPath: g.full_path || '',
    webUrl: g.web_url || '',
  }));
}

/**
 * Obtiene la actividad reciente de un grupo de GitLab.
 *
 * GitLab no expone un endpoint /groups/:id/events, así que se aproxima agregando
 * los eventos de los proyectos más activos del grupo:
 * 1. Se listan los 8 proyectos del grupo con mayor actividad reciente.
 * 2. Se piden en paralelo los eventos de cada proyecto.
 * 3. Se mergean, ordenan por fecha y se limitan a 30.
 * 4. Se normalizan con el pipeline común (`normalizeGitLabEvents`).
 *
 * @param {number|string} groupId - ID numérico del grupo.
 * @returns {Promise<Array<Object>>} Items normalizados, ordenados por fecha desc.
 * @throws {Error} 'Not authenticated with GitLab' si no hay token.
 * @throws {Error} 'UNAUTHORIZED' si el token es inválido.
 */
export async function fetchGitLabGroupActivity(groupId, { page = 1 } = {}) {
  const token = await getToken('gitlab');
  if (!token) throw new Error('Not authenticated with GitLab');

  const baseUrl = await getGitLabBaseUrl();
  const projectsCap = 10;
  const eventsPerPage = 10;

  // Estrategia: siempre tomamos el mismo conjunto de proyectos (los más activos
  // del grupo) y paginamos los eventos de cada uno con el cursor `page`. Así,
  // incluso si el grupo tiene pocos proyectos, el scroll sigue trayendo eventos
  // más antiguos de esos mismos proyectos.
  const projResp = await fetch(
    `${baseUrl}/api/v4/groups/${groupId}/projects?order_by=last_activity_at&per_page=${projectsCap}&page=1&simple=true&include_subgroups=true`,
    { headers: { 'Authorization': `Bearer ${token}` }, cache: 'no-store' }
  );
  if (projResp.status === 401) throw new Error('UNAUTHORIZED');
  if (!projResp.ok) throw new Error(`GitLab group projects API error: ${projResp.status}`);

  const projects = await projResp.json();
  if (!Array.isArray(projects) || projects.length === 0) {
    return { data: [], hasMore: false };
  }

  // projectMap a partir de la respuesta (evita fetchs adicionales)
  const projectMap = {};
  for (const p of projects) {
    projectMap[p.id] = p.path_with_namespace || `project/${p.id}`;
  }

  // Fetch paralelo de eventos por proyecto en la página solicitada.
  const perProject = await Promise.all(projects.map(async (p) => {
    try {
      const r = await fetch(
        `${baseUrl}/api/v4/projects/${p.id}/events?per_page=${eventsPerPage}&page=${page}`,
        { headers: { 'Authorization': `Bearer ${token}` }, cache: 'no-store' }
      );
      if (r.status === 401) throw new Error('UNAUTHORIZED');
      if (!r.ok) return { events: [], hasMore: false };
      const events = await r.json();
      const arr = Array.isArray(events) ? events : [];
      // `X-Next-Page` es la pista fiable; fallback al tamaño.
      const nextPage = r.headers.get('X-Next-Page');
      const hasMore = nextPage ? nextPage.trim() !== '' : arr.length >= eventsPerPage;
      return { events: arr, hasMore };
    } catch (err) {
      if (err.message === 'UNAUTHORIZED') throw err;
      return { events: [], hasMore: false };
    }
  }));

  // Merge, sort, normalizar
  const allEvents = perProject.flatMap(r => r.events);
  allEvents.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  const items = normalizeGitLabEvents(allEvents, projectMap, baseUrl);

  // hasMore: si al menos un proyecto aún tiene más páginas de eventos, seguimos.
  const hasMore = perProject.some(r => r.hasMore);
  return { data: items, hasMore };
}
