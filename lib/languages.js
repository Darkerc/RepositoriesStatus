/**
 * @fileoverview Módulo de renderizado de la barra de lenguajes más usados.
 *
 * Combina los datos de lenguajes provenientes de GitHub y GitLab en una única
 * barra horizontal apilada, normalizada al 100% (estilo barra de lenguajes
 * de github.com en cada repo, pero agregada a través de los repos del usuario).
 *
 * Flujo de datos:
 *   { github: {languages, repoCount}, gitlab: {...} }
 *   -> agregación por nombre (case-insensitive)
 *   -> top N + "Otros"
 *   -> render barra apilada + leyenda
 *
 * Los colores se toman, en este orden:
 *   1. El color oficial provisto por GitHub (Linguist) si está disponible.
 *   2. Un mapa local de colores para lenguajes comunes (cuando solo aparece en GitLab).
 *   3. Un color derivado del nombre por hashing (último recurso).
 *
 * Dependencias: i18n.js (etiquetas).
 */

import { t } from './i18n.js';

/**
 * Cantidad máxima de lenguajes mostrados en la leyenda. El resto se agrupa en "Otros".
 * @const {number}
 */
const MAX_VISIBLE = 8;

/**
 * Mapa de colores de respaldo para lenguajes comunes que no aparecen en GitHub
 * (o cuando GitLab los reporta y GitHub no). Tomados de github-linguist's
 * `languages.yml` (colores oficiales).
 * @const {Object.<string, string>}
 */
const FALLBACK_COLORS = {
  javascript: '#f1e05a',
  typescript: '#3178c6',
  python: '#3572A5',
  java: '#b07219',
  go: '#00ADD8',
  rust: '#dea584',
  ruby: '#701516',
  php: '#4F5D95',
  'c++': '#f34b7d',
  c: '#555555',
  'c#': '#178600',
  kotlin: '#A97BFF',
  swift: '#F05138',
  dart: '#00B4AB',
  scala: '#c22d40',
  shell: '#89e051',
  bash: '#89e051',
  html: '#e34c26',
  css: '#563d7c',
  scss: '#c6538c',
  sass: '#a53b70',
  less: '#1d365d',
  vue: '#41b883',
  svelte: '#ff3e00',
  elixir: '#6e4a7e',
  erlang: '#B83998',
  haskell: '#5e5086',
  lua: '#000080',
  perl: '#0298c3',
  r: '#198CE7',
  matlab: '#e16737',
  objectivec: '#438eff',
  'objective-c': '#438eff',
  groovy: '#4298b8',
  clojure: '#db5855',
  ocaml: '#3be133',
  fsharp: '#b845fc',
  'f#': '#b845fc',
  vimscript: '#199f4b',
  'vim script': '#199f4b',
  powershell: '#012456',
  dockerfile: '#384d54',
  makefile: '#427819',
  cmake: '#DA3434',
  yaml: '#cb171e',
  json: '#292929',
  toml: '#9c4221',
  xml: '#0060ac',
  markdown: '#083fa1',
  sql: '#e38c00',
  plsql: '#dad8d8',
  graphql: '#e10098',
  jupyter: '#DA5B0B',
  'jupyter notebook': '#DA5B0B',
  tex: '#3D6117',
  latex: '#3D6117',
  zig: '#ec915c',
  nim: '#ffc200',
  crystal: '#000100',
  julia: '#a270ba',
  solidity: '#AA6746',
  hcl: '#844FBA',
  terraform: '#844FBA',
  assembly: '#6E4C13',
  fortran: '#4d41b1',
  cobol: '#005ca5',
};

/**
 * Genera un color hexadecimal determinístico a partir del nombre de un lenguaje.
 * Se usa como último recurso cuando no tenemos un color oficial ni en el fallback.
 *
 * @param {string} name - Nombre del lenguaje.
 * @returns {string} Color hex en formato '#RRGGBB'.
 */
function colorFromName(name) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = ((hash << 5) - hash + name.charCodeAt(i)) | 0;
  }
  // Generar un color con suficiente saturación. Componentes en rangos seguros
  // para que no salgan colores muy claros / muy oscuros.
  const h = Math.abs(hash) % 360;
  return hslToHex(h, 65, 45);
}

/**
 * Convierte HSL a hex (utilidad local para colorFromName).
 * @param {number} h
 * @param {number} s
 * @param {number} l
 */
function hslToHex(h, s, l) {
  s /= 100;
  l /= 100;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => {
    const k = (n + h / 30) % 12;
    const color = l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);
    return Math.round(255 * color).toString(16).padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

/**
 * Resuelve el color final para un lenguaje aplicando los fallbacks.
 *
 * @param {string} name - Nombre del lenguaje.
 * @param {string|null} explicitColor - Color provisto por la API (GitHub) o null.
 * @returns {string} Color hex en formato '#RRGGBB'.
 */
function resolveColor(name, explicitColor) {
  if (explicitColor && /^#[0-9a-fA-F]{6}$/.test(explicitColor)) return explicitColor;
  const fallback = FALLBACK_COLORS[name.toLowerCase()];
  if (fallback) return fallback;
  return colorFromName(name);
}

/**
 * Combina los lenguajes de GitHub y GitLab en un único agregado y los normaliza
 * a porcentajes que suman 100. Los lenguajes se agregan por nombre normalizado
 * (case-insensitive), conservando la capitalización de la primera aparición.
 *
 * @param {Object|null} githubData - { languages, repoCount } de GitHub.
 * @param {Object|null} gitlabData - { languages, repoCount } de GitLab.
 * @returns {{
 *   visible: Array<{name: string, percent: number, bytes: number, color: string}>,
 *   others: {percent: number, bytes: number, count: number}|null,
 *   totalBytes: number,
 *   totalLangs: number
 * }}
 */
export function aggregateLanguages(githubData, gitlabData) {
  const merged = new Map(); // key (lowercase) -> { displayName, bytes, color }

  const ingest = (data) => {
    if (!data || !data.languages) return;
    for (const [name, info] of Object.entries(data.languages)) {
      const key = name.toLowerCase();
      const bytes = Number(info?.bytes) || 0;
      if (bytes <= 0) continue;
      const existing = merged.get(key);
      if (existing) {
        existing.bytes += bytes;
        // Si llega un color oficial (GitHub) y no teníamos uno fiable, fijarlo.
        if (!existing.color && info?.color) existing.color = info.color;
      } else {
        merged.set(key, {
          displayName: name,
          bytes,
          color: info?.color || null,
        });
      }
    }
  };

  ingest(githubData);
  ingest(gitlabData);

  // Convertir a array y ordenar descendente por bytes
  const sorted = [...merged.values()].sort((a, b) => b.bytes - a.bytes);
  const totalBytes = sorted.reduce((sum, x) => sum + x.bytes, 0);
  const totalLangs = sorted.length;

  if (totalBytes <= 0) {
    return { visible: [], others: null, totalBytes: 0, totalLangs: 0 };
  }

  const visibleArr = sorted.slice(0, MAX_VISIBLE).map(item => ({
    name: item.displayName,
    bytes: item.bytes,
    percent: (item.bytes / totalBytes) * 100,
    color: resolveColor(item.displayName, item.color),
  }));

  const rest = sorted.slice(MAX_VISIBLE);
  const others = rest.length > 0
    ? {
        bytes: rest.reduce((s, x) => s + x.bytes, 0),
        percent: (rest.reduce((s, x) => s + x.bytes, 0) / totalBytes) * 100,
        count: rest.length,
      }
    : null;

  return { visible: visibleArr, others, totalBytes, totalLangs };
}

/**
 * Renderiza la barra apilada de lenguajes y su leyenda dentro del contenedor dado.
 *
 * @param {HTMLElement} container - Elemento donde renderizar.
 * @param {Object|null} githubData - { languages, repoCount } o null si no aplica.
 * @param {Object|null} gitlabData - idem para GitLab.
 * @param {{loading?: boolean, error?: string|null}} [opts]
 *   - loading: muestra placeholder de carga si no hay datos.
 *   - error: muestra mensaje de error si fue provisto.
 */
export function renderLanguages(container, githubData, gitlabData, opts = {}) {
  const { loading = false, error = null } = opts;

  if (error) {
    container.innerHTML = `<p class="languages-placeholder error">${escapeHtml(error)}</p>`;
    return;
  }

  const agg = aggregateLanguages(githubData, gitlabData);

  if (agg.totalBytes === 0) {
    const msgKey = loading ? 'languages.loading' : 'languages.empty';
    container.innerHTML = `<p class="languages-placeholder">${t(msgKey)}</p>`;
    return;
  }

  // Cabecera con conteo total de lenguajes y bytes (humanizado).
  const headerHtml = `
    <div class="languages-header">
      <span class="languages-title">${t('languages.title')}</span>
      <span class="languages-stats">
        <span>${t('languages.totalLangs', { count: agg.totalLangs })}</span>
        <span class="languages-stats-sep">·</span>
        <span>${t('languages.totalBytes', { size: humanBytes(agg.totalBytes) })}</span>
      </span>
    </div>`;

  // Barra apilada: cada segmento ancho proporcional al porcentaje.
  let barHtml = '<div class="languages-bar" role="img" aria-label="' +
    escapeHtml(t('languages.title')) + '">';
  for (const lang of agg.visible) {
    const w = Math.max(lang.percent, 0.5); // mínimo visible
    barHtml += `<span class="languages-segment"
        style="width:${w}%;background:${lang.color}"
        title="${escapeHtml(lang.name)} ${lang.percent.toFixed(1)}%"></span>`;
  }
  if (agg.others) {
    const w = Math.max(agg.others.percent, 0.5);
    barHtml += `<span class="languages-segment languages-segment-other"
        style="width:${w}%"
        title="${escapeHtml(t('languages.othersTitle', { count: agg.others.count }))} ${agg.others.percent.toFixed(1)}%"></span>`;
  }
  barHtml += '</div>';

  // Leyenda: pill por lenguaje con dot del color y porcentaje.
  let legendHtml = '<ul class="languages-legend">';
  for (const lang of agg.visible) {
    legendHtml += `
      <li class="languages-legend-item" title="${escapeHtml(lang.name)} (${humanBytes(lang.bytes)})">
        <span class="languages-dot" style="background:${lang.color}"></span>
        <span class="languages-name">${escapeHtml(lang.name)}</span>
        <span class="languages-percent">${lang.percent.toFixed(1)}%</span>
      </li>`;
  }
  if (agg.others) {
    legendHtml += `
      <li class="languages-legend-item languages-legend-other"
          title="${escapeHtml(t('languages.othersTitle', { count: agg.others.count }))} (${humanBytes(agg.others.bytes)})">
        <span class="languages-dot languages-dot-other"></span>
        <span class="languages-name">${escapeHtml(t('languages.others'))}</span>
        <span class="languages-percent">${agg.others.percent.toFixed(1)}%</span>
      </li>`;
  }
  legendHtml += '</ul>';

  container.innerHTML = headerHtml + barHtml + legendHtml;
}

/**
 * Convierte un tamaño en bytes a una representación humanizada (KB/MB/GB).
 * @param {number} bytes
 * @returns {string}
 */
function humanBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let idx = 0;
  let n = bytes;
  while (n >= 1024 && idx < units.length - 1) {
    n /= 1024;
    idx++;
  }
  return `${n.toFixed(n < 10 && idx > 0 ? 1 : 0)} ${units[idx]}`;
}

/**
 * Escapa HTML para evitar inyección. Local para no acoplar este módulo al popup.
 * @param {string} str
 * @returns {string}
 */
function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
