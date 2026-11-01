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
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs'
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
import { applyPreset, readPresets } from './presets.js'
import { makeAsrRunner, makeChunksRunner, makeComponentsRunner, makeExportRunner, makeOcrRunner } from './runners.js'
import {
  BUNDLE_VERSION,
  mergeChatState,
  panelInfo,
  pruneAccountIndexes,
  readBuildState,
  spawnAutosync,
  spawnBuild,
  startWebServer,
} from './web.js'
import { describeChat, pickChat, rankChats } from './chatlookup.js'

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

/**
 * Whether the sidebar metadata request came from this machine's own browser.
 *
 * `/api/qqnt/panel` is an exact route, and DSH gives exact routes precedence
 * over its authenticated `/api` prefix, so the DSH cookie fence never sees it.
 * It only returns counts, but a DSH exposed through a trusted host or proxy
 * must not publish even that: require a loopback Host header and peer.
 */
function isLoopbackName(name) {
  const lower = String(name || '').toLowerCase()
  return lower === 'localhost' || lower === '::1'
    || lower === '::ffff:127.0.0.1' || /^127(?:\.\d{1,3}){3}$/.test(lower)
}
export function panelRequestAllowed(req) {
  const host = String(req?.headers?.host || '')
  if (host === '') return false
  let name
  if (host.startsWith('[')) {
    const end = host.indexOf(']')
    if (end === -1) return false
    name = host.slice(1, end)
  } else {
    name = host.split(':')[0]
  }
  if (!isLoopbackName(name)) return false
  const remote = String(req?.socket?.remoteAddress || '')
  return remote === '' || isLoopbackName(remote)
}

/** SQLCipher writes one native error block per rejected candidate key. */
const SQLCIPHER_NOISE = /ERROR CORE (?:sqlcipher_|sqlite3Codec:)/
/**
 * Windows builds of sqlcipher3 hand the error text to the C runtime as wide
 * characters, so every line arrives as `2\0 0\0 2\0 ...` and the noise pattern
 * above never matches. Dropping NULs restores the plain line.
 */
const stripNul = (text) => text.replace(/\u0000/g, '')
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
      const text = stripNul(raw).trimEnd()
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

/**
 * "Which of these did you mean?" — never a guess.
 *
 * Exporting is a write with the user's data in it; picking one of two equally
 * good matches is a decision the tool is not allowed to make.
 */
function ambiguousChats(phrase, ranked, limit = 5) {
  const shown = ranked.slice(0, limit)
  const lines = [`「${phrase}」匹配到 ${ranked.length} 个会话，没有导出：`]
  shown.forEach((item, index) => {
    const via = item.matched && item.matched !== phrase ? `（按「${item.matched}」匹配）` : ''
    lines.push(`  ${index + 1}. ${describeChat(item.chat)} ${via}`.trimEnd())
  })
  lines.push('')
  lines.push('换一个更完整的名字，或直接传 chatKind + chatId；也可以先用 qqnt_list_chats 的 query 看一下候选。')
  return lines.join('\n')
}

/** No match: show what is there instead of an empty error. */
function unknownChat(phrase, chats, limit = 5) {
  const recent = chats.slice(0, limit)
  const lines = [`没有找到匹配「${phrase}」的会话，没有导出。`]
  if (recent.length > 0) {
    lines.push('', '最近活跃的会话：')
    recent.forEach((chat, index) => lines.push(`  ${index + 1}. ${describeChat(chat)}`))
  }
  lines.push('', '用 qqnt_list_chats 的 query 参数可以按名字/群号/QQ 找。')
  return lines.join('\n')
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

/**
 * The "that preset does not exist" message, naming the ones that do.
 *
 * The page and the tools share `presets.json`; a model that guessed a name had
 * no way to learn the real ones short of asking the user to read the page.
 */
function unknownPreset(wanted, workDir) {
  const names = readPresets(workDir).map((row) => row.name)
  if (names.length === 0) {
    return `没有名为「${wanted}」的导出预设：还没有保存过预设。先在网页「设置 → 导出预设」保存一个，或者直接给 format / redact / media 这些参数。`
  }
  return `没有名为「${wanted}」的导出预设：可用的是${names.map((name) => `「${name}」`).join('、')}。`
}

/** One executable that takes a single group number and one output directory. */
function exportTool(settings) {
  return {
    name: 'qqnt_export_group',
    description: 'Export one QQ group\'s message history to an output directory as plain text, SQLite, and CSV, and return the exporter\'s report for that run. Name the group by `group` (its number) or by `chat` (the name the user said); a name matching several groups exports nothing and returns the candidates. This reads the message database directly, so it works before the sidecar index exists.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        group: {
          type: 'string',
          description: 'QQ group number, digits only. Optional when `chat` is given.',
        },
        chat: {
          type: 'string',
          minLength: 1,
          description: 'The group as the user named it: a group name, a name with 群 around it, or the number as a string. Resolved against the account\'s group list before anything is written.',
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
      let group = String(args.group ?? '').trim()
      const phrase = typeof args.chat === 'string' ? args.chat.trim() : ''
      if (group === '' && phrase === '') {
        return {
          ok: false, exitCode: 1, outDir: '',
          output: '给一个 group（群号）或 chat（群名）：不知道群号时先用 qqnt_list_groups 或 qqnt_list_chats 的 query 找一下。',
        }
      }
      if (phrase !== '') {
        // One `groups` call both resolves the name and shows the candidates;
        // the exporter itself would only say "群 X 没有消息" for a wrong number.
        const listing = await runCli(settings, [...globalArgs(settings, args.account), 'groups'], exec)
        if (listing.code !== 0) {
          return { ok: false, exitCode: listing.code, outDir: '', output: listing.output }
        }
        const chats = parseGroupTable(listing.output).map((row) => ({
          kind: 'group', id: row.id, name: row.name, messages: row.messages, lastTime: row.last,
        }))
        const decided = resolveGroup(chats, { chat: phrase, group })
        if (decided.error) return { ok: false, exitCode: 1, outDir: '', output: decided.error }
        group = decided.group
      }
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

/**
 * Which group a `chat` / `group` pair means, or the sentence that refuses it.
 *
 * Pure on purpose: the group table comes from the encrypted database, so the
 * only way to test this without a QQ install is to hand it the rows.
 */
export function resolveGroup(chats, { chat, group }) {
  const phrase = typeof chat === 'string' ? chat.trim() : ''
  const given = String(group ?? '').trim()
  if (phrase === '') {
    return given === '' ? { error: '给一个 group（群号）或 chat（群名）。' } : { group: given }
  }
  const picked = pickChat(chats, phrase)
  if (picked.tie) {
    // A number alongside the name settles the ambiguity the name could not.
    const numbered = given === ''
      ? null
      : picked.ranked.filter((item) => item.score === picked.ranked[0].score)
        .map((item) => item.chat)
        .find((chat) => String(chat.id) === given)
    if (numbered) return { group: String(numbered.id) }
    return { error: ambiguousChats(phrase, picked.ranked) }
  }
  if (picked.chat === null) return { error: unknownChat(phrase, chats) }
  // Both given and disagreeing is a contradiction, not a preference: honouring
  // either would export a group the user did not name.
  if (given !== '' && given !== String(picked.chat.id)) {
    return {
      error: `「${phrase}」对应的是群 ${picked.chat.id}，但 group 参数给的是 ${given}：只留一个再调。`,
    }
  }
  return { group: String(picked.chat.id) }
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
        query: {
          type: 'string',
          description: 'What the user called the chat: part of a name, an alias set in the web UI, a group number, or a QQ number. Matching is case-insensitive and ignores spaces; the most literal match comes first.',
        },
        kind: { type: 'string', enum: ['group', 'private'], description: 'Only list chats of this kind.' },
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
      // Aliases and hidden flags live in the page's chats-state.json; a chat
      // the user renamed must be findable under the new name.
      const sessions = mergeChatState(settings.workDir, payload.sessions, true)
      const kind = ['group', 'private'].includes(args.kind) ? args.kind : ''
      const pool = kind === '' ? sessions : sessions.filter((chat) => chat.kind === kind)
      const query = typeof args.query === 'string' ? args.query.trim() : ''
      const ranked = query === '' ? null : rankChats(pool, query)
      const ordered = ranked === null ? pool : ranked.map((item) => item.chat)
      const limit = Math.min(Math.max(Number(args.limit) || 200, 1), 1000)
      const chats = ordered.slice(0, limit)
      const lines = []
      if (ranked !== null) {
        const what = kind === '' ? '会话' : (kind === 'group' ? '群聊' : '私聊')
        lines.push(ranked.length === 0
          ? `没有匹配「${query}」的${what}（索引里有 ${pool.length} 个）。`
          : `匹配「${query}」：${ranked.length} 个${what}${ranked.length > chats.length ? `，显示前 ${chats.length} 个` : ''}`)
      }
      for (const chat of chats) lines.push(describeChat(chat))
      if (ordered.length > chats.length) {
        lines.push(`…共 ${ordered.length} 个会话，只显示前 ${chats.length} 个`)
      }
      lines.push('', '传 chatKind + chatId 给 qqnt_search / qqnt_export_chat；私聊的 chatId 是对方 uid。')
      lines.push('导出时也可以直接把名字/群号传给 qqnt_export_chat 的 chat 参数，不用先查 id。')
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
        sources: {
          type: 'array',
          items: { type: 'string', enum: ['text', 'ocr', 'asr'] },
          description: 'Which text to search: `text` is what was typed, `ocr` is text recognized inside images, `asr` is speech transcripts. Defaults to all of them; pass ["text"] to ignore recognized media.',
        },
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
      if (Array.isArray(args.sources) && args.sources.length > 0) payloadArgs.sources = args.sources
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

/** Shared by `qqnt_ask` / `qqnt_recall`: one line per message, no newlines. */
function flat(text, max = 400) {
  const single = String(text ?? '').replace(/\s+/g, ' ').trim()
  return single.length > max ? `${single.slice(0, max)}…` : single
}

/** The filters both retrieval tools accept. */
function retrievalArgs(question, args, fallbackTop) {
  const payload = { question }
  for (const key of ['chatKind', 'chatId', 'since', 'until']) {
    const value = args[key]
    if (typeof value === 'string' && value.trim() !== '') payload[key] = value.trim()
  }
  payload.topK = Math.min(Math.max(Number(args.topK) || fallbackTop, 1), 20)
  return payload
}

/**
 * Retrieval for a question: the spans that answer it, with citations.
 *
 * The plugin returns evidence, not prose (ADR-008): retrieval and citation are
 * local and checkable, the sentence is written by the host model. Keeping them
 * apart is also what makes "the answer cannot cite what retrieval never found"
 * true by construction.
 */
export function askTool(settings) {
  return {
    name: 'qqnt_ask',
    description: 'Retrieval for a question over local QQ conversations: returns the conversation spans most likely to answer it, each with the chat, time range, the messages it covers and a number to cite. Read the spans and write the answer yourself, citing [1], [2]; do not invent details that are not in the spans. Combines keyword terms with local embeddings when the embedding model is installed, so paraphrases are found too. Requires the sidecar index, and one run of 分块与嵌入 for the semantic half.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['question'],
      properties: {
        question: { type: 'string', minLength: 1, description: 'The question, in the user\'s own words (Chinese or English).' },
        chatKind: { type: 'string', enum: ['group', 'private'], description: 'Restrict to one kind of chat.' },
        chatId: { type: 'string', description: 'Restrict to one chat: group number, or the other party\'s uid.' },
        since: { type: 'string', description: 'Start date (`YYYY-MM-DD`) or Unix seconds.' },
        until: { type: 'string', description: 'End date (`YYYY-MM-DD`) or Unix seconds.' },
        topK: { type: 'integer', minimum: 1, maximum: 20, description: 'Spans to return. Defaults to 8.' },
      },
    },
    output: { schema: outputSchema(), render: renderReport },
    async execute(args, exec) {
      if (!existsSync(indexPath(settings))) return missingIndex(settings)
      const question = String(args.question ?? '').trim()
      if (question === '') return { ok: false, exitCode: 1, output: 'question 不能为空' }
      const payloadArgs = retrievalArgs(question, args, 8)
      const { code, payload } = await runQueryJson(
        settings, ['ask', '--json', JSON.stringify(payloadArgs)], exec)
      if (code !== 0) return { ok: false, exitCode: code, output: payload.error || '检索失败' }
      const hits = Array.isArray(payload.hits) ? payload.hits : []
      const lines = [`问题：${question}`, '']
      if (hits.length === 0) {
        lines.push('没有找到相关片段。')
      }
      hits.forEach((hit, index) => {
        const sources = (hit.sources || []).map((name) => ({
          text: '文字', ocr: '图片文字', asr: '语音转写', file_text: '文件文字',
        }[name] || name)).join('／')
        lines.push(`[${index + 1}] ${hit.chat} · ${hit.start}–${hit.end.slice(-5)} · ${sources}`)
        lines.push(flat(hit.text, 800))
        const quotes = (hit.citations || [])
          .map((row) => `${row.sender} ${String(row.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 120)}`)
          .join(' | ')
        if (quotes) lines.push(`引用（msg ${hit.msg_ids.join(',')}）：${quotes}`)
        lines.push('')
      })
      for (const note of payload.notes || []) lines.push(`提示：${note}`)
      lines.push('回答时请只依据上面的片段，用 [1]、[2] 标注来源；片段里没有的信息就说没有找到。')
      return { ok: true, exitCode: 0, output: lines.join('\n') }
    },
  }
}

/** `qqnt_ask` as a timeline: same retrieval, grouped by day, oldest first. */
export function recallTool(settings) {
  return {
    name: 'qqnt_recall',
    description: 'A topic over time: retrieves the same conversation spans as qqnt_ask but returns them grouped by day, oldest first, so you can trace how a plan, decision or price changed. Each item has the chat, time, quoted messages and the message ids behind them. Requires the sidecar index.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['query'],
      properties: {
        query: { type: 'string', minLength: 1, description: 'Topic or question to trace.' },
        chatKind: { type: 'string', enum: ['group', 'private'] },
        chatId: { type: 'string', description: 'Restrict to one chat.' },
        since: { type: 'string', description: 'Start date (`YYYY-MM-DD`) or Unix seconds.' },
        until: { type: 'string', description: 'End date (`YYYY-MM-DD`) or Unix seconds.' },
        topK: { type: 'integer', minimum: 1, maximum: 20, description: 'Spans to return. Defaults to 20.' },
      },
    },
    output: { schema: outputSchema(), render: renderReport },
    async execute(args, exec) {
      if (!existsSync(indexPath(settings))) return missingIndex(settings)
      const question = String(args.query ?? '').trim()
      if (question === '') return { ok: false, exitCode: 1, output: 'query 不能为空' }
      const payloadArgs = retrievalArgs(question, args, 20)
      payloadArgs.topK = Math.min(payloadArgs.topK, 20)
      const { code, payload } = await runQueryJson(
        settings, ['recall', '--json', JSON.stringify(payloadArgs)], exec)
      if (code !== 0) return { ok: false, exitCode: code, output: payload.error || '检索失败' }
      const days = Array.isArray(payload.days) ? payload.days : []
      const lines = [`主题：${question}`, '']
      if (days.length === 0) lines.push('没有找到相关片段。')
      for (const day of days) {
        lines.push(day.date)
        for (const item of day.items) {
          lines.push(`  ${item.time.slice(-5)} ${item.chat}：${flat(item.quote, 300)}`)
        }
        lines.push('')
      }
      for (const note of payload.notes || []) lines.push(`提示：${note}`)
      return { ok: true, exitCode: 0, output: lines.join('\n') }
    },
  }
}

/** Exports one chat (group or private) from the sidecar index to a file. */
export function exportChatTool(settings) {
  return {
    name: 'qqnt_export_chat',
    description: 'Export one chat — group or private — from the local QQ index to txt, csv, json, md, html, or sqlite, and return the written file path. Name the chat either by `chat` (a name, an alias, a group number or a QQ, as the user said it) or by chatKind + chatId; a phrase that matches several chats exports nothing and returns the candidates, so ask instead of guessing. Narrow the content with keyword/sender/since/until, and set dryRun=true to preview the count and target directory before writing. media=true copies downloaded pictures/files/voice/video into a ZIP, split=day writes one file per day (ZIP), embed=true makes a single self-contained HTML, redact pseudonymises senders. Requires the sidecar index.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        chat: {
          type: 'string',
          minLength: 1,
          description: 'The chat as the user named it: a name, an alias, a group number or a QQ number ("示例课程群", "群号 123", "和妈妈的私聊"). Resolved against the index; when two chats match equally well nothing is exported and the candidates come back.',
        },
        chatKind: { type: 'string', enum: ['group', 'private'], description: 'Optional when `chat` is given: restrict the search to one kind.' },
        chatId: { type: 'string', description: 'Group number, or the other party\'s uid for a private chat.' },
        keyword: { type: 'string', description: 'Only messages containing this text (substring, Chinese included).' },
        sender: { type: 'string', description: 'Only messages from this sender: a name fragment or an exact QQ number.' },
        since: { type: 'string', description: 'Exports messages from this date on (`YYYY-MM-DD`) or Unix seconds.' },
        until: { type: 'string', description: 'Exports messages up to this date (`YYYY-MM-DD`) or Unix seconds.' },
        dryRun: {
          type: 'boolean',
          description: 'Preview only: report the resolved chat, how many messages match, the format and the target directory without writing a file. Use it before a large or ambiguous export.',
        },
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
        preset: {
          type: 'string',
          description: 'Name of an export preset saved in the web UI (settings → 导出预设). Explicit arguments win over the preset.',
        },
      },
    },
    output: { schema: outputSchema({ outPath: { type: 'string' } }), render: renderReport },
    timeoutMs: EXPORT_TIMEOUT_MS,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      if (!existsSync(indexPath(settings))) return missingIndex(settings, { outPath: '' })
      let kind = String(args.chatKind ?? '')
      let chatId = String(args.chatId ?? '').trim()
      const phrase = typeof args.chat === 'string' ? args.chat.trim() : ''
      if (phrase === '' && (!['group', 'private'].includes(kind) || chatId === '')) {
        return {
          ok: false, exitCode: 1, outPath: '',
          output: '给一个 chat（名字/别名/群号/QQ），或者同时给 chatKind 与 chatId；拿不准时先用 qqnt_list_chats 的 query 找一下',
        }
      }
      if (typeof args.preset === 'string' && args.preset.trim() !== '') {
        const wanted = args.preset.trim()
        const preset = readPresets(settings.workDir).find((row) => row.name === wanted)
        if (!preset) {
          return { ok: false, exitCode: 1, outPath: '', output: unknownPreset(wanted, settings.workDir) }
        }
        args = applyPreset(args, preset)
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
      // Resolve the chat before writing anything: a typo used to produce a file
      // with a header and zero messages and an `ok: true`, which reads like a
      // successful export.
      let label = typeof args.label === 'string' ? args.label.trim() : ''
      let known = null
      let chats = []
      try {
        const sessions = await runQueryJson(settings, ['sessions'], exec)
        chats = mergeChatState(settings.workDir, sessions.payload.sessions, true)
      } catch (error) {
        return {
          ok: false, exitCode: 1, outPath: '',
          output: `读取索引里的会话列表失败：${error.message}`,
        }
      }
      if (phrase !== '') {
        // A kind given alongside the name narrows the pool ("private 妈妈").
        const pool = ['group', 'private'].includes(kind)
          ? chats.filter((chat) => chat.kind === kind) : chats
        const picked = pickChat(pool, phrase)
        if (picked.tie) {
          return { ok: false, exitCode: 1, outPath: '', output: ambiguousChats(phrase, picked.ranked) }
        }
        if (picked.chat === null) {
          return { ok: false, exitCode: 1, outPath: '', output: unknownChat(phrase, chats) }
        }
        known = picked.chat
        kind = known.kind
        chatId = String(known.id)
      } else {
        known = chats.find((item) => item.kind === kind && String(item.id) === chatId) || null
        if (known === null) {
          return {
            ok: false, exitCode: 1, outPath: '',
            output: `索引里没有这个会话：${kind}/${chatId}。先用 qqnt_list_chats 查一下会话 id 与类型，或者把名字直接传给 chat。`,
          }
        }
      }
      if (label === '') label = known.name || chatId
      // Content filters: "只导出九月的" / "只看小王发的" / "只导开会相关".
      const filters = {}
      for (const key of ['keyword', 'sender', 'since', 'until']) {
        const value = typeof args[key] === 'string' ? args[key].trim() : ''
        if (value !== '') filters[key] = value
      }
      const outDir = typeof args.outDir === 'string' && args.outDir.trim() !== ''
        ? path.resolve(args.outDir.trim())
        : path.join(defaultDownloadDir(), `QQ导出_${fileStem(label, chatId)}`)
      if (args.dryRun === true) {
        // Preview through `stats`: same WHERE clause, counts only, no file.
        let total = 0
        let range = ''
        try {
          const stats = await runQueryJson(settings, ['stats', '--json', JSON.stringify({
            chatKind: kind, chatId, ...filters,
          })], exec)
          if (stats.code === 0) {
            total = Number(stats.payload.total) || 0
            if (stats.payload.firstTime && stats.payload.lastTime) {
              range = `${stats.payload.firstTime} → ${stats.payload.lastTime}`
            }
          }
        } catch {
          // A preview that cannot count is still useful; the export itself
          // reports the real error.
        }
        const scoped = Object.entries(filters)
          .map(([key, value]) => ({ keyword: '关键词', sender: '发送者', since: '起', until: '止' }[key] + `「${value}」`))
        const lines = [
          `将导出：${known.name || chatId}（${kind}/${chatId}）`,
          `条数：${total}${range ? ` · ${range}` : ''}`,
          `范围：${scoped.length > 0 ? scoped.join(' · ') : '整个会话'}`,
          `格式：${container.toUpperCase()}${container === 'zip' ? '（打包）' : ''}`,
          `目标：${outDir}`,
          '这一步没有写文件；确认后去掉 dryRun 再调一次。',
        ]
        return { ok: true, exitCode: 0, outPath: '', output: lines.join('\n') }
      }
      mkdirSync(outDir, { recursive: true, mode: 0o700 })
      // The query layer may only write inside workDir/exports; stage there and
      // move the finished file to the directory the user asked for.
      const staging = path.join(settings.workDir, 'exports',
        `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${container}`)
      const payloadArgs = { chatKind: kind, chatId, format, label, out: staging, ...filters }
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

/**
 * Batch export: several chats into one ZIP with a manifest.json.
 *
 * The page already had this (200-chat limit, one file per chat); the tool was
 * missing it, so an Agent had to call `qqnt_export_chat` in a loop. Arguments
 * mirror the page's batch route so both produce the same archive.
 */
export function exportBatchTool(settings) {
  const CHAT_LIMIT = 200
  return {
    name: 'qqnt_export_batch',
    description: 'Export up to 200 chats from the local QQ index into one ZIP that also contains a manifest.json (one file per chat). List the chats as `chatNames` (names, aliases, group numbers or QQs, as the user said them) or as `chats` with kind + id; a name matching several chats refuses the whole call instead of dropping one. Supports formats, content filters (keyword/sender/since/until, applied to every chat), redaction, media, day-splitting, password ZIPs and a saved export preset. Requires the sidecar index.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        chatNames: {
          type: 'array',
          minItems: 1,
          maxItems: 200,
          items: { type: 'string', minLength: 1 },
          description: 'Chat names/aliases/group numbers as the user said them; resolved against the index before anything is written.',
        },
        chats: {
          type: 'array',
          minItems: 1,
          maxItems: CHAT_LIMIT,
          description: 'Which chats to export: `{ kind, id }` entries, optionally with `label`.',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['kind', 'id'],
            properties: {
              kind: { type: 'string', enum: ['group', 'private'] },
              id: { type: 'string', description: 'Group number, or the other party\'s uid.' },
              label: { type: 'string', description: 'Name used in the file name inside the ZIP.' },
            },
          },
        },
        keyword: { type: 'string', description: 'Only messages containing this text, in every chat of the batch.' },
        sender: { type: 'string', description: 'Only messages from this sender: a name fragment or an exact QQ number.' },
        since: { type: 'string', description: 'Only messages from this date on (`YYYY-MM-DD`) or Unix seconds.' },
        until: { type: 'string', description: 'Only messages up to this date (`YYYY-MM-DD`) or Unix seconds.' },
        format: { type: 'string', enum: ['txt', 'csv', 'json', 'md', 'html', 'sqlite'], description: 'File format inside the ZIP. Defaults to txt.' },
        outDir: { type: 'string', description: 'Absolute output directory. Defaults to QQ导出_<N>个会话 inside the user\'s downloads folder.' },
        zipName: { type: 'string', description: 'Base name of the ZIP (without .zip). Defaults to QQ导出_<N>个会话.' },
        redact: { type: 'string', enum: ['names', 'qq', 'all'], description: 'Pseudonymise senders/QQ numbers before writing.' },
        media: { type: 'boolean', description: 'Copy downloaded media for every chat into the same ZIP.' },
        split: { type: 'string', enum: ['day'], description: 'One file per local day per chat inside the ZIP.' },
        password: { type: 'string', minLength: 4, maxLength: 128, description: 'AES-256 password for the ZIP (needs pyzipper).' },
        preset: { type: 'string', description: 'Name of a saved export preset; explicit arguments win.' },
        columns: {
          type: 'array',
          items: { type: 'string', enum: ['time', 'sender', 'qq', 'direction', 'kinds', 'text'] },
          minItems: 1,
          description: 'CSV only: which columns to write.',
        },
        frontMatter: { type: 'boolean', description: 'Markdown only: start each file with YAML front matter.' },
      },
    },
    output: {
      schema: outputSchema({
        outPath: { type: 'string' },
        chats: { type: 'integer' },
        rows: { type: 'integer' },
      }),
      render: renderReport,
    },
    timeoutMs: EXPORT_TIMEOUT_MS,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const empty = { ok: false, exitCode: 1, outPath: '', chats: 0, rows: 0 }
      if (!existsSync(indexPath(settings))) return missingIndex(settings, empty)
      if (typeof args.preset === 'string' && args.preset.trim() !== '') {
        const wanted = args.preset.trim()
        const preset = readPresets(settings.workDir).find((row) => row.name === wanted)
        if (!preset) {
          return { ...empty, output: unknownPreset(wanted, settings.workDir) }
        }
        args = applyPreset(args, preset)
      }
      const raw = Array.isArray(args.chats) ? args.chats : []
      const names = (Array.isArray(args.chatNames) ? args.chatNames : [])
        .map((value) => String(value ?? '').trim()).filter((value) => value !== '')
      if (raw.length === 0 && names.length === 0) {
        return { ...empty, output: 'chats 或 chatNames 不能为空：至少给一个会话' }
      }
      if (raw.length + names.length > CHAT_LIMIT) {
        return { ...empty, output: `一次最多导出 ${CHAT_LIMIT} 个会话（收到 ${raw.length + names.length} 个）` }
      }
      const chats = []
      if (names.length > 0) {
        let sessions = []
        try {
          const answer = await runQueryJson(settings, ['sessions'], exec)
          sessions = mergeChatState(settings.workDir, answer.payload.sessions, true)
        } catch (error) {
          return { ...empty, output: `读取索引里的会话列表失败：${error.message}` }
        }
        for (const name of names) {
          const picked = pickChat(sessions, name)
          if (picked.tie) return { ...empty, output: ambiguousChats(name, picked.ranked) }
          if (picked.chat === null) return { ...empty, output: unknownChat(name, sessions) }
          chats.push({
            kind: picked.chat.kind,
            id: String(picked.chat.id),
            label: picked.chat.name || String(picked.chat.id),
          })
        }
      }
      for (const item of raw) {
        const kind = String(item?.kind ?? '')
        const id = String(item?.id ?? '').trim()
        if (!['group', 'private'].includes(kind) || id === '') {
          return { ...empty, output: '每个会话都需要 kind（group/private）和非空 id' }
        }
        const label = typeof item?.label === 'string' ? item.label.trim().slice(0, 120) : ''
        chats.push(label === '' ? { kind, id } : { kind, id, label })
      }
      const format = typeof args.format === 'string' ? args.format : 'txt'
      if (!['txt', 'csv', 'json', 'md', 'html', 'sqlite'].includes(format)) {
        return { ...empty, chats: chats.length, output: `不支持的格式: ${format}` }
      }
      const password = typeof args.password === 'string' ? args.password : ''
      if (password && (password.length < 4 || password.length > 128)) {
        return { ...empty, chats: chats.length, output: '密码长度需要 4~128 个字符' }
      }
      const media = args.media === true
      const split = args.split === 'day' ? 'day' : ''
      const redact = ['names', 'qq', 'all'].includes(args.redact) ? args.redact : ''
      const label = `批量导出 ${chats.length} 个会话`
      const outDir = typeof args.outDir === 'string' && args.outDir.trim() !== ''
        ? path.resolve(args.outDir.trim())
        : path.join(defaultDownloadDir(), `QQ导出_${chats.length}个会话`)
      mkdirSync(outDir, { recursive: true, mode: 0o700 })
      // Same staging rule as the single-chat tool: the query layer may only
      // write inside workDir/exports, then the finished ZIP is moved out.
      const staging = path.join(settings.workDir, 'exports',
        `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.zip`)
      const payloadArgs = { format, chats, out: staging, label }
      // Content filters apply per chat inside the bundle, so the same
      // keyword/sender/date narrowing the single-chat export has works here.
      for (const key of ['keyword', 'sender', 'since', 'until']) {
        const value = typeof args[key] === 'string' ? args[key].trim() : ''
        if (value !== '') payloadArgs[key] = value
      }
      if (redact) payloadArgs.redact = redact
      if (media) payloadArgs.media = true
      if (split) payloadArgs.split = 'day'
      if (format === 'csv' && Array.isArray(args.columns) && args.columns.length > 0) {
        payloadArgs.columns = args.columns.map(String)
      }
      if (format === 'md' && args.frontMatter === true) payloadArgs.frontMatter = true
      const { code, payload } = await runQueryJson(
        settings, ['export', '--json', JSON.stringify(payloadArgs)], exec,
        password ? { QQNT_EXPORT_PASSWORD: password } : undefined)
      if (code !== 0) {
        return {
          ok: false, exitCode: code, outPath: '', chats: chats.length, rows: 0,
          output: payload.error || '批量导出失败',
        }
      }
      const wanted = typeof args.zipName === 'string' ? args.zipName.trim().replace(/\.zip$/i, '') : ''
      const stem = fileStem(wanted, `QQ导出_${chats.length}个会话`)
      const target = uniqueTarget(outDir, stem, 'zip')
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
      const rows = Number(payload.rows) || 0
      const skipped = Number(payload.skipped) || 0
      const lines = [`已导出 ${chats.length} 个会话 / ${rows} 条到 ${target}`]
      if (skipped > 0) {
        lines.push(`${skipped} 个会话没有匹配的消息（筛选条件太窄，或会话本身是空的）：ZIP 里的 manifest.json 的 skipped 写着是哪几个。`)
      }
      return {
        ok: true, exitCode: 0, outPath: target, chats: chats.length, rows,
        output: lines.join('\n'),
      }
    },
  }
}

// ── Diagnostics and aggregates ───────────────────────────────────────────
// The three tools below answer "can I read anything yet", "why not" and "how
// much is there" without the user opening the web UI. They run the same
// sidecar the page runs instead of looping back through HTTP, so they keep
// working when the listener is off or another local app holds its port.

/** `1204` → `1,204`. Every count in tool output is read by a person. */
function withCommas(value) {
  const number = Math.trunc(Number(value) || 0)
  const digits = String(Math.abs(number)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return number < 0 ? `-${digits}` : digits
}

/** Byte counts for one-line summaries: `0 B`, `52.3 KB`, `1.1 GB`. */
function sizeText(bytes) {
  const value = Math.max(0, Number(bytes) || 0)
  if (value < 1024) return `${value} B`
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MB`
  return `${(value / 1024 ** 3).toFixed(1)} GB`
}

/** `2026-11-01 21:18` from Unix seconds; `''` for an unset stamp. */
function clockText(seconds) {
  const value = Math.trunc(Number(seconds) || 0)
  if (value <= 0) return ''
  const when = new Date(value * 1000)
  const pad = (n) => String(n).padStart(2, '0')
  return `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}`
    + ` ${pad(when.getHours())}:${pad(when.getMinutes())}`
}

/** How stale a stamp is, in words: `刚才`, `12 分钟前`, `3 天前`, then a date. */
function agoText(seconds) {
  const value = Math.trunc(Number(seconds) || 0)
  if (value <= 0) return ''
  const delta = Date.now() - value * 1000
  if (delta < 90_000) return '刚才'
  if (delta < 3_600_000) return `${Math.round(delta / 60_000)} 分钟前`
  if (delta < 86_400_000) return `${Math.round(delta / 3_600_000)} 小时前`
  if (delta < 7 * 86_400_000) return `${Math.round(delta / 86_400_000)} 天前`
  return clockText(value)
}

/** Global options the query CLI requires before its subcommand. */
function queryGlobalArgs(settings, account) {
  const argv = []
  if (settings.tencentRoot) argv.push('--root', settings.tencentRoot)
  if (account) argv.push('--account', String(account))
  return argv
}

/** One `status` call against the sidecar; the index file and its counts. */
async function queryStatus(settings, exec, account) {
  const { code, payload } = await runQueryJson(
    settings, [...queryGlobalArgs(settings, account), 'status'], exec)
  return { code, payload }
}

/** `解析消息 42% · 12,345/29,000`; `''` while no build is running. */
function buildProgressText(build) {
  const state = build && typeof build === 'object' ? build : {}
  if (state.state !== 'running') return ''
  const processed = Number(state.processed) || 0
  const total = Number(state.total) || 0
  const step = typeof state.step === 'string' && state.step !== '' ? state.step : '处理中'
  if (total <= 0) return step
  const percent = Math.min(100, Math.round((processed / total) * 100))
  return `${step} ${percent}% · ${withCommas(processed)}/${withCommas(total)}`
}

/** The one or two index lines shared by `qqnt_index` and `qqnt_doctor`. */
function indexLines(settings, status, build, running) {
  const index = (status && status.index) || {}
  const file = index.path || indexPath(settings.workDir)
  const lines = []
  if (index.exists !== true) {
    lines.push(`索引：还没有建立（${file}）`)
  } else {
    const built = Number(index.builtAt) || 0
    const mode = index.search === 'like' ? 'LIKE' : 'FTS'
    lines.push(`索引：${withCommas(index.messages)} 条消息 · ${withCommas(index.chats)} 个会话 · ${mode}`
      + (built > 0 ? ` · 构建于 ${clockText(built)}（${agoText(built)}）` : ''))
    lines.push(`文件：${file} · ${sizeText(index.size)}`)
  }
  if (running) lines.push(`进度：${buildProgressText(build) || '进行中'}`)
  else if (build && build.state === 'error' && build.error) lines.push(`上次构建失败：${build.error}`)
  return lines
}

/**
 * Build or inspect the sidecar index.
 *
 * Every message-reading tool needs `index.sqlite`, and until now only the web
 * page could create it — the one blocker an Agent cannot talk its way around.
 * `status` is read-only. `build` spawns the same detached helper the page
 * spawns, waits at most `waitSeconds`, and never kills the child on timeout: a
 * large account takes minutes, and restarting it from every poll would make a
 * build that never finishes.
 */
export function indexTool(settings, busy) {
  const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms) })
  return {
    name: 'qqnt_index',
    description: 'Inspect or build the local sidecar index that every message-reading qqnt_ tool needs. action="status" (the default) reports the index file, its message and chat counts, and whether a build is running; action="build" starts a build and waits up to waitSeconds for it to finish. A build copies and decrypts the QQ database, so a large account takes one to three minutes: when the call returns first, the build keeps running and a second status call reports the result. Needs a cached database key (qqnt_extract_key) unless one is already there.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['status', 'build'], description: 'Defaults to status.' },
        refresh: {
          type: 'boolean',
          description: 'build only: copy the encrypted database again before parsing (after a QQ upgrade or an account switch).',
        },
        waitSeconds: {
          type: 'integer',
          minimum: 0,
          maximum: 600,
          description: 'build only: how long to wait before returning. Defaults to 120; 0 starts the build and returns immediately.',
        },
        account: {
          type: 'string',
          description: 'QQ number to build for when the client holds several accounts. Defaults to the configured account.',
        },
      },
    },
    output: {
      schema: outputSchema({
        running: { type: 'boolean' },
        messages: { type: 'integer' },
        chats: { type: 'integer' },
      }),
      render: renderReport,
    },
    // A wait of up to 600 s plus a status call at each end.
    timeoutMs: 12 * 60_000,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const base = { ok: true, exitCode: 0, running: false, messages: 0, chats: 0 }
      const workDir = settings.workDir
      const asked = typeof args.account === 'string' ? args.account.trim() : ''
      const account = asked !== '' ? asked : (settings.account || '')
      let status = null
      try {
        status = (await queryStatus(settings, exec, asked)).payload
      } catch (error) {
        // A helper that cannot even answer `status` would fail the build the
        // same way, so this stops before spawning anything.
        return {
          ...base, ok: false, exitCode: 1,
          output: `无法读取索引状态：${error instanceof Error ? error.message : String(error)}\n`
            + '先用 qqnt_doctor 看环境（Python 解释器、sqlcipher3、密钥），修好再建索引。',
        }
      }
      const build = readBuildState(workDir)
      const running = buildRunning(workDir)
      if (args.action !== 'build') {
        const lines = indexLines(settings, status, build, running)
        if (running) {
          lines.push('再调一次 qqnt_index（action: "status"）看结果；构建进程会自己跑完。')
        } else if (!existsSync(indexPath(settings))) {
          lines.push('下一步：调 qqnt_index（action: "build"）建立索引。')
          if (!existsSync(path.join(workDir, 'key.txt'))) {
            lines.push('还没有数据库密钥：先调 qqnt_extract_key（QQ 要在登录状态，大约一到三分钟）。')
          }
        } else {
          lines.push('下一步：qqnt_list_chats 看会话，或 qqnt_stats 看总量。')
        }
        return {
          ...base,
          running,
          messages: Number(status?.index?.messages) || 0,
          chats: Number(status?.index?.chats) || 0,
          output: lines.join('\n'),
        }
      }
      if (busy?.()) {
        return {
          ...base, ok: false, exitCode: 1,
          output: '网页正在提取密钥或配置环境，等它结束再建立索引；进度在网页「设置」里。',
        }
      }
      if (running) {
        return {
          ...base, running: true,
          output: [
            '已有一次索引构建在进行，没有重复启动。',
            `进度：${buildProgressText(build) || '进行中'}`,
            '再调一次 qqnt_index（action: "status"）看结果。',
          ].join('\n'),
        }
      }
      const argv = ['-X', 'utf8', QUERY_CLI, '--work', workDir]
      if (settings.tencentRoot) argv.push('--root', settings.tencentRoot)
      if (account) argv.push('--account', String(account))
      argv.push('build')
      if (args.refresh === true) argv.push('--refresh')
      argv.push('--keep', String(settings.keepAccountIndexes ?? 2))
      argv.push('--search', settings.searchIndex === 'like' ? 'like' : 'fts')
      const spawnedAt = Date.now()
      const started = await spawnBuild(settings, argv)
      if (!started.ok) {
        const missing = started.error?.code === 'ENOENT'
        return {
          ...base, ok: false, exitCode: 1,
          output: missing
            ? `无法运行 Python 解释器「${settings.python}」：找不到可执行文件。用 qqnt_doctor 看应该填哪个路径。`
            : `无法启动索引构建：${started.error?.message || '未知错误'}`,
        }
      }
      const wait = Math.min(Math.max(Number(args.waitSeconds ?? 120) || 0, 0), 600)
      if (wait === 0) {
        return {
          ...base, running: true,
          output: [
            '索引构建已启动（waitSeconds=0，没有等待）。',
            '再调一次 qqnt_index（action: "status"）看结果；构建进程会自己跑完。',
          ].join('\n'),
        }
      }
      // The previous run's status file is still on disk, so a state only counts
      // when it was written by the child this call just started.
      const spawnSecond = Math.floor(spawnedAt / 1000)
      const fresh = (value) => Number(value?.startedAt) > 0 && Number(value.startedAt) >= spawnSecond - 1
      const deadline = spawnedAt + wait * 1000
      let state = readBuildState(workDir)
      while (Date.now() < deadline) {
        if (fresh(state) && (state.state === 'done' || state.state === 'error')) break
        if (!fresh(state) && Date.now() - spawnedAt > 5000 && !buildRunning(workDir)) break
        await sleep(400)
        state = readBuildState(workDir)
      }
      if (fresh(state) && state.state === 'error') {
        return {
          ...base, ok: false, exitCode: 1,
          output: [
            `索引构建失败：${state.error || '没有给出原因'}`,
            '',
            '按上面的原因处理后再调一次 qqnt_index（action: "build"）；密钥问题用 qqnt_extract_key，环境问题用 qqnt_doctor。',
          ].join('\n'),
        }
      }
      if (!fresh(state) || state.state === 'running') {
        return {
          ...base, running: true,
          output: [
            `构建还在进行，没有等它结束（已等 ${Math.round((Date.now() - spawnedAt) / 1000)} 秒）。`,
            `进度：${buildProgressText(state) || '还没写出进度'}`,
            '再调一次 qqnt_index（action: "status"）看结果；构建进程会自己跑完。如果一直没进度，用 qqnt_doctor 检查 Python 与密钥。',
          ].join('\n'),
        }
      }
      const seconds = Math.max(0, (Number(state.finishedAt) || 0) - (Number(state.startedAt) || 0))
      const mode = state.mode === 'incremental' ? '增量' : '全量'
      const lines = [`索引构建完成：${mode} · 新增 ${withCommas(state.added)} 条 · 共 ${withCommas(state.total)} 条`
        + (seconds > 0 ? ` · 用时 ${seconds} 秒` : '')]
      if (state.fullReasonText) lines.push(`退回全量的原因：${state.fullReasonText}`)
      if (state.schemaChanged) lines.push('注意：源表结构变了，这次按新结构重建，核对一下统计再导出。')
      if (state.walPending) lines.push('注意：源库的 WAL 里还有没落盘的内容，最近几分钟的消息可能缺几条。')
      let after = null
      try {
        after = (await queryStatus(settings, exec, asked)).payload
      } catch {
        // The build's own numbers are enough when the follow-up read fails.
      }
      if (after) lines.push(...indexLines(settings, after, null, false))
      lines.push('下一步：qqnt_list_chats 看会话，或 qqnt_stats 看总量。')
      return {
        ...base,
        messages: Number(after?.index?.messages) || Number(state.total) || 0,
        chats: Number(after?.index?.chats) || 0,
        output: lines.join('\n'),
      }
    },
  }
}

/**
 * Aggregates over the index, without paging through messages.
 *
 * Counting with `qqnt_search` meant hoping a page size covered the answer; the
 * helper's `stats` command runs the aggregation in SQL and is what the stats
 * page already draws.
 */
export function statsTool(settings) {
  return {
    name: 'qqnt_stats',
    description: 'Aggregate the local QQ index instead of paging through messages: total messages, chats and senders, monthly totals, the busiest hours, and the top senders and chats. Takes the same filters as qqnt_search (chatKind, chatId, keyword, sender, since, until). Requires the sidecar index.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        chatKind: { type: 'string', enum: ['group', 'private'] },
        chatId: { type: 'string', description: 'Group number, or the other party\'s uid for a private chat.' },
        keyword: { type: 'string', description: 'Substring match, Chinese included; the same inline filters qqnt_search accepts.' },
        sender: { type: 'string', description: 'Sender name fragment or exact QQ number.' },
        since: { type: 'string', description: 'Start date (`YYYY-MM-DD`) or Unix seconds.' },
        until: { type: 'string', description: 'End date (`YYYY-MM-DD`) or Unix seconds.' },
        sources: {
          type: 'array',
          items: { type: 'string', enum: ['text', 'ocr', 'asr'] },
          description: 'Which text the keyword matches: typed text, recognized images, speech transcripts. Defaults to all of them.',
        },
        top: {
          type: 'integer',
          minimum: 1,
          maximum: 20,
          description: 'How many senders and chats to list. Defaults to 6.',
        },
      },
    },
    output: {
      schema: outputSchema({
        total: { type: 'integer' },
        chats: { type: 'integer' },
        senders: { type: 'integer' },
      }),
      render: renderReport,
    },
    async execute(args, exec) {
      const empty = { ok: false, exitCode: 1, total: 0, chats: 0, senders: 0 }
      if (!existsSync(indexPath(settings))) return missingIndex(settings, empty)
      const payloadArgs = {}
      for (const key of ['chatKind', 'chatId', 'keyword', 'sender', 'since', 'until']) {
        const value = typeof args[key] === 'string' ? args[key].trim() : ''
        if (value !== '') payloadArgs[key] = value
      }
      if (Array.isArray(args.sources) && args.sources.length > 0) payloadArgs.sources = args.sources
      const top = Math.min(Math.max(Number(args.top) || 6, 1), 20)
      let payload
      try {
        const answer = await runQueryJson(
          settings, ['stats', '--json', JSON.stringify(payloadArgs)], exec)
        if (answer.code !== 0) {
          return { ...empty, output: answer.payload.error || '统计失败' }
        }
        payload = answer.payload
      } catch (error) {
        return {
          ...empty,
          output: `统计失败：${error instanceof Error ? error.message : String(error)}`,
        }
      }
      const total = Number(payload.total) || 0
      const chats = Number(payload.chats) || 0
      const senders = Number(payload.senders) || 0
      if (total === 0) {
        return {
          ok: true, exitCode: 0, total, chats, senders,
          output: [
            '没有匹配的消息（0 条）。',
            '放宽 since/until 或 keyword 再看；如果索引本身是空的，用 qqnt_index 建一次。',
          ].join('\n'),
        }
      }
      const scope = []
      if (payloadArgs.chatKind === 'group') scope.push('只看群聊')
      else if (payloadArgs.chatKind === 'private') scope.push('只看私聊')
      for (const [key, label] of [['keyword', '关键词'], ['sender', '发送者'], ['since', '起'], ['until', '止']]) {
        if (payloadArgs[key]) scope.push(`${label}「${payloadArgs[key]}」`)
      }
      const first = String(payload.firstTime || '').slice(0, 10)
      const last = String(payload.lastTime || '').slice(0, 10)
      const range = first !== '' && last !== '' ? ` · ${first} → ${last}` : ''
      const lines = [`范围：${scope.length > 0 ? scope.join(' · ') : '整个索引'}${range}`]
      lines.push(`合计：${withCommas(total)} 条 · ${withCommas(chats)} 个会话 · ${withCommas(senders)} 位发言人`)
      const monthly = Array.isArray(payload.monthly) ? payload.monthly : []
      if (monthly.length > 0) {
        // Empty months are absent from the payload; say so instead of printing
        // a run of zeroes for a chat that sat quiet for half a year.
        const shown = monthly.length > 12 ? monthly.slice(-12) : monthly
        const head = monthly.length > 12 ? `最近 12 个月（共 ${monthly.length} 个月）：` : '月度：'
        lines.push(head + shown.map((row) => `${row.month} ${withCommas(row.count)}`).join(' · '))
      }
      // Rows whose sender name never resolved come back as "?", which reads
      // like a parsing failure; the count is real, the name is not known.
      const label = (row) => (row.name === '?' ? '未命名' : row.name)
      const pick = (rows) => rows.slice(0, top)
        .map((row) => `${label(row)} ${withCommas(row.count)}`).join(' · ')
      if (Array.isArray(payload.topSenders) && payload.topSenders.length > 0) {
        lines.push(`Top 发言人：${pick(payload.topSenders)}`)
      }
      if (Array.isArray(payload.topChats) && payload.topChats.length > 0) {
        lines.push(`Top 会话：${pick(payload.topChats)}`)
      }
      const hourly = Array.isArray(payload.hourly) ? payload.hourly : []
      const busy = hourly.map((count, hour) => [hour, Number(count) || 0])
        .filter(([, count]) => count > 0)
      if (busy.length > 0) {
        lines.push(`小时（本地时间）：${busy.map(([hour, count]) => `${hour} 时 ${withCommas(count)}`).join(' · ')}`)
      }
      lines.push('', '要具体内容用 qqnt_search；要文件用 qqnt_export_chat（chat 可以直接给名字）。')
      return { ok: true, exitCode: 0, total, chats, senders, output: lines.join('\n') }
    },
  }
}

/**
 * One call that answers "why doesn't it work".
 *
 * Answers the question with the same probes the settings page uses
 * (`probePython`, `ptraceInfo`, `status`), then states the next step for each
 * missing piece. Deliberately not a flag on `qqnt_status`: a model that does
 * not pass `deep` still gets the short answer, and the first call is the one
 * that matters.
 */
export function doctorTool(settings, currentUrl) {
  return {
    name: 'qqnt_doctor',
    description: 'One-call health check for this plugin: version and platform, the Python interpreter with sqlcipher3 and pyzipper, the cached database key, ptrace permission on Linux, the sidecar index with its counts and any build in progress, the derived store, and the exact next step for whatever is missing. Call it first when a qqnt_ tool fails or before asking the user to open the web UI. deep=true also inspects the optional OCR/speech/embedding components and downloaded model files (about a second slower).',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        deep: {
          type: 'boolean',
          description: 'Also report the optional components (OCR, speech, embeddings) and the model files.',
        },
      },
    },
    output: { schema: outputSchema(), render: renderReport },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const deep = args.deep === true
      const workDir = settings.workDir
      const probePromise = probePython(settings)
      const statusPromise = queryStatus(settings, exec, '').then(
        (answer) => answer.payload, () => null)
      let models = null
      let components = null
      if (deep) {
        const [modelsAnswer, componentsAnswer] = await Promise.all([
          runQueryJson(settings, ['models', '--json', '{}'], exec).catch(() => null),
          runQueryJson(settings, ['components', '--json', JSON.stringify({ action: 'status' })], exec)
            .catch(() => null),
        ])
        models = modelsAnswer?.payload ?? null
        components = componentsAnswer?.payload?.components ?? null
      }
      const probe = await probePromise
      const status = await statusPromise
      const build = readBuildState(workDir)
      const running = buildRunning(workDir)
      const ptrace = ptraceInfo()
      const storage = storageSnapshot(workDir)
      let keyStamp = 0
      try {
        keyStamp = Math.floor(statSync(path.join(workDir, 'key.txt')).mtimeMs / 1000)
      } catch {
        // No cached key.
      }
      const lines = []
      lines.push(`插件 ${BUNDLE_VERSION} · ${process.platform} ${process.arch} · Node ${process.versions.node}`)
      if (probe.ok) {
        lines.push(`Python ${probe.python} · ${probe.version || '版本未知'}（${probe.bits || '?'} 位）`
          + ` · sqlcipher3 ${probe.sqlcipher3 ? '✅' : '❌'} · pyzipper ${probe.pyzipper ? '✅' : '❌'}`)
      } else {
        lines.push(`Python ${probe.python} · 无法运行：${probe.error || '未知错误'}`)
      }
      const keyText = keyStamp > 0 ? `已缓存（${clockText(keyStamp)}）` : '没有'
      const scope = ptrace.ptraceScope
      const ptraceText = scope === null
        ? '不受限'
        : (ptrace.restricted ? `受限（scope=${scope}）` : `正常（scope=${scope}）`)
      lines.push(`密钥 ${keyText} · ptrace ${ptraceText} · 工作目录占 ${sizeText(storage.totalBytes)}`)
      if (status === null) {
        lines.push('索引：状态读取失败（Python 或 helper 有问题，先看上面两行）')
      } else {
        lines.push(...indexLines(settings, status, build, running))
        const derived = status.derived || {}
        lines.push(`派生：分块 ${withCommas(derived.chunks)} · 向量 ${withCommas(derived.vectors)}`
          + (derived.exists === true ? '' : ' · 还没有派生库'))
      }
      if (components !== null) {
        const names = { ocr: '截图识别', asr: '语音转写', embed: '语义检索' }
        const parts = Object.keys(components).map((id) => {
          const item = components[id] || {}
          return `${item.label || names[id] || id} ${item.installed ? '已装' : '未装'}`
        })
        if (parts.length > 0) lines.push(`组件：${parts.join(' · ')}`)
      }
      if (models !== null) {
        const rows = Object.values(models)
        const installed = rows.filter((row) => row.installed === true).length
        const bytes = rows.reduce((sum, row) => sum + (Number(row.bytes) || 0), 0)
        lines.push(`模型：${installed}/${rows.length} 已下载 · 占 ${sizeText(bytes)}`)
      }
      const url = typeof currentUrl === 'function' ? currentUrl() : ''
      lines.push(url === '' ? '网页：没有监听（工具不受影响）' : `网页：${url}（监听中）`)

      const steps = []
      if (!probe.ok) {
        steps.push(`Python 跑不起来：在网页「设置」里把「Python 解释器」指向一个 64 位 Python 3，或用一键配置创建虚拟环境。`)
      } else {
        if (!probe.sqlcipher3) {
          steps.push(`sqlcipher3 未安装：${probe.install}（装进插件的虚拟环境，不要装进系统 Python）`)
        }
        if (!probe.pyzipper) steps.push(`pyzipper 未安装：密码 ZIP 会失败，${probe.install}`)
      }
      if (keyStamp === 0) {
        // ptrace only matters when a scan is actually needed; a cached key makes
        // the warning noise, and the header line already reports the scope.
        if (ptrace.restricted) {
          steps.push(`ptrace 受限（scope=${scope}）：密钥提取会失败，先执行 sudo sysctl kernel.yama.ptrace_scope=0`)
        }
        steps.push('还没有数据库密钥：调 qqnt_extract_key（QQ 要在登录状态，大约一到三分钟）。')
      }
      const index = (status && status.index) || {}
      if (index.exists !== true) {
        steps.push('还没有索引：调 qqnt_index（action: "build"），之后 list_chats / search / stats / 导出才能用。')
      } else if (build && build.state === 'error' && build.error) {
        steps.push(`上次索引构建失败：${build.error}`)
      } else {
        const derived = (status && status.derived) || {}
        const chunks = Number(derived.chunks) || 0
        const vectors = Number(derived.vectors) || 0
        if (chunks === 0) {
          steps.push('索引里还没有分块：qqnt_ask / qqnt_recall 只能做关键词检索，去网页点一次「分块与嵌入」会好很多。')
        } else if (vectors === 0) {
          steps.push(`有 ${withCommas(chunks)} 个分块但没有向量：语义检索用不了，qqnt_ask 只能走关键词。`
            + '在网页「模型」页装好嵌入模型后，再点一次「分块与嵌入」。')
        }
      }
      if (components !== null) {
        for (const [id, item] of Object.entries(components)) {
          if (!item || item.installed) continue
          const label = item.label || id
          steps.push(`${label}组件未安装：网页「模型」页可以一键安装（${(item.packages || []).join(' ')}）。`)
        }
      }
      if (steps.length === 0) steps.push('没有发现阻塞项：直接用 qqnt_list_chats、qqnt_stats 或 qqnt_search。')
      lines.push('', '下一步', ...steps.map((step) => `  · ${step}`))
      return { ok: true, exitCode: 0, output: lines.join('\n') }
    },
  }
}

/**
 * `进行中 42% · 识别 312/750 张` — the same wording the web task panel uses.
 *
 * Kept as a local copy instead of importing `web/js/views/jobs.js`: the host
 * half must boot even if the frontend module is ever reorganised, and the two
 * strings are pinned by tests on both sides.
 */
function jobStatusText(job) {
  const labels = {
    queued: '排队中', running: '进行中', canceling: '正在停止…',
    done: '完成', failed: '失败', canceled: '已取消', interrupted: '被中断',
  }
  const state = String(job?.state || '')
  const label = labels[state] || state || '未知'
  const progress = Number(job?.progress) > 0 && state !== 'done'
    ? `${Math.round(Number(job.progress) * 100)}%`
    : ''
  const failed = state === 'failed' || state === 'interrupted'
  const detail = failed ? (job.error || job.message) : job.message
  return [label, progress, detail]
    .filter((part) => part !== '' && part !== undefined).join(' · ')
}

/** Numeric and short-string fields of a runner result, for one line. */
function resultLine(result) {
  if (!result || typeof result !== 'object') return ''
  const parts = []
  for (const [key, value] of Object.entries(result)) {
    if (typeof value === 'number' || typeof value === 'boolean') parts.push(`${key}=${value}`)
    else if (typeof value === 'string' && value !== '' && value.length <= 60) parts.push(`${key}=${value}`)
    if (parts.length >= 6) break
  }
  return parts.join(' · ')
}

/** Task kinds the queue knows; only the first five can be started by a tool. */
const JOB_KINDS = ['ocr', 'asr', 'chunks', 'components', 'model-download', 'export']
const STARTABLE_JOB_KINDS = ['ocr', 'asr', 'chunks', 'components', 'model-download']
const JOB_SUMMARIES = {
  ocr: '识别图片文字',
  asr: '转写语音',
  chunks: '分块与嵌入',
  components: '安装组件',
  'model-download': '下载模型',
}
/**
 * What each task cannot run without. OCR falls back to the weights bundled in
 * its wheel, and chunking without the embedding model still writes chunks (the
 * helper reports that as a note), so only these two are hard requirements.
 */
const JOB_NEEDS = {
  ocr: { components: ['ocr'] },
  asr: { components: ['asr'], models: ['paraformer-zh-small'] },
}

/** The missing pieces that would make `kind` fail, as sentences. */
async function dependencyGaps(settings, kind, exec) {
  const need = JOB_NEEDS[kind]
  if (!need) return []
  const [componentAnswer, modelAnswer] = await Promise.all([
    need.components
      ? runQueryJson(settings, ['components', '--json', JSON.stringify({ action: 'status' })], exec)
        .catch(() => null)
      : null,
    need.models
      ? runQueryJson(settings, ['models', '--json', '{}'], exec).catch(() => null)
      : null,
  ])
  const gaps = []
  const found = componentAnswer?.payload?.components ?? null
  for (const id of need.components || []) {
    const item = found ? found[id] : null
    if (item && item.installed === false) {
      gaps.push(`${item.label || id}组件没装（${(item.packages || []).join(' ')}）：`
        + `用 action=start、kind=components、params={"groups":["${id}"]} 装。`)
    }
  }
  const known = modelAnswer?.payload ?? null
  for (const id of need.models || []) {
    const item = known ? known[id] : null
    if (item && item.installed === false) {
      gaps.push(`模型「${item.label || id}」没下载（约 ${sizeText(item.expectedBytes)}）：`
        + `用 action=start、kind=model-download、params={"id":"${id}"} 下载。`)
    }
  }
  return gaps
}

/**
 * The task panel, seen from the model side.
 *
 * The queue belongs to the web server (`startWebServer` creates it), so this
 * tool shares that object rather than starting a second queue: an OCR job
 * started here shows up in the page's panel, and cancelling there stops it
 * here. `getJobs` returns `null` while the listener does not exist, which is
 * also the only case where no task could run at all.
 */
export function jobsTool(settings, getJobs) {
  const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms) })
  return {
    name: 'qqnt_jobs',
    description: 'Inspect, start, cancel or retry the background tasks behind this plugin: OCR of screenshots, speech transcription, chunking plus embeddings, model downloads and component installs. The queue is shared with the web UI, so a task started here appears in the page\'s task panel and one started there appears here. start refuses a task whose component or model is missing and names the exact call that installs it instead of queueing work that cannot run. Exports have their own tools (qqnt_export_chat / qqnt_export_batch).',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'get', 'start', 'cancel', 'retry'],
          description: 'Defaults to list.',
        },
        kind: {
          type: 'string',
          enum: JOB_KINDS,
          description: 'list: only tasks of this kind. start: which task to run (export cannot be started here).',
        },
        id: {
          type: 'string',
          description: 'Task id for get / cancel / retry. A unique prefix is accepted.',
        },
        params: {
          type: 'object',
          description: 'start only. ocr/asr: {"limit": n} (how many items). chunks: {"limit": n, "force": true}. components: {"groups": ["ocr"|"asr"|"embed"]}. model-download: {"id": "bge-small-zh-v1.5"}.',
        },
        waitSeconds: {
          type: 'integer',
          minimum: 0,
          maximum: 120,
          description: 'start only: wait up to this long for the task to finish before reporting its progress. Defaults to 0.',
        },
      },
    },
    output: {
      schema: outputSchema({
        jobs: { type: 'integer' },
        running: { type: 'integer' },
      }),
      render: renderReport,
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const base = { ok: true, exitCode: 0, jobs: 0, running: 0 }
      const queue = typeof getJobs === 'function' ? getJobs() : null
      if (!queue || typeof queue.list !== 'function') {
        return {
          ...base, ok: false, exitCode: 1,
          output: '任务队列没有起来：它属于插件的网页服务，而网页现在没有在监听'
            + '（设置里的端口为空，或端口起不来）。把端口设成一个可用值并重载插件，'
            + '或用网页手动跑这些任务。',
        }
      }
      const action = ['get', 'start', 'cancel', 'retry'].includes(args.action)
        ? args.action : 'list'
      const rows = queue.list({})
      const running = rows.filter((row) => row.state === 'running' || row.state === 'queued').length
      const counts = { ...base, jobs: rows.length, running }
      if (action === 'list') {
        const kind = JOB_KINDS.includes(args.kind) ? args.kind : ''
        const shown = kind === '' ? rows : rows.filter((row) => row.kind === kind)
        if (shown.length === 0) {
          return { ...counts, output: kind === '' ? '还没有任何任务。' : `还没有「${kind}」任务。` }
        }
        const lines = [`任务（${shown.length}）`]
        for (const row of shown.slice(0, 20)) {
          // One line per task: a long error belongs in `get`, not in the list.
          lines.push(`  - ${row.summary || row.kind}（${row.kind}）${flat(jobStatusText(row), 120)} · id ${row.id}`)
        }
        if (shown.length > 20) lines.push(`  …共 ${shown.length} 个，只列最近 20 个`)
        lines.push('', '看单个任务的日志用 action=get + id；取消用 cancel，重试用 retry。')
        return { ...counts, output: lines.join('\n') }
      }
      if (action === 'start') {
        const kind = String(args.kind || '')
        if (!STARTABLE_JOB_KINDS.includes(kind)) {
          return {
            ...counts, ok: false, exitCode: 1,
            output: `这里只能起 ${STARTABLE_JOB_KINDS.join(' / ')}；导出用 qqnt_export_chat 或 qqnt_export_batch。`,
          }
        }
        if (['ocr', 'asr', 'chunks'].includes(kind) && !existsSync(indexPath(settings))) {
          // `missingIndex` must win over the counts' `ok: true`.
          return { ...missingIndex(settings), jobs: counts.jobs, running: counts.running }
        }
        const params = args.params && typeof args.params === 'object' ? { ...args.params } : {}
        let summary = JOB_SUMMARIES[kind]
        if (kind === 'components') {
          const groups = Array.isArray(params.groups) ? params.groups.map(String) : []
          const unknown = groups.filter((group) => !['ocr', 'asr', 'embed'].includes(group))
          if (groups.length === 0 || unknown.length > 0) {
            return {
              ...counts, ok: false, exitCode: 1,
              output: 'components 需要 params.groups，可选 ocr / asr / embed（分别是截图识别、语音转写、语义检索）。',
            }
          }
          params.groups = groups
          summary = `安装组件：${groups.join('、')}`
        }
        if (kind === 'model-download' && String(params.id || '').trim() === '') {
          return {
            ...counts, ok: false, exitCode: 1,
            output: 'model-download 需要 params.id：rapidocr-v4（截图识别）/ bge-small-zh-v1.5（语义检索）/ paraformer-zh-small（语音转写）。',
          }
        }
        // Starting work that is certain to fail wastes a queue slot and leaves
        // the user with a red row instead of the one command that fixes it.
        const gaps = await dependencyGaps(settings, kind, exec)
        if (gaps.length > 0) {
          return {
            ...counts, ok: false, exitCode: 1,
            output: ['这个任务现在还跑不起来：', ...gaps.map((gap) => `  · ${gap}`), '', '装好后再调一次。'].join('\n'),
          }
        }
        let job
        try {
          job = queue.submit(kind, { summary, params })
        } catch (error) {
          return {
            ...counts, ok: false, exitCode: 1,
            output: `没法排队：${error instanceof Error ? error.message : String(error)}`,
          }
        }
        const wait = Math.min(Math.max(Number(args.waitSeconds) || 0, 0), 120)
        const deadline = Date.now() + wait * 1000
        let row = job
        while (wait > 0 && Date.now() < deadline) {
          row = queue.get(job.id) || row
          if (['done', 'failed', 'canceled', 'interrupted'].includes(row.state)) break
          await sleep(500)
        }
        const lines = [`已排队：${summary}（${kind}）· id ${row.id}`, jobStatusText(row)]
        if (row.state === 'failed' || row.state === 'interrupted') {
          lines.push(`原因：${row.error || '（没有写原因）'}`, '修好后可以 action=retry。')
          return {
            ...counts, jobs: rows.length + 1, running: running + 1,
            ok: false, exitCode: 1, output: lines.join('\n'),
          }
        }
        if (row.state === 'done') {
          const summaryLine = resultLine(row.result)
          lines.push(summaryLine === '' ? '任务完成。' : `任务完成：${summaryLine}`)
        } else {
          lines.push('任务在后台跑，网页右下角也能看到；用 action=get + id 看进度。')
        }
        return { ...counts, jobs: rows.length + 1, running: running + 1, output: lines.join('\n') }
      }
      // get / cancel / retry all need one existing row.
      const wanted = String(args.id ?? '').trim()
      const current = wanted === '' ? null : queue.get(wanted)
      if (current === null) {
        return {
          ...counts, ok: false, exitCode: 1,
          output: wanted === '' ? '需要 id：先 action=list 看现有任务。' : `没有这个任务：${wanted}。用 action=list 看现有任务。`,
        }
      }
      if (action === 'get') {
        const lines = [
          `${current.summary || current.kind}（${current.kind}）`,
          `状态：${jobStatusText(current)}`,
          `id：${current.id}`,
        ]
        if (current.error) lines.push(`原因：${current.error}`)
        const summaryLine = resultLine(current.result)
        if (summaryLine !== '') lines.push(`结果：${summaryLine}`)
        const log = Array.isArray(current.log) ? current.log.slice(-10) : []
        if (log.length > 0) lines.push('', '最近日志', ...log.map((line) => `  ${line}`))
        return { ...counts, output: lines.join('\n') }
      }
      let updated
      try {
        updated = action === 'cancel' ? queue.cancel(current.id) : queue.retry(current.id)
      } catch (error) {
        return {
          ...counts, ok: false, exitCode: 1,
          output: `${action === 'cancel' ? '取消' : '重试'}失败：`
            + (error instanceof Error ? error.message : String(error)),
        }
      }
      const verb = action === 'cancel' ? '已请求取消' : '已重新排队'
      return {
        ...counts,
        output: `${verb}：${updated.summary || updated.kind} · ${jobStatusText(updated)} · id ${updated.id}`,
      }
    },
  }
}

/** `2026-11-01` or Unix seconds → seconds at the start (or end) of that day. */
function dayBoundary(value, end) {
  const text = String(value ?? '').trim()
  if (text === '') return null
  if (/^\d+$/.test(text)) return Number(text)
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text)
  if (match === null) return null
  const when = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]),
    end ? 23 : 0, end ? 59 : 0, end ? 59 : 0)
  const seconds = Math.floor(when.getTime() / 1000)
  return Number.isFinite(seconds) ? seconds : null
}

/** A file name that survives Windows and keeps the original extension. */
function mediaFileName(item, source, index) {
  const original = String(item?.name || path.basename(source) || 'image')
  const extension = path.extname(original).toLowerCase()
  const base = path.basename(original, extension)
  return `${String(index + 1).padStart(3, '0')}-${fileStem(base, 'image')}${extension}`
}

/** `dir/name`, `dir/name-2`, … so two images with the same name both survive. */
function unusedName(dir, name) {
  const extension = path.extname(name)
  const base = extension === '' ? name : name.slice(0, -extension.length)
  let candidate = name
  for (let suffix = 2; existsSync(path.join(dir, candidate)); suffix += 1) {
    candidate = `${base}-${suffix}${extension}`
  }
  return path.join(dir, candidate)
}

/**
 * The gallery, from the model side: list, fetch one file's path, or copy a
 * batch out.
 *
 * The helper only ever resolves paths inside QQ's media folder and this tool
 * never writes there; `get` is read-only, `export` copies into the user's
 * downloads directory (or `outDir`) and stages nothing inside QQ's folder.
 */
export function mediaTool(settings) {
  const PAGE_SIZE = 200
  const MAX_PAGES = 8
  const MAX_FILES = 200
  const MAX_BYTES = 2 * 1024 ** 3
  return {
    name: 'qqnt_media',
    description: 'The images of one chat, from the local index: action=list pages through the gallery (newest first), action=get returns the real file path of one item without copying it, action=export copies the matching files into a new folder under the user\'s downloads directory and returns that folder. Only media the QQ client already downloaded exists locally — nothing is fetched from the network, and a file that is not on disk is reported as missing rather than downloaded. Name the chat with chat (a name, alias, group number or QQ) or with chatKind + chatId. Requires the sidecar index.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['list', 'get', 'export'], description: 'Defaults to list.' },
        chat: { type: 'string', minLength: 1, description: 'The chat as the user named it: a name, an alias, a group number or a QQ number.' },
        chatKind: { type: 'string', enum: ['group', 'private'], description: 'Optional when `chat` is given: restrict the search to one kind.' },
        chatId: { type: 'string', description: 'Group number, or the other party\'s uid.' },
        offset: { type: 'integer', minimum: 0, description: 'list: items to skip (paging).' },
        limit: { type: 'integer', minimum: 1, maximum: 200, description: 'list: how many items to show. Defaults to 30.' },
        rowId: { type: 'integer', minimum: 1, description: 'get: the message row id printed by list.' },
        seq: { type: 'integer', minimum: 1, description: 'get: which media of that message, starting at 1. Defaults to 1.' },
        since: { type: 'string', description: 'export: only images from this date on (`YYYY-MM-DD`) or Unix seconds.' },
        until: { type: 'string', description: 'export: only images up to this date (`YYYY-MM-DD`) or Unix seconds.' },
        count: { type: 'integer', minimum: 1, maximum: 200, description: 'export: how many files to copy. Defaults to 50.' },
        outDir: { type: 'string', description: 'export: absolute target directory. Defaults to QQ媒体_<stamp> in the downloads folder.' },
      },
    },
    output: {
      schema: outputSchema({
        total: { type: 'integer' },
        files: { type: 'integer' },
        bytes: { type: 'integer' },
      }),
      render: renderReport,
    },
    timeoutMs: 10 * 60_000,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const empty = { ok: false, exitCode: 1, total: 0, files: 0, bytes: 0 }
      if (!existsSync(indexPath(settings))) return missingIndex(settings, empty)
      const action = ['get', 'export'].includes(args.action) ? args.action : 'list'
      if (action === 'get') {
        const rowId = Number(args.rowId)
        const seq = Math.max(Number(args.seq) || 1, 1)
        if (!Number.isInteger(rowId) || rowId < 1) {
          return { ...empty, output: 'get 需要 rowId（图片列表里每行末尾的那个数字）。' }
        }
        let answer
        try {
          answer = await runQueryJson(settings,
            ['media', '--json', JSON.stringify({ rowId, seq, allowLarge: true })], exec)
        } catch (error) {
          return { ...empty, output: `读取图片失败：${error instanceof Error ? error.message : String(error)}` }
        }
        if (answer.code !== 0) {
          return { ...empty, output: answer.payload.error || '这张图片取不到。' }
        }
        const payload = answer.payload
        return {
          ok: true, exitCode: 0, total: 1, files: 0, bytes: Number(payload.size) || 0,
          output: [
            `文件：${payload.path}`,
            `名称：${payload.name} · ${sizeText(payload.size)} · ${payload.mime || 'application/octet-stream'}`,
            '这一步只给出路径，没有复制；要落到磁盘用 action=export。',
          ].join('\n'),
        }
      }
      const resolved = await lookupChat(settings, exec, args)
      if (!resolved.chat) return { ...empty, output: resolved.output }
      const kind = resolved.chat.kind
      const chatId = String(resolved.chat.id)
      const name = resolved.chat.name || chatId
      const gallery = async (offset, limit) => {
        const answer = await runQueryJson(settings, ['media-list', '--json', JSON.stringify({
          chatKind: kind, chatId, offset, limit,
        })], exec)
        if (answer.code !== 0) {
          throw new Error(answer.payload.error || '读取图片列表失败')
        }
        return answer.payload
      }
      if (action === 'list') {
        const limit = Math.min(Math.max(Number(args.limit) || 30, 1), 200)
        const offset = Math.max(Math.trunc(Number(args.offset) || 0), 0)
        let payload
        try {
          payload = await gallery(offset, limit)
        } catch (error) {
          return { ...empty, output: error.message }
        }
        const total = Number(payload.total) || 0
        const items = Array.isArray(payload.items) ? payload.items : []
        if (total === 0) {
          return {
            ok: true, exitCode: 0, total: 0, files: 0, bytes: 0,
            output: `${name}：本机没有下载过的图片（图片要在 QQ 里打开过才会落到磁盘）。`,
          }
        }
        const lines = [`${name}：${withCommas(total)} 张（只算已下载到本机的）`
          + ` · 显示第 ${offset + 1}-${offset + items.length} 张`]
        for (const item of items) {
          lines.push(`  ${item.time} ${item.sender || '?'} · ${sizeText(item.size)} · ${item.name || '(无文件名)'}`
            + ` · rowId=${item.rowId} seq=${item.seq}`)
        }
        lines.push('', '取原图用 action=get + rowId/seq（只给路径）；要拷到磁盘用 action=export。')
        return { ok: true, exitCode: 0, total, files: 0, bytes: 0, output: lines.join('\n') }
      }
      // export: newest first, stop once the requested range is behind us.
      const count = Math.min(Math.max(Number(args.count) || 50, 1), MAX_FILES)
      const since = String(args.since ?? '').trim()
      const until = String(args.until ?? '').trim()
      const sinceSeconds = dayBoundary(since, false)
      const untilSeconds = dayBoundary(until, true)
      if (since !== '' && sinceSeconds === null) {
        return { ...empty, output: 'since 格式不对：用 YYYY-MM-DD 或 Unix 秒。' }
      }
      if (until !== '' && untilSeconds === null) {
        return { ...empty, output: 'until 格式不对：用 YYYY-MM-DD 或 Unix 秒。' }
      }
      const picked = []
      let scanned = 0
      let reachedEnd = false
      for (let page = 0; page < MAX_PAGES && picked.length < count; page += 1) {
        let payload
        try {
          payload = await gallery(page * PAGE_SIZE, PAGE_SIZE)
        } catch (error) {
          return { ...empty, output: error.message }
        }
        const items = Array.isArray(payload.items) ? payload.items : []
        scanned += items.length
        for (const item of items) {
          const at = Number(item.ts) || 0
          if (untilSeconds !== null && at > untilSeconds) continue
          if (sinceSeconds !== null && at < sinceSeconds) {
            reachedEnd = true
            break
          }
          picked.push(item)
          if (picked.length >= count) break
        }
        if (items.length < PAGE_SIZE) {
          reachedEnd = true
          break
        }
      }
      if (picked.length === 0) {
        return {
          ok: true, exitCode: 0, total: 0, files: 0, bytes: 0,
          output: `${name}：这个范围里没有已下载的图片（扫了 ${withCommas(scanned)} 张）。`
            + '去掉 since/until 再看一次。',
        }
      }
      const outDir = typeof args.outDir === 'string' && args.outDir.trim() !== ''
        ? path.resolve(args.outDir.trim())
        : path.join(defaultDownloadDir(), `QQ媒体_${fileStamp()}`)
      mkdirSync(outDir, { recursive: true, mode: 0o700 })
      let files = 0
      let bytes = 0
      let missing = 0
      let tooBig = 0
      for (const [index, item] of picked.entries()) {
        let answer
        try {
          answer = await runQueryJson(settings, ['media', '--json', JSON.stringify({
            rowId: item.rowId, seq: item.seq, allowLarge: true,
          })], exec)
        } catch {
          missing += 1
          continue
        }
        if (answer.code !== 0) {
          missing += 1
          continue
        }
        const payload = answer.payload
        const size = Number(payload.size) || 0
        if (bytes + size > MAX_BYTES) {
          tooBig += 1
          break
        }
        const target = unusedName(outDir, mediaFileName(item, payload.path, index))
        try {
          copyFileSync(payload.path, target)
        } catch {
          missing += 1
          continue
        }
        files += 1
        bytes += size
      }
      const lines = [`已复制 ${files} 个文件 / ${sizeText(bytes)} 到 ${outDir}`]
      if (missing > 0) lines.push(`没取到 ${missing} 个：原图不在本机了（QQ 里可能只在别的设备上）。`)
      if (tooBig > 0) lines.push(`达到单次体积上限（2 GB），剩下的没有再复制；缩小 count 或分开导。`)
      if (!reachedEnd && picked.length >= count) {
        lines.push(`只复制了最近的 ${count} 张；要更多就调大 count 或给 since/until。`)
      }
      lines.push('', '文件按「序号-原名」命名，序号跟列表顺序一致。')
      return { ok: true, exitCode: 0, total: picked.length, files, bytes, output: lines.join('\n') }
    },
  }
}

/**
 * Resolve the chat a tool was pointed at: a name/alias/number via `chat`, or
 * `chatKind` + `chatId`. Returns `{ chat }` or `{ output }` (the refusal).
 */
async function lookupChat(settings, exec, args) {
  const phrase = typeof args.chat === 'string' ? args.chat.trim() : ''
  const kind = ['group', 'private'].includes(String(args.chatKind || '')) ? String(args.chatKind) : ''
  const chatId = String(args.chatId ?? '').trim()
  if (phrase === '' && (kind === '' || chatId === '')) {
    return { output: '给一个 chat（名字/别名/群号/QQ），或者同时给 chatKind 与 chatId。' }
  }
  let sessions = []
  try {
    const answer = await runQueryJson(settings, ['sessions'], exec)
    sessions = mergeChatState(settings.workDir, answer.payload.sessions, true)
  } catch (error) {
    return { output: `读取索引里的会话列表失败：${error instanceof Error ? error.message : String(error)}` }
  }
  if (phrase === '') {
    const found = sessions.find((item) => item.kind === kind && String(item.id) === chatId)
    return found
      ? { chat: found }
      : { output: `索引里没有这个会话：${kind}/${chatId}。先用 qqnt_list_chats 查一下，或直接把名字传给 chat。` }
  }
  const pool = kind === '' ? sessions : sessions.filter((item) => item.kind === kind)
  const picked = pickChat(pool, phrase)
  if (picked.tie) return { output: ambiguousChats(phrase, picked.ranked) }
  if (picked.chat === null) return { output: unknownChat(phrase, sessions) }
  return { chat: picked.chat }
}

/**
 * What the work directory is using, and the allow-listed way to free it.
 *
 * The page has the same card; the tool exists because "磁盘满了，能清什么" is a
 * question an Agent can answer in one call, and because the answer has to be
 * the same allow-list the page uses — never a hand-built `rm` of a path that
 * looks like a cache. Destructive by nature, so `cleanup` without `confirm`
 * only reports what would go.
 */
export function storageTool(settings, busy) {
  return {
    name: 'qqnt_storage',
    description: 'Report what this plugin\'s work directory is using — decrypted copies, the query index, the key, temporary exports, build state, the non-rebuildable derived store, account caches and downloaded models — or delete one or more allow-listed categories. cleanup without confirm=true only says what would be deleted and how much it frees; nothing is removed. The QQ data directory is never touched, and cleanup is refused while a build, key extraction or environment setup is running.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['report', 'cleanup'], description: 'Defaults to report.' },
        ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'cleanup only: the ids printed by report (decrypted, index, key, exports, state, indexCache). The derived store can never be deleted here.',
        },
        confirm: {
          type: 'boolean',
          description: 'cleanup only: false (default) previews; true actually deletes.',
        },
      },
    },
    output: {
      schema: outputSchema({
        bytes: { type: 'integer' },
        freed: { type: 'integer' },
        removed: { type: 'integer' },
      }),
      render: renderReport,
    },
    isConcurrencySafe: () => false,
    async execute(args) {
      const base = { ok: true, exitCode: 0, bytes: 0, freed: 0, removed: 0 }
      const snapshot = storageSnapshot(settings.workDir)
      const detail = (item) => {
        const files = Array.isArray(item.files) ? item.files.length : 0
        return `${item.label}（${item.id}）${sizeText(item.bytes)}`
          + (files > 1 ? ` · ${files} 个文件` : '')
      }
      const lines = [
        `工作目录：${snapshot.workDir}`,
        `合计：${sizeText(snapshot.totalBytes)}${snapshot.derived.exists
          ? `（含派生库 ${sizeText(snapshot.derived.bytes)}，它不在这里删除）` : ''}`,
      ]
      for (const item of snapshot.items) lines.push(`  ${detail(item)}`)
      if (snapshot.items.length === 0) lines.push('  （还没有任何生成的文件）')
      if (args.action !== 'cleanup') {
        lines.push('', '清理用 action=cleanup + ids（先不带 confirm 看预演）。')
        return { ...base, bytes: snapshot.totalBytes, output: lines.join('\n') }
      }
      if (busy?.()) {
        return {
          ...base, ok: false, exitCode: 1,
          output: '密钥提取或环境配置正在进行，等它结束再清理。',
        }
      }
      if (buildRunning(settings.workDir)) {
        return {
          ...base, ok: false, exitCode: 1,
          output: '索引正在建立，等它结束后再清理。',
        }
      }
      const wanted = (Array.isArray(args.ids) ? args.ids : (args.ids === undefined ? [] : [args.ids]))
        .map((id) => String(id ?? '').trim()).filter((id) => id !== '')
      const available = snapshot.items.map((item) => item.id)
      if (wanted.length === 0) {
        return {
          ...base, ok: false, exitCode: 1,
          output: `cleanup 需要 ids：可清理的是 ${available.join('、')}（见 report 的输出）。`,
        }
      }
      const unknown = wanted.filter((id) => !available.includes(id))
      if (unknown.length > 0) {
        return {
          ...base, ok: false, exitCode: 1,
          output: `没有这些清理项：${unknown.join('、')}。`
            + (available.length > 0 ? `可清理的是 ${available.join('、')}。` : '工作目录里现在没有可清理的文件。'),
        }
      }
      const picked = snapshot.items.filter((item) => wanted.includes(item.id))
      const bytes = picked.reduce((sum, item) => sum + item.bytes, 0)
      const planned = [`将删除 ${picked.length} 项，释放约 ${sizeText(bytes)}：`,
        ...picked.map((item) => `  · ${detail(item)}`)]
      if (args.confirm !== true) {
        lines.push('', ...planned, '', '这一步没有删除任何东西；确认后带 confirm: true 再调一次。')
        return { ...base, bytes, output: lines.join('\n') }
      }
      let result
      try {
        result = cleanupStorage(settings.workDir, picked.map((item) => item.id))
      } catch (error) {
        return {
          ...base, ok: false, exitCode: 1,
          output: `清理失败：${error instanceof Error ? error.message : String(error)}`,
        }
      }
      const after = storageSnapshot(settings.workDir)
      const done = [`已删除 ${result.removed} 个文件，释放 ${sizeText(result.freedBytes)}。`,
        `现在工作目录占 ${sizeText(after.totalBytes)}。`]
      if (Array.isArray(result.failed) && result.failed.length > 0) {
        done.push(`有 ${result.failed.length} 个没删掉：`
          + result.failed.slice(0, 5).map((item) => `${item.name}（${item.error}）`).join('、'))
      }
      const labels = picked.map((item) => item.id)
      if (labels.includes('index')) done.push('索引已删除：qqnt_list_chats / qqnt_search / qqnt_stats 会提示先建索引。')
      if (labels.includes('key')) done.push('密钥已删除：下次建索引前要重新调 qqnt_extract_key。')
      if (labels.includes('decrypted')) done.push('解密副本已删除：下次建索引会重新从 QQ 复制。')
      return {
        ...base, bytes, freed: result.freedBytes, removed: result.removed,
        output: done.join('\n'),
      }
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

The qqnt_* tools read the message database of the NTQQ client installed on this machine. Use them in order: qqnt_status, then qqnt_extract_key, then qqnt_list_groups, then qqnt_export_group. Finding the key is slow: before calling qqnt_extract_key, tell the user that searching for the key takes one to three minutes and to please wait patiently (查找密钥耗时较长，请耐心等待); the call returns only when the scan finishes, so do not retry or cancel it while it runs. Key extraction only works while QQ is logged in; when it finds no key, ask the user to confirm QQ is signed in rather than retrying. Confirm the exact group number with the user before exporting, because the common off-by-one-digit guess exports nothing. Never move, edit, or delete files under the QQ data directory, and do not end the QQ process. Never install Python packages into the global/system interpreter; use a virtualenv, and the local web UI offers a one-click venv setup. On Linux the key is read from the qq main process memory: if the kernel's ptrace scope denies it, the tool prints the exact sysctl command to run; report that fix instead of retrying blindly. When the user names a chat instead of giving an id — a group name, a nickname, a group number, or 「和某某的私聊」 — pass that phrase as chat to qqnt_export_chat (or as chatNames to qqnt_export_batch) instead of listing every chat and guessing: the tool resolves names and aliases, and refuses to export when two chats match equally well. Use dryRun: true to preview the resolved chat, the message count and the target directory before a large export, and narrow the content with keyword / sender / since / until instead of filtering the file afterwards. When any of these tools fails, call qqnt_doctor first: it names the exact blocker — interpreter, sqlcipher3, cached key, ptrace scope, missing sidecar index — and the next step, before asking the user to open the page. When the sidecar index is missing or stale, call qqnt_index with action build instead of asking the user to click the sync button; a build takes one to three minutes, answers with progress when it is still running, and a second status call reports the result. Use qqnt_stats for counts, monthly totals and who talks most instead of paging through qqnt_search. Either export tool also accepts preset: a saved export preset; an unknown name comes back with the ones that exist.`

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

/**
 * `info --json` from the bundled helper: platform, paths and the source schema.
 *
 * A diagnostics report has to answer even when the environment is broken, so a
 * failed probe becomes `infoError` and the three sections stay `null` instead of
 * rejecting the request. Absolute paths are shown in the local UI and redacted
 * by the bundle download.
 */
async function infoReport(settings) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 8000)
  try {
    mkdirSync(settings.workDir, { recursive: true, mode: 0o700 })
    const probe = await run(settings.python,
      ['-X', 'utf8', CLI, ...globalArgs(settings), 'info', '--json'],
      { signal: controller.signal, cwd: settings.workDir })
    const text = probe.stdout.trim()
    if (text === '') throw new Error(probe.output || `info 没有输出（exit code ${probe.code}）`)
    const payload = JSON.parse(text.split('\n').pop())
    return {
      platform: payload.platform ?? null,
      paths: payload.paths ?? null,
      schema: payload.schema ?? null,
      infoError: '',
    }
  } catch (error) {
    const infoError = error?.name === 'AbortError'
      ? '读取环境信息超时（8 秒），可能是 Python 解释器无响应'
      : `无法读取环境信息：${error instanceof Error ? error.message : String(error)}`
    return { platform: null, paths: null, schema: null, infoError }
  } finally {
    clearTimeout(timer)
  }
}

/** Linux ptrace status so the startup checklist can show the exact blocker. */
function ptraceInfo() {
  if (process.platform !== 'linux') return { ptraceScope: null, restricted: false }
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
  // "Why doesn't it work": one call, before the user is asked to open the page.
  ctx.tools.register(doctorTool(settings, () => webUrl))
  // The index every message-reading tool needs; the page was the only way to
  // create it before, which is the one blocker an Agent could not fix itself.
  ctx.tools.register(indexTool(settings, () => keyJob.state === 'running' || setup.state === 'running'))
  ctx.tools.register(keyTool(settings, () => keyJob.state === 'running'))
  ctx.tools.register(groupsTool(settings))
  ctx.tools.register(exportTool(settings))
  // Index-backed tools: they cover private chats and cross-chat search, which
  // the group exporter above cannot reach.
  ctx.tools.register(listChatsTool(settings))
  ctx.tools.register(searchTool(settings))
  // Counts instead of pages: "how many, who talks most, which month".
  ctx.tools.register(statsTool(settings))
  ctx.tools.register(exportChatTool(settings))
  // Batch export: one ZIP, one manifest, instead of N tool calls.
  ctx.tools.register(exportBatchTool(settings))
  // The queue the page owns: an OCR task started here shows up in its panel.
  ctx.tools.register(jobsTool(settings, () => (webServer && webServer.jobs) || null))
  // The gallery: list, fetch a path, or copy a chat's images out.
  ctx.tools.register(mediaTool(settings))
  // Storage: the same allow-list the page's cleanup card uses.
  ctx.tools.register(storageTool(settings,
    () => keyJob.state === 'running' || setup.state === 'running'))
  // Question answering in two steps: this side retrieves and cites, the host
  // model writes the sentence (ADR-008).
  ctx.tools.register(askTool(settings))
  ctx.tools.register(recallTool(settings))

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

  // Long jobs run through the task panel; each kind is one runner. Built once
  // and handed to *every* listener: the startup path used to forget it, so
  // exports (and OCR/ASR) were rejected with "未知的任务类型" on a normal start
  // while a bind-tested listener worked.
  const jobRunners = {
    ocr: makeOcrRunner({ settings, queryCli: QUERY_CLI }),
    asr: makeAsrRunner({ settings, queryCli: QUERY_CLI }),
    chunks: makeChunksRunner({ settings, queryCli: QUERY_CLI }),
    components: makeComponentsRunner({ settings, queryCli: QUERY_CLI }),
    export: makeExportRunner({ settings, queryCli: QUERY_CLI }),
  }

  /** Start a listener on an explicit port (used for bind-testing a new one). */
  const launch = async (port, host) => {
    if (!port) return null
    const server = startWebServer(settings, port, host, {
      handlers,
      runners: jobRunners,
    })
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
      const info = await infoReport(settings)
      return {
        ...(await probePython(settings)),
        ...ptraceInfo(),
        uv: await detectUv(),
        venv: { dir: defaultVenvDir(), python: venvPython() },
        key: storage.key,
        index: storage.index,
        platform: info.platform,
        paths: info.paths,
        schema: info.schema,
        infoError: info.infoError,
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
      const text = scrubPatterns(stripNul(raw).replace(/\r/g, '').trimEnd())
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
      runners: jobRunners,
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

  // ── DSH sidebar panel ──────────────────────────────────────────────────
  // The panel mounts an iframe of this plugin's own UI, so it only needs the
  // address. Asking the host server (same origin as the DSH page) keeps the
  // browser from guessing a port or needing CORS, and keeps chat text out of
  // DSH's DOM entirely: this route answers with counts, never messages.
  const panelRoute = async (req, res) => {
    if (!panelRequestAllowed(req)) {
      res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: '面板只在本机可用' }))
      return
    }
    const head = req.method === 'HEAD'
    if (req.method !== 'GET' && !head) {
      res.writeHead(405, { allow: 'GET, HEAD', 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: '只支持 GET' }))
      return
    }
    let status = null
    if (webUrl) {
      try {
        // Reuses the web server's own five-second status cache; a slow helper
        // must not hold the panel hostage.
        const reply = await fetch(`${webUrl}api/status`, { signal: AbortSignal.timeout(2000) })
        if (reply.ok) status = await reply.json()
      } catch {
        status = null
      }
    }
    const body = JSON.stringify(panelInfo(settings, {
      version: BUNDLE_VERSION,
      running: webUrl !== '',
      status,
    }))
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    })
    res.end(head ? undefined : body)
  }

  if (typeof ctx.inject === 'function') {
    // Optional dependency on purpose: the CLI host has no `webServer`, and the
    // panel is a bonus there — `ctx.inject` simply never fires.
    ctx.inject(['webServer'], (child) => {
      child.effect(() => child.webServer.register({
        kind: 'exact', path: '/api/qqnt/panel', handler: panelRoute,
      }), 'qqnt: sidebar panel route')
    })
  } else if (typeof ctx.webServer?.register === 'function') {
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact', path: '/api/qqnt/panel', handler: panelRoute,
    }), 'qqnt: sidebar panel route')
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
