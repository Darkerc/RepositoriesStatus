import { renderHeatmap } from '../lib/heatmap.js';

const btnGitHub = document.getElementById('btn-github');
const btnGitLab = document.getElementById('btn-gitlab');
const btnRefresh = document.getElementById('btn-refresh');
const btnOptions = document.getElementById('btn-options');
const heatmapContainer = document.getElementById('heatmap-container');
const statusBar = document.getElementById('status-bar');

let authState = { github: false, gitlab: false };
let githubData = null;
let gitlabData = null;

// Initialize
document.addEventListener('DOMContentLoaded', init);

async function init() {
  await refreshAuthState();
  // Load cached data immediately from storage (no service worker needed)
  await loadCachedDataFromStorage();
  // Then try to fetch fresh data via service worker
  await loadContributions();
}

/**
 * Read auth state directly from chrome.storage.local.
 * This avoids depending on the service worker being awake.
 */
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

/**
 * Load cached contribution data directly from storage for instant display.
 */
async function loadCachedDataFromStorage() {
  if (!authState.github && !authState.gitlab) return;

  try {
    const result = await chrome.storage.local.get(['github_contributions', 'gitlab_contributions']);

    const ghCache = result.github_contributions;
    const glCache = result.gitlab_contributions;

    if (ghCache?.data) githubData = ghCache.data;
    if (glCache?.data) gitlabData = glCache.data;

    if (githubData || gitlabData) {
      renderHeatmap(heatmapContainer, githubData, gitlabData);
    }
  } catch {
    // Ignore — fresh fetch will follow
  }
}

function updateButtons() {
  if (authState.github) {
    btnGitHub.textContent = 'Disconnect';
    btnGitHub.className = 'btn btn-disconnect';
  } else {
    btnGitHub.textContent = 'Connect';
    btnGitHub.className = 'btn btn-connect';
  }

  if (authState.gitlab) {
    btnGitLab.textContent = 'Disconnect';
    btnGitLab.className = 'btn btn-disconnect';
  } else {
    btnGitLab.textContent = 'Connect';
    btnGitLab.className = 'btn btn-connect';
  }

  btnRefresh.disabled = !authState.github && !authState.gitlab;
}

async function loadContributions(forceRefresh = false) {
  if (!authState.github && !authState.gitlab) {
    heatmapContainer.innerHTML = '<p class="placeholder">Connect a provider to see your contributions.</p>';
    return;
  }

  // Only show loading if we don't have cached data already displayed
  if (!githubData && !gitlabData) {
    showStatus('Loading contributions...', 'info');
  }
  btnRefresh.classList.add('spinning');

  try {
    const result = await sendMessage({
      type: 'FETCH_ALL_CONTRIBUTIONS',
      forceRefresh,
    });

    githubData = result.github?.data || githubData;
    gitlabData = result.gitlab?.data || gitlabData;

    renderHeatmap(heatmapContainer, githubData, gitlabData);

    // Show stale data warning
    if (result.github?.stale || result.gitlab?.stale) {
      showStatus('Showing cached data. Some data may be outdated.', 'warning');
    } else {
      hideStatus();
    }

    // Handle auth errors
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
    // If we already have cached data displayed, just warn instead of error
    if (githubData || gitlabData) {
      showStatus('Could not refresh data. Showing cached results.', 'warning');
    } else {
      showStatus(`Failed to load contributions: ${err.message}`, 'error');
    }
  } finally {
    btnRefresh.classList.remove('spinning');
  }
}

// GitHub connect/disconnect
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
    await loadContributions();
  } catch (err) {
    showStatus(`GitHub: ${err.message}`, 'error');
  } finally {
    btnGitHub.disabled = false;
  }
});

// GitLab connect/disconnect
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
    await loadContributions();
  } catch (err) {
    showStatus(`GitLab: ${err.message}`, 'error');
  } finally {
    btnGitLab.disabled = false;
  }
});

// Refresh
btnRefresh.addEventListener('click', () => {
  loadContributions(true);
});

// Options
btnOptions.addEventListener('click', (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

// Helpers

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
