import { generateRandomString, sha256, base64UrlEncode, parseQueryParams } from './utils.js';
import { GITHUB_CLIENT_ID, GITLAB_CLIENT_ID } from './config.js';

const GITHUB_AUTH_URL = 'https://github.com/login/oauth/authorize';
const GITHUB_TOKEN_URL = 'https://github.com/login/oauth/access_token';
const GITLAB_TOKEN_URL = 'https://gitlab.com/oauth/token';

function getRedirectURL(provider) {
  return chrome.identity.getRedirectURL(`${provider}_callback`);
}

/**
 * Generate PKCE code verifier and challenge.
 */
async function generatePKCE() {
  const codeVerifier = generateRandomString(64);
  const digest = await sha256(codeVerifier);
  const codeChallenge = base64UrlEncode(new Uint8Array(digest));
  return { codeVerifier, codeChallenge };
}

/**
 * Authenticate with GitHub using OAuth PKCE flow.
 */
export async function authenticateGitHub() {
  const { codeVerifier, codeChallenge } = await generatePKCE();
  const state = generateRandomString(32);
  const redirectURL = getRedirectURL('github');

  const authURL = `${GITHUB_AUTH_URL}?` + new URLSearchParams({
    client_id: GITHUB_CLIENT_ID,
    redirect_uri: redirectURL,
    scope: 'read:user',
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  }).toString();

  const responseURL = await chrome.identity.launchWebAuthFlow({
    url: authURL,
    interactive: true,
  });

  const params = parseQueryParams(responseURL);

  if (params.error) {
    throw new Error(`GitHub auth error: ${params.error_description || params.error}`);
  }
  if (params.state !== state) {
    throw new Error('State mismatch — possible CSRF attack');
  }

  const token = await exchangeCode('github', params.code, codeVerifier, redirectURL);
  await chrome.storage.local.set({ github_token: token.access_token });
  return token.access_token;
}

/**
 * Authenticate with GitLab using OAuth PKCE flow.
 */
export async function authenticateGitLab(baseUrl = 'https://gitlab.com') {
  const { codeVerifier, codeChallenge } = await generatePKCE();
  const state = generateRandomString(32);
  const redirectURL = getRedirectURL('gitlab');

  const authEndpoint = `${baseUrl}/oauth/authorize`;
  const authURL = `${authEndpoint}?` + new URLSearchParams({
    client_id: GITLAB_CLIENT_ID,
    redirect_uri: redirectURL,
    response_type: 'code',
    scope: 'read_user',
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  }).toString();

  const responseURL = await chrome.identity.launchWebAuthFlow({
    url: authURL,
    interactive: true,
  });

  const params = parseQueryParams(responseURL);

  if (params.error) {
    throw new Error(`GitLab auth error: ${params.error_description || params.error}`);
  }
  if (params.state !== state) {
    throw new Error('State mismatch — possible CSRF attack');
  }

  const tokenUrl = `${baseUrl}/oauth/token`;
  const token = await exchangeCode('gitlab', params.code, codeVerifier, redirectURL, tokenUrl);
  await chrome.storage.local.set({ gitlab_token: token.access_token });
  return token.access_token;
}

/**
 * Exchange authorization code for access token.
 */
async function exchangeCode(provider, code, codeVerifier, redirectUri, customTokenUrl) {
  const tokenUrl = provider === 'github'
    ? GITHUB_TOKEN_URL
    : (customTokenUrl || GITLAB_TOKEN_URL);

  const clientId = provider === 'github' ? GITHUB_CLIENT_ID : GITLAB_CLIENT_ID;

  const body = new URLSearchParams({
    client_id: clientId,
    code,
    code_verifier: codeVerifier,
    grant_type: 'authorization_code',
    redirect_uri: redirectUri,
  });

  const response = await fetch(tokenUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': 'application/json',
    },
    body: body.toString(),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Token exchange failed (${response.status}): ${text}`);
  }

  return response.json();
}

/**
 * Get stored token for a provider.
 */
export async function getToken(provider) {
  const key = `${provider}_token`;
  const result = await chrome.storage.local.get(key);
  return result[key] || null;
}

/**
 * Remove stored token for a provider.
 */
export async function removeToken(provider) {
  const key = `${provider}_token`;
  await chrome.storage.local.remove(key);
}

/**
 * Check which providers are currently authenticated.
 */
export async function getAuthState() {
  const result = await chrome.storage.local.get(['github_token', 'gitlab_token']);
  return {
    github: !!result.github_token,
    gitlab: !!result.gitlab_token,
  };
}
