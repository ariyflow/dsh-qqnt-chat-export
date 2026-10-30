/**
 * Host half of the QQ NT chat export bundle.
 *
 * Registers seven model-facing tools that drive `scripts/qqnt_export.py` — the
 * exporter from the `qqnt-chat-export-skill` — so an Agent can inspect the local
 * NTQQ install, recover the SQLCipher key from the running client, list group
 * chats, and export one group's history. The bundled Python file is used
 * unmodified; this module only owns argument mapping, the environment probe,
 * secret redaction, and result shaping.
 *
 * It also serves a local browsing UI on its own port (see `web.js`), which reads
 * the same data through `scripts/qqnt_query.py`. Three more tools
 * (`qqnt_list_chats`, `qqnt_search`, `qqnt_export_chat`) read the sidecar index
 * that UI builds, so private chats and cross-chat keyword search work too.
 */
import { spawn } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  clearOverrides,
  defaultVenvDir,
  loadOverrides,
  persistentWorkDir,
  publicSettings,
  resolveSettings,
  saveOverrides,
  settingsFile,
  validatePatch,
  venvPython,
} from './settings.js'
import { buildRunning, cleanupStorage, migrateWorkDir, removeWorkDirEntries, storageSnapshot } from './storage.js'
import { pruneAccountIndexes, spawnAutosync, startWebServer } from './web.js'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'qqnt-chat-export'
/** Services this bundle registers into. */
export const inject = ['tools', 'systemPrompt']

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CLI = path.join(HERE, 'scripts', 'qqnt_export.py')
const QUERY_CLI = path.join(HERE, 'scripts', 'qqnt_query.py')

const DEFAULT_FORMATS = ['txt', 'sqlite', 'csv']
/** One-click setup can use the default PyPI or the Tsinghua mirror. */
const SETUP_SOURCES = {
  default: null,
  tsinghua: 'https://pypi.tuna.tsinghua.edu.cn/simple',
}
/** Key extraction is slow by nature; keep this in step with the web job's own limit. */
const KEY_TIMEOUT_MS = 15 * 60_000
const EXPORT_TIMEOUT_MS = 15 * 60_000
/** Prompt placement after the built-in `tools:sdk` section. */
const PROMPT_ORDER = 5000
/** Wait before the first automatic sync so it does not race host startup. */
const SYNC_FIRST_DELAY_MS = 60_000

/** One-line probe: Python version, pointer width, and whether sqlcipher3 resolves. */
const PYTHON_PROBE = "import json,struct,sys,importlib.util as u;print(json.dumps({'version':sys.version.split()[0],'bits':struct.calcsize('P')*8,'sqlcipher3':u.find_spec('sqlcipher3') is not None,'pyzipper':u.find_spec('pyzipper') is not None}))"

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
/** Cap on retained output; exporter progress lines are tiny. */
const MAX_OUTPUT_CHARS = 256 * 1024

/**
 * Run one program and collect bounded, filtered output.
 *
 * Extracting a key validates tens of thousands of wrong candidates, and
 * SQLCipher writes a native error block per candidate to stderr — several
 * megabytes of output that says nothing about the run. Those lines are counted
 * and folded into one footer line here.
 *
 * stdout and stderr are kept in arrival order (the exporter prints its plan and
 * progress on stdout, warnings on stderr), so the report reads like the console
 * session instead of two blocks appended to each other.
 *
 * @returns {Promise<{code: number, output: string}>}
 */
function run(command, argv, { signal, cwd, env } = {}) {
  if (signal?.aborted) {
    return Promise.reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
  }
  return new Promise((resolve, reject) => {
    const child = spawn(command, argv, {
      cwd,
      windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1', ...(env || {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const lines = []
    let size = 0
    let truncated = false
    let foldedNoise = 0
    // Raw stdout for callers that parse JSON; the merged `lines` above are for
    // humans and are capped far lower.
    let rawStdout = ''
    const RAW_LIMIT = 8 * 1024 * 1024
    const pending = { out: '', err: '' }

    const keepLine = (raw) => {
      // \r of a CRLF pair and trailing spaces are not part of the message.
      const text = raw.trimEnd()
      if (SQLCIPHER_NOISE.test(text)) {
        foldedNoise += 1
        return
      }
      if (size >= MAX_OUTPUT_CHARS) {
        truncated = true
        return
      }
      lines.push(text)
      size += text.length + 1
    }

    const consume = (chunk, stream) => {
      let text = pending[stream] + chunk
      let index = text.indexOf('\n')
      while (index !== -1) {
        keepLine(text.slice(0, index))
        text = text.slice(index + 1)
        index = text.indexOf('\n')
      }
      if (text.length > 8192) {
        keepLine(text)
        text = ''
      }
      pending[stream] = text
    }

    const onAbort = () => child.kill()
    signal?.addEventListener('abort', onAbort, { once: true })
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      if (rawStdout.length < RAW_LIMIT) rawStdout += chunk
      consume(chunk, 'out')
    })
    child.stderr.on('data', (chunk) => consume(chunk, 'err'))
    child.on('error', (error) => {
      signal?.removeEventListener('abort', onAbort)
      reject(error.code === 'ENOENT'
        ? new Error(`cannot run "${command}": not found on PATH. Set pythonPath in the config of this bundle to a 64-bit Python 3 executable${process.platform === 'win32' ? ' (for example python.exe).' : ' (for example python3 or the python binary of a virtualenv).'}`)
        : error)
    })
    child.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort)
      if (pending.out !== '') keepLine(pending.out)
      if (pending.err !== '') keepLine(pending.err)
      const body = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()
      const notes = []
      if (foldedNoise > 0) notes.push(`[已折叠 ${foldedNoise} 条 SQLCipher 逐候选项报错]`)
      if (truncated) notes.push(`[输出过长，仅保留前 ${MAX_OUTPUT_CHARS / 1024} KB]`)
      const output = [body, ...notes].filter((part) => part !== '').join('\n')
      resolve({ code: code ?? -1, output, stdout: rawStdout })
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

/**
 * Run one query-layer command and parse its single JSON result.
 *
 * `qqnt_query.py` prints one JSON object for `sessions`, `messages`, and
 * `export`; failures print `{"error": ...}` and still exit non-zero, so the
 * caller decides whether a parseable error is enough.
 */
async function runQueryJson(settings, argv, exec, env) {
  if (!existsSync(QUERY_CLI)) throw new Error(`bundled helper is missing: ${QUERY_CLI}`)
  mkdirSync(settings.workDir, { recursive: true, mode: 0o700 })
  const result = await run(settings.python, ['-X', 'utf8', QUERY_CLI, '--work', settings.workDir, ...argv], {
    signal: exec.signal,
    cwd: settings.workDir,
    env,
  })
  const text = result.stdout.trim()
  if (text === '') throw new Error(result.output || `查询层没有输出（exit code ${result.code}）`)
  let payload
  try {
    payload = JSON.parse(text.split('\n').pop())
  } catch {
    throw new Error(`查询层输出无法解析（exit code ${result.code}）：${text.slice(0, 400)}`)
  }
  return { code: result.code, payload }
}

function indexPath(settings) {
  return path.join(settings.workDir, 'index.sqlite')
}

/** The index-reading tools cannot fall back to the encrypted database. */
function missingIndex(settings, extra = {}) {
  const port = settings.webPort
  const where = port ? `http://127.0.0.1:${port}/` : '插件网页'
  return {
    ok: false,
    exitCode: 1,
    output: `还没有索引（${indexPath(settings)}）。先在 ${where} 点「从 QQ 同步」建立索引，再调用这个工具。`,
    ...extra,
  }
}

/** A chat name is also a file name; strip what Windows/Linux cannot store. */
function fileStem(text, fallback) {
  const stem = String(text).replace(/[\\/:*?"<>|\r\n\t]+/g, '_').replace(/^\.+/, '').trim().slice(0, 60)
  return stem || fallback
}

function fileStamp() {
  const now = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-`
    + `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
}

/** Never overwrite an earlier export from the same second. */
function uniqueTarget(outDir, stem, container) {
  const base = path.join(outDir, `${stem}_${fileStamp()}`)
  let target = `${base}.${container}`
  for (let index = 2; existsSync(target); index += 1) {
    target = `${base}-${index}.${container}`
  }
  return target
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
    lines.push(`Python ${value.pythonVersion} (${value.bits}-bit); sqlcipher3 ${value.sqlcipher3 ? 'available' : 'MISSING'}; pyzipper ${value.pyzipper ? 'available (password ZIP)' : 'missing (password ZIP unavailable)'}`)
    if (!value.sqlcipher3) {
      lines.push(`Install it with: ${value.pythonPath} -m pip install sqlcipher3-wheels pyzipper`)
    } else if (!value.pyzipper) {
      lines.push(`Password-protected ZIPs need: ${value.pythonPath} -m pip install pyzipper`)
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

/** Lists every chat in the sidecar index, groups and private chats alike. */
export function listChatsTool(settings) {
  return {
    name: 'qqnt_list_chats',
    description: 'List every chat in the local QQ message index — group chats and private conversations — with its kind, id, display name, message count, and last message time. Requires the sidecar index; the web UI builds it.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 1000,
          description: 'Maximum chats to return, most recent first. Defaults to 200.',
        },
      },
    },
    output: { schema: outputSchema(), render: renderReport },
    async execute(args, exec) {
      if (!existsSync(indexPath(settings))) return missingIndex(settings)
      const { code, payload } = await runQueryJson(settings, ['sessions'], exec)
      if (code !== 0 || !Array.isArray(payload.sessions)) {
        return { ok: false, exitCode: code, output: payload.error || '无法读取会话列表' }
      }
      const limit = Math.min(Math.max(Number(args.limit) || 200, 1), 1000)
      const chats = payload.sessions.slice(0, limit)
      const lines = chats.map((chat) =>
        `${chat.kind} ${chat.id} ${chat.name || '(未命名)'} — ${chat.messages} 条，最后 ${chat.lastTime || '-'}`)
      if (payload.sessions.length > chats.length) {
        lines.push(`…共 ${payload.sessions.length} 个会话，只显示前 ${chats.length} 个`)
      }
      lines.push('', '传 chatKind + chatId 给 qqnt_search / qqnt_export_chat；私聊的 chatId 是对方 uid。')
      return { ok: true, exitCode: 0, output: lines.join('\n') }
    },
  }
}

/** Full-text search over the sidecar index. */
export function searchTool(settings) {
  return {
    name: 'qqnt_search',
    description: 'Search local QQ messages by keyword (substring match, Chinese included), optionally restricted to one chat, one sender, or a date range. The keyword also accepts inline filters: from:name|QQ, since:YYYY-MM-DD, until:YYYY-MM-DD, in:group name or number, has:image|file|voice|video, and -word to exclude. Returns matching rows with their chat, sender, and time. Requires the sidecar index.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['keyword'],
      properties: {
        keyword: { type: 'string', minLength: 1, description: 'Substring to look for; 1-2 characters fall back to a slower scan.' },
        chatKind: { type: 'string', enum: ['group', 'private'] },
        chatId: { type: 'string', description: 'Group number, or the other party\'s uid for a private chat.' },
        sender: { type: 'string', description: 'Sender name fragment or exact QQ number.' },
        senderRegex: { type: 'boolean', description: 'Treat `sender` as a regular expression (re.search semantics) matched against the nickname and QQ. Defaults to a plain substring match.' },
        since: { type: 'string', description: 'Start date (`YYYY-MM-DD`) or Unix seconds.' },
        until: { type: 'string', description: 'End date (`YYYY-MM-DD`) or Unix seconds.' },
        limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Rows to return. Defaults to 20.' },
        offset: { type: 'integer', minimum: 0, description: 'Rows to skip, for paging.' },
        order: { type: 'string', enum: ['asc', 'desc'], description: 'Time order. Defaults to newest first.' },
      },
    },
    output: { schema: outputSchema(), render: renderReport },
    async execute(args, exec) {
      if (!existsSync(indexPath(settings))) return missingIndex(settings)
      const keyword = String(args.keyword ?? '').trim()
      if (keyword === '') return { ok: false, exitCode: 1, output: 'keyword 不能为空' }
      const payloadArgs = { keyword }
      for (const key of ['chatKind', 'chatId', 'sender', 'since', 'until', 'order']) {
        const value = args[key]
        if (typeof value === 'string' && value.trim() !== '') payloadArgs[key] = value.trim()
      }
      if (args.senderRegex === true) payloadArgs.senderRegex = true
      payloadArgs.limit = Math.min(Math.max(Number(args.limit) || 20, 1), 100)
      const offset = Number(args.offset)
      if (Number.isInteger(offset) && offset > 0) payloadArgs.offset = offset
      const { code, payload } = await runQueryJson(
        settings, ['messages', '--json', JSON.stringify(payloadArgs)], exec)
      if (code !== 0) return { ok: false, exitCode: code, output: payload.error || '搜索失败' }
      const rows = Array.isArray(payload.rows) ? payload.rows : []
      const lines = [`命中 ${payload.total} 条，返回第 ${payload.offset + 1}-${payload.offset + rows.length} 条`]
      for (const row of rows) {
        const text = String(row.text ?? '').replace(/\r?\n/g, ' \\n ')
        const qq = row.qq ? ` (${row.qq})` : ''
        lines.push(`[${row.time}] ${row.chatKind || '?'}/${row.chatId || '?'} ${row.sender}${qq}: ${text}`)
      }
      return { ok: true, exitCode: 0, output: lines.join('\n') }
    },
  }
}

/** Exports one chat (group or private) from the sidecar index to a file. */
export function exportChatTool(settings) {
  return {
    name: 'qqnt_export_chat',
    description: 'Export one chat — group or private — from the local QQ index to txt, csv, json, md, html, or sqlite, and return the written file path. Set media=true to also copy downloaded pictures/files/voice/video (returns a ZIP), split=day for one file per day (ZIP), embed=true for a single self-contained HTML, and redact to pseudonymise senders. Requires the sidecar index.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['chatKind', 'chatId'],
      properties: {
        chatKind: { type: 'string', enum: ['group', 'private'] },
        chatId: { type: 'string', description: 'Group number, or the other party\'s uid for a private chat.' },
        format: { type: 'string', enum: ['txt', 'csv', 'json', 'md', 'html', 'sqlite'], description: 'Defaults to txt.' },
        outDir: { type: 'string', description: 'Absolute output directory. Defaults to QQ导出_<chat> inside the user\'s downloads folder.' },
        label: { type: 'string', description: 'Chat name used in the file name and heading. Defaults to the name in the index.' },
        redact: {
          type: 'string', enum: ['names', 'qq', 'all'],
          description: 'Pseudonymise senders/QQ numbers before writing; message text is never rewritten.',
        },
        media: {
          type: 'boolean',
          description: 'Copy downloaded media into a ZIP (best effort; missing files are listed in manifest.json).',
        },
        split: {
          type: 'string', enum: ['day'],
          description: 'Split the chat into one file per local day inside a ZIP.',
        },
        embed: {
          type: 'boolean',
          description: 'Inline pictures as data URIs in a single HTML file (format must be html).',
        },
        password: {
          type: 'string', minLength: 4, maxLength: 128,
          description: 'Protect the resulting ZIP with AES-256 (4-128 characters). Needs pyzipper in the plugin venv; the one-click setup installs it.',
        },
        columns: {
          type: 'array',
          items: { type: 'string', enum: ['time', 'sender', 'qq', 'direction', 'kinds', 'text'] },
          minItems: 1,
          description: 'CSV only: which columns to write. Defaults to all six.',
        },
        frontMatter: {
          type: 'boolean',
          description: 'Markdown only: start the file with a YAML front-matter block (chat, account, exportedAt).',
        },
      },
    },
    output: { schema: outputSchema({ outPath: { type: 'string' } }), render: renderReport },
    timeoutMs: EXPORT_TIMEOUT_MS,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      if (!existsSync(indexPath(settings))) return missingIndex(settings, { outPath: '' })
      const kind = String(args.chatKind ?? '')
      const chatId = String(args.chatId ?? '').trim()
      if (!['group', 'private'].includes(kind) || chatId === '') {
        return { ok: false, exitCode: 1, outPath: '', output: 'chatKind 必须是 group 或 private，且 chatId 不能为空' }
      }
      const format = typeof args.format === 'string' ? args.format : 'txt'
      if (!['txt', 'csv', 'json', 'md', 'html', 'sqlite'].includes(format)) {
        return { ok: false, exitCode: 1, outPath: '', output: `不支持的格式: ${format}` }
      }
      const embed = args.embed === true
      const split = args.split === 'day' ? 'day' : ''
      const media = args.media === true || embed
      const redact = ['names', 'qq', 'all'].includes(args.redact) ? args.redact : ''
      const password = typeof args.password === 'string' ? args.password : ''
      if (embed && format !== 'html') {
        return { ok: false, exitCode: 1, outPath: '', output: 'embed 只支持 html 格式' }
      }
      if (password && (password.length < 4 || password.length > 128)) {
        return { ok: false, exitCode: 1, outPath: '', output: '密码长度需要 4~128 个字符' }
      }
      if (embed && password) {
        return { ok: false, exitCode: 1, outPath: '', output: '内嵌图片不能和密码 ZIP 同时使用' }
      }
      // Media, day-splitting and encryption always arrive as one bundle;
      // embedding stays a single shareable HTML.
      const container = embed ? 'html'
        : (media || split || password ? 'zip' : format)
      // Prefer the name the index knows; the label also names the file.
      let label = typeof args.label === 'string' ? args.label.trim() : ''
      if (label === '') {
        try {
          const sessions = await runQueryJson(settings, ['sessions'], exec)
          const match = (sessions.payload.sessions || [])
            .find((item) => item.kind === kind && String(item.id) === chatId)
          label = (match && match.name) || chatId
        } catch {
          label = chatId
        }
      }
      const outDir = typeof args.outDir === 'string' && args.outDir.trim() !== ''
        ? path.resolve(args.outDir.trim())
        : path.join(defaultDownloadDir(), `QQ导出_${fileStem(label, chatId)}`)
      mkdirSync(outDir, { recursive: true, mode: 0o700 })
      // The query layer may only write inside workDir/exports; stage there and
      // move the finished file to the directory the user asked for.
      const staging = path.join(settings.workDir, 'exports',
        `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${container}`)
      const payloadArgs = { chatKind: kind, chatId, format, label, out: staging }
      if (redact) payloadArgs.redact = redact
      if (media) payloadArgs.media = true
      if (split) payloadArgs.split = 'day'
      if (embed) payloadArgs.embed = true
      if (format === 'csv' && Array.isArray(args.columns) && args.columns.length > 0) {
        payloadArgs.columns = args.columns.map(String)
      }
      if (format === 'md' && args.frontMatter === true) payloadArgs.frontMatter = true
      const { code, payload } = await runQueryJson(
        settings, ['export', '--json', JSON.stringify(payloadArgs)], exec,
        password ? { QQNT_EXPORT_PASSWORD: password } : undefined)
      if (code !== 0) return { ok: false, exitCode: code, outPath: '', output: payload.error || '导出失败' }
      const target = uniqueTarget(outDir, fileStem(label, chatId), container)
      try {
        renameSync(payload.path, target)
      } catch (error) {
        if (error.code !== 'EXDEV') throw error
        copyFileSync(payload.path, target)
        try {
          rmSync(payload.path)
        } catch {
          // Leaving the staged copy is harmless; it is inside workDir.
        }
      }
      return { ok: true, exitCode: 0, outPath: target, output: `已导出 ${payload.rows} 条到 ${target}` }
    },
  }
}

/** Reports the Python/SQLCipher environment plus the exporter's data info. */
export function statusTool(settings) {
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
        pyzipper: { type: 'boolean' },
      }),
      render: renderStatus,
    },
    isConcurrencySafe: () => true,
    async execute(_args, exec) {
      let pythonVersion = ''
      let bits = 0
      let sqlcipher3 = false
      let pyzipper = false
      let probeError = ''
      try {
        const probe = await run(settings.python, ['-X', 'utf8', '-c', PYTHON_PROBE], { signal: exec.signal })
        const info = JSON.parse(probe.output.trim().split('\n').pop() ?? '{}')
        pythonVersion = String(info.version ?? '')
        bits = Number(info.bits ?? 0)
        sqlcipher3 = info.sqlcipher3 === true
        pyzipper = info.pyzipper === true
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
        pyzipper,
      }
    },
  }
}

function keyTool(settings, busy) {
  return {
    name: 'qqnt_extract_key',
    description: 'Recover the local QQ message-database key from the running, logged-in QQ client and cache it for later calls. Finding the key is slow: it scans QQ process memory and validates candidate keys, which usually takes one to three minutes. Tell the user it takes a while and to please wait before calling this tool, and never cancel it merely because it is slow.',
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
      // The web page runs the same job; two scans would race for key.txt and
      // both write into the same work directory.
      if (busy?.()) {
        return {
          ok: false,
          exitCode: 1,
          output: '网页正在提取数据库密钥，等它结束后再试；进度可以在网页的「设置 → 数据库密钥」里查看。',
        }
      }
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

The qqnt_* tools read the message database of the NTQQ client installed on this machine. Use them in order: qqnt_status, then qqnt_extract_key, then qqnt_list_groups, then qqnt_export_group. Finding the key is slow: before calling qqnt_extract_key, tell the user that searching for the key takes one to three minutes and to please wait patiently (查找密钥耗时较长，请耐心等待); the call returns only when the scan finishes, so do not retry or cancel it while it runs. Key extraction only works while QQ is logged in; when it finds no key, ask the user to confirm QQ is signed in rather than retrying. Confirm the exact group number with the user before exporting, because the common off-by-one-digit guess exports nothing. Never move, edit, or delete files under the QQ data directory, and do not end the QQ process. Never install Python packages into the global/system interpreter; use a virtualenv, and the local web UI offers a one-click venv setup. On Linux the key is read from the qq main process memory: if the kernel's ptrace scope denies it, the tool prints the exact sysctl command to run; report that fix instead of retrying blindly.`

/** Appended only while the browsing UI is actually listening. */
function webGuidance(url) {
  return ` The same data, including private chats and keyword search across every chat, is browsable at ${url} in a browser tab; that page also downloads the current query as txt, csv, json, markdown, html, or sqlite. The page opens with a startup checklist that names this URL, checks Python/sqlcipher3 and the cached key, and offers a one-click setup that creates a private virtualenv and installs sqlcipher3-wheels into it. The same checklist and the settings page have a 提取密钥 button that runs key extraction with visible progress and logs; when the user is working in the browser, point them there instead of asking them to run a tool. Never install Python packages into the global/system interpreter; use that one-click setup or another virtualenv and point the Python interpreter setting at it. For private chats or cross-chat search, the sidecar index must exist first: qqnt_list_chats, qqnt_search, and qqnt_export_chat read it, and they explain how to build it in the web UI when it is missing. An export can also bundle downloaded media (media: true), split into one file per day (split: "day"), pseudonymise senders (redact), or inline pictures into a single HTML (embed); the first two return a ZIP with manifest.json.`
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
      pyzipper: info.pyzipper === true,
      install: `${command} -m pip install sqlcipher3-wheels pyzipper`,
    }
  } catch (error) {
    return {
      ok: false,
      python: current.python,
      version: '',
      bits: 0,
      sqlcipher3: false,
      pyzipper: false,
      error: error instanceof Error ? error.message : String(error),
      install: `${command} -m pip install sqlcipher3-wheels pyzipper`,
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
  // A missing yama file means the kernel does not restrict ptrace at all;
  // treating `null` as "restricted" refuses extraction on those systems.
  return {
    platform: 'linux',
    ptraceScope: scope,
    restricted: !root && scope !== null && scope !== 0,
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
  // Recomputed per request: after a work-dir migration the cached copy would
  // still advertise the old temp placeholder and `workDirLegacy: true`.
  const currentDefaults = () => resolveSettings(bundleConfig, {})
  // The model-facing key tool shares the web job's slot: `busy` is evaluated
  // when the tool runs, long after `keyJob` below is initialised.
  ctx.tools.register(statusTool(settings))
  ctx.tools.register(keyTool(settings, () => keyJob.state === 'running'))
  ctx.tools.register(groupsTool(settings))
  ctx.tools.register(exportTool(settings))
  // Index-backed tools: they cover private chats and cross-chat search, which
  // the group exporter above cannot reach.
  ctx.tools.register(listChatsTool(settings))
  ctx.tools.register(searchTool(settings))
  ctx.tools.register(exportChatTool(settings))

  let webUrl = ''
  let webServer = null
  let applying = false
  let setupAbort = null
  let keyJobAbort = null
  const setup = {
    state: 'idle', step: '', log: [], error: '', source: 'default',
    engine: '', uv: '',
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
    getSettings: () => publicSettings(settings, currentDefaults(), { url: webUrl, file: settingsFile() }),
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
        uv: await detectUv(),
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
    migrateWorkDir: async () => {
      if (keyJob.state === 'running' || setup.state === 'running') {
        throw Object.assign(new Error('密钥提取或环境配置进行中，等它结束再迁移'), { status: 409 })
      }
      if (buildRunning(settings.workDir)) {
        throw Object.assign(new Error('索引正在建立，等它结束再迁移'), { status: 409 })
      }
      const target = persistentWorkDir()
      if (path.resolve(target) === path.resolve(settings.workDir)) {
        throw Object.assign(new Error('工作目录已经在持久位置'), { status: 400 })
      }
      // Copy first, point the settings at the copy, and only then delete the
      // old files: a failed settings write leaves everything where it was.
      const result = await migrateWorkDir(settings.workDir, target)
      await commitSettings({ ...overrides, workDir: target })
      // Stale progress files are dropped rather than copied, but they still
      // belong to the old directory, so the cleanup removes them too.
      const removed = await removeWorkDirEntries(result.from, [...result.copied, ...result.discarded])
      return { ...result, workDir: target, removed }
    },
  }


/** Data directories owned by QQ; the plugin must never write into them. */
function qqDataRoots(tencentRoot) {
  const home = os.homedir()
  const roots = []
  if (tencentRoot) roots.push(tencentRoot)
  if (process.platform === 'win32') {
    roots.push(path.join(home, 'Documents', 'Tencent Files'))
  } else {
    const configHome = process.env.XDG_CONFIG_HOME || path.join(home, '.config')
    roots.push(
      path.join(configHome, 'QQ'),
      path.join(home, '.var', 'app', 'com.qq.QQ', 'config', 'QQ'),
      path.join(home, '.var', 'app', 'com.tencent.qq', 'config', 'QQ'),
      path.join(home, 'snap', 'qq', 'current', '.config', 'QQ'),
      path.join(home, 'snap', 'qq', 'common', '.config', 'QQ'),
      path.join(home, 'Documents', 'Tencent Files'),
      path.join(home, '文档', 'Tencent Files'),
    )
  }
  return roots
}

/** Whether `child` is `parent` itself or sits underneath it. */
function isInsideDir(parent, child) {
  const rel = path.relative(path.resolve(parent), path.resolve(child))
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
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
      for (const root of qqDataRoots(next.tencentRoot)) {
        if (isInsideDir(root, next.workDir)) {
          throw Object.assign(new Error(
            `工作目录不能放在 QQ 数据目录内（${root}）。插件对 QQ 数据只读，请换一个目录。`
          ), { status: 400 })
        }
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
      const previousKeep = settings.keepAccountIndexes
      const previousAutoSync = settings.autoSync
      const previousInterval = settings.syncIntervalMinutes
      Object.assign(settings, next)
      if (portChanged) {
        webServer = candidate
        webUrl = candidate ? candidate.url : ''
        // Let the response to this very request finish before stopping the
        // listener that is serving it.
        if (previousServer) setImmediate(() => { void previousServer.close() })
      }
      // Lowering the limit must shrink the cache now, not after the next build.
      if (next.keepAccountIndexes !== previousKeep && !buildRunning(settings.workDir)) {
        pruneAccountIndexes(settings, next.keepAccountIndexes)
      }
      if (next.autoSync !== previousAutoSync || next.syncIntervalMinutes !== previousInterval) {
        restartSyncLoop()
      }
      return {
        ...publicSettings(settings, currentDefaults(), { url: webUrl, file: settingsFile() }),
        restart: portChanged,
        previousUrl: previousServer ? previousServer.url : '',
      }
    } finally {
      applying = false
    }
  }

  async function hasModule(command, module, signal) {
    const probe = await runSetupCommand(command, ['-c', `import ${module}`], {
      signal, timeoutMs: 15_000,
    })
    return probe.code === 0
  }

  async function hasSqlcipher(command, signal) {
    return hasModule(command, 'sqlcipher3', signal)
  }

  /**
   * pyzipper is optional: only password-protected ZIPs need it. Never fail the
   * whole setup because of it; password export reports the missing module.
   */
  async function installOptionalPyzipper(target, signal, indexUrl) {
    setup.step = '安装 pyzipper（密码 ZIP，可选）'
    setupLog('正在安装 pyzipper（密码 ZIP 需要）…')
    const pipArgs = ['-m', 'pip', 'install', '--disable-pip-version-check', '--no-input']
    if (indexUrl) pipArgs.push('--index-url', indexUrl)
    pipArgs.push('pyzipper')
    let attempt = await runSetupCommand(target, pipArgs, { signal, timeoutMs: 5 * 60_000 })
    if (attempt.code !== 0) {
      const uv = await detectUv(signal)
      if (uv.available) {
        const uvArgs = ['pip', 'install', '--python', target]
        if (indexUrl) uvArgs.push('--index-url', indexUrl)
        uvArgs.push('pyzipper')
        attempt = await runSetupCommand(uv.command, uvArgs, { signal, timeoutMs: 5 * 60_000 })
      }
    }
    if (attempt.code !== 0) {
      if (signal.aborted) throw new Error('配置已取消')
      setupLog('pyzipper 安装失败；密码 ZIP 暂不可用，其他导出不受影响')
    } else {
      setupLog('pyzipper 安装完成')
    }
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
  /** Whether uv is installed. uv is never downloaded for the user. */
  async function detectUv(signal) {
    const command = settings.uv || 'uv'
    try {
      const probe = await runSetupCommand(command, ['--version'], { signal, timeoutMs: 20_000 })
      const version = probe.code === 0 ? (probe.output.trim().split('\n').pop() || '') : ''
      return { command, available: version !== '', version }
    } catch {
      return { command, available: false, version: '' }
    }
  }

  /**
   * One-click setup: create a private virtualenv and install sqlcipher3-wheels
   * into it. System Python is never modified, and the page shows the full log.
   *
   * `uv` is preferred when installed: it can fetch a known-good Python (the
   * system one may lack a wheel or the venv module) and installs in seconds.
   * `pip` stays as the fallback, so a machine without uv still works.
   */
  async function runSetup(source = 'default') {
    const indexUrl = SETUP_SOURCES[source] || ''
    const sourceLabel = indexUrl ? '清华镜像' : '默认源'
    setupAbort = new AbortController()
    const signal = setupAbort.signal
    const venvDir = defaultVenvDir()
    const target = venvPython(venvDir)
    Object.assign(setup, {
      state: 'running', step: '准备', log: [], error: '', source, engine: '', uv: '',
      startedAt: Date.now(), finishedAt: 0, venv: venvDir, python: target,
    })
    try {
      setupLog(`虚拟环境目录：${venvDir}`)
      setupLog(indexUrl
        ? `安装源：清华 PyPI 镜像（${indexUrl}）`
        : '安装源：默认 PyPI')
      ensureDir(path.dirname(venvDir))
      if (existsSync(target) && await hasSqlcipher(target, signal)) {
        setupLog('虚拟环境里已经有 sqlcipher3')
        if (!(await hasModule(target, 'pyzipper', signal))) {
          await installOptionalPyzipper(target, signal, indexUrl)
        } else {
          setupLog('pyzipper 已安装，直接切换')
        }
      } else {
        const uv = await detectUv(signal)
        setup.uv = uv.version
        setupLog(settings.installer === 'auto'
          ? `安装方式：自动（${uv.available ? '使用 uv' : '未找到 uv，使用 pip'}）`
          : `安装方式：${settings.installer}`)
        if (settings.installer === 'uv' && !uv.available) {
          throw new Error('没有找到 uv。先安装 https://docs.astral.sh/uv/ ，'
            + '或在设置里把「环境安装方式」改成 pip / 自动。')
        }
        let useUv = uv.available && settings.installer !== 'pip'
        if (useUv) {
          setup.engine = 'uv'
          setup.step = '创建虚拟环境（uv）'
          setupLog(`使用 ${uv.version || 'uv'}，目标 Python ${settings.pythonVersion}`
            + '（首次运行时 uv 会下载托管的 Python，可能较慢）')
          if (existsSync(venvDir)) {
            setupLog('删除不完整的旧虚拟环境')
            rmSync(venvDir, { recursive: true, force: true })
          }
          const create = await runSetupCommand(uv.command, [
            'venv', '--python', settings.pythonVersion, venvDir,
          ], { signal, timeoutMs: 10 * 60_000 })
          appendSetupOutput(create.output)
          if (create.code !== 0) {
            if (signal.aborted) throw new Error('配置已取消')
            if (settings.installer === 'auto') {
              setupLog('uv 创建虚拟环境失败，改用系统 Python + pip 重试')
              useUv = false
            } else {
              throw new Error(`uv 创建虚拟环境失败（Python ${settings.pythonVersion}）。`
                + '检查网络或代理，或在设置里把安装方式改回自动 / pip。')
            }
          } else {
            setup.step = indexUrl ? '安装 sqlcipher3（uv，清华镜像）' : '安装 sqlcipher3（uv）'
            setupLog('只安装到上面的虚拟环境，不修改系统 Python')
            setupLog(`正在从${sourceLabel}下载并安装 sqlcipher3-wheels…`)
            const uvArgs = ['pip', 'install', '--python', target]
            if (indexUrl) uvArgs.push('--index-url', indexUrl)
            uvArgs.push('sqlcipher3-wheels')
            const install = await runSetupCommand(uv.command, uvArgs, { signal, timeoutMs: 15 * 60_000 })
            appendSetupOutput(install.output)
            if (install.code !== 0) {
              if (signal.aborted) throw new Error('配置已取消')
              if (settings.installer === 'auto') {
                setupLog('uv 安装 sqlcipher3 失败，改用系统 Python + pip 重试')
                useUv = false
              } else {
                throw new Error(`uv 安装 sqlcipher3-wheels 失败（${sourceLabel}）；`
                  + '请检查网络或代理后重试，或换另一个安装源')
              }
            }
          }
        }
        if (!useUv) {
          setup.engine = 'pip'
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
            throw new Error('创建虚拟环境失败。Debian/Ubuntu 可能需要先安装 python3-venv：sudo apt install python3-venv，'
              + '或安装 uv 让插件用它下载 Python。')
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
        await installOptionalPyzipper(target, signal, indexUrl)
      }
      setup.step = '验证'
      if (!(await hasSqlcipher(target, signal))) {
        throw new Error('虚拟环境创建成功，但 sqlcipher3 无法导入')
      }
      setupLog('sqlcipher3 验证通过，切换插件使用的 Python')
      if (await hasModule(target, 'pyzipper', signal)) {
        setupLog('pyzipper 验证通过，可导出密码 ZIP')
      } else {
        setupLog('pyzipper 未安装：密码 ZIP 不可用，其他导出不受影响')
      }
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
    // Claim the slot before the first `await`: otherwise two clicks (or the
    // model tool and the page) both pass the `running` check and scan memory,
    // write key.txt, and overwrite each other's log.
    Object.assign(keyJob, {
      state: 'running', step: '检查运行环境', error: '', force: !!force,
      startedAt: Date.now(), finishedAt: 0, folded: 0, dropped: 0, key: false,
      log: ['提示：查找密钥耗时较长（通常 1~3 分钟，内存较大时更久），请耐心等待；期间保持 QQ 登录，不要关闭 QQ。'],
    })
    keyJobAbort = new AbortController()
    let child
    try {
      ensureDir(settings.workDir)
      if (!(await hasSqlcipher(settings.python, keyJobAbort.signal))) {
        throw Object.assign(new Error(
          '还没有可用的 sqlcipher3。先点「默认源安装」或「清华镜像安装」'
        ), { status: 409 })
      }
      const argv = ['-X', 'utf8', CLI, '--work', settings.workDir]
      if (settings.tencentRoot) argv.push('--root', settings.tencentRoot)
      if (settings.account) argv.push('--account', String(settings.account))
      argv.push('key')
      if (force) argv.push('--force')
      child = spawn(settings.python, argv, {
        cwd: settings.workDir,
        windowsHide: true,
        env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      keyJob.step = '启动 QQ 进程扫描'
    } catch (error) {
      // Nothing started; release the slot so the next click can try again.
      keyJobAbort = null
      Object.assign(keyJob, {
        state: 'idle', step: '', error: '', finishedAt: Date.now(), log: [], key: false,
      })
      throw error && typeof error === 'object' && error.status
        ? error
        : Object.assign(error instanceof Error ? error : new Error(String(error)), { status: 409 })
    }
    const signal = keyJobAbort.signal
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
      if (text.includes('扫描 QQ 进程内存')) keyJob.step = '扫描 QQ 进程内存'
      else if (text.includes('校验候选密钥')) keyJob.step = '校验候选密钥'
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
      if (keyJob.folded > 0) addLine(`[已折叠 ${keyJob.folded} 条 SQLCipher 逐候选项报错]`)
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

  let stopSyncLoop = null

  /**
   * One ticks worth of automatic sync. Everything cheap is checked here so an
   * idle database costs no Python start: the helper would also refuse quickly,
   * but a timer should not fork every interval for nothing.
   */
  function syncTick() {
    if (settings.autoSync === false) return
    if (keyJob.state === 'running' || setup.state === 'running') return
    if (!existsSync(path.join(settings.workDir, 'key.txt'))) return
    if (!existsSync(path.join(settings.workDir, 'index.sqlite'))) return
    if (buildRunning(settings.workDir)) return
    spawnAutosync(settings, {
      keep: settings.keepAccountIndexes,
      search: settings.searchIndex,
    })
  }

  /** (Re)arm the timer: first run after a minute, then every interval. */
  function restartSyncLoop() {
    if (stopSyncLoop) {
      stopSyncLoop()
      stopSyncLoop = null
    }
    if (settings.autoSync === false) return
    const interval = Math.max(1, settings.syncIntervalMinutes || 60) * 60_000
    const tick = () => {
      try {
        syncTick()
      } catch (error) {
        console.warn(`[qqnt-chat-export] automatic sync tick failed: ${error.message}`)
      }
    }
    const first = setTimeout(tick, SYNC_FIRST_DELAY_MS)
    const timer = setInterval(tick, interval)
    // The host keeps the process alive; these timers must not hold it open.
    first.unref?.()
    timer.unref?.()
    stopSyncLoop = () => {
      clearTimeout(first)
      clearInterval(timer)
    }
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
      restartSyncLoop()
      return () => {
        if (stopSyncLoop) {
          stopSyncLoop()
          stopSyncLoop = null
        }
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
    restartSyncLoop()
  }

  ctx.systemPrompt.section({
    name: 'tool:qqnt_chat_export',
    order: PROMPT_ORDER,
    text: () => (webUrl === '' ? GUIDANCE : GUIDANCE + webGuidance(webUrl)),
  })
}
