/**
 * Generate a cryptographically random string of given length.
 * Used for PKCE code verifiers and state parameters.
 */
export function generateRandomString(length = 64) {
  const array = new Uint8Array(length);
  crypto.getRandomValues(array);
  return base64UrlEncode(array);
}

/**
 * Base64-URL encode a Uint8Array (no padding).
 */
export function base64UrlEncode(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let binary = '';
  for (const b of bytes) {
    binary += String.fromCharCode(b);
  }
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * Compute SHA-256 hash and return as ArrayBuffer.
 */
export async function sha256(plain) {
  const encoder = new TextEncoder();
  return crypto.subtle.digest('SHA-256', encoder.encode(plain));
}

/**
 * Format a Date to YYYY-MM-DD string.
 */
export function formatDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * Get short month name from month index (0-based).
 */
export function monthName(index) {
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return months[index];
}

/**
 * Get an array of date strings for the past 365 days (inclusive of today).
 * Returns oldest first.
 */
export function getLast365Days() {
  const days = [];
  const today = new Date();
  for (let i = 364; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(today.getDate() - i);
    days.push(formatDate(d));
  }
  return days;
}

/**
 * Parse URL query parameters from a redirect URL.
 */
export function parseQueryParams(url) {
  const params = {};
  const queryString = new URL(url).search.substring(1);
  for (const pair of queryString.split('&')) {
    const [key, value] = pair.split('=');
    if (key) params[decodeURIComponent(key)] = decodeURIComponent(value || '');
  }
  return params;
}
