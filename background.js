import { authenticateGitHub, authenticateGitLab, getAuthState, removeToken } from './lib/auth.js';
import { fetchGitHubContributions } from './lib/github-api.js';
import { fetchGitLabContributions } from './lib/gitlab-api.js';
import { getCached, setCache, clearCache } from './lib/cache.js';

// Message handler for popup communication
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message).then(sendResponse).catch(err => {
    sendResponse({ error: err.message });
  });
  return true; // Keep channel open for async response
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
      if (message.provider === 'gitlab') {
        await chrome.storage.local.remove('gitlab_username');
      }
      return { success: true };
    }

    case 'GET_AUTH_STATE':
      return getAuthState();

    case 'FETCH_CONTRIBUTIONS':
      return fetchContributions(message.provider, message.forceRefresh);

    case 'FETCH_ALL_CONTRIBUTIONS':
      return fetchAllContributions(message.forceRefresh);

    default:
      throw new Error(`Unknown message type: ${message.type}`);
  }
}

/**
 * Fetch contributions for a single provider, with caching.
 */
async function fetchContributions(provider, forceRefresh = false) {
  const cacheKey = `${provider}_contributions`;

  if (!forceRefresh) {
    const cached = await getCached(cacheKey);
    if (cached) return { data: cached, fromCache: true };
  }

  try {
    let data;
    if (provider === 'github') {
      data = await fetchGitHubContributions();
    } else {
      data = await fetchGitLabContributions();
    }
    await setCache(cacheKey, data);
    return { data, fromCache: false };
  } catch (err) {
    // On error, try to return stale cache
    if (err.message === 'UNAUTHORIZED') {
      await removeToken(provider);
      throw err;
    }

    const stale = await getCached(cacheKey);
    if (stale) {
      return { data: stale, fromCache: true, stale: true };
    }
    throw err;
  }
}

/**
 * Fetch contributions from all authenticated providers.
 */
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

// Periodic refresh alarm
chrome.alarms.create('refresh-contributions', { periodInMinutes: 60 });

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'refresh-contributions') {
    try {
      await fetchAllContributions(true);
    } catch {
      // Silently fail on background refresh
    }
  }
});
