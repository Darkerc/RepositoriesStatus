import { getToken } from './auth.js';

/**
 * Get the GitLab base URL from options (defaults to gitlab.com).
 */
async function getGitLabBaseUrl() {
  const result = await chrome.storage.sync.get('gitlab_base_url');
  return result.gitlab_base_url || 'https://gitlab.com';
}

/**
 * Fetch the current GitLab user's username.
 */
async function fetchGitLabUsername(baseUrl, token) {
  const response = await fetch(`${baseUrl}/api/v4/user`, {
    headers: { 'Authorization': `Bearer ${token}` },
  });

  if (response.status === 401) throw new Error('UNAUTHORIZED');
  if (!response.ok) throw new Error(`GitLab user API error: ${response.status}`);

  const user = await response.json();

  // Cache the username so we don't need to refetch
  await chrome.storage.local.set({ gitlab_username: user.username });
  return user.username;
}

/**
 * Fetch GitLab contribution data for the past year.
 * Returns normalized { "YYYY-MM-DD": count } object.
 */
export async function fetchGitLabContributions() {
  const token = await getToken('gitlab');
  if (!token) throw new Error('Not authenticated with GitLab');

  const baseUrl = await getGitLabBaseUrl();

  // Get username (try cache first)
  const cached = await chrome.storage.local.get('gitlab_username');
  const username = cached.gitlab_username || await fetchGitLabUsername(baseUrl, token);

  const response = await fetch(
    `${baseUrl}/users/${encodeURIComponent(username)}/calendar.json`,
    {
      headers: { 'Authorization': `Bearer ${token}` },
    }
  );

  if (response.status === 401) throw new Error('UNAUTHORIZED');

  if (!response.ok) {
    if (response.status === 429) {
      throw new Error('RATE_LIMITED');
    }
    throw new Error(`GitLab calendar API error: ${response.status}`);
  }

  // GitLab calendar.json already returns { "YYYY-MM-DD": count }
  return response.json();
}
