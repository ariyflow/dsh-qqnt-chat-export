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

/** Mutating requests must come from this loopback page, not a cross-site form. */
function isTrustedMutation(req) {
  const origin = req.headers.origin
  if (origin !== undefined && !isLoopbackOrigin(origin)) return false
  // A custom header forces a CORS preflight, which this server never allows.
  return req.headers['x-qqnt-action'] === '1'
}

/** Read a small JSON request body. */
function readJsonBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(Object.assign(new Error('请求体过大'), { status: 413 }))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (size === 0) {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        reject(Object.assign(new Error('请求体不是合法 JSON'), { status: 400 }))
      }
    })
    req.on('error', (error) => reject(Object.assign(error, { status: 400 })))
  })
}

/**
 * Start the detached index builder and resolve once Node knows whether the
 * process really started.
 *
 * `spawn` reports a missing interpreter through an asynchronous `error` event;
 * an unhandled `error` event on a ChildProcess would take the whole host
 * process down. Waiting for `spawn` also lets the HTTP response report a bad
 * `pythonPath` instead of answering 202 for a build that never existed.
 */
function spawnBuild(settings, argv) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(settings.python, argv, {
        windowsHide: true,
        detached: true,
        stdio: 'ignore',
        env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
      })
    } catch (error) {
      resolve({ ok: false, error })
      return
    }
    const onError = (error) => {
      child.removeListener('spawn', onSpawn)
      resolve({ ok: false, error })
    }
    const onSpawn = () => {
      child.removeListener('error', onError)
      // A later error (killed by the OS, for instance) must stay harmless.
      child.on('error', (error) => {
        console.warn(`[qqnt-chat-export] index build child error: ${error.message}`)
      })
      child.unref()
      resolve({ ok: true })
    }
    child.once('error', onError)
    child.once('spawn', onSpawn)
  })
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
    if (command === 'select') {
      argv.push('--account', String(args.account || ''))
      argv.push('--keep', String(settings.keepAccountIndexes ?? 2))
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

/** One file's size/mtime, in the shape the page already reads. */
function fileInfo(file) {
  try {
    const info = statSync(file)
    return { path: file, exists: true, size: info.size, mtime: Math.floor(info.mtimeMs / 1000) }
  } catch {
    return { path: file, exists: false, size: 0, mtime: 0 }
  }
}

/** The helper's progress file; `{ state: 'idle' }` before the first build. */
function readBuildState(workDir) {
  try {
    const value = JSON.parse(readFileSync(path.join(workDir, 'build-status.json'), 'utf8'))
    return value && typeof value === 'object' ? value : { state: 'idle' }
  } catch {
    return { state: 'idle' }
  }
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
 * @param {{ onError?: (error: Error) => void, handlers?: object }} options - notified when the listener cannot bind; handlers serve settings/storage.
 * @returns {{close: () => Promise<void>, url: string, error?: Error, ready: Promise<string>}}
 */
export function startWebServer(settings, port = DEFAULT_PORT, host = DEFAULT_HOST, options = {}) {
  const handlers = options.handlers && typeof options.handlers === 'object' ? options.handlers : {}
  const urlHost = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host
  const state = {
    url: `http://${urlHost}:${port || DEFAULT_PORT}/`,
    error: undefined,
    server: undefined,
    startedAt: Date.now(),
  }
  /**
   * Last successful `status` report plus the index file it described. The page
   * polls `/api/status` every 1.2 s during a build, and spawning Python for
   * each poll would compete with that build for the same disk.
   */
  let statusCache
  // Functions, not constants: the settings page can change `workDir` without
  // restarting the listener (only a port change restarts it).
  const indexFile = () => path.join(settings.workDir, 'index.sqlite')
  const dbFile = () => path.join(settings.workDir, 'nt_msg.db')
  const keyFile = () => path.join(settings.workDir, 'key.txt')

  /**
   * Whether a build is likely running. Three sources because the helper needs
   * a moment to create its lock file, and a recent spawn covers that gap.
   */
  const buildInProgress = () => {
    if (Date.now() - lastBuildSpawnAt < 10_000) return true
    try {
      const status = JSON.parse(readFileSync(path.join(settings.workDir, 'build-status.json'), 'utf8'))
      if (status.state === 'running') return true
    } catch {
      // No status file yet.
    }
    try {
      if (Date.now() - statSync(path.join(settings.workDir, 'build.lock')).mtimeMs < 15 * 60 * 1000) return true
    } catch {
      // No lock file.
    }
    return false
  }

  /** Status from the helper, reused while a build runs or the index is unchanged. */
  const currentStatus = async () => {
    const index = fileInfo(indexFile())
    const build = readBuildState(settings.workDir)
    const cached = statusCache
    const usable = cached && (build.state === 'running'
      || (Date.now() - cached.at < 5000 && cached.path === index.path
        && cached.indexMtime === index.mtime))
    if (!usable) {
      statusCache = {
        at: Date.now(), path: index.path, indexMtime: index.mtime,
        value: await runJson(settings, 'status'),
      }
    }
    const value = statusCache.value
    return {
      ...value,
      db: fileInfo(dbFile()),
      index: { ...(value.index || {}), ...index },
      key: existsSync(keyFile()),
      build,
      workDir: settings.workDir,
      workDirLegacy: settings.workDirLegacy === true,
    }
  }

  let resolveReady
  let rejectReady
  const ready = new Promise((resolve, reject) => {
    resolveReady = resolve
    rejectReady = reject
  })
  ready.catch(() => {})       // callers that ignore ready must not crash the process
  if (!port) return { close: async () => {}, url: '', error: undefined, ready: Promise.resolve('') }

  let pageHtml = ''
  try {
    pageHtml = readFileSync(PAGE, 'utf8')
  } catch (error) {
    state.error = new Error(`page.html is missing: ${error.message}`)
    rejectReady(state.error)
    return { close: async () => {}, url: state.url, error: state.error, ready }
  }

  const server = createServer((req, res) => {
    const hostHeader = String(req.headers.host ?? '')
    const requestHost = hostHeader.startsWith('[')
      ? hostHeader.slice(1, hostHeader.indexOf(']'))
      : hostHeader.split(':')[0]
    if (!LOOPBACK.has(requestHost)) {
      sendJson(res, 403, { error: 'loopback only' })
      return
    }
    const requestUrl = new URL(req.url ?? '/', state.url)
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
    if (req.method === 'GET' && pathname === '/api/settings') {
      if (typeof handlers.getSettings !== 'function') {
        sendJson(res, 501, { error: 'this build has no settings API' })
        return
      }
      try {
        sendJson(res, 200, handlers.getSettings())
      } catch (error) {
        sendJson(res, 500, { error: error.message })
      }
      return
    }
    if ((req.method === 'PUT' || req.method === 'POST') && pathname === '/api/settings') {
      if (!isTrustedMutation(req)) {
        sendJson(res, 403, { error: 'cross-origin requests are refused' })
        return
      }
      if (typeof handlers.updateSettings !== 'function') {
        sendJson(res, 501, { error: 'this build has no settings API' })
        return
      }
      readJsonBody(req)
        .then((patch) => handlers.updateSettings(patch))
        .then((result) => sendJson(res, 200, result))
        .catch((error) => sendJson(res, error.status ?? 400, { error: error.message }))
      return
    }
    if (req.method === 'POST' && pathname === '/api/settings/reset') {
      if (!isTrustedMutation(req)) {
        sendJson(res, 403, { error: 'cross-origin requests are refused' })
        return
      }
      if (typeof handlers.resetSettings !== 'function') {
        sendJson(res, 501, { error: 'this build has no settings API' })
        return
      }
      Promise.resolve()
        .then(() => handlers.resetSettings())
        .then((result) => sendJson(res, 200, result))
        .catch((error) => sendJson(res, error.status ?? 400, { error: error.message }))
      return
    }
    if (req.method === 'GET' && pathname === '/api/storage') {
      if (typeof handlers.getStorage !== 'function') {
        sendJson(res, 501, { error: 'this build has no storage API' })
        return
      }
      try {
        sendJson(res, 200, handlers.getStorage())
      } catch (error) {
        sendJson(res, 500, { error: error.message })
      }
      return
    }
    if (req.method === 'POST' && pathname === '/api/workdir/migrate') {
      if (!isTrustedMutation(req)) {
        sendJson(res, 403, { error: 'cross-origin requests are refused' })
        return
      }
      if (typeof handlers.migrateWorkDir !== 'function') {
        sendJson(res, 501, { error: 'this build has no migration API' })
        return
      }
      Promise.resolve()
        .then(() => handlers.migrateWorkDir())
        .then((result) => sendJson(res, 200, result))
        .catch((error) => sendJson(res, error.status ?? 500, { error: error.message }))
      return
    }
    if (req.method === 'POST' && pathname === '/api/storage/cleanup') {
      if (!isTrustedMutation(req)) {
        sendJson(res, 403, { error: 'cross-origin requests are refused' })
        return
      }
      if (typeof handlers.cleanupStorage !== 'function') {
        sendJson(res, 501, { error: 'this build has no storage API' })
        return
      }
      readJsonBody(req)
        .then((body) => {
          if (body.confirm !== true) {
            throw Object.assign(new Error('删除需要二次确认'), { status: 400 })
          }
          return handlers.cleanupStorage(body.ids)
        })
        .then((result) => sendJson(res, 200, result))
        .catch((error) => sendJson(res, error.status ?? 400, { error: error.message }))
      return
    }
    if (req.method === 'GET' && pathname === '/api/diagnostics') {
      if (typeof handlers.getDiagnostics !== 'function') {
        sendJson(res, 501, { error: 'this build has no diagnostics API' })
        return
      }
      Promise.resolve()
        .then(() => handlers.getDiagnostics())
        .then((result) => sendJson(res, 200, result))
        .catch((error) => sendJson(res, 500, { error: error.message }))
      return
    }
    if (req.method === 'GET' && pathname === '/api/setup') {
      if (typeof handlers.getSetup !== 'function') {
        sendJson(res, 501, { error: 'this build has no setup API' })
        return
      }
      try {
        sendJson(res, 200, handlers.getSetup())
      } catch (error) {
        sendJson(res, 500, { error: error.message })
      }
      return
    }
    if (req.method === 'POST' && pathname === '/api/setup/venv') {
      if (!isTrustedMutation(req)) {
        sendJson(res, 403, { error: 'cross-origin requests are refused' })
        return
      }
      if (typeof handlers.startSetup !== 'function') {
        sendJson(res, 501, { error: 'this build has no setup API' })
        return
      }
      readJsonBody(req)
        .then((body) => {
          if (body.confirm !== true) {
            throw Object.assign(new Error('一键配置需要确认'), { status: 400 })
          }
          return handlers.startSetup(body.source)
        })
        .then((result) => sendJson(res, 202, result))
        .catch((error) => sendJson(res, error.status ?? 400, { error: error.message }))
      return
    }
    if (req.method === 'GET' && pathname === '/api/key/extract') {
      if (typeof handlers.getKeyJob !== 'function') {
        sendJson(res, 501, { error: 'this build has no key extraction API' })
        return
      }
      try {
        sendJson(res, 200, handlers.getKeyJob())
      } catch (error) {
        sendJson(res, 500, { error: error.message })
      }
      return
    }
    if (req.method === 'POST' && pathname === '/api/key/extract') {
      if (!isTrustedMutation(req)) {
        sendJson(res, 403, { error: 'cross-origin requests are refused' })
        return
      }
      if (typeof handlers.startKeyJob !== 'function') {
        sendJson(res, 501, { error: 'this build has no key extraction API' })
        return
      }
      readJsonBody(req)
        .then((body) => {
          if (body.confirm !== true) {
            throw Object.assign(new Error('提取密钥需要确认'), { status: 400 })
          }
          return handlers.startKeyJob(body.force === true)
        })
        .then((result) => sendJson(res, 202, result))
        .catch((error) => sendJson(res, error.status ?? 400, { error: error.message }))
      return
    }
    if (req.method === 'GET' && pathname === '/api/status') {
      const exports = path.join(settings.workDir, 'exports')
      currentStatus()
        .then((status) => sendJson(res, 200, {
          ...status,
          port,
          host,
          exportDir: exports,
          startedAt: state.startedAt,
          version: 1,
        }))
        .catch((error) => sendJson(res, 500, { error: error.message }))
      return
    }
    if (req.method === 'GET' && pathname === '/api/index') {
      currentStatus()
        .then(({ index, build, db, key }) => sendJson(res, 200, { index, build, db, key }))
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
    if (req.method === 'POST' && pathname === '/api/index/select') {
      if (!isTrustedMutation(req)) {
        sendJson(res, 403, { error: 'cross-origin requests are refused' })
        return
      }
      if (typeof handlers.canStartBuild === 'function' && !handlers.canStartBuild()) {
        sendJson(res, 409, { error: '密钥提取或环境配置进行中，请等它结束。' })
        return
      }
      if (buildInProgress()) {
        sendJson(res, 409, { error: '已有一次索引构建正在进行，请等它结束。' })
        return
      }
      readJsonBody(req)
        .then((body) => {
          const account = String(body.account ?? '').trim()
          if (!/^[0-9A-Za-z_-]+$/.test(account)) {
            throw Object.assign(new Error('账号格式不正确'), { status: 400 })
          }
          return runJson(settings, 'select', { account })
        })
        .then((result) => {
          // The live index just changed; the next /api/status must re-read it.
          statusCache = undefined
          sendJson(res, 200, result)
        })
        .catch((error) => {
          const conflict = error.status === 400 && /构建/.test(error.message)
          sendJson(res, conflict ? 409 : (error.status ?? 500), { error: error.message })
        })
      return
    }
    if (req.method === 'POST' && pathname === '/api/index/build') {
      // A page on another origin must not be able to start a 1 GB rebuild.
      const origin = req.headers.origin
      if (origin !== undefined && !isLoopbackOrigin(origin)) {
        sendJson(res, 403, { error: 'cross-origin requests are refused' })
        return
      }
      if (typeof handlers.canStartBuild === 'function' && !handlers.canStartBuild()) {
        sendJson(res, 409, { error: '密钥提取或环境配置进行中，请等它结束。' })
        return
      }
      // Report a running build instead of answering 202 for a spawn that the
      // helper's own lock will immediately refuse. Three sources because the
      // helper needs a moment to create its lock file.
      if (buildInProgress()) {
        sendJson(res, 409, { error: '已有一次索引构建正在进行，请等它结束。' })
        return
      }
      const refresh = params.get('refresh') === '1'
      const argv = ['-X', 'utf8', QUERY_CLI, '--work', settings.workDir]
      if (settings.tencentRoot) argv.push('--root', settings.tencentRoot)
      if (settings.account) argv.push('--account', String(settings.account))
      argv.push('build')
      if (refresh) argv.push('--refresh')
      argv.push('--keep', String(settings.keepAccountIndexes ?? 2))
      argv.push('--search', settings.searchIndex === 'like' ? 'like' : 'fts')
      // Only claim the spawn gap once the child exists; a failed spawn must not
      // make `/api/status` think a build is running for the next ten seconds.
      spawnBuild(settings, argv).then((result) => {
        if (!result.ok) {
          const missing = result.error?.code === 'ENOENT'
          sendJson(res, 500, {
            error: missing
              ? `无法运行 Python 解释器「${settings.python}」：找不到可执行文件。请在设置里检查「Python 解释器」。`
              : `无法启动索引构建：${result.error?.message || '未知错误'}`,
          })
          return
        }
        lastBuildSpawnAt = Date.now()
        sendJson(res, 202, { started: true, refresh })
      })
      return
    }
    sendJson(res, 404, { error: 'not found' })
  })

  server.on('error', (error) => {
    state.error = error
    console.warn(`[qqnt-chat-export] web UI on ${state.url} unavailable: ${error.message}`)
    rejectReady(error)
    options.onError?.(error)
  })
  server.listen(port, host, () => {
    console.log(`[qqnt-chat-export] web UI listening on ${state.url}`)
    sweepExports(path.join(settings.workDir, 'exports'))
    resolveReady(state.url)
  })
  state.server = server

  return {
    url: state.url,
    get error() {
      return state.error
    },
    ready,
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
