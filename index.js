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
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { startWebServer } from './web.js'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'qqnt-chat-export'
/** Services this bundle registers into. */
export const inject = ['tools', 'systemPrompt']

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CLI = path.join(HERE, 'scripts', 'qqnt_export.py')

const DEFAULT_WORK_DIR = path.join(os.tmpdir(), 'qqnt-chat-export')
const DEFAULT_FORMATS = ['txt', 'sqlite', 'csv']
const KEY_TIMEOUT_MS = 10 * 60_000
const EXPORT_TIMEOUT_MS = 15 * 60_000
/** Local browsing UI port; 0 turns the server off. */
const DEFAULT_WEB_PORT = 46728
/** Prompt placement after the built-in `tools:sdk` section. */
const PROMPT_ORDER = 5000

/** One-line probe: Python version, pointer width, and whether sqlcipher3 resolves. */
const PYTHON_PROBE = "import json,struct,sys,importlib.util as u;print(json.dumps({'version':sys.version.split()[0],'bits':struct.calcsize('P')*8,'sqlcipher3':u.find_spec('sqlcipher3') is not None}))"

/** Read the row's config defensively; this bundle declares no Config schema. */
function resolveSettings(config) {
  const raw = config && typeof config === 'object' ? config : {}
  const str = (value) => (typeof value === 'string' && value.trim() !== '' ? value.trim() : '')
  const webPort = Number.parseInt(String(raw.webPort ?? ''), 10)
  return {
    python: str(raw.pythonPath) || 'python',
    workDir: str(raw.workDir) ? path.resolve(str(raw.workDir)) : DEFAULT_WORK_DIR,
    tencentRoot: str(raw.tencentRoot) ? path.resolve(str(raw.tencentRoot)) : '',
    account: str(raw.account),
    webPort: Number.isFinite(webPort) && webPort >= 0 ? webPort : DEFAULT_WEB_PORT,
    webHost: str(raw.webHost) || '127.0.0.1',
  }
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
        ? new Error(`cannot run "${command}": not found on PATH. Set pythonPath in the config of this bundle to a 64-bit Python 3 executable.`)
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
  mkdirSync(settings.workDir, { recursive: true })
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
          description: 'Absolute output directory. Defaults to QQ导出_<group> inside the user\'s Downloads folder.',
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
        : path.join(os.homedir(), 'Downloads', `QQ导出_${group}`)
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

The qqnt_* tools read the message database of the NTQQ client installed on this machine. Use them in order: qqnt_status, then qqnt_extract_key, then qqnt_list_groups, then qqnt_export_group. Key extraction only works while QQ is logged in; when it finds no key, ask the user to confirm QQ is signed in rather than retrying. Confirm the exact group number with the user before exporting, because the common off-by-one-digit guess exports nothing. Never move, edit, or delete files under the QQ data directory, and do not end the QQ process.`

/** Appended only while the browsing UI is actually listening. */
function webGuidance(url) {
  return ` The same data, including private chats and keyword search across every chat, is browsable at ${url} in a browser tab; that page also downloads the current query as txt, csv, json, markdown, html, or sqlite.`
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
  const settings = resolveSettings(config)
  for (const build of [statusTool, keyTool, groupsTool, exportTool]) {
    ctx.tools.register(build(settings))
  }

  let webUrl = ''
  const run = () => {
    const server = startWebServer(settings, settings.webPort, settings.webHost, {
      // A failed bind must not leave the model advertising a URL that is not there.
      onError: () => { webUrl = '' },
    })
    if (!server.error && server.url) webUrl = server.url
    return () => {
      webUrl = ''
      void server.close()
    }
  }
  if (typeof ctx.effect === 'function') ctx.effect(run)
  else run()

  ctx.systemPrompt.section({
    name: 'tool:qqnt_chat_export',
    order: PROMPT_ORDER,
    text: () => (webUrl === '' ? GUIDANCE : GUIDANCE + webGuidance(webUrl)),
  })
}
