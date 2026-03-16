import { authenticateGitHub, authenticateGitLab, getAuthState, removeToken } from './lib/auth.js';
import { fetchGitHubContributions, fetchGitHubActivity, fetchGitHubCommitDetail } from './lib/github-api.js';
import { fetchGitLabContributions, fetchGitLabActivity, fetchGitLabCommitDetail } from './lib/gitlab-api.js';
import { getCached, setCache, clearCache } from './lib/cache.js';

// Message handler for popup communication
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message).then(sendResponse).catch(err => {
    sendResponse({ error: err.message });
  });
  return true;
});

async function handleMessage(message) {
  switch (message.type) {
    case 'AUTH_GITHUB':
      await authenticateGitHub();
      return { success: true };

    case 'AUTH_GITLAB': {
      const baseUrl = message.baseUrl || 'https://gitlab.com';
      await authenticateGitLab(baseUrl);
      return { success: true };
    }

    case 'DISCONNECT': {
      await removeToken(message.provider);
      await clearCache(`${message.provider}_contributions`);
      await clearCache(`${message.provider}_activity`);
      if (message.provider === 'gitlab') {
        await chrome.storage.local.remove(['gitlab_username', 'gitlab_projects']);
      }
      if (message.provider === 'github') {
        await chrome.storage.local.remove('github_username');
      }
      return { success: true };
    }

    case 'GET_AUTH_STATE':
      return getAuthState();

    case 'FETCH_CONTRIBUTIONS':
      return fetchContributions(message.provider, message.forceRefresh);

    case 'FETCH_ALL_CONTRIBUTIONS':
      return fetchAllContributions(message.forceRefresh);

    case 'FETCH_ALL_ACTIVITY':
      return fetchAllActivity(message.forceRefresh);

    case 'FETCH_COMMIT_DETAIL':
      return fetchCommitDetail(message.provider, message.repo, message.sha, message.projectId);

    default:
      throw new Error(`Unknown message type: ${message.type}`);
  }
}

async function fetchContributions(provider, forceRefresh = false) {
  const cacheKey = `${provider}_contributions`;

  if (!forceRefresh) {
    const cached = await getCached(cacheKey);
    if (cached) return { data: cached, fromCache: true };
  }

  try {
    const data = provider === 'github'
      ? await fetchGitHubContributions()
      : await fetchGitLabContributions();
    await setCache(cacheKey, data);
    return { data, fromCache: false };
  } catch (err) {
    if (err.message === 'UNAUTHORIZED') {
      await removeToken(provider);
      throw err;
    }
    const stale = await getCached(cacheKey);
    if (stale) return { data: stale, fromCache: true, stale: true };
    throw err;
  }
}

async function fetchAllContributions(forceRefresh = false) {
  const authState = await getAuthState();
  const result = { github: null, gitlab: null };
  const promises = [];

  if (authState.github) {
    promises.push(
      fetchContributions('github', forceRefresh)
        .then(r => { result.github = r; })
        .catch(err => { result.githubError = err.message; })
    );
  }
  if (authState.gitlab) {
    promises.push(
      fetchContributions('gitlab', forceRefresh)
        .then(r => { result.gitlab = r; })
        .catch(err => { result.gitlabError = err.message; })
    );
  }

  await Promise.all(promises);
  return result;
}

async function fetchActivity(provider, forceRefresh = false) {
  const cacheKey = `${provider}_activity`;

  if (!forceRefresh) {
    const cached = await getCached(cacheKey);
    if (cached) return { data: cached, fromCache: true };
  }

  try {
    const data = provider === 'github'
      ? await fetchGitHubActivity()
      : await fetchGitLabActivity();
    await setCache(cacheKey, data);
    return { data, fromCache: false };
  } catch (err) {
    if (err.message === 'UNAUTHORIZED') {
      await removeToken(provider);
      throw err;
    }
    const stale = await getCached(cacheKey);
    if (stale) return { data: stale, fromCache: true, stale: true };
    throw err;
  }
}

async function fetchAllActivity(forceRefresh = false) {
  const authState = await getAuthState();
  const result = { github: null, gitlab: null };
  const promises = [];

  if (authState.github) {
    promises.push(
      fetchActivity('github', forceRefresh)
        .then(r => { result.github = r; })
        .catch(err => { result.githubError = err.message; })
    );
  }
  if (authState.gitlab) {
    promises.push(
      fetchActivity('gitlab', forceRefresh)
        .then(r => { result.gitlab = r; })
        .catch(err => { result.gitlabError = err.message; })
    );
  }

  await Promise.all(promises);
  return result;
}

async function fetchCommitDetail(provider, repo, sha, projectId) {
  if (provider === 'github') {
    return fetchGitHubCommitDetail(repo, sha);
  }
  return fetchGitLabCommitDetail(projectId, sha);
}

// Periodic refresh
chrome.alarms.create('refresh-contributions', { periodInMinutes: 60 });

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'refresh-contributions') {
    try {
      await fetchAllContributions(true);
      await fetchAllActivity(true);
    } catch { /* silent */ }
  }
});
