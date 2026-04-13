/**
 * @fileoverview Módulo de renderizado del heatmap (mapa de calor) de contribuciones.
 *
 * Genera un gráfico SVG estilo GitHub/GitLab que muestra las contribuciones diarias
 * del último año. Soporta datos de GitHub, GitLab, o ambos simultáneamente, usando
 * esquemas de colores diferentes para cada caso:
 *   - Verde: solo GitHub
 *   - Púrpura: solo GitLab
 *   - Teal: ambos proveedores combinados
 *
 * El heatmap se compone de:
 *   - Una cuadrícula de 53 columnas (semanas) x 7 filas (días de la semana).
 *   - Etiquetas de meses en la parte superior.
 *   - Etiquetas de días (Lun, Mié, Vie) en el lateral izquierdo.
 *   - Tooltips con el detalle de contribuciones por día.
 *   - Una leyenda de colores debajo del gráfico.
 *
 * Flujo de datos:
 *   Datos de contribuciones { fecha: conteo } -> cálculo de niveles de intensidad
 *   -> generación de celdas SVG con colores y tooltips -> inserción en el DOM.
 *
 * Dependencias: utils.js (fechas y nombres de meses).
 */

import { getLast365Days } from './utils.js';
import { t, getLocale } from './i18n.js';

/** @const {number} Tamaño de cada celda del heatmap en píxeles */
const CELL_SIZE = 11;

/** @const {number} Espacio entre celdas en píxeles */
const CELL_GAP = 3;

/** @const {number} Distancia total entre inicio de una celda y la siguiente (tamaño + espacio) */
const CELL_STEP = CELL_SIZE + CELL_GAP;

/** @const {number} Ancho reservado para las etiquetas de días de la semana (izquierda) */
const LABEL_WIDTH = 30;

/** @const {number} Altura reservada para las etiquetas de meses (arriba) */
const HEADER_HEIGHT = 20;

/** @const {number} Ancho total del SVG: 53 semanas * paso + etiquetas + margen */
const SVG_WIDTH = 53 * CELL_STEP + LABEL_WIDTH + 10;

/** @const {number} Altura total del SVG: 7 días * paso + cabecera + margen */
const SVG_HEIGHT = 7 * CELL_STEP + HEADER_HEIGHT + 5;

/**
 * Escalas de colores para cada modo de visualización.
 * Cada escala tiene 5 niveles (0-4) de menor a mayor intensidad.
 * El nivel 0 siempre es gris claro (sin contribuciones).
 * @const {Object.<string, string[]>}
 */
const COLORS = {
  github: ['#ebedf0', '#9be9a8', '#40c463', '#30a14e', '#216e39'],  // Escala verde (GitHub)
  gitlab: ['#ebedf0', '#c4b5fd', '#8b5cf6', '#7c3aed', '#6d28d9'],  // Escala púrpura (GitLab)
  mixed:  ['#ebedf0', '#99f6e4', '#2dd4bf', '#14b8a6', '#0d9488'],  // Escala teal (ambos)
};

/**
 * Determina el nivel de intensidad (0-4) a partir del conteo de contribuciones.
 * Los umbrales definen cuántas contribuciones se necesitan para cada nivel:
 *   0 contribuciones = nivel 0 (vacío)
 *   1-3 = nivel 1 (bajo)
 *   4-7 = nivel 2 (medio)
 *   8-12 = nivel 3 (alto)
 *   13+ = nivel 4 (muy alto)
 *
 * @param {number} count - Número de contribuciones en un día.
 * @returns {number} Nivel de intensidad de 0 a 4.
 */
function getLevel(count) {
  if (count === 0) return 0;
  if (count <= 3) return 1;
  if (count <= 7) return 2;
  if (count <= 12) return 3;
  return 4;
}

/**
 * Retorna el color de celda vacía (nivel 0) según el tema activo.
 * En tema oscuro usa un gris oscuro, en claro usa el gris claro estándar.
 * @returns {string} Color hexadecimal CSS.
 */
function getEmptyCellColor() {
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark' ||
    (document.documentElement.getAttribute('data-theme') === null &&
     window.matchMedia('(prefers-color-scheme: dark)').matches);
  return isDark ? '#161b22' : '#ebedf0';
}

/**
 * Selecciona el color apropiado para una celda del heatmap según qué proveedores contribuyeron.
 *
 * Lógica de selección:
 * - Si no hay contribuciones (nivel 0), usa el color vacío según el tema activo.
 * - Si hay contribuciones de ambos proveedores, usa la escala "mixed" (teal).
 * - Si solo hay GitLab, usa la escala púrpura.
 * - Si solo hay GitHub (o por defecto), usa la escala verde.
 *
 * @param {number} githubCount - Contribuciones de GitHub para este día.
 * @param {number} gitlabCount - Contribuciones de GitLab para este día.
 * @returns {string} Color hexadecimal CSS para la celda.
 */
function getCellColor(githubCount, gitlabCount) {
  const total = githubCount + gitlabCount;
  const level = getLevel(total);

  // Sin contribuciones: color según el tema activo
  if (level === 0) return getEmptyCellColor();

  // Seleccionar la escala de color según los proveedores activos
  if (githubCount > 0 && gitlabCount > 0) {
    return COLORS.mixed[level];   // Ambos proveedores: teal
  } else if (gitlabCount > 0) {
    return COLORS.gitlab[level];  // Solo GitLab: púrpura
  }
  return COLORS.github[level];   // Solo GitHub: verde
}

/**
 * Construye el texto del tooltip para una celda del heatmap.
 * El tooltip se muestra al pasar el cursor sobre una celda y detalla
 * las contribuciones desglosadas por proveedor.
 *
 * @param {string} dateStr - Fecha en formato 'YYYY-MM-DD'.
 * @param {number} githubCount - Contribuciones de GitHub para este día.
 * @param {number} gitlabCount - Contribuciones de GitLab para este día.
 * @returns {string} Texto descriptivo para el tooltip.
 */
const LOCALE_MAP = { en: 'en-US', es: 'es-ES', zh: 'zh-CN' };

function buildTooltip(dateStr, githubCount, gitlabCount) {
  const date = new Date(dateStr + 'T00:00:00');
  const formatted = date.toLocaleDateString(LOCALE_MAP[getLocale()] || 'en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
  });

  const total = githubCount + gitlabCount;

  if (githubCount > 0 && gitlabCount > 0) {
    return t('heatmap.tooltipBoth', { date: formatted, ghCount: githubCount, glCount: gitlabCount, total });
  } else if (githubCount > 0) {
    const key = githubCount === 1 ? 'heatmap.tooltipGitHubOne' : 'heatmap.tooltipGitHub';
    return t(key, { date: formatted, count: githubCount });
  } else if (gitlabCount > 0) {
    const key = gitlabCount === 1 ? 'heatmap.tooltipGitLabOne' : 'heatmap.tooltipGitLab';
    return t(key, { date: formatted, count: gitlabCount });
  }
  return t('heatmap.tooltipNone', { date: formatted });
}

/**
 * Renderiza el heatmap SVG completo dentro de un elemento contenedor del DOM.
 *
 * Proceso de renderizado:
 * 1. Obtener los últimos 365 días.
 * 2. Construir el SVG como cadena de texto (más eficiente que manipulación DOM).
 * 3. Dibujar etiquetas de días de la semana (Mon, Wed, Fri).
 * 4. Dibujar cada celda con su color y tooltip según las contribuciones.
 * 5. Dibujar etiquetas de meses en la cabecera.
 * 6. Insertar el SVG en el contenedor.
 * 7. Agregar la leyenda de colores debajo.
 *
 * La disposición es: columnas = semanas (domingo inicia nueva columna),
 * filas = días de la semana (0=domingo arriba, 6=sábado abajo).
 *
 * @param {HTMLElement} container - Elemento DOM donde renderizar el heatmap.
 * @param {Object.<string, number>|null} githubData - Contribuciones de GitHub { "YYYY-MM-DD": conteo }, o null.
 * @param {Object.<string, number>|null} gitlabData - Contribuciones de GitLab { "YYYY-MM-DD": conteo }, o null.
 */
export function renderHeatmap(container, githubData, gitlabData) {
  // Usar objetos vacíos si los datos son null (proveedor no conectado)
  const github = githubData || {};
  const gitlab = gitlabData || {};
  const days = getLast365Days();

  // Construir el SVG como arreglo de cadenas para concatenar al final (eficiente)
  const parts = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${SVG_WIDTH} ${SVG_HEIGHT}" class="heatmap-svg">`);

  // Etiquetas de días de la semana (solo Mon, Wed, Fri para no saturar)
  const dayLabels = [
    { label: t('heatmap.mon'), row: 1 },
    { label: t('heatmap.wed'), row: 3 },
    { label: t('heatmap.fri'), row: 5 },
  ];
  for (const { label, row } of dayLabels) {
    const y = HEADER_HEIGHT + row * CELL_STEP + CELL_SIZE - 1;
    parts.push(`<text x="0" y="${y}" class="heatmap-label">${label}</text>`);
  }

  // Registro de posiciones de meses para dibujar las etiquetas de cabecera
  const monthPositions = new Map();
  let col = 0;
  let firstDayOfWeek = new Date(days[0] + 'T00:00:00').getDay();

  // Renderizar cada celda del heatmap
  for (let i = 0; i < days.length; i++) {
    const dateStr = days[i];
    const date = new Date(dateStr + 'T00:00:00');
    const dayOfWeek = date.getDay(); // 0=Domingo, 1=Lunes, ..., 6=Sábado

    // Cada domingo (excepto el primero) avanzamos a la siguiente columna (nueva semana)
    if (dayOfWeek === 0 && i > 0) {
      col++;
    }

    // Registrar la primera aparición de cada mes para ubicar su etiqueta
    const monthIdx = date.getMonth();
    const monthKey = `${date.getFullYear()}-${monthIdx}`;
    if (!monthPositions.has(monthKey)) {
      monthPositions.set(monthKey, col);
    }

    // Calcular la posición (x, y) de la celda en el SVG
    const x = LABEL_WIDTH + col * CELL_STEP;
    const y = HEADER_HEIGHT + dayOfWeek * CELL_STEP;

    // Obtener los conteos de contribuciones para este día
    const ghCount = github[dateStr] || 0;
    const glCount = gitlab[dateStr] || 0;
    const color = getCellColor(ghCount, glCount);
    const tooltip = buildTooltip(dateStr, ghCount, glCount);

    // Generar el elemento rect SVG con esquinas redondeadas y tooltip
    parts.push(
      `<rect x="${x}" y="${y}" width="${CELL_SIZE}" height="${CELL_SIZE}" rx="2" ry="2" fill="${color}" class="heatmap-cell">` +
      `<title>${tooltip}</title></rect>`
    );
  }

  // Dibujar las etiquetas de meses en la cabecera del SVG
  for (const [monthKey, colIdx] of monthPositions) {
    const monthIdx = parseInt(monthKey.split('-')[1]);
    const x = LABEL_WIDTH + colIdx * CELL_STEP;
    parts.push(`<text x="${x}" y="12" class="heatmap-label">${t('month.' + monthIdx)}</text>`);
  }

  parts.push('</svg>');

  // Insertar el SVG completo en el contenedor
  container.innerHTML = parts.join('');

  // Agregar la leyenda de colores debajo del heatmap
  renderLegend(container, github, gitlab);
}

/**
 * Renderiza la leyenda de colores debajo del heatmap.
 *
 * La leyenda muestra:
 * - La escala de intensidad de "Less" a "More" (5 niveles de color).
 * - Si ambos proveedores están activos, muestra adicionalmente una clave de colores
 *   indicando qué color corresponde a GitHub, GitLab, y ambos combinados.
 *
 * @param {HTMLElement} container - Elemento DOM padre donde agregar la leyenda.
 * @param {Object.<string, number>} githubData - Datos de contribuciones de GitHub.
 * @param {Object.<string, number>} gitlabData - Datos de contribuciones de GitLab.
 */
function renderLegend(container, githubData, gitlabData) {
  // Determinar qué proveedores tienen datos para seleccionar la escala correcta
  const hasGitHub = Object.keys(githubData).length > 0;
  const hasGitLab = Object.keys(gitlabData).length > 0;

  const legend = document.createElement('div');
  legend.className = 'heatmap-legend';

  let html = `<span class="legend-label">${t('heatmap.less')}</span>`;

  // Seleccionar la escala de colores según los proveedores activos
  let scale;
  if (hasGitHub && hasGitLab) {
    scale = COLORS.mixed;   // Ambos: escala teal
  } else if (hasGitLab) {
    scale = COLORS.gitlab;  // Solo GitLab: escala púrpura
  } else {
    scale = COLORS.github;  // Solo GitHub o ninguno: escala verde
  }

  // Generar las celdas de la leyenda con cada nivel de intensidad
  for (let i = 0; i < scale.length; i++) {
    const color = i === 0 ? getEmptyCellColor() : scale[i];
    html += `<span class="legend-cell" style="background:${color}"></span>`;
  }
  html += `<span class="legend-label">${t('heatmap.more')}</span>`;

  // En modo mixto, agregar una clave de colores para identificar cada proveedor
  if (hasGitHub && hasGitLab) {
    html += '<span class="legend-divider"></span>';
    html += `<span class="legend-cell" style="background:${COLORS.github[2]}"></span><span class="legend-label">${t('heatmap.github')}</span>`;
    html += `<span class="legend-cell" style="background:${COLORS.gitlab[2]}"></span><span class="legend-label">${t('heatmap.gitlab')}</span>`;
    html += `<span class="legend-cell" style="background:${COLORS.mixed[2]}"></span><span class="legend-label">${t('heatmap.both')}</span>`;
  }

  legend.innerHTML = html;
  container.appendChild(legend);
}
