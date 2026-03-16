const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

/**
 * Get cached data if it exists and hasn't expired.
 * @returns {object|null} The cached data or null if expired/missing.
 */
export async function getCached(key) {
  const result = await chrome.storage.local.get(key);
  const entry = result[key];

  if (!entry) return null;
  if (Date.now() - entry.timestamp > CACHE_TTL_MS) return null;

  return entry.data;
}

/**
 * Store data in cache with a timestamp.
 */
export async function setCache(key, data) {
  await chrome.storage.local.set({
    [key]: {
      data,
      timestamp: Date.now(),
    },
  });
}

/**
 * Remove a cache entry.
 */
export async function clearCache(key) {
  await chrome.storage.local.remove(key);
}
