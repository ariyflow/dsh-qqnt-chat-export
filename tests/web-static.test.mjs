/**
 * The `/app/` static server that carries the modular UI.
 *
 * These cases matter because the document root sits next to the helper scripts
 * and the working directory: a traversal bug here would serve `web.js`,
 * `page.html` or anything else the process can read to a local page. The
 * legacy `/` route is asserted too so the additive promise holds.
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { startWebServer } from '../web.js'

async function tempDir() {
  return mkdtemp(path.join(os.tmpdir(), 'qqnt-static-'))
}

/** Start the UI on the first free random loopback port. */
async function startServer(settings) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const port = 24000 + Math.floor(Math.random() * 4000)
    const server = startWebServer(settings, port, '127.0.0.1', { handlers: {} })
    try {
      await server.ready
      return { server, base: `http://127.0.0.1:${port}` }
    } catch {
      await server.close()
    }
  }
  throw new Error('could not bind a test port')
}

test('the modular UI shell is served under /app/', async () => {
  const dir = await tempDir()
  const { server, base } = await startServer({ python: process.execPath, workDir: dir })
  try {
    const response = await fetch(`${base}/app/`)
    assert.equal(response.status, 200)
    assert.match(response.headers.get('content-type'), /^text\/html/)
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff')
    // Same-origin modules only: no inline script, no remote origins.
    const csp = response.headers.get('content-security-policy')
    assert.match(csp, /script-src 'self'/)
    assert.doesNotMatch(csp, /script-src[^;]*unsafe-inline/)
    assert.ok(response.headers.get('etag'))
    const html = await response.text()
    assert.match(html, /\/app\/css\/base\.css/)
    // The only script is the external module; nothing inline, which is what
    // lets this route run under `script-src 'self'`.
    assert.match(html, /<script type="module" src="\/app\/js\/app\.js">/)
    assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)/)
  } finally {
    await server.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('stylesheets are served with their own content type', async () => {
  const dir = await tempDir()
  const { server, base } = await startServer({ python: process.execPath, workDir: dir })
  try {
    const response = await fetch(`${base}/app/css/base.css`)
    assert.equal(response.status, 200)
    assert.match(response.headers.get('content-type'), /^text\/css/)
    assert.match(await response.text(), /--accent/)
  } finally {
    await server.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('/app redirects to /app/ and HEAD returns metadata only', async () => {
  const dir = await tempDir()
  const { server, base } = await startServer({ python: process.execPath, workDir: dir })
  try {
    let response = await fetch(`${base}/app`, { redirect: 'manual' })
    assert.equal(response.status, 308)
    assert.equal(response.headers.get('location'), '/app/')

    response = await fetch(`${base}/app/`, { method: 'HEAD' })
    assert.equal(response.status, 200)
    assert.ok(Number(response.headers.get('content-length')) > 0)
    assert.equal(await response.text(), '')
  } finally {
    await server.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('revalidation returns 304 for an unchanged file', async () => {
  const dir = await tempDir()
  const { server, base } = await startServer({ python: process.execPath, workDir: dir })
  try {
    const first = await fetch(`${base}/app/css/base.css`)
    const etag = first.headers.get('etag')
    const second = await fetch(`${base}/app/css/base.css`, { headers: { 'if-none-match': etag } })
    assert.equal(second.status, 304)
    assert.equal(await second.text(), '')
  } finally {
    await server.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('traversal and unlisted extensions are refused', async () => {
  const dir = await tempDir()
  const { server, base } = await startServer({ python: process.execPath, workDir: dir })
  try {
    const payloads = [
      // URL normalisation keeps these encoded, so they reach the server and
      // are rejected after decoding to a path that leaves `web/`.
      '/app/css/%2e%2e%2f%2e%2e%2fweb.js',
      '/app/..%2fpackage.json',
      '/app/%2E%2E%2Fpage.html',
      // Normalised by the URL parser before it ever arrives.
      '/app/%2e%2e/package.json',
      // Whitelisted directory, extension that is not served.
      '/app/scripts/qqnt_query.py',
      '/app/missing.js',
    ]
    for (const payload of payloads) {
      const response = await fetch(`${base}${payload}`)
      assert.equal(response.status, 404, `${payload} must not be served`)
      assert.doesNotMatch(await response.text(), /require|"name"/, `${payload} leaked content`)
    }
  } finally {
    await server.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('the root serves the modular UI with the strict CSP', async () => {
  const dir = await tempDir()
  const { server, base } = await startServer({ python: process.execPath, workDir: dir })
  try {
    const response = await fetch(`${base}/`)
    assert.equal(response.status, 200)
    const csp = response.headers.get('content-security-policy')
    assert.match(csp, /script-src 'self'/)
    assert.doesNotMatch(csp, /script-src[^;]*unsafe-inline/)
    assert.match(csp, /default-src 'none'/)
    const html = await response.text()
    assert.match(html, /id="app-main"/)
  } finally {
    await server.close()
    await rm(dir, { recursive: true, force: true })
  }
})
