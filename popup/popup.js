import { renderHeatmap } from '../lib/heatmap.js';

const btnGitHub = document.getElementById('btn-github');
const btnGitLab = document.getElementById('btn-gitlab');
const btnRefresh = document.getElementById('btn-refresh');
const btnOptions = document.getElementById('btn-options');
const btnBack = document.getElementById('btn-back');
const heatmapContainer = document.getElementById('heatmap-container');
const statusBar = document.getElementById('status-bar');
const activitySection = document.getElementById('activity-section');
const activityFeed = document.getElementById('activity-feed');
const activityList = document.getElementById('activity-list');
const activityDetail = document.getElementById('activity-detail');
const detailType = document.getElementById('detail-type');
const detailBody = document.getElementById('detail-body');

let authState = { github: false, gitlab: false };
let githubData = null;
let gitlabData = null;
let allActivities = [];

// ── Init ──
document.addEventListener('DOMContentLoaded', init);

async function init() {
  await refreshAuthState();
  await loadCachedDataFromStorage();

  // Load fresh data (contributions + activity in parallel)
  await Promise.all([
    loadContributions(),
    loadActivity(),
  ]);
}

// ── Auth state ──
async function refreshAuthState() {
  try {
    const result = await chrome.storage.local.get(['github_token', 'gitlab_token']);
    authState = {
      github: !!result.github_token,
      gitlab: !!result.gitlab_token,
    };
  } catch {
    authState = { github: false, gitlab: false };
  }
  updateButtons();
}

function updateButtons() {
  // GitHub button
  if (authState.github) {
    btnGitHub.className = 'provider-btn connected github-connected';
    btnGitHub.title = 'Disconnect GitHub';
    btnGitHub.querySelector('.provider-label').textContent = 'GitHub';
  } else {
    btnGitHub.className = 'provider-btn';
    btnGitHub.title = 'Connect GitHub';
    btnGitHub.querySelector('.provider-label').textContent = 'GitHub';
  }

  // GitLab button
  if (authState.gitlab) {
    btnGitLab.className = 'provider-btn connected gitlab-connected';
    btnGitLab.title = 'Disconnect GitLab';
    btnGitLab.querySelector('.provider-label').textContent = 'GitLab';
  } else {
    btnGitLab.className = 'provider-btn';
    btnGitLab.title = 'Connect GitLab';
    btnGitLab.querySelector('.provider-label').textContent = 'GitLab';
  }

  btnRefresh.disabled = !authState.github && !authState.gitlab;

  // Show/hide activity section
  activitySection.style.display = (authState.github || authState.gitlab) ? '' : 'none';
}

// ── Cached data ──
async function loadCachedDataFromStorage() {
  if (!authState.github && !authState.gitlab) return;

  try {
    const result = await chrome.storage.local.get([
      'github_contributions', 'gitlab_contributions',
      'github_activity', 'gitlab_activity',
    ]);

    if (result.github_contributions?.data) githubData = result.github_contributions.data;
    if (result.gitlab_contributions?.data) gitlabData = result.gitlab_contributions.data;

    if (githubData || gitlabData) {
      renderHeatmap(heatmapContainer, githubData, gitlabData);
    }

    // Load cached activity
    const ghActivity = result.github_activity?.data || [];
    const glActivity = result.gitlab_activity?.data || [];
    allActivities = mergeAndSortActivities(ghActivity, glActivity);
    if (allActivities.length > 0) {
      renderActivityList(allActivities);
    }
  } catch { /* ignore */ }
}

// ── Contributions ──
async function loadContributions(forceRefresh = false) {
  if (!authState.github && !authState.gitlab) {
    heatmapContainer.innerHTML = '<p class="placeholder">Connect a provider to see your contributions.</p>';
    return;
  }

  if (!githubData && !gitlabData) {
    showStatus('Loading contributions...', 'info');
  }
  btnRefresh.classList.add('spinning');

  try {
    const result = await sendMessage({ type: 'FETCH_ALL_CONTRIBUTIONS', forceRefresh });

    githubData = result.github?.data || githubData;
    gitlabData = result.gitlab?.data || gitlabData;
    renderHeatmap(heatmapContainer, githubData, gitlabData);

    if (result.github?.stale || result.gitlab?.stale) {
      showStatus('Showing cached data. Some data may be outdated.', 'warning');
    } else {
      hideStatus();
    }

    if (result.githubError === 'UNAUTHORIZED') {
      authState.github = false;
      updateButtons();
      showStatus('GitHub session expired. Please reconnect.', 'warning');
    }
    if (result.gitlabError === 'UNAUTHORIZED') {
      authState.gitlab = false;
      updateButtons();
      showStatus('GitLab session expired. Please reconnect.', 'warning');
    }
  } catch (err) {
    if (githubData || gitlabData) {
      showStatus('Could not refresh data. Showing cached results.', 'warning');
    } else {
      showStatus(`Failed to load contributions: ${err.message}`, 'error');
    }
  } finally {
    btnRefresh.classList.remove('spinning');
  }
}

// ── Activity Feed ──
async function loadActivity(forceRefresh = false) {
  if (!authState.github && !authState.gitlab) return;

  try {
    const result = await sendMessage({ type: 'FETCH_ALL_ACTIVITY', forceRefresh });

    const ghActivity = result.github?.data || [];
    const glActivity = result.gitlab?.data || [];
    allActivities = mergeAndSortActivities(ghActivity, glActivity);
    renderActivityList(allActivities);
  } catch {
    if (allActivities.length === 0) {
      activityList.innerHTML = '<div class="activity-empty">Could not load activity.</div>';
    }
  }
}

function mergeAndSortActivities(ghItems, glItems) {
  return [...ghItems, ...glItems]
    .sort((a, b) => new Date(b.date) - new Date(a.date))
    .slice(0, 30);
}

function renderActivityList(items) {
  if (items.length === 0) {
    activityList.innerHTML = '<div class="activity-empty">No recent activity.</div>';
    return;
  }

  activityList.innerHTML = items.map((item, idx) => `
    <div class="activity-item type-${item.type}" data-index="${idx}">
      <div class="activity-type-icon ${item.type}">${getTypeIcon(item.type)}</div>
      <div class="activity-content">
        <div class="activity-repo">${escapeHtml(item.repo)}</div>
        <div class="activity-title">${escapeHtml(item.title)}</div>
        <div class="activity-meta">
          <span class="activity-type-label">${getTypeLabel(item.type)}</span>
          <span class="activity-date">${timeAgo(item.date)}</span>
        </div>
      </div>
      <span class="activity-provider-badge ${item.provider}">${item.provider === 'github' ? 'GH' : 'GL'}</span>
    </div>
  `).join('');

  // Click handlers
  activityList.querySelectorAll('.activity-item').forEach(el => {
    el.addEventListener('click', () => {
      const idx = parseInt(el.dataset.index);
      showDetail(allActivities[idx]);
    });
  });
}

// ── Detail Panel ──
async function showDetail(item) {
  activityFeed.classList.add('hidden');
  activityDetail.classList.remove('hidden');

  detailType.textContent = getTypeLabel(item.type);
  detailType.className = `detail-type-badge ${item.type}`;

  if (item.type === 'commit') {
    await showCommitDetail(item);
  } else {
    showGenericDetail(item);
  }
}

async function showCommitDetail(item) {
  const commits = item.commits || [];
  const firstCommit = commits[0];

  let html = `
    <div class="detail-repo">${escapeHtml(item.repo)}</div>
    <div class="detail-title">${escapeHtml(item.title)}</div>
    <div class="detail-date">${formatDate(item.date)}</div>
  `;

  if (firstCommit?.sha) {
    html += `<div class="detail-sha">${firstCommit.sha.substring(0, 7)}</div>`;
  }

  // Show all commits if multiple in push
  if (commits.length > 1) {
    html += '<div class="detail-message">';
    for (const c of commits) {
      html += `${escapeHtml(c.sha?.substring(0, 7) || '')} ${escapeHtml(c.message?.split('\n')[0] || '')}\n`;
    }
    html += '</div>';
  }

  html += '<div class="detail-loading">Loading file details...</div>';
  detailBody.innerHTML = html;

  // Fetch commit details (files)
  try {
    const detail = await sendMessage({
      type: 'FETCH_COMMIT_DETAIL',
      provider: item.provider,
      repo: item.repo,
      sha: firstCommit?.sha,
      projectId: item.projectId,
    });

    // Replace loading with full message + files
    let fullHtml = `
      <div class="detail-repo">${escapeHtml(item.repo)}</div>
      <div class="detail-title">${escapeHtml(detail.message?.split('\n')[0] || item.title)}</div>
      <div class="detail-date">${formatDate(detail.date || item.date)}</div>
      <div class="detail-sha">${detail.sha?.substring(0, 7) || ''}</div>
    `;

    // Full commit message
    if (detail.message && detail.message.includes('\n')) {
      fullHtml += `<div class="detail-message">${escapeHtml(detail.message)}</div>`;
    }

    if (detail.url) {
      fullHtml += `<a class="detail-link" href="${detail.url}" target="_blank">View on ${item.provider === 'github' ? 'GitHub' : 'GitLab'} &rarr;</a>`;
    }

    // Files
    if (detail.files && detail.files.length > 0) {
      fullHtml += `<div class="detail-files-header">Files changed (${detail.files.length})</div>`;
      fullHtml += '<ul class="detail-files">';
      for (const f of detail.files) {
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
    // Remove loading indicator, keep basic info
    const loadingEl = detailBody.querySelector('.detail-loading');
    if (loadingEl) loadingEl.textContent = 'Could not load file details.';
  }
}

function showGenericDetail(item) {
  let html = `
    <div class="detail-repo">${escapeHtml(item.repo)}</div>
    <div class="detail-title">${escapeHtml(item.title)}</div>
    <div class="detail-date">${formatDate(item.date)}</div>
  `;

  if (item.action) {
    html += `<div class="detail-action">Action: ${escapeHtml(item.action)}</div>`;
  }

  if (item.state) {
    html += `<span class="detail-state ${item.state}">${item.state}</span>`;
  }

  if (item.number) {
    html += `<div class="detail-sha">#${item.number}</div>`;
  }

  if (item.description) {
    html += `<div class="detail-description">${escapeHtml(item.description)}</div>`;
  }

  if (item.url) {
    html += `<a class="detail-link" href="${item.url}" target="_blank">View on ${item.provider === 'github' ? 'GitHub' : 'GitLab'} &rarr;</a>`;
  }

  detailBody.innerHTML = html;
}

function hideDetail() {
  activityDetail.classList.add('hidden');
  activityFeed.classList.remove('hidden');
}

// ── Event Listeners ──

btnGitHub.addEventListener('click', async () => {
  btnGitHub.disabled = true;
  try {
    if (authState.github) {
      await sendMessage({ type: 'DISCONNECT', provider: 'github' });
      githubData = null;
    } else {
      await sendMessage({ type: 'AUTH_GITHUB' });
    }
    await refreshAuthState();
    await Promise.all([loadContributions(), loadActivity()]);
  } catch (err) {
    showStatus(`GitHub: ${err.message}`, 'error');
  } finally {
    btnGitHub.disabled = false;
  }
});

btnGitLab.addEventListener('click', async () => {
  btnGitLab.disabled = true;
  try {
    if (authState.gitlab) {
      await sendMessage({ type: 'DISCONNECT', provider: 'gitlab' });
      gitlabData = null;
    } else {
      const stored = await chrome.storage.sync.get('gitlab_base_url');
      const baseUrl = stored.gitlab_base_url || 'https://gitlab.com';
      await sendMessage({ type: 'AUTH_GITLAB', baseUrl });
    }
    await refreshAuthState();
    await Promise.all([loadContributions(), loadActivity()]);
  } catch (err) {
    showStatus(`GitLab: ${err.message}`, 'error');
  } finally {
    btnGitLab.disabled = false;
  }
});

btnRefresh.addEventListener('click', () => {
  Promise.all([loadContributions(true), loadActivity(true)]);
});

btnOptions.addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});

btnBack.addEventListener('click', hideDetail);

// ── Helpers ──

function sendMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (response?.error) {
        reject(new Error(response.error));
        return;
      }
      resolve(response);
    });
  });
}

function showStatus(text, type = 'info') {
  statusBar.textContent = text;
  statusBar.className = `status-bar ${type}`;
}

function hideStatus() {
  statusBar.className = 'status-bar hidden';
}

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function getTypeIcon(type) {
  const icons = {
    commit: 'C',
    pull_request: 'PR',
    merge_request: 'MR',
    issue: 'I',
    comment: '&#x1f4ac;',
    review: 'R',
    branch: 'B',
    tag: 'T',
    fork: 'F',
    star: '&#x2605;',
    other: '?',
  };
  return icons[type] || '?';
}

function getTypeLabel(type) {
  const labels = {
    commit: 'Commit',
    pull_request: 'Pull Request',
    merge_request: 'Merge Request',
    issue: 'Issue',
    comment: 'Comment',
    review: 'Review',
    branch: 'Branch',
    tag: 'Tag',
    fork: 'Fork',
    star: 'Star',
    other: 'Activity',
  };
  return labels[type] || type;
}

function timeAgo(dateStr) {
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diff = now - then;

  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;

  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;

  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}

function formatDate(dateStr) {
  return new Date(dateStr).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}
