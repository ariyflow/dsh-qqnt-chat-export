/**
 * Local web UI for the QQ chat export bundle.
 *
 * Binds a loopback-only HTTP listener (port 46728 by default) that serves one
 * static page plus a JSON API over `scripts/qqnt_query.py`. Every query runs
 * against the sidecar index that script builds, so the page never scans the
 * encrypted database per request.
 *
 * The server is deliberately standalone rather than a Harness slot page: the
 * requested destination is its own port, and a plain browser tab keeps the
 * decrypted data out of the agent surface.
 */
import { spawn } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync, unlinkSync, createReadStream } from 'node:fs'
import { createServer } from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const QUERY_CLI = path.join(HERE, 'scripts', 'qqnt_query.py')
const PAGE = path.join(HERE, 'page.html')
const DEFAULT_PORT = 46728
const DEFAULT_HOST = '127.0.0.1'
const REQUEST_TIMEOUT_MS = 180_000
const EXPORT_DIR_MAX_AGE_MS = 60 * 60 * 1000
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

/** When this process last asked the helper to build; covers the spawn gap. */
let lastBuildSpawnAt = 0

/** Whether an Origin header names this machine. */
function isLoopbackOrigin(value) {
  try {
    return LOOPBACK.has(new URL(value).hostname)
  } catch {
    return false
  }
}

/** One python invocation returning parsed JSON from stdout. */
function runJson(settings, command, args = {}, { signal } = {}) {
  return new Promise((resolve, reject) => {
    const argv = ['-X', 'utf8', QUERY_CLI, '--work', settings.workDir]
    if (settings.tencentRoot) argv.push('--root', settings.tencentRoot)
    if (settings.account) argv.push('--account', String(settings.account))
    argv.push(command)
    if (command === 'messages' || command === 'export') {
      argv.push('--json', JSON.stringify(args))
    }
    const child = spawn(settings.python, argv, {
      windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const stdout = []
    const stderr = []
    let settled = false
    const timer = setTimeout(() => {
      if (!settled) child.kill()
    }, REQUEST_TIMEOUT_MS)
    const onAbort = () => child.kill()
    signal?.addEventListener('abort', onAbort, { once: true })
    const finish = (fn, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      fn(value)
    }
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => stdout.push(chunk))
    child.stderr.on('data', (chunk) => stderr.push(chunk))
    child.on('error', (error) => finish(reject, error.code === 'ENOENT'
      ? new Error(`cannot run "${settings.python}": not found on PATH`)
      : error))
    child.on('close', (code) => {
      const out = stdout.join('').trim()
      if (code !== 0) {
        let message = stderr.join('').trim() || `helper exited with code ${code}`
        try {
          const parsed = JSON.parse(out)
          if (parsed && typeof parsed.error === 'string') message = parsed.error
        } catch {
          // Not a structured error; keep the raw stderr tail below.
        }
        const error = new Error(message.split('\n').slice(-4).join(' '))
        // Exit code 2 is the helper's "bad request"; everything else is a failure.
        error.status = code === 2 ? 400 : 500
        finish(reject, error)
        return
      }
      try {
        finish(resolve, JSON.parse(out === '' ? '{}' : out))
      } catch (error) {
        finish(reject, new Error(`unreadable helper output: ${error.message}`))
      }
    })
  })
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(body)
}

function readInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10)
  return Number.isFinite(parsed) ? parsed : fallback
}

/** Collect the filter parameters shared by the message list and the exports. */
function filtersFrom(params) {
  const args = {
    chatKind: params.get('chatKind') || '',
    chatId: params.get('chatId') || '',
    keyword: params.get('keyword') || '',
    sender: params.get('sender') || '',
    since: params.get('since') || '',
    until: params.get('until') || '',
  }
  for (const key of Object.keys(args)) {
    if (args[key] === '') delete args[key]
  }
  return args
}

function safeFileStem(text) {
  return String(text).replace(/[\\/:*?"<>|\r\n\t]+/g, '_').replace(/^\.+/, '').trim().slice(0, 60) || 'QQ聊天记录'
}

function stamp() {
  const now = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`
}

/** Drop export files a previous session left behind. */
function sweepExports(dir) {
  try {
    const cutoff = Date.now() - EXPORT_DIR_MAX_AGE_MS
    for (const name of readdirSync(dir)) {
      const file = path.join(dir, name)
      try {
        if (statSync(file).mtimeMs < cutoff) unlinkSync(file)
      } catch {
        // Ignore files another request is still streaming.
      }
    }
  } catch {
    // No export directory yet.
  }
}

/**
 * Start the local UI.
 *
 * @param {object} settings - resolved plugin settings (`python`, `workDir`, `tencentRoot`, `account`).
 * @param {number} port - listen port; 0 disables the server.
 * @param {string} host - bind address; loopback by default.
 * @param {{ onError?: (error: Error) => void }} options - notified when the listener cannot bind.
 * @returns {{close: () => Promise<void>, url: string, error?: Error}}
 */
export function startWebServer(settings, port = DEFAULT_PORT, host = DEFAULT_HOST, options = {}) {
  const state = {
    url: `http://${host}:${port || DEFAULT_PORT}/`,
    error: undefined,
    server: undefined,
  }
  if (!port) return { close: async () => {}, url: '', error: undefined }

  let pageHtml = ''
  try {
    pageHtml = readFileSync(PAGE, 'utf8')
  } catch (error) {
    state.error = new Error(`page.html is missing: ${error.message}`)
    return { close: async () => {}, url: state.url, error: state.error }
  }

  const server = createServer((req, res) => {
    const requestHost = String(req.headers.host ?? '').split(':')[0]
    if (!LOOPBACK.has(requestHost)) {
      sendJson(res, 403, { error: 'loopback only' })
      return
    }
    const requestUrl = new URL(req.url ?? '/', `http://${host}:${port}`)
    const pathname = requestUrl.pathname
    const params = requestUrl.searchParams

    if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src data:",
      })
      res.end(pageHtml)
      return
    }
    if (pathname === '/favicon.ico') {
      res.writeHead(204).end()
      return
    }
    if (req.method === 'GET' && pathname === '/api/status') {
      const exports = path.join(settings.workDir, 'exports')
      runJson(settings, 'status')
        .then((status) => sendJson(res, 200, {
          ...status,
          port,
          host,
          exportDir: exports,
          version: 1,
        }))
        .catch((error) => sendJson(res, 500, { error: error.message }))
      return
    }
    if (req.method === 'GET' && pathname === '/api/index') {
      runJson(settings, 'status')
        .then((status) => sendJson(res, 200, { index: status.index, build: status.build, db: status.db, key: status.key }))
        .catch((error) => sendJson(res, 500, { error: error.message }))
      return
    }
    if (req.method === 'GET' && pathname === '/api/sessions') {
      runJson(settings, 'sessions')
        .then((payload) => sendJson(res, 200, payload))
        .catch((error) => sendJson(res, 500, { error: error.message }))
      return
    }
    if (req.method === 'GET' && pathname === '/api/messages') {
      const args = {
        ...filtersFrom(params),
        offset: readInt(params.get('offset'), 0),
        limit: Math.min(Math.max(readInt(params.get('limit'), 50), 1), 500),
      }
      runJson(settings, 'messages', args)
        .then((payload) => sendJson(res, 200, payload))
        .catch((error) => sendJson(res, error.status ?? 409, { error: error.message }))
      return
    }
    if (req.method === 'GET' && pathname === '/api/export') {
      const format = (params.get('format') || 'txt').toLowerCase()
      const allowed = new Set(['txt', 'csv', 'json', 'md', 'html', 'sqlite'])
      if (!allowed.has(format)) {
        sendJson(res, 400, { error: `unsupported format: ${format}` })
        return
      }
      const label = params.get('label') || 'QQ聊天记录'
      const outDir = path.join(settings.workDir, 'exports')
      const outPath = path.join(outDir, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${format}`)
      const args = { ...filtersFrom(params), format, out: outPath, label }
      runJson(settings, 'export', args)
        .then((result) => {
          const filename = `${safeFileStem(label)}_${stamp()}.${format}`
          const headers = {
            'content-type': format === 'html' ? 'text/html; charset=utf-8' : 'application/octet-stream',
            'content-disposition':
              `attachment; filename="qqnt-export-${Date.now()}.${format}"; ` +
              `filename*=UTF-8''${encodeURIComponent(filename)}`,
            'cache-control': 'no-store',
          }
          if (Number.isFinite(result.bytes)) headers['content-length'] = String(result.bytes)
          res.writeHead(200, headers)
          const stream = createReadStream(result.path)
          stream.on('error', () => {
            if (!res.headersSent) sendJson(res, 500, { error: 'export file unreadable' })
            else res.end()
          })
          stream.pipe(res)
          res.on('close', () => {
            try {
              unlinkSync(result.path)
            } catch {
              // Already removed.
            }
          })
        })
        .catch((error) => sendJson(res, error.status ?? 500, { error: error.message }))
      return
    }
    if (req.method === 'POST' && pathname === '/api/index/build') {
      // A page on another origin must not be able to start a 1 GB rebuild.
      const origin = req.headers.origin
      if (origin !== undefined && !isLoopbackOrigin(origin)) {
        sendJson(res, 403, { error: 'cross-origin requests are refused' })
        return
      }
      // Report a running build instead of answering 202 for a spawn that the
      // helper's own lock will immediately refuse. Three sources because the
      // helper needs a moment to create its lock file.
      const lockFile = path.join(settings.workDir, 'build.lock')
      let running = Date.now() - lastBuildSpawnAt < 10_000
      if (!running) {
        try {
          running = JSON.parse(readFileSync(path.join(settings.workDir, 'build-status.json'), 'utf8')).state === 'running'
        } catch {
          // No status file yet.
        }
      }
      if (!running) {
        try {
          running = Date.now() - statSync(lockFile).mtimeMs < 15 * 60 * 1000
        } catch {
          // No lock file.
        }
      }
      if (running) {
        sendJson(res, 409, { error: '已有一次索引构建正在进行，请等它结束。' })
        return
      }
      lastBuildSpawnAt = Date.now()
      const argv = ['-X', 'utf8', QUERY_CLI, '--work', settings.workDir]
      if (settings.tencentRoot) argv.push('--root', settings.tencentRoot)
      if (settings.account) argv.push('--account', String(settings.account))
      argv.push('build')
      if (params.get('refresh') === '1') argv.push('--refresh')
      const child = spawn(settings.python, argv, {
        windowsHide: true,
        detached: true,
        stdio: 'ignore',
        env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
      })
      child.unref()
      sendJson(res, 202, { started: true, refresh: params.get('refresh') === '1' })
      return
    }
    sendJson(res, 404, { error: 'not found' })
  })

  server.on('error', (error) => {
    state.error = error
    console.warn(`[qqnt-chat-export] web UI on ${state.url} unavailable: ${error.message}`)
    options.onError?.(error)
  })
  server.listen(port, host, () => {
    console.log(`[qqnt-chat-export] web UI listening on ${state.url}`)
    sweepExports(path.join(settings.workDir, 'exports'))
  })
  state.server = server

  return {
    url: state.url,
    get error() {
      return state.error
    },
    close: () => new Promise((resolve) => {
      if (!server.listening) {
        resolve()
        return
      }
      server.close(() => resolve())
    }),
  }
}

export { DEFAULT_PORT, DEFAULT_HOST }
