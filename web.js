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
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, createReadStream, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createExportQueue, MAX_CONCURRENT } from './exportQueue.js'
import { readPresets, writePresets } from './presets.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const QUERY_CLI = path.join(HERE, 'scripts', 'qqnt_query.py')
const PAGE = path.join(HERE, 'page.html')
const DEFAULT_PORT = 46728
const DEFAULT_HOST = '127.0.0.1'
const REQUEST_TIMEOUT_MS = 180_000
/** One export may combine at most this many chats. */
const MAX_BATCH_CHATS = 200
const EXPORT_DIR_MAX_AGE_MS = 60 * 60 * 1000
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

/**
 * Path of the helper this process runs.
 *
 * `QQNT_HELPER_SCRIPT` is a **test-only** seam. The Node suites used a
 * `#!/bin/sh` wrapper as a fake interpreter, which Windows cannot spawn, so the
 * web routes were the 16 cases that never ran on the Windows CI job. A test now
 * points this variable at a small `.py` fake and runs it with a real
 * interpreter. Only an absolute path is accepted, and the variable is unset in
 * every shipped install — nothing about the default path changes.
 */
function queryCli() {
  const override = process.env.QQNT_HELPER_SCRIPT
  return override && path.isAbsolute(override) ? override : QUERY_CLI
}

/** Reported in the diagnostics bundle; the installed copy ships package.json. */
export const BUNDLE_VERSION = (() => {
  try {
    return String(JSON.parse(readFileSync(path.join(HERE, 'package.json'), 'utf8')).version || '')
  } catch {
    return ''
  }
})()

/** When this process last asked the helper to build; covers the spawn gap. */
let lastBuildSpawnAt = 0

/**
 * Payload behind `GET /api/qqnt/panel`: the address of the local UI plus the
 * counts the DSH sidebar header prints.
 *
 * Metadata only — the panel embeds the page in an iframe, so no chat text ever
 * passes through here. `running` is the host's answer (it owns the listener),
 * and `status` is the same `/api/status` document the page itself uses, so the
 * counts cannot drift from what the page shows.
 */
export function panelInfo(settings, extra = {}) {
  const port = Number(settings?.webPort) || 0
  const host = String(settings?.webHost || '') || '127.0.0.1'
  const urlHost = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host
  const status = extra.status && typeof extra.status === 'object' ? extra.status : null
  const index = (status && status.index) || {}
  const running = extra.running === true && port > 0
  return {
    version: String(extra.version || ''),
    port,
    running,
    url: running ? `http://${urlHost}:${port}/` : '',
    indexed: index.exists === true,
    messages: Number(index.messages || 0),
    chats: Number(index.chats || 0),
    lastSync: Number((status && status.sync && status.sync.lastSyncAt) || 0),
  }
}

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

/** argv prefix shared by every detached helper run. */
function helperArgv(settings, command) {
  const argv = ['-X', 'utf8', queryCli(), '--work', settings.workDir]
  if (settings.tencentRoot) argv.push('--root', settings.tencentRoot)
  if (settings.account) argv.push('--account', String(settings.account))
  argv.push(command)
  return argv
}

/**
 * Run a helper command detached, without blocking the caller.
 *
 * A missing interpreter or a busy lock must cost one log line, not a failed
 * settings save or a crashed host; the next interval retries.
 */
function spawnDetached(settings, argv, label) {
  try {
    const child = spawn(settings.python, argv, {
      windowsHide: true,
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
    })
    child.on('error', (error) => {
      console.warn(`[qqnt-chat-export] ${label} skipped: ${error.message}`)
    })
    child.unref()
    return true
  } catch (error) {
    console.warn(`[qqnt-chat-export] ${label} failed: ${error.message}`)
    return false
  }
}

/**
 * Drop parked account indexes beyond a newly lowered limit.
 *
 * Runs detached and never blocks the settings response: a busy build lock or a
 * missing interpreter only costs a log line, and the next sync prunes again.
 */
export function pruneAccountIndexes(settings, keep) {
  return spawnDetached(settings, helperArgv(settings, 'prune')
    .concat(['--keep', String(keep)]), 'account cache prune')
}

/**
 * One automatic sync: the helper decides whether anything changed, so the
 * timer costs a Python start (and nothing else) when the database is idle.
 */
export function spawnAutosync(settings, { keep, search } = {}) {
  const argv = helperArgv(settings, 'autosync')
  argv.push('--keep', String(keep ?? settings.keepAccountIndexes ?? 2))
  argv.push('--search', search === 'like' ? 'like' : 'fts')
  return spawnDetached(settings, argv, 'automatic sync')
}

/** One python invocation returning parsed JSON from stdout. */
function runJson(settings, command, args = {}, { signal } = {}) {
  return new Promise((resolve, reject) => {
    const argv = ['-X', 'utf8', queryCli(), '--work', settings.workDir]
    if (settings.tencentRoot) argv.push('--root', settings.tencentRoot)
    if (settings.account) argv.push('--account', String(settings.account))
    argv.push(command)
    if (command === 'messages' || command === 'export' || command === 'stats'
      || command === 'media' || command === 'media-list') {
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
    senderRegex: params.get('senderRegex') === '1' ? '1' : '',
    since: params.get('since') || '',
    until: params.get('until') || '',
  }
  for (const key of Object.keys(args)) {
    if (args[key] === '') delete args[key]
  }
  return args
}

/** The same filters, read from a JSON body instead of the query string. */
function filtersFromBody(body) {
  const args = {}
  for (const key of ['chatKind', 'chatId', 'keyword', 'sender', 'since', 'until', 'redact']) {
    const value = body[key]
    if (typeof value === 'string' && value.trim() !== '') args[key] = value.trim()
  }
  // A boolean cannot go through the string loop above.
  if (body.senderRegex === true || body.senderRegex === '1' || body.senderRegex === 'true') {
    args.senderRegex = true
  }
  return args
}

/** Batch selection from a request body; throws a 400-shaped error. */
function chatsFromBody(value) {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) {
    throw Object.assign(new Error('chats 必须是数组'), { status: 400 })
  }
  if (value.length > MAX_BATCH_CHATS) {
    throw Object.assign(new Error(`一次最多导出 ${MAX_BATCH_CHATS} 个会话`), { status: 400 })
  }
  return value.map((item) => {
    const kind = item?.kind
    const id = String(item?.id ?? '').trim()
    if (!['group', 'private'].includes(kind) || id === '') {
      throw Object.assign(new Error('每个会话都需要 kind（group/private）和 id'), { status: 400 })
    }
    const label = typeof item?.label === 'string' ? item.label.slice(0, 120) : ''
    return { kind, id, label }
  })
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

/** Per-chat alias/pin/hide flags; kept beside the index, never inside it. */
function chatStateFile(workDir) {
  return path.join(workDir, 'chats-state.json')
}

function readChatState(workDir) {
  try {
    const value = JSON.parse(readFileSync(chatStateFile(workDir), 'utf8'))
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  } catch {
    return {}
  }
}

function writeChatState(workDir, value) {
  const file = chatStateFile(workDir)
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify(value, null, 2))
  renameSync(tmp, file)
}

/** Merge aliases/pins/hides into the helper's session list (pinned first). */
function mergeChatState(workDir, sessions, includeHidden) {
  const states = readChatState(workDir)
  const out = []
  for (const session of Array.isArray(sessions) ? sessions : []) {
    const patch = states[`${session.kind}:${session.id}`] || {}
    if (patch.hidden && !includeHidden) continue
    out.push({
      ...session,
      name: typeof patch.alias === 'string' && patch.alias.trim()
        ? patch.alias.trim() : session.name,
      alias: typeof patch.alias === 'string' ? patch.alias : '',
      pinned: patch.pinned === true,
      hidden: patch.hidden === true,
    })
  }
  // V8 sorts stably, so pinned chats keep their newest-first order.
  out.sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0))
  return out
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

/** The last automatic sync; `{}` before the first tick. */
export function readSyncState(workDir) {
  try {
    const value = JSON.parse(readFileSync(path.join(workDir, 'sync-status.json'), 'utf8'))
    return value && typeof value === 'object' ? value : {}
  } catch {
    return {}
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

/** Last path segment only: a bundle must not carry a user's home directory. */
export function lastSegment(value) {
  const text = String(value ?? '').replace(/[\\/]+$/, '')
  if (text === '') return ''
  const parts = text.split(/[\\/]/).filter((part) => part !== '')
  return parts.length > 0 ? parts[parts.length - 1] : text
}

/** 8 hex digits stand in for an account number; enough to tell two apart. */
export function accountDigest(value) {
  const text = String(value ?? '').trim()
  if (text === '') return ''
  return createHash('sha1').update(text).digest('hex').slice(0, 8)
}

/** Epoch seconds → ISO, or '' when the stamp is missing. */
function isoSeconds(value) {
  const seconds = Number(value)
  return Number.isFinite(seconds) && seconds > 0
    ? new Date(seconds * 1000).toISOString()
    : ''
}

/**
 * Assemble the downloadable diagnostics bundle.
 *
 * White-listed field by field rather than filtered from the live payload: a new
 * `diagnostics` field has to be added here on purpose, so a future release
 * cannot leak chat text, a nickname, a cached key or an account number into a
 * file the user attaches to a public issue. Paths keep their last segment only,
 * account numbers become `sha1(...)[:8]`, and free-text errors are scrubbed of
 * the paths and accounts this module already knows.
 *
 * Pure apart from the scrubbing list (and `now`/`storage` are injectable), so
 * the tests can pin exactly what a user would upload.
 *
 * @returns {object} JSON-serialisable bundle
 */
export function diagnosticsBundle({
  version = '', diagnostics = {}, status = {}, storage = null, now = new Date(),
} = {}) {
  const platform = diagnostics.platform || null
  const paths = diagnostics.paths || null
  const schema = diagnostics.schema || null
  const index = status.index || {}
  const build = status.build || {}
  const sync = status.sync || {}
  const uv = diagnostics.uv || {}

  const scrubbers = [
    [os.homedir(), '~'],
    [platform?.account, accountDigest(platform?.account)],
    [index.account, accountDigest(index.account)],
    [paths?.workDir, lastSegment(paths?.workDir)],
    [paths?.tencentRoot, lastSegment(paths?.tencentRoot)],
    [paths?.dbDir, lastSegment(paths?.dbDir)],
    [paths?.dataDir, lastSegment(paths?.dataDir)],
    [paths?.python, lastSegment(paths?.python)],
    [diagnostics.python, lastSegment(diagnostics.python)],
  ].filter(([from]) => typeof from === 'string' && from !== '')
  const scrub = (text) => {
    let out = String(text ?? '')
    if (out === '') return ''
    for (const [from, to] of scrubbers) out = out.split(from).join(to)
    return out.length > 300 ? `${out.slice(0, 300)}…` : out
  }
  const bytesFor = (id) => {
    const item = (storage?.items || []).find((entry) => entry.id === id)
    return item ? Number(item.bytes || 0) : 0
  }
  const startedAt = Number(build.startedAt || 0)
  const finishedAt = Number(build.finishedAt || 0)
  return {
    version,
    generatedAt: now.toISOString(),
    platform: platform ? {
      os: String(platform.os || ''),
      arch: String(platform.arch || ''),
      bits: Number(platform.bits || 0),
      python: String(platform.python || ''),
      sqlcipher: platform.sqlcipher === true,
      pyzipper: platform.pyzipper === true,
      qqProcesses: Number(platform.qqProcesses || 0),
      memoryAccess: String(platform.memoryAccess || ''),
      dataRootFound: platform.dataRootFound === true,
      accounts: Number(platform.accounts || 0),
      account: accountDigest(platform.account),
    } : null,
    paths: paths ? {
      tencentRoot: lastSegment(paths.tencentRoot),
      dbDir: lastSegment(paths.dbDir),
      dataDir: lastSegment(paths.dataDir),
      workDir: lastSegment(paths.workDir),
      python: lastSegment(paths.python),
      index: lastSegment(paths.index),
      venv: lastSegment(paths.venv),
    } : null,
    schema: schema ? {
      fingerprint: String(schema.fingerprint || ''),
      missing: Array.isArray(schema.missing) ? schema.missing : [],
      unchecked: Array.isArray(schema.unchecked) ? schema.unchecked : [],
      tables: schema.tables || {},
    } : null,
    index: {
      exists: index.exists === true,
      version: String(index.version || ''),
      schema: String(index.schema || ''),
      messages: Number(index.messages || 0),
      chats: Number(index.chats || 0),
      search: String(index.search || ''),
      account: accountDigest(index.account),
      bytes: Number(index.size || 0),
    },
    build: {
      state: String(build.state || 'idle'),
      mode: String(build.mode || ''),
      seconds: finishedAt > startedAt ? finishedAt - startedAt : 0,
      walPending: build.walPending === true,
      schemaChanged: build.schemaChanged === true,
      fullReason: String(build.fullReason || ''),
      error: scrub(build.error),
    },
    sync: {
      autoSync: sync.autoSync !== false,
      intervalMinutes: Number(sync.intervalMinutes || 60),
      lastRun: isoSeconds(sync.lastSyncAt),
      error: scrub(sync.error),
    },
    deps: {
      sqlcipher3: platform ? platform.sqlcipher === true : false,
      pyzipper: platform ? platform.pyzipper === true : false,
      uv: String(uv.version || ''),
      probeError: scrub(diagnostics.error),
      infoError: scrub(diagnostics.infoError),
    },
    storage: {
      decryptedBytes: bytesFor('decrypted'),
      indexBytes: bytesFor('index'),
      exportsBytes: bytesFor('exports'),
      totalBytes: Number(storage?.totalBytes || 0),
    },
    errors: [scrub(build.error), scrub(sync.error)].filter((text) => text !== ''),
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
      sync: {
        ...readSyncState(settings.workDir),
        autoSync: settings.autoSync !== false,
        intervalMinutes: settings.syncIntervalMinutes ?? 60,
      },
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

  // Long exports belong to a queue, not to one request: parsing a 1.2M-row
  // account takes minutes and used to be cut at the 180-second timeout.
  const queue = createExportQueue({ settings, queryCli: queryCli() })

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
        'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; media-src 'self'",
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
        // A separate key on purpose: `version` in this payload is the Python
        // interpreter (the settings page prints "Python <version>"), so the
        // plugin build gets its own name instead of shadowing it.
        .then((result) => sendJson(res, 200, { ...result, pluginVersion: BUNDLE_VERSION }))
        .catch((error) => sendJson(res, 500, { error: error.message }))
      return
    }
    if (req.method === 'GET' && pathname === '/api/diagnostics/bundle') {
      // Read-only, so the loopback Host check above is enough; no action header.
      if (typeof handlers.getDiagnostics !== 'function') {
        sendJson(res, 501, { error: 'this build has no diagnostics API' })
        return
      }
      Promise.resolve()
        .then(async () => {
          const diagnostics = await handlers.getDiagnostics()
          // A broken helper still has to produce a bundle: the failure itself
          // (`infoError`) is the most useful thing in it.
          const status = await currentStatus().catch(() => ({}))
          const storage = typeof handlers.getStorage === 'function'
            ? handlers.getStorage()
            : null
          return diagnosticsBundle({ version: BUNDLE_VERSION, diagnostics, status, storage })
        })
        .then((bundle) => {
          const stamp = new Date()
          const pad = (n) => String(n).padStart(2, '0')
          const name = `qqnt-diagnostics-${bundle.version || 'unknown'}`
            + `-${stamp.getFullYear()}${pad(stamp.getMonth() + 1)}${pad(stamp.getDate())}`
            + `-${pad(stamp.getHours())}${pad(stamp.getMinutes())}.json`
          const body = Buffer.from(`${JSON.stringify(bundle, null, 2)}\n`, 'utf8')
          res.writeHead(200, {
            'content-type': 'application/json; charset=utf-8',
            'content-disposition': `attachment; filename="${name}"`,
            'content-length': body.length,
            'cache-control': 'no-store',
          })
          res.end(body)
        })
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
        .then((payload) => sendJson(res, 200, {
          sessions: mergeChatState(settings.workDir, payload.sessions,
            params.get('hidden') === '1'),
        }))
        .catch((error) => sendJson(res, 500, { error: error.message }))
      return
    }
    if (req.method === 'POST' && pathname === '/api/chats/state') {
      if (!isTrustedMutation(req)) {
        sendJson(res, 403, { error: 'cross-origin requests are refused' })
        return
      }
      readJsonBody(req)
        .then((body) => {
          const kind = body.kind
          const id = String(body.id ?? '').trim()
          if (!['group', 'private'].includes(kind) || id === '') {
            throw Object.assign(new Error('kind 与 id 都是必需的'), { status: 400 })
          }
          const patch = body.patch && typeof body.patch === 'object' ? body.patch : {}
          const allowed = {}
          if (typeof patch.alias === 'string') allowed.alias = patch.alias.trim().slice(0, 80)
          if (typeof patch.pinned === 'boolean') allowed.pinned = patch.pinned
          if (typeof patch.hidden === 'boolean') allowed.hidden = patch.hidden
          if (!Object.keys(allowed).length) {
            throw Object.assign(new Error('没有可保存的字段'), { status: 400 })
          }
          const states = readChatState(settings.workDir)
          const key = `${kind}:${id}`
          const next = { ...(states[key] || {}), ...allowed }
          if (!next.alias) delete next.alias
          if (next.pinned === false) delete next.pinned
          if (next.hidden === false) delete next.hidden
          if (Object.keys(next).length) states[key] = next
          else delete states[key]
          writeChatState(settings.workDir, states)
          return { key, state: states[key] || {} }
        })
        .then((result) => sendJson(res, 200, result))
        .catch((error) => sendJson(res, error.status ?? 500, { error: error.message }))
      return
    }
    if (req.method === 'GET' && pathname === '/api/stats') {
      runJson(settings, 'stats', filtersFrom(params))
        .then((payload) => sendJson(res, 200, payload))
        .catch((error) => sendJson(res, error.status ?? 500, { error: error.message }))
      return
    }
    if (req.method === 'GET' && pathname === '/api/messages') {
      const args = {
        ...filtersFrom(params),
        offset: readInt(params.get('offset'), 0),
        limit: Math.min(Math.max(readInt(params.get('limit'), 50), 1), 500),
      }
      // "View in chat": the helper resolves the anchor and returns its context,
      // ignoring the paging and the other filters.
      const around = params.get('around')
      if (around) args.around = around
      runJson(settings, 'messages', args)
        .then((payload) => sendJson(res, 200, payload))
        .catch((error) => sendJson(res, error.status ?? 409, { error: error.message }))
      return
    }
    if (req.method === 'GET' && pathname === '/api/media/list') {
      const kind = params.get('chatKind')
      const chatId = params.get('chatId')
      if (!['group', 'private'].includes(kind) || !chatId) {
        sendJson(res, 400, { error: 'chatKind 和 chatId 都是必需的' })
        return
      }
      runJson(settings, 'media-list', {
        chatKind: kind,
        chatId,
        offset: readInt(params.get('offset'), 0),
        limit: Math.min(Math.max(readInt(params.get('limit'), 60), 1), 200),
      })
        .then((payload) => sendJson(res, 200, payload))
        .catch((error) => sendJson(res, error.status ?? 500, { error: error.message }))
      return
    }
    // One media file of one message: the helper resolves the path inside
    // nt_data, and this process only streams the bytes.
    const mediaMatch = pathname.match(/^\/api\/media\/(\d+)$/)
    if (req.method === 'GET' && mediaMatch) {
      const args = {
        rowId: Number(mediaMatch[1]),
        seq: Math.max(readInt(params.get('seq'), 1), 1),
      }
      if (params.get('thumb') === '1') args.thumb = true
      runJson(settings, 'media', args)
        .then((payload) => {
          let info
          try {
            info = statSync(payload.path)
          } catch {
            throw Object.assign(new Error('媒体文件已不存在'), { status: 404 })
          }
          const etag = `"${info.size}-${Math.floor(info.mtimeMs)}"`
          if (req.headers['if-none-match'] === etag) {
            res.writeHead(304, { etag, 'cache-control': 'private, max-age=3600' })
            res.end()
            return
          }
          const name = encodeURIComponent(path.basename(String(payload.name || 'media')))
          res.writeHead(200, {
            'content-type': payload.mime || 'application/octet-stream',
            'content-length': info.size,
            'cache-control': 'private, max-age=3600',
            etag,
            'content-disposition': `inline; filename*=UTF-8''${name}`,
            'x-content-type-options': 'nosniff',
          })
          const stream = createReadStream(payload.path)
          stream.on('error', () => res.destroy())
          stream.pipe(res)
        })
        .catch((error) => sendJson(
          res, error.status === 400 ? 404 : (error.status ?? 500), { error: error.message }))
      return
    }
    if (req.method === 'POST' && pathname === '/api/export/queue') {
      if (!isTrustedMutation(req)) {
        sendJson(res, 403, { error: 'cross-origin requests are refused' })
        return
      }
      readJsonBody(req)
        .then((body) => {
          const innerFormat = String(body.format || 'txt').toLowerCase()
          const allowed = new Set(['txt', 'csv', 'json', 'md', 'html', 'sqlite'])
          if (!allowed.has(innerFormat)) {
            throw Object.assign(new Error(`unsupported format: ${innerFormat}`), { status: 400 })
          }
          const chats = chatsFromBody(body.chats)
          const media = body.media === true
          const embed = body.embed === true
          const split = body.split === 'day' ? 'day' : ''
          const password = typeof body.password === 'string' ? body.password : ''
          if (password && (password.length < 4 || password.length > 128)) {
            throw Object.assign(new Error('ZIP 密码长度需要 4~128 个字符'), { status: 400 })
          }
          if (password && embed) {
            throw Object.assign(new Error('内嵌图片不能和密码 ZIP 同时使用'), { status: 400 })
          }
          if (body.split && body.split !== 'day') {
            throw Object.assign(new Error('split 只支持 day'), { status: 400 })
          }
          if (embed && innerFormat !== 'html') {
            throw Object.assign(new Error('内嵌图片只支持 html 格式'), { status: 400 })
          }
          if (embed && chats.length > 1) {
            throw Object.assign(new Error('内嵌图片只支持单个会话'), { status: 400 })
          }
          if (embed && split) {
            throw Object.assign(new Error('内嵌图片不能和按天分文件同时使用'), { status: 400 })
          }
          const container = embed ? innerFormat
            : (chats.length > 0 || media || split || password ? 'zip' : innerFormat)
          const label = String(body.label || (chats.length > 1
            ? `批量导出 ${chats.length} 个会话` : 'QQ聊天记录')).slice(0, 120)
          const columns = Array.isArray(body.columns)
            ? body.columns.map((name) => String(name).trim()).filter(Boolean)
            : null
          const args = filtersFromBody(body)
          if (chats.length > 0) args.chats = chats
          if (media || embed) args.media = true
          if (embed) args.embed = true
          if (split) args.split = 'day'
          if (columns && columns.length > 0) args.columns = columns
          if (body.frontMatter === true) args.frontMatter = true
          const queued = queue.enqueue(args, {
            label, format: container, innerFormat, password,
          })
          if (!queued) {
            throw Object.assign(new Error(
              `最多同时 ${MAX_CONCURRENT} 个导出任务，等一个完成再试`), { status: 429 })
          }
          sendJson(res, 202, { id: queued.id, task: queued })
        })
        .catch((error) => sendJson(res, error.status ?? 500, { error: error.message }))
      return
    }
    if (req.method === 'GET' && pathname === '/api/export/queue') {
      sendJson(res, 200, queue.list())
      return
    }
    const cancelMatch = /^\/api\/export\/queue\/([0-9a-z]+)\/cancel$/.exec(pathname)
    if (req.method === 'POST' && cancelMatch) {
      if (!isTrustedMutation(req)) {
        sendJson(res, 403, { error: 'cross-origin requests are refused' })
        return
      }
      const id = cancelMatch[1]
      if (!queue.get(id)) {
        sendJson(res, 404, { error: '没有这个导出任务' })
        return
      }
      const cancelled = queue.cancel(id)
      if (!cancelled) {
        sendJson(res, 409, { error: '这个任务已经结束' })
        return
      }
      sendJson(res, 200, { task: cancelled })
      return
    }
    if (pathname === '/api/presets' && req.method === 'GET') {
      sendJson(res, 200, { presets: readPresets(settings.workDir) })
      return
    }
    if (pathname === '/api/presets' && req.method === 'POST') {
      readJsonBody(req)
        .then((body) => {
          // The page owns the whole list, so a POST replaces it. Naming a
          // preset twice is a mistake, not a merge.
          const rows = Array.isArray(body?.presets) ? body.presets : []
          const saved = writePresets(settings.workDir, rows)
          sendJson(res, 200, { presets: saved })
        })
        .catch((error) => sendJson(res, error.status ?? 400, { error: error.message }))
      return
    }

    if (req.method === 'GET' && pathname.startsWith('/api/export/queue/')) {
      const rest = pathname.slice('/api/export/queue/'.length)
      const match = /^([0-9a-z]+)(\/file)?$/.exec(rest)
      if (!match) {
        sendJson(res, 404, { error: 'not found' })
        return
      }
      const task = queue.get(match[1])
      if (!match[2]) {
        // Polling one task: return its state even while it is still running.
        if (!task) {
          sendJson(res, 404, { error: '没有这个导出任务（可能已被清理）' })
          return
        }
        sendJson(res, 200, { task })
        return
      }
      const found = queue.file(match[1])
      if (!found) {
        sendJson(res, task ? 409 : 404, {
          error: task
            ? (task.state === 'gone'
              ? '导出文件已清理（导出目录只保留一小时）'
              : '导出还没有完成')
            : '没有这个导出任务（可能已被清理）',
        })
        return
      }
      const filename = `${safeFileStem(found.task.label)}_${stamp()}.${found.task.format}`
      res.writeHead(200, {
        'content-type': found.task.format === 'html'
          ? 'text/html; charset=utf-8' : 'application/octet-stream',
        'content-disposition':
          `attachment; filename="qqnt-export-${Date.now()}.${found.task.format}"; ` +
          `filename*=UTF-8''${encodeURIComponent(filename)}`,
        'cache-control': 'no-store',
      })
      const stream = createReadStream(found.path)
      stream.on('error', () => {
        if (!res.headersSent) sendJson(res, 500, { error: '导出文件不可读' })
        else res.end()
      })
      stream.pipe(res)
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
      const argv = ['-X', 'utf8', queryCli(), '--work', settings.workDir]
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
      queue.close()
      if (!server.listening) {
        resolve()
        return
      }
      server.close(() => resolve())
    }),
  }
}

export { DEFAULT_PORT, DEFAULT_HOST }
