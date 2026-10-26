/**
 * Host half of the QQ NT chat export bundle.
 *
 * Registers four model-facing tools that drive `scripts/qqnt_export.py` — the
 * exporter from the `qqnt-chat-export-skill` — so an Agent can inspect the local
 * NTQQ install, recover the SQLCipher key from the running client, list group
 * chats, and export one group's history. The bundled Python file is used
 * unmodified; this module only owns argument mapping, the environment probe,
 * secret redaction, and result shaping.
 *
 * It also serves a local browsing UI on its own port (see `web.js`), which reads
 * the same data through `scripts/qqnt_query.py`.
 */
import { spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  clearOverrides,
  defaultVenvDir,
  loadOverrides,
  publicSettings,
  resolveSettings,
  saveOverrides,
  settingsFile,
  validatePatch,
  venvPython,
} from './settings.js'
import { buildRunning, cleanupStorage, storageSnapshot } from './storage.js'
import { startWebServer } from './web.js'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'qqnt-chat-export'
/** Services this bundle registers into. */
export const inject = ['tools', 'systemPrompt']

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CLI = path.join(HERE, 'scripts', 'qqnt_export.py')

const DEFAULT_FORMATS = ['txt', 'sqlite', 'csv']
/** One-click setup can use the default PyPI or the Tsinghua mirror. */
const SETUP_SOURCES = {
  default: null,
  tsinghua: 'https://pypi.tuna.tsinghua.edu.cn/simple',
}
const KEY_TIMEOUT_MS = 10 * 60_000
const EXPORT_TIMEOUT_MS = 15 * 60_000
/** Prompt placement after the built-in `tools:sdk` section. */
const PROMPT_ORDER = 5000

/** One-line probe: Python version, pointer width, and whether sqlcipher3 resolves. */
const PYTHON_PROBE = "import json,struct,sys,importlib.util as u;print(json.dumps({'version':sys.version.split()[0],'bits':struct.calcsize('P')*8,'sqlcipher3':u.find_spec('sqlcipher3') is not None}))"

/**
 * The user's downloads directory, following the XDG user-dirs file on Linux.
 * Its localized name (e.g. `~/下载`) means `~/Downloads` is not a safe guess.
 */
function defaultDownloadDir() {
  if (process.platform === 'win32') return path.join(os.homedir(), 'Downloads')
  const fromEnv = process.env.XDG_DOWNLOAD_DIR
  if (fromEnv) return path.resolve(fromEnv)
  try {
    const configHome = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config')
    const file = path.join(configHome, 'user-dirs.dirs')
    const match = /^XDG_DOWNLOAD_DIR="(.*)"$/m.exec(readFileSync(file, 'utf8'))
    if (match) {
      return path.resolve(match[1].replace(/^\$HOME(?=\/|$)/, os.homedir()))
    }
  } catch {
    // No XDG config; fall through to the conventional name.
  }
  return path.join(os.homedir(), 'Downloads')
}

/** SQLCipher writes one native error block per rejected candidate key. */
const SQLCIPHER_NOISE = /ERROR CORE (?:sqlcipher_|sqlite3Codec:)/
/** Cap on retained stdout; exporter progress lines are tiny. */
const MAX_STDOUT_CHARS = 256 * 1024
/** Retained stderr lines, newest kept. */
const STDERR_LINE_LIMIT = 300

/**
 * Run one program and collect bounded, filtered output.
 *
 * Extracting a key validates tens of thousands of wrong candidates, and
 * SQLCipher writes a native error block per candidate to stderr — several
 * megabytes of output that says nothing about the run. Those blocks are counted
 * and folded away here; the exporter's own diagnostics are kept.
 *
 * @returns {Promise<{code: number, output: string}>}
 */
function run(command, argv, { signal, cwd }) {
  if (signal?.aborted) {
    return Promise.reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
  }
  return new Promise((resolve, reject) => {
    const child = spawn(command, argv, {
      cwd,
      windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const stdout = []
    let stdoutChars = 0
    let stdoutTruncated = false
    const stderrLines = []
    let foldedNoise = 0
    let droppedLines = 0
    let pending = ''

    const keepStderrLine = (line) => {
      const text = line.endsWith('\r') ? line.slice(0, -1) : line
      if (SQLCIPHER_NOISE.test(text)) {
        foldedNoise += 1
        return
      }
      stderrLines.push(text)
      if (stderrLines.length > STDERR_LINE_LIMIT) {
        stderrLines.shift()
        droppedLines += 1
      }
    }

    const onAbort = () => child.kill()
    signal?.addEventListener('abort', onAbort, { once: true })
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      if (stdoutChars >= MAX_STDOUT_CHARS) {
        stdoutTruncated = true
        return
      }
      stdout.push(chunk)
      stdoutChars += chunk.length
    })
    child.stderr.on('data', (chunk) => {
      pending += chunk
      let index = pending.indexOf('\n')
      while (index !== -1) {
        keepStderrLine(pending.slice(0, index))
        pending = pending.slice(index + 1)
        index = pending.indexOf('\n')
      }
      if (pending.length > 8192) {
        keepStderrLine(pending)
        pending = ''
      }
    })
    child.on('error', (error) => {
      signal?.removeEventListener('abort', onAbort)
      reject(error.code === 'ENOENT'
        ? new Error(`cannot run "${command}": not found on PATH. Set pythonPath in the config of this bundle to a 64-bit Python 3 executable${process.platform === 'win32' ? ' (for example python.exe).' : ' (for example python3 or the python binary of a virtualenv).'}`)
        : error)
    })
    child.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort)
      if (pending !== '') keepStderrLine(pending)
      const sections = []
      const text = stdout.join('').trimEnd()
      if (text !== '') sections.push(stdoutTruncated ? `${text}\n[输出过长，仅保留前 256 KB]` : text)
      if (droppedLines > 0) sections.push(`[较早的 ${droppedLines} 行 stderr 已省略]`)
      const kept = stderrLines.join('\n').trim()
      if (kept !== '') sections.push(kept)
      if (foldedNoise > 0) sections.push(`[已折叠 ${foldedNoise} 行 SQLCipher 逐候选项解密日志]`)
      resolve({ code: code ?? -1, output: sections.join('\n') })
    })
  })
}

/**
 * Keep the extracted database key out of the transcript. The exact cached key is
 * replaced wherever the exporter echoes it; `key.txt` in the work directory
 * still holds it for later calls. Other paths on the same lines stay intact.
 */
function redactSecrets(text, keyFile) {
  let result = text
  try {
    const key = readFileSync(keyFile, 'utf8').trim()
    if (key.length >= 8) result = result.split(key).join('<redacted>')
  } catch {
    // No cached key yet; the narrow patterns below still cover the echo.
  }
  return result
    .replace(/(找到密钥:\s*)([!-~]{16})/g, '$1<redacted>')
    .replace(/(可强制重新提取[）)]?:\s*)([!-~]{16})/g, '$1<redacted>')
}

/** Global options of the CLI; argparse requires them before the subcommand. */
function globalArgs(settings, account) {
  const argv = ['--work', settings.workDir]
  if (settings.tencentRoot) argv.push('--root', settings.tencentRoot)
  if (account) argv.push('--account', String(account))
  return argv
}

/** Run the exporter and return its exit code plus scrubbed combined output. */
async function runCli(settings, argv, exec) {
  if (!existsSync(CLI)) throw new Error(`bundled helper is missing: ${CLI}`)
  mkdirSync(settings.workDir, { recursive: true, mode: 0o700 })
  const result = await run(settings.python, ['-X', 'utf8', CLI, ...argv], {
    signal: exec.signal,
    cwd: settings.workDir,
  })
  return { code: result.code, output: redactSecrets(result.output, path.join(settings.workDir, 'key.txt')) }
}

/** Parse the exporter's fixed-width group table; a best-effort convenience. */
function parseGroupTable(text) {
  const rows = []
  for (const line of text.split('\n')) {
    const match = /^(\d{5,12})\s+(\d+)\s+(\S+)\s+(\S+)(?:\s+(.*))?$/.exec(line.trim())
    if (match) {
      rows.push({
        id: match[1],
        messages: Number(match[2]),
        first: match[3] === '-' ? '' : match[3],
        last: match[4] === '-' ? '' : match[4],
        name: (match[5] ?? '').trim(),
      })
    }
  }
  return rows
}

/** The canonical output value shared by every tool in this bundle. */
function outputSchema(extra = {}) {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['ok', 'exitCode', 'output', ...Object.keys(extra)],
    properties: {
      ok: { type: 'boolean' },
      exitCode: { type: 'integer' },
      output: { type: 'string' },
      ...extra,
    },
  }
}

/** Default renderer: the exporter's own report, with failure called out first. */
function renderReport(_args, value) {
  const body = value.output === '' ? '(no output)' : value.output
  return [{
    type: 'text',
    text: value.ok ? body : `The exporter failed (exit code ${value.exitCode}).\n\n${body}`,
  }]
}

/** Renderer for the status tool: the probe verdict above the exporter report. */
function renderStatus(_args, value) {
  const lines = []
  if (value.pythonVersion !== '') {
    lines.push(`Python ${value.pythonVersion} (${value.bits}-bit); sqlcipher3 ${value.sqlcipher3 ? 'available' : 'MISSING'}`)
    if (!value.sqlcipher3) {
      lines.push(`Install it with: ${value.pythonPath} -m pip install sqlcipher3-wheels`)
    }
  }
  if (value.output !== '') lines.push(value.output)
  return [{ type: 'text', text: lines.join('\n\n') }]
}

/** One executable that takes a single group number and one output directory. */
function exportTool(settings) {
  return {
    name: 'qqnt_export_group',
    description: 'Export one QQ group\'s message history to an output directory as plain text, SQLite, and CSV, and return the exporter\'s report for that run.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['group'],
      properties: {
        group: {
          type: 'string',
          description: 'QQ group number, digits only.',
        },
        outDir: {
          type: 'string',
          description: 'Absolute output directory. Defaults to QQ导出_<group> inside the user\'s downloads folder (the XDG download directory on Linux).',
        },
        formats: {
          type: 'array',
          items: { type: 'string', enum: DEFAULT_FORMATS },
          description: 'Files to write. Defaults to all three.',
        },
        account: {
          type: 'string',
          description: 'QQ number to read when the client holds more than one account. Defaults to the account with the largest message database.',
        },
      },
    },
    output: {
      schema: outputSchema({ outDir: { type: 'string' } }),
      render: renderReport,
    },
    timeoutMs: EXPORT_TIMEOUT_MS,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const group = String(args.group).trim()
      const outDir = typeof args.outDir === 'string' && args.outDir.trim() !== ''
        ? path.resolve(args.outDir.trim())
        : path.join(defaultDownloadDir(), `QQ导出_${group}`)
      const formats = Array.isArray(args.formats) && args.formats.length > 0
        ? [...new Set(args.formats)].filter((format) => DEFAULT_FORMATS.includes(format))
        : DEFAULT_FORMATS
      const argv = [
        ...globalArgs(settings, args.account),
        'export',
        '--group', group,
        '--out', outDir,
        '--format', (formats.length > 0 ? formats : DEFAULT_FORMATS).join(','),
      ]
      const { code, output } = await runCli(settings, argv, exec)
      return { ok: code === 0, exitCode: code, output, outDir }
    },
  }
}

/** Registers the exporter's four commands as tools. */
function statusTool(settings) {
  return {
    name: 'qqnt_status',
    description: 'Report whether this machine can export QQ chats: the running QQ client, each account\'s message-database size, any cached database key, and the Python SQLCipher dependency.',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: {
      schema: outputSchema({
        pythonPath: { type: 'string' },
        pythonVersion: { type: 'string' },
        bits: { type: 'integer' },
        sqlcipher3: { type: 'boolean' },
      }),
      render: renderStatus,
    },
    isConcurrencySafe: () => true,
    async execute(_args, exec) {
      let pythonVersion = ''
      let bits = 0
      let sqlcipher3 = false
      let probeError = ''
      try {
        const probe = await run(settings.python, ['-X', 'utf8', '-c', PYTHON_PROBE], { signal: exec.signal })
        const info = JSON.parse(probe.output.trim().split('\n').pop() ?? '{}')
        pythonVersion = String(info.version ?? '')
        bits = Number(info.bits ?? 0)
        sqlcipher3 = info.sqlcipher3 === true
      } catch (error) {
        probeError = `Environment check failed: ${error instanceof Error ? error.message : String(error)}`
      }
      const report = await runCli(settings, [...globalArgs(settings), 'info'], exec)
      const output = [probeError, report.output].filter((part) => part !== '').join('\n\n')
      return {
        ok: report.code === 0 && probeError === '',
        exitCode: report.code,
        output,
        pythonPath: settings.python,
        pythonVersion,
        bits,
        sqlcipher3,
      }
    },
  }
}

function keyTool(settings) {
  return {
    name: 'qqnt_extract_key',
    description: 'Recover the local QQ message-database key from the running, logged-in QQ client and cache it for later calls. A first extraction takes one to three minutes.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        account: {
          type: 'string',
          description: 'QQ number to read when the client holds more than one account. Defaults to the account with the largest message database.',
        },
        force: {
          type: 'boolean',
          description: 'Extract again even though a cached key already opens the database.',
        },
      },
    },
    output: { schema: outputSchema(), render: renderReport },
    timeoutMs: KEY_TIMEOUT_MS,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const argv = [...globalArgs(settings, args.account), 'key']
      if (args.force === true) argv.push('--force')
      const { code, output } = await runCli(settings, argv, exec)
      return { ok: code === 0, exitCode: code, output }
    },
  }
}

function groupsTool(settings) {
  return {
    name: 'qqnt_list_groups',
    description: 'List the group chats stored in the account\'s message database with message count, first and last message date, and group name, most active first.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        account: {
          type: 'string',
          description: 'QQ number to read when the client holds more than one account. Defaults to the account with the largest message database.',
        },
      },
    },
    output: {
      schema: outputSchema({
        groups: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['id', 'messages', 'first', 'last', 'name'],
            properties: {
              id: { type: 'string' },
              messages: { type: 'integer' },
              first: { type: 'string' },
              last: { type: 'string' },
              name: { type: 'string' },
            },
          },
        },
      }),
      render: renderReport,
    },
    timeoutMs: EXPORT_TIMEOUT_MS,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const { code, output } = await runCli(settings, [...globalArgs(settings, args.account), 'groups'], exec)
      return { ok: code === 0, exitCode: code, output, groups: parseGroupTable(output) }
    },
  }
}

/** Workflow and guardrails the tool definitions do not carry. */
const GUIDANCE = `## QQ chat export

The qqnt_* tools read the message database of the NTQQ client installed on this machine. Use them in order: qqnt_status, then qqnt_extract_key, then qqnt_list_groups, then qqnt_export_group. Key extraction only works while QQ is logged in; when it finds no key, ask the user to confirm QQ is signed in rather than retrying. Confirm the exact group number with the user before exporting, because the common off-by-one-digit guess exports nothing. Never move, edit, or delete files under the QQ data directory, and do not end the QQ process. Never install Python packages into the global/system interpreter; use a virtualenv, and the local web UI offers a one-click venv setup. On Linux the key is read from the qq main process memory: if the kernel's ptrace scope denies it, the tool prints the exact sysctl command to run; report that fix instead of retrying blindly.`

/** Appended only while the browsing UI is actually listening. */
function webGuidance(url) {
  return ` The same data, including private chats and keyword search across every chat, is browsable at ${url} in a browser tab; that page also downloads the current query as txt, csv, json, markdown, html, or sqlite. The page opens with a startup checklist that names this URL, checks Python/sqlcipher3 and the cached key, and offers a one-click setup that creates a private virtualenv and installs sqlcipher3-wheels into it. The same checklist and the settings page have a 提取密钥 button that runs key extraction with visible progress and logs; when the user is working in the browser, point them there instead of asking them to run a tool. Never install Python packages into the global/system interpreter; use that one-click setup or another virtualenv and point the Python interpreter setting at it.`
}

/** One-shot Python/sqlcipher3 probe used by the settings page. */
async function probePython(current) {
  const command = /\s/.test(current.python) ? `"${current.python}"` : current.python
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 10_000)
  try {
    const probe = await run(current.python, ['-X', 'utf8', '-c', PYTHON_PROBE], {
      signal: controller.signal,
    })
    const info = JSON.parse(probe.output.trim().split('\n').pop() || '{}')
    return {
      ok: probe.code === 0,
      python: current.python,
      version: String(info.version ?? ''),
      bits: Number(info.bits ?? 0),
      sqlcipher3: info.sqlcipher3 === true,
      install: `${command} -m pip install sqlcipher3-wheels`,
    }
  } catch (error) {
    return {
      ok: false,
      python: current.python,
      version: '',
      bits: 0,
      sqlcipher3: false,
      error: error instanceof Error ? error.message : String(error),
      install: `${command} -m pip install sqlcipher3-wheels`,
    }
  } finally {
    clearTimeout(timer)
  }
}

/** Linux ptrace status so the startup checklist can show the exact blocker. */
function ptraceInfo() {
  if (process.platform !== 'linux') return { platform: process.platform, ptraceScope: null, restricted: false }
  let scope = null
  try {
    const parsed = Number.parseInt(readFileSync('/proc/sys/kernel/yama/ptrace_scope', 'utf8').trim(), 10)
    if (Number.isFinite(parsed)) scope = parsed
  } catch {
    // No yama on this kernel.
  }
  const root = typeof process.geteuid === 'function' && process.geteuid() === 0
  return {
    platform: 'linux',
    ptraceScope: scope,
    restricted: !root && scope !== 0,
  }
}

/**
 * Register the tools, their workflow guidance, and the local browsing UI.
 * Every registration is effect-scoped, so unloading the bundle removes the
 * tools and closes the listener.
 *
 * @param ctx - context providing `tools` and `systemPrompt`.
 * @param config - optional row config: `pythonPath`, `workDir`, `tencentRoot`,
 *   `account`, `webPort`, `webHost`.
 */
export function apply(ctx, config) {
  const bundleConfig = config && typeof config === 'object' ? config : {}
  let overrides = loadOverrides()
  const settings = resolveSettings(bundleConfig, overrides)
  const defaults = resolveSettings(bundleConfig, {})
  for (const build of [statusTool, keyTool, groupsTool, exportTool]) {
    ctx.tools.register(build(settings))
  }

  let webUrl = ''
  let webServer = null
  let applying = false
  let setupAbort = null
  let keyJobAbort = null
  const setup = {
    state: 'idle', step: '', log: [], error: '', source: 'default',
    startedAt: 0, finishedAt: 0, venv: '', python: '',
  }
  const keyJob = {
    state: 'idle', step: '', log: [], error: '', force: false,
    startedAt: 0, finishedAt: 0, folded: 0, dropped: 0, key: false,
  }

  const setupLog = (line) => {
    const text = String(line).replace(/\r/g, '').trimEnd()
    if (text === '') return
    setup.log.push(text.length > 500 ? `${text.slice(0, 500)}…` : text)
    if (setup.log.length > 200) setup.log.splice(0, setup.log.length - 200)
  }
  const setupSnapshot = () => ({
    ...setup,
    log: setup.log.slice(-160),
    indexUrl: SETUP_SOURCES[setup.source] || '',
  })
  const keyJobSnapshot = () => ({ ...keyJob, log: keyJob.log.slice(-200) })

  const ensureDir = (dir) => {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    if (process.platform !== 'win32') {
      try {
        chmodSync(dir, 0o700)
      } catch {
        // A filesystem without chmod support still works.
      }
    }
  }

  /** Start a listener on an explicit port (used for bind-testing a new one). */
  const launch = async (port, host) => {
    if (!port) return null
    const server = startWebServer(settings, port, host, { handlers })
    await server.ready
    return server
  }

  const handlers = {
    getSettings: () => publicSettings(settings, defaults, { url: webUrl, file: settingsFile() }),
    getStorage: () => storageSnapshot(settings.workDir),
    cleanupStorage: (ids) => {
      if (keyJob.state === 'running') {
        throw Object.assign(new Error('密钥提取进行中，等它结束后再清理'), { status: 409 })
      }
      if (setup.state === 'running') {
        throw Object.assign(new Error('环境配置进行中，等它结束后再清理'), { status: 409 })
      }
      return cleanupStorage(settings.workDir, ids)
    },
    getDiagnostics: async () => {
      const storage = storageSnapshot(settings.workDir)
      return {
        ...(await probePython(settings)),
        ...ptraceInfo(),
        venv: { dir: defaultVenvDir(), python: venvPython() },
        key: storage.key,
        index: storage.index,
      }
    },
    getSetup: () => setupSnapshot(),
    startSetup: (source = 'default') => {
      const choice = String(source || 'default')
      if (!Object.prototype.hasOwnProperty.call(SETUP_SOURCES, choice)) {
        throw Object.assign(new Error('未知的安装源，只能选择默认源或清华镜像'), { status: 400 })
      }
      if (keyJob.state === 'running') {
        throw Object.assign(new Error('密钥提取进行中，等它结束后再配置环境'), { status: 409 })
      }
      if (setup.state === 'running') return setupSnapshot()
      void runSetup(choice)
      return setupSnapshot()
    },
    getKeyJob: () => keyJobSnapshot(),
    startKeyJob: (force) => startKeyJob(force === true),
    canStartBuild: () => keyJob.state !== 'running' && setup.state !== 'running',
    updateSettings: (patch) => commitSettings({ ...overrides, ...validatePatch(patch) }),
    resetSettings: () => commitSettings({}),
  }

  /**
   * Apply a full set of overrides. A changed port is bind-tested on the new
   * port before the old listener is closed, so a typo or a busy port leaves
   * the working UI untouched.
   */
  async function commitSettings(nextOverrides) {
    if (applying) throw Object.assign(new Error('设置正在应用，请稍候'), { status: 409 })
    if (keyJob.state === 'running') {
      throw Object.assign(new Error('密钥提取进行中，完成后再修改设置'), { status: 409 })
    }
    applying = true
    try {
      const next = resolveSettings(bundleConfig, nextOverrides)
      if (next.workDir === path.parse(next.workDir).root) {
        throw Object.assign(new Error('工作目录不能是文件系统根目录'), { status: 400 })
      }
      try {
        ensureDir(next.workDir)
      } catch (error) {
        throw Object.assign(error, { status: 400 })
      }
      const portChanged = next.webPort !== settings.webPort
      let candidate = null
      if (portChanged && next.webPort !== 0) {
        try {
          candidate = await launch(next.webPort, next.webHost)
        } catch (error) {
          throw Object.assign(error, { status: 409 })
        }
      }
      try {
        if (Object.keys(nextOverrides).length > 0) saveOverrides(nextOverrides)
        else clearOverrides()
      } catch (error) {
        if (candidate) void candidate.close()
        throw Object.assign(error, { status: 500 })
      }

      const previousServer = webServer
      Object.assign(settings, next)
      if (portChanged) {
        webServer = candidate
        webUrl = candidate ? candidate.url : ''
        // Let the response to this very request finish before stopping the
        // listener that is serving it.
        if (previousServer) setImmediate(() => { void previousServer.close() })
      }
      return {
        ...publicSettings(settings, defaults, { url: webUrl, file: settingsFile() }),
        restart: portChanged,
        previousUrl: previousServer ? previousServer.url : '',
      }
    } finally {
      applying = false
    }
  }

  async function hasSqlcipher(command, signal) {
    const probe = await runSetupCommand(command, ['-c', 'import sqlcipher3'], {
      signal, timeoutMs: 15_000,
    })
    return probe.code === 0
  }

  /** Setup commands get their own timeout so a broken interpreter cannot hang the job. */
  async function runSetupCommand(command, argv, { signal, timeoutMs = 120_000 } = {}) {
    const controller = new AbortController()
    if (signal?.aborted) controller.abort()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    const forwardAbort = () => controller.abort()
    signal?.addEventListener('abort', forwardAbort, { once: true })
    try {
      return await run(command, argv, { signal: controller.signal })
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', forwardAbort)
    }
  }

  /**
   * The interpreter used only to create the private virtualenv. A virtualenv
   * that we are about to replace is never used as its own base interpreter.
   */
  async function findBasePython(venvDir, signal) {
    const candidates = []
    const seen = new Set()
    const root = path.resolve(venvDir)
    const rootLower = root.toLowerCase()
    const add = (command, args = []) => {
      if (!command) return
      const key = `${command} ${args.join(' ')}`
      if (seen.has(key)) return
      seen.add(key)
      if (/[\\/]/.test(command)) {
        const resolved = path.resolve(command).toLowerCase()
        if (resolved.startsWith(`${rootLower}${path.sep}`) || resolved === rootLower) return
      }
      candidates.push({ command, args })
    }
    add(settings.python)
    if (process.platform === 'win32') {
      add('python')
      add('py', ['-3'])
    } else {
      add('python3')
      add('python')
    }
    for (const candidate of candidates) {
      const probe = await runSetupCommand(candidate.command, [
        ...candidate.args, '-c', 'import sys; print(sys.version.split()[0])',
      ], { signal, timeoutMs: 15_000 })
      if (probe.code !== 0) continue
      const version = probe.output.trim().split('\n').pop()
      if (version) return { ...candidate, version }
    }
    throw new Error('找不到可用的 Python 3。请先安装 Python 3（Debian/Ubuntu 还需要 python3-venv）后重试。')
  }

  const appendSetupOutput = (output) => {
    for (const line of String(output).split('\n')) setupLog(line)
  }

  /**
   * One-click setup: create a private virtualenv and install sqlcipher3-wheels
   * into it. System Python is never modified, and the page shows the full log.
   */
  async function runSetup(source = 'default') {
    const indexUrl = SETUP_SOURCES[source] || ''
    const sourceLabel = indexUrl ? '清华镜像' : '默认源'
    setupAbort = new AbortController()
    const signal = setupAbort.signal
    const venvDir = defaultVenvDir()
    const target = venvPython(venvDir)
    Object.assign(setup, {
      state: 'running', step: '准备', log: [], error: '', source,
      startedAt: Date.now(), finishedAt: 0, venv: venvDir, python: target,
    })
    try {
      setupLog(`虚拟环境目录：${venvDir}`)
      setupLog(indexUrl
        ? `安装源：清华 PyPI 镜像（${indexUrl}）`
        : '安装源：默认 PyPI')
      ensureDir(path.dirname(venvDir))
      if (existsSync(target) && await hasSqlcipher(target, signal)) {
        setupLog('虚拟环境里已经有 sqlcipher3，直接切换')
      } else {
        const base = await findBasePython(venvDir, signal)
        setup.step = '创建虚拟环境'
        setupLog(`使用 Python ${base.version}：${[base.command, ...base.args].join(' ').trim()}`)
        if (existsSync(venvDir)) {
          setupLog('删除不完整的旧虚拟环境')
          rmSync(venvDir, { recursive: true, force: true })
        }
        const create = await runSetupCommand(base.command, [
          ...base.args, '-m', 'venv', venvDir,
        ], { signal, timeoutMs: 120_000 })
        appendSetupOutput(create.output)
        if (create.code !== 0) {
          if (signal.aborted) throw new Error('配置已取消')
          throw new Error('创建虚拟环境失败。Debian/Ubuntu 可能需要先安装 python3-venv：sudo apt install python3-venv')
        }
        setup.step = indexUrl ? '安装 sqlcipher3（清华镜像）' : '安装 sqlcipher3'
        setupLog('只安装到上面的虚拟环境，不修改系统 Python')
        setupLog(`正在从${sourceLabel}下载并安装 sqlcipher3-wheels（取决于网络，可能需要几分钟）…`)
        const pipArgs = ['-m', 'pip', 'install', '--disable-pip-version-check', '--no-input']
        if (indexUrl) pipArgs.push('--index-url', indexUrl)
        pipArgs.push('sqlcipher3-wheels')
        const install = await runSetupCommand(target, pipArgs, { signal, timeoutMs: 15 * 60_000 })
        appendSetupOutput(install.output)
        if (install.code !== 0) {
          if (signal.aborted) throw new Error('配置已取消')
          throw new Error(`在虚拟环境里安装 sqlcipher3-wheels 失败（${sourceLabel}）；请检查网络或代理后重试，或换另一个安装源`)
        }
      }
      setup.step = '验证'
      if (!(await hasSqlcipher(target, signal))) {
        throw new Error('虚拟环境创建成功，但 sqlcipher3 无法导入')
      }
      setupLog('sqlcipher3 验证通过，切换插件使用的 Python')
      await commitSettings({ ...overrides, pythonPath: target })
      setup.state = 'done'
      setup.step = '完成'
      setup.finishedAt = Date.now()
      setupLog(`已切换到 ${target}`)
    } catch (error) {
      setup.state = 'error'
      setup.step = '失败'
      setup.finishedAt = Date.now()
      setup.error = error instanceof Error ? error.message : String(error)
      setupLog(`失败：${setup.error}`)
    } finally {
      setupAbort = null
    }
  }

  /**
   * Run the exporter's `key` command as a visible background job. Its output is
   * streamed into `keyJob.log`; SQLCipher's per-candidate noise is folded and
   * any recovered key is redacted before it reaches the page.
   */
  async function startKeyJob(force) {
    if (keyJob.state === 'running') return keyJobSnapshot()
    if (setup.state === 'running') {
      throw Object.assign(new Error('环境配置进行中，等它结束后再提取密钥'), { status: 409 })
    }
    if (buildRunning(settings.workDir)) {
      throw Object.assign(new Error('索引正在建立，等它结束后再提取密钥'), { status: 409 })
    }
    const ptrace = ptraceInfo()
    if (ptrace.restricted) {
      throw Object.assign(new Error(
        'Linux 的 ptrace 限制还没有放开。先在终端执行：sudo sysctl -w kernel.yama.ptrace_scope=0'
      ), { status: 409 })
    }
    if (!(await hasSqlcipher(settings.python, undefined))) {
      throw Object.assign(new Error(
        '还没有可用的 sqlcipher3。先点「默认源安装」或「清华镜像安装」'
      ), { status: 409 })
    }

    ensureDir(settings.workDir)
    Object.assign(keyJob, {
      state: 'running', step: '启动 QQ 进程扫描', log: [], error: '', force: !!force,
      startedAt: Date.now(), finishedAt: 0, folded: 0, dropped: 0, key: false,
    })
    keyJobAbort = new AbortController()
    const signal = keyJobAbort.signal

    const argv = ['-X', 'utf8', CLI, '--work', settings.workDir]
    if (settings.tencentRoot) argv.push('--root', settings.tencentRoot)
    if (settings.account) argv.push('--account', String(settings.account))
    argv.push('key')
    if (force) argv.push('--force')

    const child = spawn(settings.python, argv, {
      cwd: settings.workDir,
      windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let outPending = ''
    let errPending = ''
    let settled = false
    let timer = null

    const scrubPatterns = (value) => String(value)
      .replace(/(找到密钥:\s*)([!-~]{16})/g, '$1<redacted>')
      .replace(/(可强制重新提取[）)]?:\s*)([!-~]{16})/g, '$1<redacted>')
      .replace(/((?:key|密钥)\s*[:=]\s*)([!-~]{16})/gi, '$1<redacted>')
    const addLine = (raw) => {
      const text = scrubPatterns(String(raw).replace(/\r/g, '').trimEnd())
      if (text === '') return
      if (SQLCIPHER_NOISE.test(text)) {
        keyJob.folded += 1
        return
      }
      if (/找到密钥|已有可用密钥/.test(text)) {
        keyJob.log.push('*** 找到可用密钥（内容已隐藏）***')
        return
      }
      keyJob.log.push(text.length > 600 ? `${text.slice(0, 600)}…` : text)
      if (keyJob.log.length > 250) {
        keyJob.log.shift()
        keyJob.dropped += 1
      }
      if (text.includes('开始扫描进程内存')) keyJob.step = '扫描 QQ 进程内存'
      else if (text.includes('候选密钥')) keyJob.step = '校验候选密钥'
    }
    const consume = (chunk, source) => {
      let pending = source === 'out' ? outPending : errPending
      pending += chunk
      let index = pending.indexOf('\n')
      while (index !== -1) {
        addLine(pending.slice(0, index))
        pending = pending.slice(index + 1)
        index = pending.indexOf('\n')
      }
      if (pending.length > 8192) {
        addLine(pending)
        pending = ''
      }
      if (source === 'out') outPending = pending
      else errPending = pending
    }
    const redact = () => {
      let key = ''
      try {
        key = readFileSync(path.join(settings.workDir, 'key.txt'), 'utf8').trim()
      } catch {
        // No key file.
      }
      const scrub = (text) => {
        let result = scrubPatterns(text)
        if (key.length >= 8) result = result.split(key).join('<redacted>')
        return result
      }
      keyJob.log = keyJob.log.map(scrub)
      if (keyJob.error) keyJob.error = scrub(keyJob.error)
    }
    const finish = (code, extraError) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      if (outPending) addLine(outPending)
      if (errPending) addLine(errPending)
      keyJob.finishedAt = Date.now()
      keyJob.key = existsSync(path.join(settings.workDir, 'key.txt'))
      if (extraError) {
        keyJob.state = 'error'
        keyJob.step = '失败'
        keyJob.error = extraError
      } else if (code === 0 && keyJob.key) {
        keyJob.state = 'done'
        keyJob.step = '完成'
        addLine('密钥已保存到 key.txt（内容已隐藏）')
      } else {
        keyJob.state = 'error'
        keyJob.step = '失败'
        keyJob.error = keyJob.error || (
          `qqnt_export.py 退出码 ${code ?? '未知'}${keyJob.key ? '' : '，且没有生成 key.txt'}；请查看下方日志`
        )
      }
      if (keyJob.folded > 0) addLine(`[已折叠 ${keyJob.folded} 行 SQLCipher 逐候选项日志]`)
      if (keyJob.dropped > 0) addLine(`[较早的 ${keyJob.dropped} 行日志已省略]`)
      redact()
      keyJobAbort = null
    }

    signal.addEventListener('abort', () => {
      try { child.kill() } catch { /* already gone */ }
    }, { once: true })
    timer = setTimeout(() => {
      if (settled) return
      addLine('提取超时（超过 15 分钟），正在终止…')
      try { child.kill() } catch { /* already gone */ }
      finish(null, '密钥提取超时（超过 15 分钟）')
    }, 15 * 60_000)

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => consume(chunk, 'out'))
    child.stderr.on('data', (chunk) => consume(chunk, 'err'))
    child.on('error', (error) => {
      finish(null, error.code === 'ENOENT'
        ? `无法运行 ${settings.python}：找不到解释器`
        : `无法启动密钥提取：${error.message}`)
    })
    child.on('close', (code) => finish(code))
    return keyJobSnapshot()
  }

  const startWeb = () => {
    if (!settings.webPort) {
      webUrl = ''
      return
    }
    const server = startWebServer(settings, settings.webPort, settings.webHost, {
      // A failed bind must not leave the model advertising a URL that is not there.
      onError: () => {
        if (webServer === server) webUrl = ''
      },
      handlers,
    })
    webServer = server
    server.ready.then(() => {
      if (webServer === server) {
        webUrl = server.url
        console.log(`[qqnt-chat-export] open ${webUrl} for the startup checklist and one-click environment setup`)
      }
    }, () => {
      if (webServer === server) webUrl = ''
    })
  }

  if (typeof ctx.effect === 'function') {
    ctx.effect(() => {
      startWeb()
      return () => {
        setupAbort?.abort()
        keyJobAbort?.abort()
        const server = webServer
        webServer = null
        webUrl = ''
        if (server) void server.close()
      }
    })
  } else {
    startWeb()
  }

  ctx.systemPrompt.section({
    name: 'tool:qqnt_chat_export',
    order: PROMPT_ORDER,
    text: () => (webUrl === '' ? GUIDANCE : GUIDANCE + webGuidance(webUrl)),
  })
}
