// Deep-link parsing. Only a tiny, non-sensitive route identifier is accepted.
// Anything unrecognized resolves to the gift cover (the safe default); no URL
// value is ever treated as proof of identity or authorization.

export const ROUTE_HOME = 'home';
export const ROUTE_GIFT = 'gift';

const ALLOWED = new Set([ROUTE_HOME, ROUTE_GIFT]);

/**
 * @param {string} pathname
 * @param {string} search
 * @returns {'home'|'gift'}
 */
export function parseRoute(pathname, search = '') {
  let path = '/';
  try {
    path = String(pathname || '/');
  } catch {
    path = '/';
  }

  const normalized = path.length > 1 ? path.replace(/\/+$/, '') : path;
  if (normalized === '/gift') return ROUTE_GIFT;

  let queryRoute = null;
  try {
    queryRoute = new URLSearchParams(String(search || '')).get('route');
  } catch {
    queryRoute = null;
  }
  if (queryRoute === ROUTE_GIFT) return ROUTE_GIFT;
  if (queryRoute && ALLOWED.has(queryRoute)) return queryRoute;

  // "/", "/index.html", unknown paths and hostile values all land on home.
  return ROUTE_HOME;
}

/** Build the gift route for tests and future client-side navigation. */
export function giftPath() {
  return '/gift';
}
