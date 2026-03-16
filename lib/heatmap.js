import { getLast365Days, monthName } from './utils.js';

const CELL_SIZE = 11;
const CELL_GAP = 3;
const CELL_STEP = CELL_SIZE + CELL_GAP;
const LABEL_WIDTH = 30;
const HEADER_HEIGHT = 20;
const SVG_WIDTH = 53 * CELL_STEP + LABEL_WIDTH + 10;
const SVG_HEIGHT = 7 * CELL_STEP + HEADER_HEIGHT + 5;

// Color scales
const COLORS = {
  github: ['#ebedf0', '#9be9a8', '#40c463', '#30a14e', '#216e39'],
  gitlab: ['#ebedf0', '#c4b5fd', '#8b5cf6', '#7c3aed', '#6d28d9'],
  mixed:  ['#ebedf0', '#99f6e4', '#2dd4bf', '#14b8a6', '#0d9488'],
};

/**
 * Get intensity level (0-4) from contribution count.
 */
function getLevel(count) {
  if (count === 0) return 0;
  if (count <= 3) return 1;
  if (count <= 7) return 2;
  if (count <= 12) return 3;
  return 4;
}

/**
 * Pick the right color for a cell based on which providers contributed.
 */
function getCellColor(githubCount, gitlabCount) {
  const total = githubCount + gitlabCount;
  const level = getLevel(total);

  if (level === 0) return COLORS.github[0];

  if (githubCount > 0 && gitlabCount > 0) {
    return COLORS.mixed[level];
  } else if (gitlabCount > 0) {
    return COLORS.gitlab[level];
  }
  return COLORS.github[level];
}

/**
 * Build tooltip text for a cell.
 */
function buildTooltip(dateStr, githubCount, gitlabCount) {
  const date = new Date(dateStr + 'T00:00:00');
  const formatted = date.toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
  });

  const total = githubCount + gitlabCount;

  if (githubCount > 0 && gitlabCount > 0) {
    return `${formatted}: GitHub ${githubCount}, GitLab ${gitlabCount} (${total} total)`;
  } else if (githubCount > 0) {
    return `${formatted}: ${githubCount} contribution${githubCount !== 1 ? 's' : ''} (GitHub)`;
  } else if (gitlabCount > 0) {
    return `${formatted}: ${gitlabCount} contribution${gitlabCount !== 1 ? 's' : ''} (GitLab)`;
  }
  return `${formatted}: No contributions`;
}

/**
 * Render the heatmap SVG into a container element.
 * @param {HTMLElement} container - DOM element to render into
 * @param {object} githubData - { "YYYY-MM-DD": count } or null
 * @param {object} gitlabData - { "YYYY-MM-DD": count } or null
 */
export function renderHeatmap(container, githubData, gitlabData) {
  const github = githubData || {};
  const gitlab = gitlabData || {};
  const days = getLast365Days();

  // Build SVG
  const parts = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${SVG_WIDTH} ${SVG_HEIGHT}" class="heatmap-svg">`);

  // Day labels
  const dayLabels = [
    { label: 'Mon', row: 1 },
    { label: 'Wed', row: 3 },
    { label: 'Fri', row: 5 },
  ];
  for (const { label, row } of dayLabels) {
    const y = HEADER_HEIGHT + row * CELL_STEP + CELL_SIZE - 1;
    parts.push(`<text x="0" y="${y}" class="heatmap-label">${label}</text>`);
  }

  // Track months for header labels
  const monthPositions = new Map();
  let col = 0;
  let firstDayOfWeek = new Date(days[0] + 'T00:00:00').getDay();

  // Render cells
  for (let i = 0; i < days.length; i++) {
    const dateStr = days[i];
    const date = new Date(dateStr + 'T00:00:00');
    const dayOfWeek = date.getDay(); // 0=Sun

    // Calculate column: on Sunday, advance to next column (except first)
    if (dayOfWeek === 0 && i > 0) {
      col++;
    }

    // Track first occurrence of each month
    const monthIdx = date.getMonth();
    const monthKey = `${date.getFullYear()}-${monthIdx}`;
    if (!monthPositions.has(monthKey)) {
      monthPositions.set(monthKey, col);
    }

    const x = LABEL_WIDTH + col * CELL_STEP;
    const y = HEADER_HEIGHT + dayOfWeek * CELL_STEP;

    const ghCount = github[dateStr] || 0;
    const glCount = gitlab[dateStr] || 0;
    const color = getCellColor(ghCount, glCount);
    const tooltip = buildTooltip(dateStr, ghCount, glCount);

    parts.push(
      `<rect x="${x}" y="${y}" width="${CELL_SIZE}" height="${CELL_SIZE}" rx="2" ry="2" fill="${color}" class="heatmap-cell">` +
      `<title>${tooltip}</title></rect>`
    );
  }

  // Month labels
  for (const [monthKey, colIdx] of monthPositions) {
    const monthIdx = parseInt(monthKey.split('-')[1]);
    const x = LABEL_WIDTH + colIdx * CELL_STEP;
    parts.push(`<text x="${x}" y="12" class="heatmap-label">${monthName(monthIdx)}</text>`);
  }

  parts.push('</svg>');

  container.innerHTML = parts.join('');

  // Add legend
  renderLegend(container, github, gitlab);
}

/**
 * Render a color legend below the heatmap.
 */
function renderLegend(container, githubData, gitlabData) {
  const hasGitHub = Object.keys(githubData).length > 0;
  const hasGitLab = Object.keys(gitlabData).length > 0;

  const legend = document.createElement('div');
  legend.className = 'heatmap-legend';

  let html = '<span class="legend-label">Less</span>';

  // Show the appropriate color scale
  let scale;
  if (hasGitHub && hasGitLab) {
    scale = COLORS.mixed;
  } else if (hasGitLab) {
    scale = COLORS.gitlab;
  } else {
    scale = COLORS.github;
  }

  for (const color of scale) {
    html += `<span class="legend-cell" style="background:${color}"></span>`;
  }
  html += '<span class="legend-label">More</span>';

  // Color key for mixed mode
  if (hasGitHub && hasGitLab) {
    html += '<span class="legend-divider"></span>';
    html += `<span class="legend-cell" style="background:${COLORS.github[2]}"></span><span class="legend-label">GitHub</span>`;
    html += `<span class="legend-cell" style="background:${COLORS.gitlab[2]}"></span><span class="legend-label">GitLab</span>`;
    html += `<span class="legend-cell" style="background:${COLORS.mixed[2]}"></span><span class="legend-label">Both</span>`;
  }

  legend.innerHTML = html;
  container.appendChild(legend);
}
