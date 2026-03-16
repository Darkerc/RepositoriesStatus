import { getToken } from './auth.js';

const GITHUB_GRAPHQL_URL = 'https://api.github.com/graphql';
const GITHUB_REST_URL = 'https://api.github.com';

const CONTRIBUTIONS_QUERY = `
query {
  viewer {
    contributionsCollection {
      contributionCalendar {
        weeks {
          contributionDays {
            date
            contributionCount
          }
        }
      }
    }
  }
}`;

/**
 * Fetch GitHub contribution data for the past year.
 * Returns normalized { "YYYY-MM-DD": count } object.
 */
export async function fetchGitHubContributions() {
  const token = await getToken('github');
  if (!token) throw new Error('Not authenticated with GitHub');

  const response = await fetch(GITHUB_GRAPHQL_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query: CONTRIBUTIONS_QUERY }),
  });

  if (response.status === 401) throw new Error('UNAUTHORIZED');

  if (!response.ok) {
    if (response.status === 403) {
      const resetHeader = response.headers.get('x-ratelimit-reset');
      if (resetHeader) throw new Error(`RATE_LIMITED:${resetHeader}`);
    }
    throw new Error(`GitHub API error: ${response.status}`);
  }

  const json = await response.json();
  if (json.errors) throw new Error(`GitHub GraphQL error: ${json.errors[0].message}`);

  const weeks = json.data.viewer.contributionsCollection.contributionCalendar.weeks;
  const contributions = {};
  for (const week of weeks) {
    for (const day of week.contributionDays) {
      contributions[day.date] = day.contributionCount;
    }
  }
  return contributions;
}

/**
 * Get the authenticated GitHub username (cached).
 */
async function getGitHubUsername() {
  const cached = await chrome.storage.local.get('github_username');
  if (cached.github_username) return cached.github_username;

  const token = await getToken('github');
  const response = await fetch(`${GITHUB_REST_URL}/user`, {
    headers: { 'Authorization': `Bearer ${token}` },
  });
  if (!response.ok) throw new Error(`GitHub user API error: ${response.status}`);

  const user = await response.json();
  await chrome.storage.local.set({ github_username: user.login });
  return user.login;
}

/**
 * Fetch recent GitHub activity events.
 * Returns normalized array of activity items.
 */
export async function fetchGitHubActivity() {
  const token = await getToken('github');
  if (!token) throw new Error('Not authenticated with GitHub');

  const username = await getGitHubUsername();
  const response = await fetch(
    `${GITHUB_REST_URL}/users/${encodeURIComponent(username)}/events?per_page=30`,
    { headers: { 'Authorization': `Bearer ${token}` } }
  );

  if (response.status === 401) throw new Error('UNAUTHORIZED');
  if (!response.ok) throw new Error(`GitHub events API error: ${response.status}`);

  const events = await response.json();
  return normalizeGitHubEvents(events);
}

function normalizeGitHubEvents(events) {
  const items = [];
  for (const event of events) {
    const base = {
      id: `gh-${event.id}`,
      provider: 'github',
      repo: event.repo.name,
      date: event.created_at,
    };

    switch (event.type) {
      case 'PushEvent':
        items.push({
          ...base,
          type: 'commit',
          title: event.payload.commits?.[0]?.message?.split('\n')[0] || 'Push',
          commits: (event.payload.commits || []).map(c => ({
            sha: c.sha,
            message: c.message,
          })),
        });
        break;

      case 'PullRequestEvent':
        items.push({
          ...base,
          type: 'pull_request',
          title: event.payload.pull_request.title,
          number: event.payload.pull_request.number,
          state: event.payload.pull_request.state,
          action: event.payload.action,
          description: event.payload.pull_request.body?.substring(0, 300) || '',
          url: event.payload.pull_request.html_url,
        });
        break;

      case 'IssuesEvent':
        items.push({
          ...base,
          type: 'issue',
          title: event.payload.issue.title,
          number: event.payload.issue.number,
          state: event.payload.issue.state,
          action: event.payload.action,
          description: event.payload.issue.body?.substring(0, 300) || '',
          url: event.payload.issue.html_url,
        });
        break;

      case 'IssueCommentEvent':
        items.push({
          ...base,
          type: 'comment',
          title: `Comment on #${event.payload.issue.number}: ${event.payload.issue.title}`,
          description: event.payload.comment.body?.substring(0, 300) || '',
          url: event.payload.comment.html_url,
        });
        break;

      case 'CreateEvent':
        items.push({
          ...base,
          type: event.payload.ref_type === 'tag' ? 'tag' : 'branch',
          title: `Created ${event.payload.ref_type} ${event.payload.ref || ''}`.trim(),
          description: event.payload.description || '',
        });
        break;

      case 'DeleteEvent':
        items.push({
          ...base,
          type: 'branch',
          title: `Deleted ${event.payload.ref_type} ${event.payload.ref || ''}`.trim(),
        });
        break;

      case 'ForkEvent':
        items.push({
          ...base,
          type: 'fork',
          title: `Forked to ${event.payload.forkee.full_name}`,
          url: event.payload.forkee.html_url,
        });
        break;

      case 'WatchEvent':
        items.push({
          ...base,
          type: 'star',
          title: `Starred ${event.repo.name}`,
        });
        break;

      case 'PullRequestReviewEvent':
        items.push({
          ...base,
          type: 'review',
          title: `Reviewed PR #${event.payload.pull_request.number}: ${event.payload.pull_request.title}`,
          description: event.payload.review.body?.substring(0, 300) || '',
          url: event.payload.review.html_url,
        });
        break;

      default:
        items.push({
          ...base,
          type: 'other',
          title: event.type.replace('Event', ''),
        });
    }
  }
  return items;
}

/**
 * Fetch commit details including files changed.
 */
export async function fetchGitHubCommitDetail(repo, sha) {
  const token = await getToken('github');
  if (!token) throw new Error('Not authenticated with GitHub');

  const response = await fetch(`${GITHUB_REST_URL}/repos/${repo}/commits/${sha}`, {
    headers: { 'Authorization': `Bearer ${token}` },
  });

  if (!response.ok) throw new Error(`GitHub commit API error: ${response.status}`);

  const commit = await response.json();
  return {
    sha: commit.sha,
    message: commit.commit.message,
    author: commit.commit.author.name,
    date: commit.commit.author.date,
    url: commit.html_url,
    stats: commit.stats,
    files: (commit.files || []).map(f => ({
      filename: f.filename,
      status: f.status,
      additions: f.additions,
      deletions: f.deletions,
    })),
  };
}
