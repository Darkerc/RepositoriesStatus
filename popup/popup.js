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

/** @type {HTMLButtonElement} Tab principal "Mi actividad" (actividad personal del usuario) */
const tabUser = document.getElementById('tab-user');

/** @type {HTMLButtonElement} Tab principal "Actividad de grupos" (orgs/grupos del usuario) */
const tabGroups = document.getElementById('tab-groups');

/** @type {HTMLElement} Contenedor del strip de sub-tabs de grupos (uno por cada org/group) */
const groupTabsContainer = document.getElementById('group-tabs-container');

/** @type {HTMLElement} Strip donde se renderizan los botones de cada grupo */
const groupTabsList = document.getElementById('group-tabs');

/** @type {HTMLElement} Mensaje que se muestra cuando el usuario no tiene grupos */
const groupTabsEmpty = document.getElementById('group-tabs-empty');

/** @type {HTMLElement} Contenedor del filtro por proveedor (se oculta en modo grupo) */
const activityFilterGroup = document.querySelector('.activity-filter-group');

/** @type {HTMLElement} Toolbar de acciones del heatmap (ocultar/descargar) */
const heatmapToolbar = document.getElementById('heatmap-toolbar');

/** @type {HTMLButtonElement} Botón para ocultar/mostrar el heatmap */
const btnToggleHeatmap = document.getElementById('btn-toggle-heatmap');

/** @type {HTMLButtonElement} Botón para descargar el heatmap como imagen */
const btnDownloadHeatmap = document.getElementById('btn-download-heatmap');

/** @type {HTMLButtonElement} Botón para cambiar el tema (claro/oscuro/sistema) */
const btnTheme = document.getElementById('btn-theme');

/** @type {SVGElement} Icono de sol (tema claro) */
const iconSun = document.getElementById('icon-sun');

/** @type {SVGElement} Icono de luna (tema oscuro) */
const iconMoon = document.getElementById('icon-moon');

/** @type {SVGElement} Icono de monitor (tema sistema) */
const iconSystem = document.getElementById('icon-system');

// ── Estado de la aplicación ──

/** @type {{github: boolean, gitlab: boolean}} Estado de autenticación de cada proveedor */
let authState = { github: false, gitlab: false };

/** @type {Object.<string, number>|null} Datos de contribuciones de GitHub */
let githubData = null;

/** @type {Object.<string, number>|null} Datos de contribuciones de GitLab */
let gitlabData = null;

/** @type {Array<Object>} Lista combinada y ordenada de actividades recientes del usuario */
let userActivities = [];

/** @type {Array<Object>} Lista de actividades que se está mostrando actualmente
 *  (apunta a `userActivities` en tab "Mi actividad" o a la actividad del grupo
 *  seleccionado en tab "Actividad de grupos"). */
let displayedActivities = [];

/** @type {'all'|'github'|'gitlab'} Filtro actual aplicado al feed de actividad (solo en tab de usuario) */
let activityFilter = 'all';

/** @type {'user'|'groups'} Tab principal activo */
let mainTab = 'user';

/** @type {{github: Array, gitlab: Array}} Listas de orgs/grupos del usuario (se llena al entrar al tab de grupos) */
let userGroups = { github: [], gitlab: [] };

/** @type {boolean} Indica si ya se intentó cargar la lista de grupos (evita fetch repetidos) */
let groupsLoaded = false;

/** @type {boolean} Guard de concurrencia para evitar cargas paralelas de la lista de grupos */
let groupsLoading = false;

/** @type {'system'|'light'|'dark'} Preferencia de tema del usuario */
let themePref = 'system';

/** @const {string[]} Opciones de tema disponibles para el ciclo */
const THEMES = ['system', 'light', 'dark'];

/** @type {{provider: string, ref: string|number, name: string}|null} Grupo actualmente seleccionado en el strip */
let selectedGroup = null;

/** @type {Object.<string, Array<Object>>} Caché en memoria de actividad por grupo ("{provider}:{ref}" → items) */
let groupActivityCache = {};

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
  await initTheme();
  initLanguageSelector();
  await initActivityFilter();
  await initMainTabs();

  await refreshAuthState();
  await loadCachedDataFromStorage();

  // Si el último tab era "groups", entrar en ese modo tras cargar el caché.
  if (mainTab === 'groups' && (authState.github || authState.gitlab)) {
    await setMainTab('groups');
  }

  // Cargar datos frescos de contribuciones y actividad en paralelo
  await Promise.all([
    loadContributions(),
    loadActivity(),
  ]);
}

// ── Tema (claro / oscuro / sistema) ──

/**
 * Inicializa el sistema de temas: carga la preferencia persistida, aplica el tema,
 * escucha cambios del tema del SO y conecta el botón de cambio de tema.
 */
async function initTheme() {
  try {
    const stored = await chrome.storage.local.get('user_theme');
    if (stored.user_theme && THEMES.includes(stored.user_theme)) {
      themePref = stored.user_theme;
    }
  } catch { /* por defecto 'system' */ }

  applyTheme();

  // Escuchar cambios del tema del SO (afecta solo al modo 'system')
  window.matchMedia('(prefers-color-scheme: dark)')
    .addEventListener('change', () => {
      if (themePref === 'system') {
        applyTheme();
        rerenderHeatmapIfVisible();
      }
    });

  btnTheme.addEventListener('click', cycleTheme);
}

/**
 * Aplica el tema actual al DOM: establece o elimina el atributo data-theme
 * en el elemento <html> y sincroniza localStorage para prevenir flash.
 */
function applyTheme() {
  const html = document.documentElement;

  if (themePref === 'system') {
    html.removeAttribute('data-theme');
  } else {
    html.setAttribute('data-theme', themePref);
  }

  // Sincronizar localStorage para prevención de flash al abrir
  localStorage.setItem('user_theme', themePref);

  updateThemeIcon();
}

/**
 * Retorna el tema efectivo resuelto: 'light' o 'dark'.
 * Cuando la preferencia es 'system', consulta la media query del SO.
 * @returns {'light'|'dark'}
 */
function getEffectiveTheme() {
  if (themePref !== 'system') return themePref;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/**
 * Actualiza el icono y tooltip del botón de tema según la preferencia actual.
 */
function updateThemeIcon() {
  iconSun.classList.toggle('hidden', themePref !== 'light');
  iconMoon.classList.toggle('hidden', themePref !== 'dark');
  iconSystem.classList.toggle('hidden', themePref !== 'system');

  const tooltipKey = 'theme.' + themePref;
  btnTheme.title = t(tooltipKey);
}

/**
 * Cicla entre los temas: system → light → dark → system.
 * Persiste la preferencia y re-renderiza el heatmap si es necesario.
 */
function cycleTheme() {
  const idx = THEMES.indexOf(themePref);
  themePref = THEMES[(idx + 1) % THEMES.length];
  applyTheme();
  chrome.storage.local.set({ user_theme: themePref });
  rerenderHeatmapIfVisible();
}

/**
 * Re-renderiza el heatmap si hay datos visibles (para actualizar celdas vacías al cambiar tema).
 */
function rerenderHeatmapIfVisible() {
  if (githubData || gitlabData) {
    renderHeatmap(heatmapContainer, githubData, gitlabData);
  }
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

  // Si ambos proveedores están desconectados, resetear el estado de grupos y
  // forzar la vuelta al tab de usuario (evita quedar bloqueado en un strip vacío).
  if (!authState.github && !authState.gitlab) {
    userGroups = { github: [], gitlab: [] };
    groupsLoaded = false;
    selectedGroup = null;
    groupActivityCache = {};
    if (mainTab === 'groups') {
      setMainTab('user');
    }
  } else if (mainTab === 'groups' && selectedGroup) {
    // Si el proveedor del grupo seleccionado se desconectó, limpiar la selección.
    if ((selectedGroup.provider === 'github' && !authState.github) ||
        (selectedGroup.provider === 'gitlab' && !authState.gitlab)) {
      selectedGroup = null;
      groupsLoaded = false;
      userGroups = { github: [], gitlab: [] };
      enterGroupTab();
    }
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
      setHeatmapToolbarVisible(true);
    }

    // Cargar y renderizar la actividad cacheada del usuario
    const ghActivity = result.github_activity?.data || [];
    const glActivity = result.gitlab_activity?.data || [];
    userActivities = mergeAndSortActivities(ghActivity, glActivity);
    // Por defecto al abrir el popup se muestra la actividad del usuario.
    // Si el último tab era "groups", el flujo de initMainTabs lo cambiará después.
    if (mainTab === 'user') {
      displayedActivities = userActivities;
      if (userActivities.length > 0) {
        renderFilteredActivities();
      }
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
    setHeatmapToolbarVisible(false);
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
    setHeatmapToolbarVisible(true);

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
    userActivities = mergeAndSortActivities(ghActivity, glActivity);
    // Solo re-renderizar si estamos viendo la actividad del usuario.
    // Si estamos en el tab de grupos, no queremos pisar la vista del grupo actual.
    if (mainTab === 'user') {
      displayedActivities = userActivities;
      renderFilteredActivities();
    }

    // Recopilar y mostrar errores específicos de cada proveedor (si los hay)
    const errors = [];
    if (result.githubError) errors.push(`GitHub activity: ${result.githubError}`);
    if (result.gitlabError) errors.push(`GitLab activity: ${result.gitlabError}`);
    if (errors.length > 0) {
      showStatus(errors.join(' | '), 'warning');
    }
  } catch {
    // Si no hay actividades previas y estamos en el tab de usuario, mostrar mensaje de error
    if (mainTab === 'user' && userActivities.length === 0) {
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
    // Si estamos en el tab de grupos, mostrar mensaje específico de grupo vacío
    if (mainTab === 'groups') {
      const emptyKey = selectedGroup ? 'status.noActivity' : 'groupTab.selectGroup';
      activityList.innerHTML = `<div class="activity-empty">${t(emptyKey)}</div>`;
      return;
    }
    // Si hay actividades en total pero ninguna coincide con el filtro, mostrar mensaje contextual
    const emptyKey = displayedActivities.length > 0 && activityFilter !== 'all'
      ? 'status.noActivityForFilter'
      : 'status.noActivity';
    activityList.innerHTML = `<div class="activity-empty">${t(emptyKey)}</div>`;
    return;
  }

  // En el tab de grupos mostramos el autor del evento junto al nombre del repo,
  // para que sea fácil identificar quién hizo cada cosa dentro del grupo.
  const showActor = mainTab === 'groups';

  // Generar el HTML de todos los elementos de actividad
  activityList.innerHTML = items.map((item, idx) => `
    <div class="activity-item type-${item.type}" data-index="${idx}">
      <div class="activity-type-icon ${item.type}">${getTypeIcon(item.type)}</div>
      <div class="activity-content">
        <div class="activity-repo-row">
          <span class="activity-repo">${escapeHtml(item.repo)}${item.isPrivate ? ' <span class="private-badge">&#128274;</span>' : ''}</span>
          ${showActor && item.actor ? `<span class="activity-actor" title="${escapeHtml(item.actor)}">@${escapeHtml(item.actor)}</span>` : ''}
        </div>
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
 * Aplica el filtro actual sobre displayedActivities y renderiza la lista resultante.
 * Es el punto de entrada preferido cuando cambian los datos o el filtro.
 * El filtro por proveedor (All/GH/GL) solo se aplica en el tab de usuario; en el
 * tab de grupos el filtro es irrelevante porque cada grupo pertenece a un solo proveedor.
 */
function renderFilteredActivities() {
  const items = (mainTab === 'user' && activityFilter !== 'all')
    ? displayedActivities.filter(it => it.provider === activityFilter)
    : displayedActivities;
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

// ── Tabs principales (User / Groups) ──

/**
 * Inicializa los tabs principales: lee el último tab activo del storage, engancha
 * los listeners de click y deja todo listo para que init() haga el bootstrap final.
 */
async function initMainTabs() {
  try {
    const stored = await chrome.storage.local.get('main_tab_last');
    if (stored.main_tab_last === 'groups') {
      mainTab = 'groups';
    }
  } catch { /* mantener 'user' por defecto */ }

  tabUser.addEventListener('click', () => setMainTab('user'));
  tabGroups.addEventListener('click', () => setMainTab('groups'));
}

/**
 * Cambia el tab principal activo. Se encarga de toda la gestión de UI:
 * - Toggle de clases `.active` en los tabs.
 * - Muestra/oculta el strip de sub-tabs de grupos.
 * - Oculta el filtro por proveedor cuando estamos en grupos (es irrelevante porque
 *   cada grupo pertenece a un único proveedor).
 * - Persiste la preferencia y entra en el tab correspondiente.
 *
 * @param {'user'|'groups'} tab
 */
async function setMainTab(tab) {
  mainTab = tab;
  tabUser.classList.toggle('active', tab === 'user');
  tabUser.setAttribute('aria-selected', String(tab === 'user'));
  tabGroups.classList.toggle('active', tab === 'groups');
  tabGroups.setAttribute('aria-selected', String(tab === 'groups'));

  // El strip de grupos solo aparece en el tab de grupos.
  groupTabsContainer.classList.toggle('hidden', tab !== 'groups');
  // El filtro por proveedor no tiene sentido en el tab de grupos.
  if (activityFilterGroup) {
    activityFilterGroup.style.display = tab === 'groups' ? 'none' : '';
  }

  // Si estamos en el panel de detalle, volver al feed al cambiar de tab.
  if (!activityDetail.classList.contains('hidden')) {
    hideDetail();
  }

  try { chrome.storage.local.set({ main_tab_last: tab }); } catch { /* ignore */ }

  if (tab === 'user') {
    enterUserTab();
  } else {
    await enterGroupTab();
  }
}

/**
 * Prepara la vista del tab de usuario: apunta `displayedActivities` a las
 * actividades del usuario y re-renderiza.
 */
function enterUserTab() {
  displayedActivities = userActivities;
  renderFilteredActivities();
}

/**
 * Prepara la vista del tab de grupos: asegura que la lista de grupos esté cargada
 * (lazy), renderiza el strip y auto-selecciona el último grupo visitado (o el primero
 * disponible si no había selección previa).
 */
async function enterGroupTab() {
  if (!groupsLoaded && !groupsLoading) {
    await loadUserGroups();
  } else {
    renderGroupTabs();
  }

  // Si ya hay un grupo seleccionado y está en la lista actual, recargar su actividad.
  if (selectedGroup && groupExistsInCurrentLists(selectedGroup)) {
    // Marcar visualmente el botón correcto y cargar.
    highlightActiveGroupButton();
    loadGroupActivity(selectedGroup);
    return;
  }

  // Auto-seleccionar el primer grupo disponible.
  const first = firstAvailableGroup();
  if (first) {
    selectGroup(first);
  } else {
    // No hay grupos: mostrar vacío en la lista de actividad.
    displayedActivities = [];
    renderFilteredActivities();
  }
}

/**
 * Devuelve true si `group` está presente en las listas actuales de userGroups.
 */
function groupExistsInCurrentLists(group) {
  const list = group.provider === 'github' ? userGroups.github : userGroups.gitlab;
  return list.some(g => String(g.ref) === String(group.ref));
}

/**
 * Devuelve el primer grupo disponible (GitHub prioritario, luego GitLab).
 * @returns {{provider: string, ref: string|number, name: string}|null}
 */
function firstAvailableGroup() {
  if (userGroups.github.length > 0) {
    const g = userGroups.github[0];
    return { provider: 'github', ref: g.login, name: g.name || g.login };
  }
  if (userGroups.gitlab.length > 0) {
    const g = userGroups.gitlab[0];
    return { provider: 'gitlab', ref: g.id, name: g.name || g.fullPath };
  }
  return null;
}

/**
 * Solicita al background la lista de orgs de GitHub y grupos de GitLab.
 * Maneja errores por proveedor (UNAUTHORIZED actualiza el auth state) sin tumbar
 * la UI si solo uno de los dos falla.
 */
async function loadUserGroups() {
  if (groupsLoading) return;
  groupsLoading = true;
  activityList.innerHTML = `<div class="activity-empty">${t('groupTab.loadingGroups')}</div>`;
  try {
    const result = await sendMessage({ type: 'FETCH_USER_GROUPS' });
    // El background envuelve cada provider como { data, fromCache, stale? }
    userGroups = {
      github: Array.isArray(result.github?.data) ? result.github.data : [],
      gitlab: Array.isArray(result.gitlab?.data) ? result.gitlab.data : [],
    };
    groupsLoaded = true;

    if (result.github?.stale || result.gitlab?.stale) {
      showStatus(t('status.cachedData'), 'warning');
    }

    // Propagar UNAUTHORIZED por proveedor igual que loadContributions/loadActivity.
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

    renderGroupTabs();
  } catch (err) {
    activityList.innerHTML = `<div class="activity-empty">${t('groupTab.loadError')}</div>`;
    showStatus(err.message || t('groupTab.loadError'), 'error');
  } finally {
    groupsLoading = false;
  }
}

/**
 * Renderiza el strip de botones de grupo. GitHub orgs primero (orden alfabético),
 * luego GitLab groups. Cada botón incluye un dot del color del proveedor. Si no
 * hay grupos en ningún proveedor, muestra el empty state.
 */
function renderGroupTabs() {
  const ghSorted = [...userGroups.github].sort((a, b) =>
    (a.name || a.login).localeCompare(b.name || b.login));
  const glSorted = [...userGroups.gitlab].sort((a, b) =>
    (a.name || a.fullPath).localeCompare(b.name || b.fullPath));

  if (ghSorted.length === 0 && glSorted.length === 0) {
    groupTabsList.innerHTML = '';
    groupTabsEmpty.classList.remove('hidden');
    return;
  }
  groupTabsEmpty.classList.add('hidden');

  const parts = [];
  for (const g of ghSorted) {
    const name = g.name || g.login;
    parts.push(`
      <button type="button" class="group-tab-btn" data-provider="github" data-ref="${escapeHtml(g.login)}" title="${escapeHtml(name)}">
        <span class="provider-dot gh-dot"></span>
        <span class="group-tab-label">${escapeHtml(name)}</span>
      </button>`);
  }
  for (const g of glSorted) {
    const name = g.name || g.fullPath;
    parts.push(`
      <button type="button" class="group-tab-btn" data-provider="gitlab" data-ref="${escapeHtml(String(g.id))}" title="${escapeHtml(name)}">
        <span class="provider-dot gl-dot"></span>
        <span class="group-tab-label">${escapeHtml(name)}</span>
      </button>`);
  }
  groupTabsList.innerHTML = parts.join('');

  groupTabsList.querySelectorAll('.group-tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const provider = btn.dataset.provider;
      const ref = btn.dataset.ref;
      const name = btn.querySelector('.group-tab-label').textContent;
      selectGroup({ provider, ref, name });
    });
  });

  highlightActiveGroupButton();
}

/**
 * Marca como activo el botón del strip correspondiente al `selectedGroup` actual.
 */
function highlightActiveGroupButton() {
  groupTabsList.querySelectorAll('.group-tab-btn').forEach(btn => {
    const match = selectedGroup
      && btn.dataset.provider === selectedGroup.provider
      && btn.dataset.ref === String(selectedGroup.ref);
    btn.classList.toggle('active', !!match);
  });
}

/**
 * Selecciona un grupo del strip, persiste la elección y carga su actividad.
 * @param {{provider: string, ref: string|number, name: string}} group
 */
function selectGroup(group) {
  selectedGroup = group;
  highlightActiveGroupButton();
  try {
    chrome.storage.local.set({ group_selected_last: group });
  } catch { /* ignore */ }
  loadGroupActivity(group);
}

/**
 * Carga la actividad de un grupo desde el background. Usa un guard de respuesta
 * obsoleta para evitar renderizar datos de un grupo que ya no está seleccionado
 * (por ejemplo si el usuario cambió de grupo mientras llegaba la respuesta).
 *
 * @param {{provider: string, ref: string|number, name: string}} group
 * @param {boolean} [forceRefresh=false]
 */
async function loadGroupActivity(group, forceRefresh = false) {
  const cacheKey = `${group.provider}:${group.ref}`;

  // Render instantáneo desde el caché en memoria si existe y no estamos forzando.
  if (!forceRefresh && groupActivityCache[cacheKey]) {
    displayedActivities = groupActivityCache[cacheKey];
    renderFilteredActivities();
    return;
  }

  // Mostrar estado de carga solo si no tenemos nada que mostrar aún.
  activityList.innerHTML = `<div class="activity-empty">${t('groupTab.loadingActivity')}</div>`;
  btnRefresh.classList.add('spinning');

  const requestedKey = cacheKey;
  try {
    const result = await sendMessage({
      type: 'FETCH_GROUP_ACTIVITY',
      provider: group.provider,
      ref: group.ref,
      forceRefresh,
    });

    // Guard de respuesta obsoleta: si el usuario cambió de grupo mientras llegaba
    // la respuesta, descartar el resultado.
    if (!selectedGroup || `${selectedGroup.provider}:${selectedGroup.ref}` !== requestedKey) {
      return;
    }

    const items = Array.isArray(result.data) ? result.data : [];
    groupActivityCache[cacheKey] = items;
    displayedActivities = items;
    renderFilteredActivities();

    if (result.stale) {
      showStatus(t('status.cachedData'), 'warning');
    } else {
      hideStatus();
    }
  } catch (err) {
    // UNAUTHORIZED: refrescar auth state para reflejar la desconexión.
    if (err.message === 'UNAUTHORIZED') {
      await refreshAuthState();
      return;
    }
    if (!selectedGroup || `${selectedGroup.provider}:${selectedGroup.ref}` !== requestedKey) {
      return;
    }
    activityList.innerHTML = `
      <div class="activity-empty">
        ${t('groupTab.loadError')}
        <button type="button" class="retry-btn">${t('groupTab.retry')}</button>
      </div>`;
    const retry = activityList.querySelector('.retry-btn');
    if (retry) retry.addEventListener('click', () => loadGroupActivity(group, true));
  } finally {
    btnRefresh.classList.remove('spinning');
  }
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
 * En el tab de grupos, refresca la actividad del grupo seleccionado en lugar de la
 * del usuario (el heatmap y la actividad del usuario siempre se refrescan igual porque
 * se alimentan de la misma fuente y el usuario espera que el refresh impacte a todo).
 */
btnRefresh.addEventListener('click', () => {
  loadContributions(true);
  if (mainTab === 'groups' && selectedGroup) {
    loadGroupActivity(selectedGroup, true);
  } else {
    loadActivity(true);
  }
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

// ── Heatmap toolbar (ocultar/mostrar y descargar) ──

/**
 * Muestra u oculta la toolbar del heatmap según haya datos disponibles.
 * @param {boolean} show - Si la toolbar debe ser visible.
 */
function setHeatmapToolbarVisible(show) {
  heatmapToolbar.classList.toggle('visible', show);
}

/**
 * Aplica el estado de visibilidad del heatmap (colapsado o expandido).
 * Actualiza el icono del botón de toggle y el estado del botón de descarga.
 * @param {boolean} collapsed - Si el heatmap debe estar oculto.
 */
function applyHeatmapCollapsed(collapsed) {
  heatmapContainer.classList.toggle('collapsed', collapsed);
  document.getElementById('icon-eye-open').classList.toggle('hidden', collapsed);
  document.getElementById('icon-eye-closed').classList.toggle('hidden', !collapsed);
  btnDownloadHeatmap.disabled = collapsed;
  btnToggleHeatmap.title = collapsed ? t('heatmap.toggleShow') : t('heatmap.toggleHide');
}

/**
 * Handler del botón de toggle del heatmap: alterna visibilidad y persiste la preferencia.
 */
btnToggleHeatmap.addEventListener('click', () => {
  const collapsed = !heatmapContainer.classList.contains('collapsed');
  applyHeatmapCollapsed(collapsed);
  localStorage.setItem('heatmap_collapsed', collapsed ? '1' : '0');
});

/**
 * Handler del botón de descarga: convierte el SVG del heatmap a PNG y lo descarga.
 * Inyecta los estilos CSS necesarios en el SVG para que se renderice correctamente
 * como imagen independiente, y dibuja la leyenda de colores debajo usando Canvas 2D.
 */
btnDownloadHeatmap.addEventListener('click', () => {
  const svgEl = heatmapContainer.querySelector('.heatmap-svg');
  if (!svgEl) return;

  // Clonar el SVG e inyectar los estilos que normalmente vienen del CSS externo
  const clone = svgEl.cloneNode(true);
  const vb = svgEl.viewBox.baseVal;
  clone.setAttribute('width', vb.width);
  clone.setAttribute('height', vb.height);

  const labelColor = getEffectiveTheme() === 'dark' ? '#8b949e' : '#8b949e';
  const styleEl = document.createElementNS('http://www.w3.org/2000/svg', 'style');
  styleEl.textContent =
    `.heatmap-label{font-size:10px;fill:${labelColor};font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif}` +
    '.heatmap-cell{shape-rendering:geometricPrecision}';
  clone.insertBefore(styleEl, clone.firstChild);

  const svgData = new XMLSerializer().serializeToString(clone);
  const svgBlob = new Blob([svgData], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(svgBlob);

  const img = new Image();
  img.onload = () => {
    const scale = 2;
    const legendPad = 8;
    const legendH = 16;
    const w = vb.width;
    const h = vb.height + legendPad + legendH;

    const canvas = document.createElement('canvas');
    canvas.width = w * scale;
    canvas.height = h * scale;
    const ctx = canvas.getContext('2d');
    ctx.scale(scale, scale);

    // Fondo según el tema activo
    ctx.fillStyle = getEffectiveTheme() === 'dark' ? '#0d1117' : '#ffffff';
    ctx.fillRect(0, 0, w, h);

    // Dibujar el SVG del heatmap
    ctx.drawImage(img, 0, 0, w, vb.height);
    URL.revokeObjectURL(url);

    // Dibujar la leyenda leyendo los elementos del DOM
    const legendEl = heatmapContainer.querySelector('.heatmap-legend');
    if (legendEl) {
      drawLegendOnCanvas(ctx, legendEl, w, vb.height + legendPad);
    }

    canvas.toBlob((blob) => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'heatmap.png';
      a.click();
      URL.revokeObjectURL(a.href);
    }, 'image/png');
  };
  img.src = url;
});

/**
 * Dibuja la leyenda del heatmap en un canvas 2D, leyendo colores y textos
 * directamente de los elementos del DOM para mantenerse sincronizado.
 *
 * @param {CanvasRenderingContext2D} ctx - Contexto del canvas.
 * @param {HTMLElement} legendEl - Elemento .heatmap-legend del DOM.
 * @param {number} canvasW - Ancho del canvas (sin escalar).
 * @param {number} y - Posición Y donde dibujar la leyenda.
 */
function drawLegendOnCanvas(ctx, legendEl, canvasW, y) {
  const font = '10px -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif';
  ctx.font = font;
  ctx.textBaseline = 'middle';
  const cellSize = 11;
  const gap = 3;
  const midY = y + cellSize / 2;

  // Recopilar los elementos de la leyenda desde el DOM
  const items = [];
  for (const child of legendEl.children) {
    if (child.classList.contains('legend-label')) {
      items.push({ type: 'label', text: child.textContent });
    } else if (child.classList.contains('legend-cell')) {
      items.push({ type: 'cell', color: child.style.background || child.style.backgroundColor });
    } else if (child.classList.contains('legend-divider')) {
      items.push({ type: 'divider' });
    }
  }

  // Calcular el ancho total para alinear a la derecha
  let totalW = 0;
  for (const it of items) {
    if (it.type === 'label') totalW += ctx.measureText(it.text).width + 6;
    else if (it.type === 'cell') totalW += cellSize + gap;
    else if (it.type === 'divider') totalW += 13;
  }

  let x = canvasW - totalW - 5;
  for (const it of items) {
    if (it.type === 'label') {
      ctx.fillStyle = getEffectiveTheme() === 'dark' ? '#8b949e' : '#8b949e';
      ctx.fillText(it.text, x, midY);
      x += ctx.measureText(it.text).width + 6;
    } else if (it.type === 'cell') {
      ctx.fillStyle = it.color;
      ctx.beginPath();
      ctx.roundRect(x, y, cellSize, cellSize, 2);
      ctx.fill();
      x += cellSize + gap;
    } else if (it.type === 'divider') {
      ctx.fillStyle = getEffectiveTheme() === 'dark' ? '#30363d' : '#d0d7de';
      ctx.fillRect(x + 6, y, 1, cellSize);
      x += 13;
    }
  }
}

// Restaurar la preferencia de visibilidad del heatmap al arrancar
if (localStorage.getItem('heatmap_collapsed') === '1') {
  applyHeatmapCollapsed(true);
}

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
    if (displayedActivities.length > 0) {
      renderFilteredActivities();
    }
  });
}
