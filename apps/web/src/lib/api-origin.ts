const configuredApiOrigin = process.env.NEXT_PUBLIC_API_URL ?? ''

export type BrowserLocation = Pick<Location, 'origin' | 'protocol'>

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '')
}

/**
 * Production requests use the Pages origin so its edge proxy can issue a
 * first-party session cookie. Local HTTP development keeps talking directly
 * to the configured Worker because Next dev does not run the Pages proxy.
 */
export function resolveBrowserApiOrigin(
  workerOrigin: string,
  location?: BrowserLocation | null,
): string {
  const fallback = stripTrailingSlash(workerOrigin)
  if (!location || location.protocol !== 'https:') return fallback
  return stripTrailingSlash(location.origin)
}

export function getApiOrigin(): string {
  if (!configuredApiOrigin) {
    throw new Error('NEXT_PUBLIC_API_URL is not set. API requests cannot be sent.')
  }
  const location = typeof window === 'undefined' ? null : window.location
  return resolveBrowserApiOrigin(configuredApiOrigin, location)
}

export function getWorkerOrigin(): string {
  return stripTrailingSlash(configuredApiOrigin)
}

export function buildApiRequestUrl(pathOrUrl: string): string {
  try {
    const url = new URL(pathOrUrl)
    if (url.protocol === 'http:' || url.protocol === 'https:') return url.toString()
  } catch {
    // Relative API paths are handled below.
  }
  const path = pathOrUrl.startsWith('/') ? pathOrUrl : `/${pathOrUrl}`
  return `${getApiOrigin()}${path}`
}
