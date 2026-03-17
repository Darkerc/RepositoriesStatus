/**
 * @fileoverview Módulo de comunicación con la API de GitHub.
 *
 * Encapsula todas las llamadas a la API de GitHub necesarias para la extensión:
 * - Obtener contribuciones del último año (API GraphQL).
 * - Obtener el feed de actividad reciente del usuario (API REST).
 * - Obtener detalles de commits individuales (API REST).
 *
 * Flujo de datos:
 *   Token almacenado -> llamada a API -> datos crudos -> normalización -> datos uniformes
 *
 * Los datos normalizados tienen un formato común con GitLab para que el popup
 * pueda mostrarlos de forma unificada sin importar el proveedor.
 *
 * Dependencias: auth.js (obtención de tokens).
 */

import { getToken } from './auth.js';

/** @const {string} URL del endpoint GraphQL de GitHub */
const GITHUB_GRAPHQL_URL = 'https://api.github.com/graphql';

/** @const {string} URL base de la API REST de GitHub */
const GITHUB_REST_URL = 'https://api.github.com';

/**
 * Query GraphQL para obtener el calendario de contribuciones del usuario autenticado.
 * Retorna todas las semanas del último año con la fecha y cantidad de contribuciones por día.
 * Usa 'viewer' que automáticamente se refiere al usuario del token.
 * @const {string}
 */
const CONTRIBUTIONS_QUERY = `
query {
  viewer {
    contributionsCollection {
      contributionCalendar {
        weeks {
          contributionDays {
            date
            contributionCount
          }
        }
      }
    }
  }
}`;

/**
 * Obtiene los datos de contribuciones de GitHub del último año.
 * Usa la API GraphQL de GitHub para obtener el calendario de contribuciones completo.
 *
 * Flujo: obtener token -> enviar query GraphQL -> extraer semanas -> aplanar a mapa fecha->conteo.
 *
 * @returns {Promise<Object.<string, number>>} Objeto normalizado { "YYYY-MM-DD": conteo }
 *   donde cada clave es una fecha y el valor es la cantidad de contribuciones ese día.
 * @throws {Error} 'Not authenticated with GitHub' si no hay token almacenado.
 * @throws {Error} 'UNAUTHORIZED' si el token ha expirado o es inválido (HTTP 401).
 * @throws {Error} 'RATE_LIMITED:<timestamp>' si se excedió el límite de peticiones (HTTP 403).
 * @throws {Error} Error de GraphQL si la query falla.
 */
export async function fetchGitHubContributions() {
  const token = await getToken('github');
  if (!token) throw new Error('Not authenticated with GitHub');

  // Enviar la query GraphQL con autenticación Bearer
  const response = await fetch(GITHUB_GRAPHQL_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query: CONTRIBUTIONS_QUERY }),
  });

  // HTTP 401: token inválido o expirado, el background.js lo manejará eliminando el token
  if (response.status === 401) throw new Error('UNAUTHORIZED');

  if (!response.ok) {
    // HTTP 403 con header x-ratelimit-reset indica rate limiting
    if (response.status === 403) {
      const resetHeader = response.headers.get('x-ratelimit-reset');
      if (resetHeader) throw new Error(`RATE_LIMITED:${resetHeader}`);
    }
    throw new Error(`GitHub API error: ${response.status}`);
  }

  const json = await response.json();

  // GraphQL puede retornar HTTP 200 con errores en el cuerpo de la respuesta
  if (json.errors) throw new Error(`GitHub GraphQL error: ${json.errors[0].message}`);

  // Extraer las semanas del calendario de contribuciones
  const weeks = json.data.viewer.contributionsCollection.contributionCalendar.weeks;

  // Aplanar la estructura de semanas -> días a un mapa simple { fecha: conteo }
  const contributions = {};
  for (const week of weeks) {
    for (const day of week.contributionDays) {
      contributions[day.date] = day.contributionCount;
    }
  }
  return contributions;
}

/**
 * Obtiene el nombre de usuario de GitHub del usuario autenticado.
 * El resultado se cachea en chrome.storage.local para evitar llamadas repetidas.
 *
 * @returns {Promise<string>} Nombre de usuario de GitHub (login).
 * @throws {Error} Si la llamada a la API falla.
 */
async function getGitHubUsername() {
  // Verificar si ya tenemos el username en caché
  const cached = await chrome.storage.local.get('github_username');
  if (cached.github_username) return cached.github_username;

  // Si no está en caché, hacer una llamada a la API REST /user
  const token = await getToken('github');
  const response = await fetch(`${GITHUB_REST_URL}/user`, {
    headers: { 'Authorization': `Bearer ${token}` },
  });
  if (!response.ok) throw new Error(`GitHub user API error: ${response.status}`);

  const user = await response.json();
  // Guardar el username en caché para futuras consultas
  await chrome.storage.local.set({ github_username: user.login });
  return user.login;
}

/**
 * Obtiene los eventos de actividad reciente del usuario de GitHub.
 * Usa la API REST de eventos de usuario (máximo 30 eventos por página).
 *
 * Los eventos se normalizan a un formato común para poder mezclarlos con los de GitLab.
 *
 * @returns {Promise<Array<Object>>} Arreglo de elementos de actividad normalizados.
 *   Cada elemento tiene: id, provider, repo, date, type, title, y campos adicionales según el tipo.
 * @throws {Error} 'Not authenticated with GitHub' si no hay token.
 * @throws {Error} 'UNAUTHORIZED' si el token es inválido.
 */
export async function fetchGitHubActivity() {
  const token = await getToken('github');
  if (!token) throw new Error('Not authenticated with GitHub');

  // Necesitamos el username para construir la URL de la API de eventos
  const username = await getGitHubUsername();
  const response = await fetch(
    `${GITHUB_REST_URL}/users/${encodeURIComponent(username)}/events?per_page=30`,
    { headers: { 'Authorization': `Bearer ${token}` } }
  );

  if (response.status === 401) throw new Error('UNAUTHORIZED');
  if (!response.ok) throw new Error(`GitHub events API error: ${response.status}`);

  const events = await response.json();
  // Transformar los eventos crudos de GitHub a nuestro formato normalizado
  return normalizeGitHubEvents(events);
}

/**
 * Normaliza los eventos crudos de la API de GitHub a un formato uniforme.
 *
 * GitHub tiene muchos tipos de eventos (PushEvent, PullRequestEvent, etc.).
 * Esta función los transforma a un formato común con campos estándar.
 *
 * Cada evento normalizado incluye como mínimo:
 *   { id, provider:'github', repo, date, type, title }
 * Y campos adicionales según el tipo (commits, url, description, state, etc.).
 *
 * @param {Array<Object>} events - Eventos crudos de la API de GitHub.
 * @returns {Array<Object>} Eventos normalizados.
 */
function normalizeGitHubEvents(events) {
  const items = [];
  for (const event of events) {
    // Campos base comunes a todos los tipos de evento
    const base = {
      id: `gh-${event.id}`,      // Prefijo 'gh-' para evitar colisiones con IDs de GitLab
      provider: 'github',
      repo: event.repo.name,
      date: event.created_at,
    };

    switch (event.type) {
      // Evento de push (uno o más commits)
      case 'PushEvent':
        items.push({
          ...base,
          type: 'commit',
          // Usar el mensaje del primer commit como título, solo la primera línea
          title: event.payload.commits?.[0]?.message?.split('\n')[0] || 'Push',
          commits: (event.payload.commits || []).map(c => ({
            sha: c.sha,
            message: c.message,
          })),
        });
        break;

      // Evento de Pull Request (abierto, cerrado, fusionado, etc.)
      case 'PullRequestEvent':
        items.push({
          ...base,
          type: 'pull_request',
          title: event.payload.pull_request.title,
          number: event.payload.pull_request.number,
          state: event.payload.pull_request.state,
          action: event.payload.action,
          // Truncar la descripción a 300 caracteres para no sobrecargar el popup
          description: event.payload.pull_request.body?.substring(0, 300) || '',
          url: event.payload.pull_request.html_url,
        });
        break;

      // Evento de Issue (abierto, cerrado, etc.)
      case 'IssuesEvent':
        items.push({
          ...base,
          type: 'issue',
          title: event.payload.issue.title,
          number: event.payload.issue.number,
          state: event.payload.issue.state,
          action: event.payload.action,
          description: event.payload.issue.body?.substring(0, 300) || '',
          url: event.payload.issue.html_url,
        });
        break;

      // Comentario en un issue
      case 'IssueCommentEvent':
        items.push({
          ...base,
          type: 'comment',
          title: `Comment on #${event.payload.issue.number}: ${event.payload.issue.title}`,
          description: event.payload.comment.body?.substring(0, 300) || '',
          url: event.payload.comment.html_url,
        });
        break;

      // Creación de rama o tag
      case 'CreateEvent':
        items.push({
          ...base,
          // Distinguir entre creación de tag y de rama
          type: event.payload.ref_type === 'tag' ? 'tag' : 'branch',
          title: `Created ${event.payload.ref_type} ${event.payload.ref || ''}`.trim(),
          description: event.payload.description || '',
        });
        break;

      // Eliminación de rama o tag
      case 'DeleteEvent':
        items.push({
          ...base,
          type: 'branch',
          title: `Deleted ${event.payload.ref_type} ${event.payload.ref || ''}`.trim(),
        });
        break;

      // Fork de un repositorio
      case 'ForkEvent':
        items.push({
          ...base,
          type: 'fork',
          title: `Forked to ${event.payload.forkee.full_name}`,
          url: event.payload.forkee.html_url,
        });
        break;

      // Dar estrella a un repositorio (WatchEvent es el nombre real en la API)
      case 'WatchEvent':
        items.push({
          ...base,
          type: 'star',
          title: `Starred ${event.repo.name}`,
        });
        break;

      // Revisión de un Pull Request
      case 'PullRequestReviewEvent':
        items.push({
          ...base,
          type: 'review',
          title: `Reviewed PR #${event.payload.pull_request.number}: ${event.payload.pull_request.title}`,
          description: event.payload.review.body?.substring(0, 300) || '',
          url: event.payload.review.html_url,
        });
        break;

      // Cualquier otro tipo de evento no manejado explícitamente
      default:
        items.push({
          ...base,
          type: 'other',
          // Quitar el sufijo 'Event' del nombre del tipo para mostrar algo legible
          title: event.type.replace('Event', ''),
        });
    }
  }
  return items;
}

/**
 * Obtiene los detalles de un commit específico de GitHub, incluyendo los archivos modificados.
 *
 * Se usa cuando el usuario hace clic en un commit en el feed de actividad
 * para ver qué archivos fueron cambiados y las estadísticas de líneas.
 *
 * @param {string} repo - Nombre del repositorio en formato 'owner/repo'.
 * @param {string} sha - Hash SHA del commit.
 * @returns {Promise<Object>} Detalles del commit con la estructura:
 *   { sha, message, author, date, url, stats: {additions, deletions, total},
 *     files: [{filename, status, additions, deletions}] }
 * @throws {Error} 'Not authenticated with GitHub' si no hay token.
 * @throws {Error} Error de API si el commit no existe o no es accesible.
 */
export async function fetchGitHubCommitDetail(repo, sha) {
  const token = await getToken('github');
  if (!token) throw new Error('Not authenticated with GitHub');

  // Llamar a la API REST para obtener los detalles completos del commit
  const response = await fetch(`${GITHUB_REST_URL}/repos/${repo}/commits/${sha}`, {
    headers: { 'Authorization': `Bearer ${token}` },
  });

  if (!response.ok) throw new Error(`GitHub commit API error: ${response.status}`);

  const commit = await response.json();

  // Normalizar la respuesta a nuestro formato estándar de detalle de commit
  return {
    sha: commit.sha,
    message: commit.commit.message,
    author: commit.commit.author.name,
    date: commit.commit.author.date,
    url: commit.html_url,
    stats: commit.stats,  // { additions, deletions, total }
    // Mapear los archivos a un formato simplificado
    files: (commit.files || []).map(f => ({
      filename: f.filename,
      status: f.status,       // 'added', 'removed', 'modified', 'renamed'
      additions: f.additions,
      deletions: f.deletions,
    })),
  };
}
