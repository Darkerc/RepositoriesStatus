import { getToken } from './auth.js';

const GITHUB_GRAPHQL_URL = 'https://api.github.com/graphql';

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

  if (response.status === 401) {
    throw new Error('UNAUTHORIZED');
  }

  if (!response.ok) {
    if (response.status === 403) {
      const resetHeader = response.headers.get('x-ratelimit-reset');
      if (resetHeader) {
        throw new Error(`RATE_LIMITED:${resetHeader}`);
      }
    }
    throw new Error(`GitHub API error: ${response.status}`);
  }

  const json = await response.json();

  if (json.errors) {
    throw new Error(`GitHub GraphQL error: ${json.errors[0].message}`);
  }

  const weeks = json.data.viewer.contributionsCollection.contributionCalendar.weeks;
  const contributions = {};

  for (const week of weeks) {
    for (const day of week.contributionDays) {
      contributions[day.date] = day.contributionCount;
    }
  }

  return contributions;
}
