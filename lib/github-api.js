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
 * Query GraphQL para obtener la actividad reciente del usuario autenticado.
 * Usa 'viewer' para tener acceso a repos privados (a diferencia del REST Events API
 * que con tokens de GitHub Apps solo ve repos donde la App está instalada).
 *
 * Obtiene: PRs, issues, reviews y commits agrupados por repositorio.
 * @const {string}
 */
const ACTIVITY_QUERY = `
query {
  viewer {
    login
    contributionsCollection {
      pullRequestContributions(first: 20, orderBy: {direction: DESC}) {
        nodes {
          occurredAt
          pullRequest {
            id
            title
            number
            state
            url
            body
            repository {
              nameWithOwner
            }
          }
        }
      }
      issueContributions(first: 20, orderBy: {direction: DESC}) {
        nodes {
          occurredAt
          issue {
            id
            title
            number
            state
            url
            body
            repository {
              nameWithOwner
            }
          }
        }
      }
      pullRequestReviewContributions(first: 10, orderBy: {direction: DESC}) {
        nodes {
          occurredAt
          pullRequestReview {
            id
            body
            url
            pullRequest {
              title
              number
              repository {
                nameWithOwner
              }
            }
          }
        }
      }
    }
    repositories(first: 15, orderBy: {field: PUSHED_AT, direction: DESC}, affiliations: [OWNER, ORGANIZATION_MEMBER, COLLABORATOR]) {
      nodes {
        nameWithOwner
        defaultBranchRef {
          target {
            ... on Commit {
              history(first: 10) {
                nodes {
                  oid
                  message
                  committedDate
                  url
                  author {
                    user {
                      login
                    }
                  }
                }
              }
            }
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
 * Obtiene la actividad reciente del usuario de GitHub usando la API GraphQL.
 *
 * Usa GraphQL en vez de la API REST de eventos porque los tokens de GitHub Apps (ghu_)
 * solo ven eventos de repos donde la App está instalada en el endpoint REST.
 * La query GraphQL con 'viewer' sí tiene acceso completo a repos privados.
 *
 * @returns {Promise<Array<Object>>} Arreglo de elementos de actividad normalizados.
 *   Cada elemento tiene: id, provider, repo, date, type, title, y campos adicionales según el tipo.
 * @throws {Error} 'Not authenticated with GitHub' si no hay token.
 * @throws {Error} 'UNAUTHORIZED' si el token es inválido.
 */
export async function fetchGitHubActivity() {
  const token = await getToken('github');
  if (!token) throw new Error('Not authenticated with GitHub');

  const response = await fetch(GITHUB_GRAPHQL_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query: ACTIVITY_QUERY }),
  });

  if (response.status === 401) throw new Error('UNAUTHORIZED');

  if (!response.ok) {
    if (response.status === 403) {
      const resetHeader = response.headers.get('x-ratelimit-reset');
      if (resetHeader) throw new Error(`RATE_LIMITED:${resetHeader}`);
    }
    throw new Error(`GitHub API error: ${response.status}`);
  }

  const json = await response.json();
  if (json.errors) throw new Error(`GitHub GraphQL error: ${json.errors[0].message}`);

  return normalizeGraphQLActivity(json.data);
}

/**
 * Normaliza la respuesta de la query GraphQL de actividad a un formato uniforme.
 *
 * Transforma las contribuciones de GraphQL (PRs, issues, reviews, commits por repo)
 * a un formato común con campos estándar, compatible con los datos de GitLab.
 *
 * @param {Object} data - Datos del campo 'data' de la respuesta GraphQL.
 * @returns {Array<Object>} Eventos normalizados, ordenados por fecha descendente, máximo 30.
 */
function normalizeGraphQLActivity(data) {
  const items = [];
  const cc = data.viewer.contributionsCollection;

  // Pull Requests
  for (const node of cc.pullRequestContributions.nodes) {
    const pr = node.pullRequest;
    items.push({
      id: `gh-pr-${pr.id}`,
      provider: 'github',
      repo: pr.repository.nameWithOwner,
      date: node.occurredAt,
      type: 'pull_request',
      title: pr.title,
      number: pr.number,
      state: pr.state.toLowerCase(),
      description: pr.body?.substring(0, 300) || '',
      url: pr.url,
    });
  }

  // Issues
  for (const node of cc.issueContributions.nodes) {
    const issue = node.issue;
    items.push({
      id: `gh-issue-${issue.id}`,
      provider: 'github',
      repo: issue.repository.nameWithOwner,
      date: node.occurredAt,
      type: 'issue',
      title: issue.title,
      number: issue.number,
      state: issue.state.toLowerCase(),
      description: issue.body?.substring(0, 300) || '',
      url: issue.url,
    });
  }

  // Reviews de PRs
  for (const node of cc.pullRequestReviewContributions.nodes) {
    const review = node.pullRequestReview;
    const pr = review.pullRequest;
    items.push({
      id: `gh-review-${review.id}`,
      provider: 'github',
      repo: pr.repository.nameWithOwner,
      date: node.occurredAt,
      type: 'review',
      title: `Reviewed PR #${pr.number}: ${pr.title}`,
      description: review.body?.substring(0, 300) || '',
      url: review.url,
    });
  }

  // Commits individuales de los repos más recientes del usuario
  const viewerLogin = data.viewer.login;
  for (const repo of (data.viewer.repositories?.nodes || [])) {
    const repoName = repo.nameWithOwner;
    const commits = repo.defaultBranchRef?.target?.history?.nodes || [];
    for (const commit of commits) {
      // Solo incluir commits del usuario autenticado
      if (commit.author?.user?.login !== viewerLogin) continue;
      items.push({
        id: `gh-${commit.oid}`,
        provider: 'github',
        repo: repoName,
        date: commit.committedDate,
        type: 'commit',
        title: commit.message.split('\n')[0],
        commits: [{
          sha: commit.oid,
          message: commit.message,
        }],
      });
    }
  }

  // Ordenar por fecha descendente (más reciente primero) y limitar a 30
  items.sort((a, b) => new Date(b.date) - new Date(a.date));
  return items.slice(0, 30);
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
