import { getToken } from './auth.js';

/**
 * Get the GitLab base URL from options (defaults to gitlab.com).
 */
async function getGitLabBaseUrl() {
  const result = await chrome.storage.sync.get('gitlab_base_url');
  return result.gitlab_base_url || 'https://gitlab.com';
}

/**
 * Fetch the current GitLab user's username (cached).
 */
async function fetchGitLabUsername(baseUrl, token) {
  const cached = await chrome.storage.local.get('gitlab_username');
  if (cached.gitlab_username) return cached.gitlab_username;

  const response = await fetch(`${baseUrl}/api/v4/user`, {
    headers: { 'Authorization': `Bearer ${token}` },
  });

  if (response.status === 401) throw new Error('UNAUTHORIZED');
  if (!response.ok) throw new Error(`GitLab user API error: ${response.status}`);

  const user = await response.json();
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
  const username = await fetchGitLabUsername(baseUrl, token);

  const response = await fetch(
    `${baseUrl}/users/${encodeURIComponent(username)}/calendar.json`,
    { headers: { 'Authorization': `Bearer ${token}` } }
  );

  if (response.status === 401) throw new Error('UNAUTHORIZED');
  if (!response.ok) {
    if (response.status === 429) throw new Error('RATE_LIMITED');
    throw new Error(`GitLab calendar API error: ${response.status}`);
  }

  return response.json();
}

/**
 * Fetch recent GitLab activity events.
 * Returns normalized array of activity items.
 */
export async function fetchGitLabActivity() {
  const token = await getToken('gitlab');
  if (!token) throw new Error('Not authenticated with GitLab');

  const baseUrl = await getGitLabBaseUrl();

  const response = await fetch(
    `${baseUrl}/api/v4/events?per_page=30`,
    { headers: { 'Authorization': `Bearer ${token}` } }
  );

  if (response.status === 401) throw new Error('UNAUTHORIZED');
  if (!response.ok) throw new Error(`GitLab events API error: ${response.status}`);

  const events = await response.json();

  // We need project info for repo names — fetch in parallel
  const projectIds = [...new Set(events.map(e => e.project_id).filter(Boolean))];
  const projectMap = await fetchProjectNames(baseUrl, token, projectIds);

  return normalizeGitLabEvents(events, projectMap, baseUrl);
}

/**
 * Fetch project names for a list of project IDs.
 */
async function fetchProjectNames(baseUrl, token, projectIds) {
  const map = {};
  const cached = await chrome.storage.local.get('gitlab_projects');
  const cachedProjects = cached.gitlab_projects || {};

  const toFetch = projectIds.filter(id => !cachedProjects[id]);

  // Fetch missing projects (max 10 to avoid rate limits)
  const promises = toFetch.slice(0, 10).map(async (id) => {
    try {
      const resp = await fetch(`${baseUrl}/api/v4/projects/${id}?simple=true`, {
        headers: { 'Authorization': `Bearer ${token}` },
      });
      if (resp.ok) {
        const proj = await resp.json();
        cachedProjects[id] = proj.path_with_namespace;
      }
    } catch { /* ignore */ }
  });

  await Promise.all(promises);
  await chrome.storage.local.set({ gitlab_projects: cachedProjects });

  for (const id of projectIds) {
    map[id] = cachedProjects[id] || `project/${id}`;
  }
  return map;
}

function normalizeGitLabEvents(events, projectMap, baseUrl) {
  const items = [];
  for (const event of events) {
    const repo = projectMap[event.project_id] || `project/${event.project_id}`;
    const base = {
      id: `gl-${event.id}`,
      provider: 'gitlab',
      repo,
      date: event.created_at,
    };

    const action = event.action_name;

    if (event.push_data) {
      items.push({
        ...base,
        type: 'commit',
        title: event.push_data.commit_title || 'Push',
        commits: [{
          sha: event.push_data.commit_to,
          message: event.push_data.commit_title || '',
        }],
        projectId: event.project_id,
      });
    } else if (event.target_type === 'MergeRequest') {
      items.push({
        ...base,
        type: 'merge_request',
        title: event.target_title || 'Merge Request',
        action,
        number: event.target_iid,
        url: `${baseUrl}/${repo}/-/merge_requests/${event.target_iid}`,
        description: '',
      });
    } else if (event.target_type === 'Issue') {
      items.push({
        ...base,
        type: 'issue',
        title: event.target_title || 'Issue',
        action,
        number: event.target_iid,
        url: `${baseUrl}/${repo}/-/issues/${event.target_iid}`,
        description: '',
      });
    } else if (event.target_type === 'Note' || event.target_type === 'DiffNote') {
      items.push({
        ...base,
        type: 'comment',
        title: `Comment on: ${event.target_title || 'item'}`,
        description: event.note?.body?.substring(0, 300) || '',
      });
    } else if (action === 'joined' || action === 'left') {
      items.push({
        ...base,
        type: 'other',
        title: `${action} ${repo}`,
      });
    } else {
      items.push({
        ...base,
        type: 'other',
        title: `${action || 'Activity'} on ${event.target_type || 'project'}`,
      });
    }
  }
  return items;
}

/**
 * Fetch GitLab commit details including diff.
 */
export async function fetchGitLabCommitDetail(projectId, sha) {
  const token = await getToken('gitlab');
  if (!token) throw new Error('Not authenticated with GitLab');

  const baseUrl = await getGitLabBaseUrl();

  // Fetch commit info and diff in parallel
  const [commitResp, diffResp] = await Promise.all([
    fetch(`${baseUrl}/api/v4/projects/${projectId}/repository/commits/${sha}`, {
      headers: { 'Authorization': `Bearer ${token}` },
    }),
    fetch(`${baseUrl}/api/v4/projects/${projectId}/repository/commits/${sha}/diff`, {
      headers: { 'Authorization': `Bearer ${token}` },
    }),
  ]);

  if (!commitResp.ok) throw new Error(`GitLab commit API error: ${commitResp.status}`);

  const commit = await commitResp.json();
  const diffs = diffResp.ok ? await diffResp.json() : [];

  return {
    sha: commit.id,
    message: commit.message,
    author: commit.author_name,
    date: commit.created_at,
    url: commit.web_url,
    stats: commit.stats,
    files: diffs.map(d => ({
      filename: d.new_path,
      status: d.new_file ? 'added' : d.deleted_file ? 'removed' : d.renamed_file ? 'renamed' : 'modified',
      additions: 0,
      deletions: 0,
    })),
  };
}
