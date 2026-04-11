/**
 * @fileoverview Script principal del popup de la extensión.
 *
 * Este archivo controla toda la interfaz de usuario del popup que aparece al hacer
 * clic en el ícono de la extensión. Gestiona:
 *
 * 1. Estado de autenticación: muestra si GitHub/GitLab están conectados y permite
 *    conectar/desconectar proveedores.
 * 2. Heatmap de contribuciones: renderiza el mapa de calor combinado de GitHub y GitLab.
 * 3. Feed de actividad: lista las acciones recientes (commits, PRs, issues, etc.)
 *    ordenadas por fecha, combinando ambos proveedores.
 * 4. Panel de detalle: al hacer clic en un elemento de actividad, muestra los
 *    detalles completos (archivos modificados para commits, descripción para PRs, etc.).
 *
 * Arquitectura de comunicación:
 *   popup.js  --sendMessage-->  background.js  --API calls-->  GitHub/GitLab
 *   popup.js  <--response----   background.js  <--data------   GitHub/GitLab
 *
 * Flujo de inicialización:
 *   DOMContentLoaded -> verificar auth -> cargar datos cacheados -> cargar datos frescos
 *
 * Estrategia de carga:
 *   1. Mostrar inmediatamente datos del caché (si existen) para UX instantánea.
 *   2. En paralelo, solicitar datos frescos al background.
 *   3. Actualizar la UI cuando lleguen los datos frescos.
 *
 * Dependencias: heatmap.js (renderizado del mapa de calor).
 */

import { renderHeatmap } from '../lib/heatmap.js';
import { initI18n, t, setLocale, getLocale, translatePage } from '../lib/i18n.js';

// ── Referencias a elementos del DOM ──

/** @type {HTMLButtonElement} Botón para conectar/desconectar GitHub */
const btnGitHub = document.getElementById('btn-github');

/** @type {HTMLButtonElement} Botón para conectar/desconectar GitLab */
const btnGitLab = document.getElementById('btn-gitlab');

/** @type {HTMLButtonElement} Botón para refrescar datos manualmente */
const btnRefresh = document.getElementById('btn-refresh');

/** @type {HTMLButtonElement} Botón para abrir la página de opciones */
const btnOptions = document.getElementById('btn-options');

/** @type {HTMLButtonElement} Botón "Volver" del panel de detalle */
const btnBack = document.getElementById('btn-back');

/** @type {HTMLElement} Contenedor donde se renderiza el heatmap SVG */
const heatmapContainer = document.getElementById('heatmap-container');

/** @type {HTMLElement} Barra de estado para mostrar mensajes informativos/errores */
const statusBar = document.getElementById('status-bar');

/** @type {HTMLElement} Sección completa de actividad (se oculta si no hay proveedores) */
const activitySection = document.getElementById('activity-section');

/** @type {HTMLElement} Contenedor del feed de actividad (lista) */
const activityFeed = document.getElementById('activity-feed');

/** @type {HTMLElement} Lista donde se renderizan los elementos de actividad */
const activityList = document.getElementById('activity-list');

/** @type {HTMLElement} Panel de detalle de un elemento de actividad */
const activityDetail = document.getElementById('activity-detail');

/** @type {HTMLElement} Badge que muestra el tipo de actividad en el detalle */
const detailType = document.getElementById('detail-type');

/** @type {HTMLElement} Cuerpo del panel de detalle donde se muestra la información */
const detailBody = document.getElementById('detail-body');

/** @type {HTMLButtonElement} Botón de filtro: mostrar toda la actividad */
const filterAll = document.getElementById('filter-all');

/** @type {HTMLButtonElement} Botón de filtro: mostrar solo actividad de GitHub */
const filterGitHub = document.getElementById('filter-github');

/** @type {HTMLButtonElement} Botón de filtro: mostrar solo actividad de GitLab */
const filterGitLab = document.getElementById('filter-gitlab');

// ── Estado de la aplicación ──

/** @type {{github: boolean, gitlab: boolean}} Estado de autenticación de cada proveedor */
let authState = { github: false, gitlab: false };

/** @type {Object.<string, number>|null} Datos de contribuciones de GitHub */
let githubData = null;

/** @type {Object.<string, number>|null} Datos de contribuciones de GitLab */
let gitlabData = null;

/** @type {Array<Object>} Lista combinada y ordenada de actividades recientes */
let allActivities = [];

/** @type {'all'|'github'|'gitlab'} Filtro actual aplicado al feed de actividad */
let activityFilter = 'all';

// ── Inicialización ──

/** Iniciar la aplicación cuando el DOM esté listo */
document.addEventListener('DOMContentLoaded', init);

/**
 * Función de inicialización principal.
 * Ejecuta la secuencia de carga en orden:
 * 1. Verificar estado de autenticación.
 * 2. Cargar datos del caché para mostrar inmediatamente.
 * 3. Solicitar datos frescos a las APIs (contribuciones y actividad en paralelo).
 */
async function init() {
  await initI18n();
  translatePage();
  initLanguageSelector();
  await initActivityFilter();

  await refreshAuthState();
  await loadCachedDataFromStorage();

  // Cargar datos frescos de contribuciones y actividad en paralelo
  await Promise.all([
    loadContributions(),
    loadActivity(),
  ]);
}

// ── Estado de autenticación ──

/**
 * Consulta y actualiza el estado de autenticación leyendo los tokens del storage.
 * Actualiza los botones de la UI según el estado resultante.
 */
async function refreshAuthState() {
  try {
    const result = await chrome.storage.local.get(['github_token', 'gitlab_token']);
    authState = {
      github: !!result.github_token,
      gitlab: !!result.gitlab_token,
    };
  } catch {
    // Si falla la lectura del storage, asumir que no hay conexión
    authState = { github: false, gitlab: false };
  }
  updateButtons();
}

/**
 * Actualiza la apariencia y estado de los botones de la UI según el estado de autenticación.
 * - Botones de proveedor: cambian su clase CSS y título según estén conectados o no.
 * - Botón de refresco: deshabilitado si no hay ningún proveedor conectado.
 * - Sección de actividad: oculta si no hay ningún proveedor conectado.
 */
function updateButtons() {
  // Actualizar botón de GitHub según el estado de conexión
  if (authState.github) {
    btnGitHub.className = 'provider-btn connected github-connected';
    btnGitHub.title = t('button.disconnectGitHub');
    btnGitHub.querySelector('.provider-label').textContent = 'GitHub';
  } else {
    btnGitHub.className = 'provider-btn';
    btnGitHub.title = t('button.connectGitHub');
    btnGitHub.querySelector('.provider-label').textContent = 'GitHub';
  }

  // Actualizar botón de GitLab según el estado de conexión
  if (authState.gitlab) {
    btnGitLab.className = 'provider-btn connected gitlab-connected';
    btnGitLab.title = t('button.disconnectGitLab');
    btnGitLab.querySelector('.provider-label').textContent = 'GitLab';
  } else {
    btnGitLab.className = 'provider-btn';
    btnGitLab.title = t('button.connectGitLab');
    btnGitLab.querySelector('.provider-label').textContent = 'GitLab';
  }

  // Deshabilitar refresco si no hay proveedores conectados
  btnRefresh.disabled = !authState.github && !authState.gitlab;

  // Mostrar/ocultar la sección de actividad según haya proveedores conectados
  activitySection.style.display = (authState.github || authState.gitlab) ? '' : 'none';

  // Deshabilitar los filtros de proveedores no conectados
  filterGitHub.disabled = !authState.github;
  filterGitLab.disabled = !authState.gitlab;

  // Si el filtro activo pertenece a un proveedor desconectado, resetear a "Todos"
  if ((activityFilter === 'github' && !authState.github) ||
      (activityFilter === 'gitlab' && !authState.gitlab)) {
    setActivityFilter('all');
  }
}

// ── Datos en caché ──

/**
 * Carga datos previamente cacheados del chrome.storage para mostrarlos inmediatamente.
 * Esto permite que el popup muestre datos al instante sin esperar llamadas a la API.
 *
 * Se cargan tanto contribuciones (para el heatmap) como actividad (para el feed).
 * Si hay datos disponibles, se renderizan inmediatamente en la UI.
 */
async function loadCachedDataFromStorage() {
  // No intentar cargar datos si no hay proveedores conectados
  if (!authState.github && !authState.gitlab) return;

  try {
    // Leer todas las claves de caché relevantes de una sola vez
    const result = await chrome.storage.local.get([
      'github_contributions', 'gitlab_contributions',
      'github_activity', 'gitlab_activity',
    ]);

    // Extraer los datos de contribuciones (están envueltos en { data, timestamp })
    if (result.github_contributions?.data) githubData = result.github_contributions.data;
    if (result.gitlab_contributions?.data) gitlabData = result.gitlab_contributions.data;

    // Si hay datos de contribuciones, renderizar el heatmap inmediatamente
    if (githubData || gitlabData) {
      renderHeatmap(heatmapContainer, githubData, gitlabData);
    }

    // Cargar y renderizar la actividad cacheada
    const ghActivity = result.github_activity?.data || [];
    const glActivity = result.gitlab_activity?.data || [];
    allActivities = mergeAndSortActivities(ghActivity, glActivity);
    if (allActivities.length > 0) {
      renderFilteredActivities();
    }
  } catch { /* Ignorar errores de lectura de caché — se cargarán datos frescos */ }
}

// ── Contribuciones ──

/**
 * Carga las contribuciones de todos los proveedores conectados y actualiza el heatmap.
 *
 * Manejo de estados:
 * - Si no hay datos previos, muestra un indicador de carga.
 * - Si los datos vienen del caché obsoleto, muestra una advertencia.
 * - Si un proveedor reporta UNAUTHORIZED, actualiza el estado de auth.
 * - Si la API falla pero hay datos previos, los mantiene con una advertencia.
 *
 * @param {boolean} [forceRefresh=false] - Si es true, fuerza la recarga desde la API.
 */
async function loadContributions(forceRefresh = false) {
  // Si no hay proveedores conectados, mostrar un mensaje placeholder
  if (!authState.github && !authState.gitlab) {
    heatmapContainer.innerHTML = `<p class="placeholder">${t('popup.placeholder')}</p>`;
    return;
  }

  // Mostrar indicador de carga solo si no tenemos datos previos para mostrar
  if (!githubData && !gitlabData) {
    showStatus(t('status.loading'), 'info');
  }
  // Animar el botón de refresco (gira mientras se cargan datos)
  btnRefresh.classList.add('spinning');

  try {
    // Enviar mensaje al background para obtener contribuciones de todos los proveedores
    const result = await sendMessage({ type: 'FETCH_ALL_CONTRIBUTIONS', forceRefresh });

    // Actualizar los datos (mantener los anteriores si el proveedor no devolvió datos nuevos)
    githubData = result.github?.data || githubData;
    gitlabData = result.gitlab?.data || gitlabData;
    // Re-renderizar el heatmap con los datos actualizados
    renderHeatmap(heatmapContainer, githubData, gitlabData);

    // Mostrar advertencia si alguno de los datos viene del caché obsoleto
    if (result.github?.stale || result.gitlab?.stale) {
      showStatus(t('status.cachedData'), 'warning');
    } else {
      hideStatus();
    }

    // Manejar sesiones expiradas: actualizar estado y notificar al usuario
    if (result.githubError === 'UNAUTHORIZED') {
      authState.github = false;
      updateButtons();
      showStatus(t('status.githubExpired'), 'warning');
    }
    if (result.gitlabError === 'UNAUTHORIZED') {
      authState.gitlab = false;
      updateButtons();
      showStatus(t('status.gitlabExpired'), 'warning');
    }
  } catch (err) {
    // Si hay datos previos, mostrar advertencia en vez de error
    if (githubData || gitlabData) {
      showStatus(t('status.refreshFailed'), 'warning');
    } else {
      showStatus(t('status.loadFailed', { error: err.message }), 'error');
    }
  } finally {
    // Detener la animación del botón de refresco
    btnRefresh.classList.remove('spinning');
  }
}

// ── Feed de actividad ──

/**
 * Carga la actividad reciente de todos los proveedores y actualiza el feed.
 *
 * @param {boolean} [forceRefresh=false] - Si es true, fuerza la recarga desde la API.
 */
async function loadActivity(forceRefresh = false) {
  if (!authState.github && !authState.gitlab) return;

  try {
    // Solicitar la actividad de todos los proveedores al background
    const result = await sendMessage({ type: 'FETCH_ALL_ACTIVITY', forceRefresh });

    // Combinar la actividad de ambos proveedores y ordenar por fecha
    const ghActivity = result.github?.data || [];
    const glActivity = result.gitlab?.data || [];
    allActivities = mergeAndSortActivities(ghActivity, glActivity);
    renderFilteredActivities();

    // Recopilar y mostrar errores específicos de cada proveedor (si los hay)
    const errors = [];
    if (result.githubError) errors.push(`GitHub activity: ${result.githubError}`);
    if (result.gitlabError) errors.push(`GitLab activity: ${result.gitlabError}`);
    if (errors.length > 0) {
      showStatus(errors.join(' | '), 'warning');
    }
  } catch {
    // Si no hay actividades previas, mostrar mensaje de error en la lista
    if (allActivities.length === 0) {
      activityList.innerHTML = `<div class="activity-empty">${t('status.activityFailed')}</div>`;
    }
  }
}

/**
 * Combina las actividades de GitHub y GitLab, las ordena por fecha (más reciente primero)
 * y limita el resultado a 30 elementos.
 *
 * @param {Array<Object>} ghItems - Elementos de actividad de GitHub.
 * @param {Array<Object>} glItems - Elementos de actividad de GitLab.
 * @returns {Array<Object>} Actividades combinadas, ordenadas y limitadas a 30.
 */
function mergeAndSortActivities(ghItems, glItems) {
  return [...ghItems, ...glItems]
    .sort((a, b) => new Date(b.date) - new Date(a.date)) // Más reciente primero
    .slice(0, 30); // Limitar a 30 elementos para no sobrecargar el popup
}

/**
 * Renderiza la lista de actividades en el DOM.
 * Cada elemento muestra: ícono de tipo, nombre del repo, título, tipo, fecha y proveedor.
 * Al hacer clic en un elemento, se abre el panel de detalle.
 *
 * @param {Array<Object>} items - Elementos de actividad a renderizar.
 */
function renderActivityList(items) {
  if (items.length === 0) {
    // Si hay actividades en total pero ninguna coincide con el filtro, mostrar mensaje contextual
    const emptyKey = allActivities.length > 0 && activityFilter !== 'all'
      ? 'status.noActivityForFilter'
      : 'status.noActivity';
    activityList.innerHTML = `<div class="activity-empty">${t(emptyKey)}</div>`;
    return;
  }

  // Generar el HTML de todos los elementos de actividad
  activityList.innerHTML = items.map((item, idx) => `
    <div class="activity-item type-${item.type}" data-index="${idx}">
      <div class="activity-type-icon ${item.type}">${getTypeIcon(item.type)}</div>
      <div class="activity-content">
        <div class="activity-repo">${escapeHtml(item.repo)}${item.isPrivate ? ' <span class="private-badge">&#128274;</span>' : ''}</div>
        <div class="activity-title">${escapeHtml(item.title)}</div>
        <div class="activity-meta">
          <span class="activity-type-label">${getTypeLabel(item.type)}</span>
          ${item.branch ? `<span class="activity-branch">${escapeHtml(item.branch)}</span>` : ''}
          <span class="activity-date">${timeAgo(item.date)}</span>
          <span class="activity-short-date">${shortDate(item.date)}</span>
        </div>
      </div>
      <span class="activity-provider-badge ${item.provider}">${item.provider === 'github' ? 'GH' : 'GL'}</span>
    </div>
  `).join('');

  // Agregar handlers de clic a cada elemento usando la lista filtrada como fuente,
  // de modo que el índice del DOM corresponda al mismo item que se renderizó.
  activityList.querySelectorAll('.activity-item').forEach(el => {
    el.addEventListener('click', () => {
      const idx = parseInt(el.dataset.index);
      showDetail(items[idx]);
    });
  });
}

/**
 * Aplica el filtro actual sobre allActivities y renderiza la lista resultante.
 * Es el punto de entrada preferido cuando cambian los datos o el filtro.
 */
function renderFilteredActivities() {
  const items = activityFilter === 'all'
    ? allActivities
    : allActivities.filter(it => it.provider === activityFilter);
  renderActivityList(items);
}

/**
 * Cambia el filtro activo, actualiza la UI de los botones, persiste la preferencia
 * y re-renderiza la lista de actividad.
 *
 * @param {'all'|'github'|'gitlab'} filter - Nuevo filtro a aplicar.
 */
function setActivityFilter(filter) {
  activityFilter = filter;
  [filterAll, filterGitHub, filterGitLab].forEach(btn => {
    btn.classList.toggle('active', btn.dataset.filter === filter);
  });
  chrome.storage.local.set({ activity_filter: filter });
  renderFilteredActivities();
}

/**
 * Carga el filtro persistido de chrome.storage y engancha los listeners de los 3 botones.
 */
async function initActivityFilter() {
  try {
    const stored = await chrome.storage.local.get('activity_filter');
    if (stored.activity_filter === 'github' || stored.activity_filter === 'gitlab') {
      activityFilter = stored.activity_filter;
      filterAll.classList.remove('active');
      const activeBtn = stored.activity_filter === 'github' ? filterGitHub : filterGitLab;
      activeBtn.classList.add('active');
    }
  } catch { /* Si falla la lectura, mantener 'all' por defecto */ }

  filterAll.addEventListener('click', () => setActivityFilter('all'));
  filterGitHub.addEventListener('click', () => setActivityFilter('github'));
  filterGitLab.addEventListener('click', () => setActivityFilter('gitlab'));
}

// ── Panel de detalle ──

/**
 * Muestra el panel de detalle para un elemento de actividad.
 * Oculta el feed de actividad y muestra el panel con la información detallada.
 * Para commits, carga información adicional (archivos modificados) desde la API.
 *
 * @param {Object} item - Elemento de actividad a mostrar en detalle.
 */
async function showDetail(item) {
  // Alternar visibilidad: ocultar feed, mostrar detalle
  activityFeed.classList.add('hidden');
  activityDetail.classList.remove('hidden');

  // Configurar el badge de tipo
  detailType.textContent = getTypeLabel(item.type);
  detailType.className = `detail-type-badge ${item.type}`;

  // Los commits tienen un flujo especial con carga asíncrona de archivos
  if (item.type === 'commit') {
    await showCommitDetail(item);
  } else {
    showGenericDetail(item);
  }
}

/**
 * Muestra el detalle de un commit, incluyendo la carga asíncrona de archivos modificados.
 *
 * Flujo en dos fases:
 * 1. Mostrar inmediatamente la información básica (repo, título, SHA) + indicador de carga.
 * 2. Solicitar al background los detalles del commit (archivos) y actualizar la UI.
 *
 * @param {Object} item - Elemento de actividad de tipo 'commit'.
 */
async function showCommitDetail(item) {
  const commits = item.commits || [];
  const firstCommit = commits[0];

  // Fase 1: Mostrar información básica inmediatamente
  let html = `
    <div class="detail-repo">${escapeHtml(item.repo)}</div>
    <div class="detail-title">${escapeHtml(item.title)}</div>
    <div class="detail-date">${formatDate(item.date)}</div>
  `;

  if (item.branch) {
    html += `<div class="detail-branch">${t('detail.branch')}: ${escapeHtml(item.branch)}</div>`;
  }
  if (item.author) {
    html += `<div class="detail-author">${t('detail.author')}: ${escapeHtml(item.author)}</div>`;
  }

  // Si no hay SHAs individuales (commits agregados de GraphQL), mostrar resumen con enlace
  if (!firstCommit?.sha) {
    const repoUrl = item.provider === 'github'
      ? `https://github.com/${item.repo}/commits`
      : item.url;
    if (repoUrl) {
      html += `<a class="detail-link" href="${repoUrl}" target="_blank">${t(item.provider === 'github' ? 'detail.viewCommitsGitHub' : 'detail.viewCommitsGitLab')}</a>`;
    }
    detailBody.innerHTML = html;
    return;
  }

  // Mostrar el SHA abreviado del commit (primeros 7 caracteres)
  html += `<div class="detail-sha">${firstCommit.sha.substring(0, 7)}</div>`;

  // Si el push incluye múltiples commits, listarlos todos
  if (commits.length > 1) {
    html += '<div class="detail-message">';
    for (const c of commits) {
      html += `${escapeHtml(c.sha?.substring(0, 7) || '')} ${escapeHtml(c.message?.split('\n')[0] || '')}\n`;
    }
    html += '</div>';
  }

  // Indicador de carga mientras se obtienen los detalles de archivos
  html += `<div class="detail-loading">${t('status.loadingFiles')}</div>`;
  detailBody.innerHTML = html;

  // Fase 2: Solicitar los detalles completos del commit al background
  try {
    const detail = await sendMessage({
      type: 'FETCH_COMMIT_DETAIL',
      provider: item.provider,
      repo: item.repo,
      sha: firstCommit.sha,
      projectId: item.projectId, // Solo necesario para GitLab
    });

    // Reemplazar todo el contenido con la información completa
    let fullHtml = `
      <div class="detail-repo">${escapeHtml(item.repo)}</div>
      <div class="detail-title">${escapeHtml(detail.message?.split('\n')[0] || item.title)}</div>
      <div class="detail-date">${formatDate(detail.date || item.date)}</div>
      <div class="detail-sha">${detail.sha?.substring(0, 7) || ''}</div>
    `;

    if (item.branch) {
      fullHtml += `<div class="detail-branch">${t('detail.branch')}: ${escapeHtml(item.branch)}</div>`;
    }
    if (detail.author || item.author) {
      fullHtml += `<div class="detail-author">${t('detail.author')}: ${escapeHtml(detail.author || item.author)}</div>`;
    }

    // Mostrar el mensaje completo del commit si es multilínea
    if (detail.message && detail.message.includes('\n')) {
      fullHtml += `<div class="detail-message">${escapeHtml(detail.message)}</div>`;
    }

    // Enlace para ver el commit en la plataforma web
    if (detail.url) {
      fullHtml += `<a class="detail-link" href="${detail.url}" target="_blank">${t(item.provider === 'github' ? 'detail.viewOnGitHub' : 'detail.viewOnGitLab')}</a>`;
    }

    // Lista de archivos modificados con estadísticas
    if (detail.files && detail.files.length > 0) {
      fullHtml += `<div class="detail-files-header">${t('detail.filesChanged', { count: detail.files.length })}</div>`;
      fullHtml += '<ul class="detail-files">';
      for (const f of detail.files) {
        // Letra indicadora del estado: A=Added, D=Deleted, R=Renamed, M=Modified
        const statusLetter = f.status === 'added' ? 'A' : f.status === 'removed' ? 'D' : f.status === 'renamed' ? 'R' : 'M';
        const statusClass = f.status || 'modified';
        fullHtml += `
          <li class="detail-file">
            <span class="file-status ${statusClass}">${statusLetter}</span>
            <span class="file-name">${escapeHtml(f.filename)}</span>
            <span class="file-stats">
              ${f.additions ? `<span class="additions">+${f.additions}</span>` : ''}
              ${f.deletions ? ` <span class="deletions">-${f.deletions}</span>` : ''}
            </span>
          </li>`;
      }
      fullHtml += '</ul>';
    }

    detailBody.innerHTML = fullHtml;
  } catch {
    // Si falla la carga de detalles, solo actualizar el indicador de carga
    const loadingEl = detailBody.querySelector('.detail-loading');
    if (loadingEl) loadingEl.textContent = t('status.filesFailed');
  }
}

/**
 * Muestra el detalle genérico de un elemento de actividad (no commit).
 * Muestra: repo, título, fecha, acción, estado, número, descripción y enlace web.
 *
 * @param {Object} item - Elemento de actividad (PR, issue, comment, etc.).
 */
function showGenericDetail(item) {
  let html = `
    <div class="detail-repo">${escapeHtml(item.repo)}</div>
    <div class="detail-title">${escapeHtml(item.title)}</div>
    <div class="detail-date">${formatDate(item.date)}</div>
  `;

  // Mostrar la acción realizada (ej: 'opened', 'closed', 'merged')
  if (item.action) {
    html += `<div class="detail-action">${t('detail.action', { action: escapeHtml(item.action) })}</div>`;
  }

  // Mostrar el estado actual (ej: 'open', 'closed')
  if (item.state) {
    html += `<span class="detail-state ${item.state}">${item.state}</span>`;
  }

  // Mostrar el número del issue/PR/MR
  if (item.number) {
    html += `<div class="detail-sha">#${item.number}</div>`;
  }

  // Mostrar la descripción (truncada a 300 caracteres)
  if (item.description) {
    html += `<div class="detail-description">${escapeHtml(item.description)}</div>`;
  }

  // Enlace para ver el recurso en la plataforma web
  if (item.url) {
    html += `<a class="detail-link" href="${item.url}" target="_blank">${t(item.provider === 'github' ? 'detail.viewOnGitHub' : 'detail.viewOnGitLab')}</a>`;
  }

  detailBody.innerHTML = html;
}

/**
 * Oculta el panel de detalle y vuelve a mostrar el feed de actividad.
 */
function hideDetail() {
  activityDetail.classList.add('hidden');
  activityFeed.classList.remove('hidden');
}

// ── Event Listeners (manejadores de eventos de la UI) ──

/**
 * Handler del botón de GitHub: conecta o desconecta según el estado actual.
 * Después de la acción, refresca el estado de auth y recarga los datos.
 */
btnGitHub.addEventListener('click', async () => {
  btnGitHub.disabled = true; // Deshabilitar durante la operación para evitar doble clic
  try {
    if (authState.github) {
      // Ya está conectado: desconectar
      await sendMessage({ type: 'DISCONNECT', provider: 'github' });
      githubData = null; // Limpiar datos locales
    } else {
      // No está conectado: iniciar flujo de autenticación
      await sendMessage({ type: 'AUTH_GITHUB' });
    }
    // Actualizar UI y recargar datos
    await refreshAuthState();
    await Promise.all([loadContributions(), loadActivity()]);
  } catch (err) {
    showStatus(`GitHub: ${t('status.loadFailed', { error: err.message })}`, 'error');
  } finally {
    btnGitHub.disabled = false;
  }
});

/**
 * Handler del botón de GitLab: conecta o desconecta según el estado actual.
 * Lee la URL base configurada en las opciones para soportar instancias self-hosted.
 */
btnGitLab.addEventListener('click', async () => {
  btnGitLab.disabled = true;
  try {
    if (authState.gitlab) {
      await sendMessage({ type: 'DISCONNECT', provider: 'gitlab' });
      gitlabData = null;
    } else {
      // Leer la URL base de GitLab configurada por el usuario (o usar la por defecto)
      const stored = await chrome.storage.sync.get('gitlab_base_url');
      const baseUrl = stored.gitlab_base_url || 'https://gitlab.com';
      await sendMessage({ type: 'AUTH_GITLAB', baseUrl });
    }
    await refreshAuthState();
    await Promise.all([loadContributions(), loadActivity()]);
  } catch (err) {
    showStatus(`GitLab: ${t('status.loadFailed', { error: err.message })}`, 'error');
  } finally {
    btnGitLab.disabled = false;
  }
});

/**
 * Handler del botón de refresco: fuerza la recarga de todos los datos desde las APIs.
 */
btnRefresh.addEventListener('click', () => {
  Promise.all([loadContributions(true), loadActivity(true)]);
});

/**
 * Handler del botón de opciones: abre la página de configuración de la extensión.
 */
btnOptions.addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});

/**
 * Handler del botón "Volver": cierra el panel de detalle y vuelve al feed.
 */
btnBack.addEventListener('click', hideDetail);

// ── Funciones auxiliares ──

/**
 * Envía un mensaje al service worker (background.js) y espera la respuesta.
 * Envuelve chrome.runtime.sendMessage en una Promise para poder usar async/await.
 *
 * @param {Object} message - Mensaje a enviar (debe tener un campo 'type').
 * @returns {Promise<Object>} Respuesta del background.
 * @throws {Error} Si hay un error de runtime de Chrome o si el background responde con error.
 */
function sendMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      // Verificar errores de comunicación con el runtime de Chrome
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      // Verificar errores reportados por el background en la respuesta
      if (response?.error) {
        reject(new Error(response.error));
        return;
      }
      resolve(response);
    });
  });
}

/**
 * Muestra un mensaje en la barra de estado del popup.
 *
 * @param {string} text - Texto del mensaje a mostrar.
 * @param {string} [type='info'] - Tipo de mensaje ('info', 'warning', 'error') para estilos CSS.
 */
function showStatus(text, type = 'info') {
  statusBar.textContent = text;
  statusBar.className = `status-bar ${type}`;
}

/**
 * Oculta la barra de estado.
 */
function hideStatus() {
  statusBar.className = 'status-bar hidden';
}

/**
 * Escapa caracteres HTML especiales para prevenir inyección de HTML/XSS.
 * Se usa en todos los lugares donde se insertan datos dinámicos en el DOM.
 *
 * @param {string} str - Cadena a escapar.
 * @returns {string} Cadena con caracteres HTML especiales escapados.
 */
function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Devuelve el ícono (carácter o abreviatura) correspondiente a un tipo de actividad.
 * Se usa en la lista de actividad para identificar visualmente cada tipo.
 *
 * @param {string} type - Tipo de actividad ('commit', 'pull_request', 'issue', etc.).
 * @returns {string} Ícono o abreviatura (puede incluir entidades HTML).
 */
function getTypeIcon(type) {
  const icons = {
    commit: 'C',
    pull_request: 'PR',
    merge_request: 'MR',
    issue: 'I',
    comment: '&#x1f4ac;',  // Emoji de globo de diálogo
    review: 'R',
    branch: 'B',
    tag: 'T',
    fork: 'F',
    star: '&#x2605;',      // Estrella
    other: '?',
  };
  return icons[type] || '?';
}

/**
 * Devuelve la etiqueta legible para un tipo de actividad.
 * Se usa en el feed de actividad y en el panel de detalle.
 *
 * @param {string} type - Tipo de actividad.
 * @returns {string} Nombre legible del tipo de actividad.
 */
function getTypeLabel(type) {
  const key = `type.${type}`;
  const translated = t(key);
  return translated !== key ? translated : type;
}

/**
 * Calcula y formatea el tiempo transcurrido desde una fecha dada hasta ahora.
 * Devuelve una cadena legible como "5m ago", "2h ago", "3d ago", "1mo ago".
 *
 * @param {string} dateStr - Fecha en formato ISO 8601 (ej: '2025-03-15T10:30:00Z').
 * @returns {string} Tiempo transcurrido en formato legible.
 */
function timeAgo(dateStr) {
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diff = now - then;

  const mins = Math.floor(diff / 60000);
  if (mins < 1) return t('time.justNow');
  if (mins < 60) return t('time.minsAgo', { mins });

  const hours = Math.floor(mins / 60);
  if (hours < 24) return t('time.hoursAgo', { hours });

  const days = Math.floor(hours / 24);
  if (days < 30) return t('time.daysAgo', { days });

  const months = Math.floor(days / 30);
  return t('time.monthsAgo', { months });
}

/**
 * Formatea una fecha ISO a un formato legible para el panel de detalle.
 * Incluye mes, día, año, hora y minutos.
 *
 * @param {string} dateStr - Fecha en formato ISO 8601.
 * @returns {string} Fecha formateada (ej: 'Mar 15, 2025, 10:30 AM').
 */
const LOCALE_MAP = { en: 'en-US', es: 'es-ES', zh: 'zh-CN' };

function formatDate(dateStr) {
  return new Date(dateStr).toLocaleDateString(LOCALE_MAP[getLocale()] || 'en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

function shortDate(dateStr) {
  const locale = LOCALE_MAP[getLocale()] || 'en-US';
  return new Date(dateStr).toLocaleDateString(locale, {
    weekday: 'short', day: 'numeric', month: 'short',
  });
}

// ── Selector de idioma ──

/**
 * Inicializa el selector de idioma en el header.
 * Establece el valor actual y maneja el cambio de idioma en runtime.
 */
function initLanguageSelector() {
  const langSelect = document.getElementById('lang-select');
  langSelect.value = getLocale();

  langSelect.addEventListener('change', async () => {
    await setLocale(langSelect.value);
    // Re-renderizar contenido dinámico que ya está en pantalla
    updateButtons();
    if (githubData || gitlabData) {
      renderHeatmap(heatmapContainer, githubData, gitlabData);
    }
    if (allActivities.length > 0) {
      renderFilteredActivities();
    }
  });
}
