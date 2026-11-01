/**
 * Client for the local JSON API.
 *
 * The page never talks to anything but its own origin, so this wrapper stays
 * deliberately small: build a query string, send the action header that the
 * server requires for mutations, and turn an error body into a throw that
 * carries the status. No retries, no caching, no library.
 */

/** A failed request: `status` is 0 when the connection itself failed. */
export class ApiError extends Error {
  /**
   * @param {string} message - human readable, already safe to show
   * @param {{status?: number, body?: unknown, path?: string}} [details]
   */
  constructor(message, { status = 0, body = null, path = '' } = {}) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.body = body
    this.path = path
  }
}

/**
 * Serialise query parameters the way the server reads them.
 *
 * Empty strings, `null` and `undefined` are dropped: the helper treats an
 * empty filter as "no filter", so sending `keyword=` would be noise. `0` and
 * `false` are kept because they are meaningful values, not absences.
 *
 * @param {Record<string, unknown>} params
 * @returns {string} `?...` or an empty string
 */
export function buildQuery(params = {}) {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined || value === '') continue
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item === null || item === undefined || item === '') continue
        search.append(key, String(item))
      }
      continue
    }
    search.set(key, String(value))
  }
  const text = search.toString()
  return text === '' ? '' : `?${text}`
}

/**
 * @param {object} [options]
 * @param {string} [options.base] - origin prefix; same-origin by default
 * @param {typeof fetch} [options.fetchImpl] - injectable for tests
 * @returns {{get: Function, post: Function, put: Function, remove: Function, request: Function}}
 */
export function createApi({ base = '', fetchImpl = globalThis.fetch } = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('createApi needs a fetch implementation')

  /**
   * @param {string} method
   * @param {string} path - starts with `/api/`
   * @param {{params?: object, body?: unknown}} [options]
   */
  async function request(method, path, { params, body } = {}) {
    const url = `${base}${path}${buildQuery(params || {})}`
    /** @type {RequestInit} */
    const init = { method, headers: {} }
    // Every mutation carries the action header, not only the ones with a body:
    // the server's CSRF guard checks the header alone, so `post('/api/...')`
    // without a payload used to be refused as a cross-origin request.
    if (String(method).toUpperCase() !== 'GET') init.headers['x-qqnt-action'] = '1'
    if (body !== undefined) {
      init.headers['content-type'] = 'application/json'
      init.body = JSON.stringify(body)
    }
    let response
    try {
      response = await fetchImpl(url, init)
    } catch (error) {
      throw new ApiError(error?.message || '网络请求失败', { path })
    }
    let payload = null
    if (response.status !== 204) {
      const text = await response.text()
      if (text !== '') {
        try {
          payload = JSON.parse(text)
        } catch {
          payload = text
        }
      }
    }
    if (!response.ok) {
      const message = payload && typeof payload === 'object' && payload.error
        ? String(payload.error)
        : `HTTP ${response.status}`
      throw new ApiError(message, { status: response.status, body: payload, path })
    }
    return payload
  }

  return {
    request,
    get: (path, params) => request('GET', path, { params }),
    post: (path, body, params) => request('POST', path, { body, params }),
    put: (path, body, params) => request('PUT', path, { body, params }),
    remove: (path, body, params) => request('DELETE', path, { body, params }),
  }
}
