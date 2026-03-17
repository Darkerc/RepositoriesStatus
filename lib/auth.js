/**
 * @fileoverview Módulo de autenticación OAuth2 con PKCE para GitHub y GitLab.
 *
 * Gestiona todo el flujo de autenticación de la extensión:
 * 1. Genera parámetros PKCE (code_verifier + code_challenge) para seguridad.
 * 2. Abre la ventana de autorización del proveedor usando chrome.identity.
 * 3. Intercambia el código de autorización por un token de acceso.
 * 4. Almacena/recupera/elimina tokens en chrome.storage.local.
 *
 * Flujo de datos:
 *   Usuario hace clic en "Conectar" -> se genera PKCE -> se abre ventana de auth
 *   -> usuario autoriza -> se recibe código -> se intercambia por token -> se guarda token.
 *
 * Dependencias: utils.js (generación aleatoria, SHA-256, Base64URL, parseo de query params),
 *               config.js (IDs de cliente OAuth).
 */

import { generateRandomString, sha256, base64UrlEncode, parseQueryParams } from './utils.js';
import { GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET, GITLAB_CLIENT_ID } from './config.js';

/** @const {string} URL del endpoint de autorización de GitHub */
const GITHUB_AUTH_URL = 'https://github.com/login/oauth/authorize';

/** @const {string} URL del endpoint de intercambio de tokens de GitHub */
const GITHUB_TOKEN_URL = 'https://github.com/login/oauth/access_token';

/** @const {string} URL del endpoint de intercambio de tokens de GitLab (instancia por defecto) */
const GITLAB_TOKEN_URL = 'https://gitlab.com/oauth/token';

/**
 * Construye la URL de redirección para el flujo OAuth de un proveedor.
 * Usa chrome.identity.getRedirectURL() que genera una URL única para la extensión.
 *
 * @param {string} provider - Nombre del proveedor ('github' o 'gitlab').
 * @returns {string} URL de redirección con el sufijo del proveedor.
 */
function getRedirectURL(provider) {
  return chrome.identity.getRedirectURL(`${provider}_callback`);
}

/**
 * Genera los parámetros PKCE (Proof Key for Code Exchange) necesarios para el flujo OAuth2.
 *
 * PKCE añade seguridad al flujo de autorización: el code_verifier es un secreto que solo
 * conoce el cliente, y el code_challenge es su hash SHA-256 codificado en Base64-URL.
 * El servidor de autorización verifica que quien intercambia el código es el mismo
 * que inició la solicitud.
 *
 * @returns {Promise<{codeVerifier: string, codeChallenge: string}>} Par de verificador y desafío PKCE.
 */
async function generatePKCE() {
  // Generar una cadena aleatoria de 64 bytes como verificador
  const codeVerifier = generateRandomString(64);
  // Calcular el hash SHA-256 del verificador
  const digest = await sha256(codeVerifier);
  // Codificar el hash en Base64-URL para obtener el challenge
  const codeChallenge = base64UrlEncode(new Uint8Array(digest));
  return { codeVerifier, codeChallenge };
}

/**
 * Autentica al usuario con GitHub usando el flujo OAuth2 con PKCE.
 *
 * Proceso completo:
 * 1. Genera PKCE y un estado aleatorio anti-CSRF.
 * 2. Abre la página de autorización de GitHub en una ventana del navegador.
 * 3. El usuario autoriza la aplicación en GitHub.
 * 4. Se recibe la URL de redirección con el código de autorización.
 * 5. Se valida el estado para prevenir ataques CSRF.
 * 6. Se intercambia el código por un token de acceso.
 * 7. Se guarda el token en chrome.storage.local.
 *
 * @returns {Promise<string>} El token de acceso de GitHub.
 * @throws {Error} Si el usuario cancela, si hay error de autenticación, o si el estado no coincide.
 */
export async function authenticateGitHub() {
  const { codeVerifier, codeChallenge } = await generatePKCE();
  // Estado aleatorio para protección contra CSRF
  const state = generateRandomString(32);
  const redirectURL = getRedirectURL('github');

  // GitHub Apps no usan scope — los permisos se configuran en los ajustes de la app
  const authURL = `${GITHUB_AUTH_URL}?` + new URLSearchParams({
    client_id: GITHUB_CLIENT_ID,
    redirect_uri: redirectURL,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  }).toString();

  // Abrir la ventana de autorización; interactive:true muestra la UI al usuario
  const responseURL = await chrome.identity.launchWebAuthFlow({
    url: authURL,
    interactive: true,
  });

  // Extraer los parámetros de la URL de respuesta (code, state, error, etc.)
  const params = parseQueryParams(responseURL);

  // Verificar si hubo un error en la autorización
  if (params.error) {
    throw new Error(`GitHub auth error: ${params.error_description || params.error}`);
  }

  // Validar que el estado coincida para prevenir ataques CSRF
  if (params.state !== state) {
    throw new Error('State mismatch — possible CSRF attack');
  }

  // Intercambiar el código de autorización por un token de acceso
  const token = await exchangeCode('github', params.code, codeVerifier, redirectURL);
  // Persistir el token en el almacenamiento local de la extensión
  await chrome.storage.local.set({ github_token: token.access_token });
  return token.access_token;
}

/**
 * Autentica al usuario con GitLab usando el flujo OAuth2 con PKCE.
 *
 * Similar al flujo de GitHub pero con diferencias:
 * - Requiere especificar scope (read_user, read_api).
 * - Soporta instancias self-hosted de GitLab mediante el parámetro baseUrl.
 * - Requiere response_type y grant_type explícitos (estándar OAuth2 completo).
 *
 * @param {string} [baseUrl='https://gitlab.com'] - URL base de la instancia GitLab.
 * @returns {Promise<string>} El token de acceso de GitLab.
 * @throws {Error} Si el usuario cancela, si hay error de autenticación, o si el estado no coincide.
 */
export async function authenticateGitLab(baseUrl = 'https://gitlab.com') {
  const { codeVerifier, codeChallenge } = await generatePKCE();
  const state = generateRandomString(32);
  const redirectURL = getRedirectURL('gitlab');

  // Construir la URL de autorización para la instancia específica de GitLab
  const authEndpoint = `${baseUrl}/oauth/authorize`;
  const authURL = `${authEndpoint}?` + new URLSearchParams({
    client_id: GITLAB_CLIENT_ID,
    redirect_uri: redirectURL,
    response_type: 'code',
    scope: 'read_user read_api', // Permisos: leer usuario y API
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  }).toString();

  // Lanzar el flujo de autenticación web interactivo
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

  // Usar la URL de token correspondiente a la instancia (puede ser self-hosted)
  const tokenUrl = `${baseUrl}/oauth/token`;
  const token = await exchangeCode('gitlab', params.code, codeVerifier, redirectURL, tokenUrl);
  await chrome.storage.local.set({ gitlab_token: token.access_token });
  return token.access_token;
}

/**
 * Intercambia un código de autorización OAuth por un token de acceso.
 *
 * Esta función hace la solicitud POST al endpoint de tokens del proveedor,
 * enviando el código de autorización junto con el verificador PKCE para
 * demostrar que somos el mismo cliente que inició el flujo.
 *
 * Diferencias entre proveedores:
 * - GitLab requiere el campo 'grant_type' (estándar OAuth2), GitHub no.
 * - GitHub Apps pueden necesitar 'client_secret' si fue generado.
 *
 * @param {string} provider - Proveedor ('github' o 'gitlab').
 * @param {string} code - Código de autorización recibido del proveedor.
 * @param {string} codeVerifier - Verificador PKCE original (se envía para validación).
 * @param {string} redirectUri - URL de redirección usada en la solicitud de autorización.
 * @param {string} [customTokenUrl] - URL personalizada del endpoint de tokens (para GitLab self-hosted).
 * @returns {Promise<Object>} Respuesta del servidor con access_token y otros campos.
 * @throws {Error} Si el intercambio falla (código inválido, expirado, etc.).
 */
async function exchangeCode(provider, code, codeVerifier, redirectUri, customTokenUrl) {
  // Seleccionar la URL de tokens según el proveedor
  const tokenUrl = provider === 'github'
    ? GITHUB_TOKEN_URL
    : (customTokenUrl || GITLAB_TOKEN_URL);

  const clientId = provider === 'github' ? GITHUB_CLIENT_ID : GITLAB_CLIENT_ID;

  // Construir el cuerpo de la solicitud como application/x-www-form-urlencoded
  const body = new URLSearchParams({
    client_id: clientId,
    code,
    code_verifier: codeVerifier,
    redirect_uri: redirectUri,
  });

  // GitLab requiere grant_type (estándar OAuth2), GitHub no lo necesita
  if (provider !== 'github') {
    body.set('grant_type', 'authorization_code');
  }

  // GitHub Apps: incluir client_secret si se configuró uno
  if (provider === 'github' && GITHUB_CLIENT_SECRET) {
    body.set('client_secret', GITHUB_CLIENT_SECRET);
  }

  // Enviar la solicitud POST al endpoint de tokens
  const response = await fetch(tokenUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': 'application/json', // Solicitar respuesta en JSON
    },
    body: body.toString(),
  });

  // Si la respuesta no es exitosa, lanzar error con los detalles
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Token exchange failed (${response.status}): ${text}`);
  }

  return response.json();
}

/**
 * Obtiene el token almacenado para un proveedor específico.
 *
 * @param {string} provider - Nombre del proveedor ('github' o 'gitlab').
 * @returns {Promise<string|null>} El token de acceso almacenado, o null si no existe.
 */
export async function getToken(provider) {
  const key = `${provider}_token`;
  const result = await chrome.storage.local.get(key);
  return result[key] || null;
}

/**
 * Elimina el token almacenado para un proveedor específico.
 * Se usa al desconectar una cuenta o cuando el token ha expirado.
 *
 * @param {string} provider - Nombre del proveedor ('github' o 'gitlab').
 * @returns {Promise<void>}
 */
export async function removeToken(provider) {
  const key = `${provider}_token`;
  await chrome.storage.local.remove(key);
}

/**
 * Verifica el estado de autenticación de todos los proveedores.
 * Consulta chrome.storage.local para determinar qué proveedores tienen token almacenado.
 *
 * @returns {Promise<{github: boolean, gitlab: boolean}>} Objeto indicando si cada proveedor está autenticado.
 */
export async function getAuthState() {
  const result = await chrome.storage.local.get(['github_token', 'gitlab_token']);
  return {
    github: !!result.github_token,  // Convertir a booleano: true si hay token
    gitlab: !!result.gitlab_token,
  };
}
