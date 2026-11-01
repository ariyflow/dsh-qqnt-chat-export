/**
 * Job runners that drive the Python sidecar.
 *
 * A runner is what a job actually does. The long ones — OCR now, speech and
 * embedding next — all follow the same shape: spawn the helper with
 * `--json`, read one JSON object per line, forward `progress` to the queue and
 * keep the last object as the result. This module keeps that shape in one
 * place so the next feature is a few lines rather than a second implementation.
 *
 * Cancellation is cooperative: the queue flips a flag, this kills the child,
 * and the runner resolves instead of rejecting so the job ends as `canceled`.
 */
import { spawn } from 'node:child_process'
import { unlinkSync } from 'node:fs'
import path from 'node:path'

/**
 * Argument prefix shared by every sidecar call.
 * @param {object} settings
 * @param {string} queryCli - absolute path to `qqnt_query.py`
 * @param {string[]} rest - subcommand and its flags
 */
/**
 * Keep paths and chat labels out of `job.error`, which `jobs.json` persists.
 *
 * A Python traceback quotes the output path (`exports/<id>--<label>.txt`), so a
 * failed export used to write the group name into the job list — the one file
 * the queue promises holds no chat content. The full text still goes to the
 * job log.
 */
export function sanitizeError(text, { workDir = '', label = '' } = {}) {
  let out = String(text || '')
  if (workDir) {
    out = out.split(path.join(workDir, 'exports')).join('<导出目录>')
    out = out.split(workDir).join('<工作目录>')
  }
  const name = String(label || '').trim()
  if (name.length >= 2) out = out.split(name).join('<会话>')
  return out
}

export function helperArgv(settings, queryCli, rest) {
  const argv = ['-X', 'utf8', queryCli, '--work', settings.workDir]
  if (settings.tencentRoot) argv.push('--root', settings.tencentRoot)
  if (settings.account) argv.push('--account', String(settings.account))
  return argv.concat(rest)
}

/**
 * Run a helper that prints newline-delimited JSON and report its progress.
 *
 * @param {object} options
 * @param {object} options.settings - live settings (`python`, `workDir`)
 * @param {string} options.queryCli - absolute path to `qqnt_query.py`
 * @param {string[]} options.args - subcommand plus flags
 * @param {object} options.ctx - job context from the queue
 * @returns {Promise<object>} the last JSON object the helper printed
 */
export function runNdjson({ settings, queryCli, args, ctx, label = '任务' }) {
  return new Promise((resolve, reject) => {
    const child = spawn(settings.python, helperArgv(settings, queryCli, args), {
      windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let buffer = ''
    const stderr = []
    let last = null
    // The sidecar answers a bad input with `{"error": ...}` on stdout and exit
    // code 2; without keeping it the job only ever said "exit code 2".
    let failure = null
    let settled = false

    // Declared before `finish` uses it: a spawn failure calls finish from the
    // 'error' handler, which can fire before the interval exists.
    let watch = null
    const finish = (fn, value) => {
      if (settled) return
      settled = true
      if (watch) clearInterval(watch)
      fn(value)
    }

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      buffer += chunk
      let newline = buffer.indexOf('\n')
      while (newline !== -1) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        newline = buffer.indexOf('\n')
        if (line === '') continue
        let payload = null
        try {
          payload = JSON.parse(line)
        } catch {
          ctx.log(line)
          continue
        }
        if (payload && typeof payload.progress === 'number') {
          ctx.onProgress(payload.progress, payload.message || '')
        } else if (payload && typeof payload.error === 'string') {
          failure = payload
          ctx.log(payload.error)
        } else if (payload) {
          last = payload
        }
      }
    })
    child.stderr.on('data', (chunk) => {
      // Keep the tail: a Python traceback is only readable at the end.
      stderr.push(String(chunk))
      if (stderr.length > 20) stderr.shift()
    })
    child.on('error', (error) => finish(reject, error.code === 'ENOENT'
      ? new Error(`无法运行 Python 解释器「${settings.python}」：找不到可执行文件`)
      : error))

    watch = setInterval(() => {
      if (ctx.isCanceled()) child.kill()
    }, 300)

    child.on('close', (code) => {
      if (ctx.isCanceled()) {
        finish(resolve, { canceled: true })
        return
      }
      if (code !== 0) {
        const tail = stderr.join('').trim().split('\n').slice(-3).join(' ')
        const message = failure?.error || last?.error || tail || `${label}进程退出码 ${code}`
        finish(reject, new Error(sanitizeError(message, { workDir: settings.workDir })))
        return
      }
      finish(resolve, last || {})
    })
  })
}

/**
 * The OCR job: recognize pending screenshots into `derived.sqlite`.
 *
 * @param {{settings: object, queryCli: string}} options
 * @returns {(job: object, ctx: object) => Promise<object>}
 */
export function makeOcrRunner({ settings, queryCli }) {
  return async function ocrRunner(job, ctx) {
    const args = ['ocr', '--json', JSON.stringify({ limit: job.params.limit ?? null })]
    return runNdjson({ settings, queryCli, args, ctx, label: '识别' })
  }
}

/**
 * The chunking + embedding job: conversation windows into `chunks`, vectors
 * into `vectors`. Runs after OCR/ASR so the chunk text already contains the
 * transcripts — re-running it later picks them up incrementally.
 *
 * @param {{settings: object, queryCli: string}} options
 * @returns {(job: object, ctx: object) => Promise<object>}
 */
export function makeChunksRunner({ settings, queryCli }) {
  return async function chunksRunner(job, ctx) {
    const args = ['chunks', '--json', JSON.stringify({
      limit: job.params.limit ?? null,
      force: job.params.force === true,
    })]
    return runNdjson({ settings, queryCli, args, ctx, label: '分块' })
  }
}

/**
 * Install the optional Python packages for a feature group (`ocr`, `asr`,
 * `embed`). pip's output is plain text, which `runNdjson` treats as log lines;
 * the last JSON object is the result.
 *
 * @param {{settings: object, queryCli: string}} options
 * @returns {(job: object, ctx: object) => Promise<object>}
 */
export function makeComponentsRunner({ settings, queryCli }) {
  return async function componentsRunner(job, ctx) {
    const groups = Array.isArray(job.params.groups) ? job.params.groups : []
    const args = ['components', '--json', JSON.stringify({ action: 'install', groups })]
    return runNdjson({ settings, queryCli, args, ctx, label: '组件安装' })
  }
}

/**
 * The ASR job: transcribe pending voice messages into `derived.sqlite`.
 * Same protocol as OCR, only the subcommand differs.
 *
 * @param {{settings: object, queryCli: string}} options
 * @returns {(job: object, ctx: object) => Promise<object>}
 */
export function makeAsrRunner({ settings, queryCli }) {
  return async function asrRunner(job, ctx) {
    const args = ['asr', '--json', JSON.stringify({ limit: job.params.limit ?? null })]
    return runNdjson({ settings, queryCli, args, ctx, label: '转写' })
  }
}

/** A chat name is also a file name; strip what Windows/Linux cannot store. */
function safeStem(text) {
  return String(text || '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 80) || 'export'
}

/** The last JSON object a helper printed (exports print one, crash wrappers more). */
function lastJson(text) {
  const lines = String(text).split('\n').map((line) => line.trim()).filter(Boolean)
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const value = JSON.parse(lines[index])
      if (value && typeof value === 'object') return value
    } catch {
      // Keep walking up.
    }
  }
  return null
}

/**
 * The export job: one file (or one ZIP) written under `workDir/exports`.
 *
 * The file name is `<job id>--<label>.<format>`: the id prefix is how the
 * download route finds the file after a restart without the job row having to
 * carry a chat name on disk, and the label keeps the name readable for the
 * person who opens it in a file manager.
 *
 * Returns only counts — never the path or the label — so `jobs.json` stays free
 * of chat content. The password travels in the environment, never in argv.
 *
 * @param {{settings: object, queryCli: string}} options
 * @returns {(job: object, ctx: object) => Promise<object>}
 */
export function makeExportRunner({ settings, queryCli }) {
  return function exportRunner(job, ctx) {
    return new Promise((resolve, reject) => {
      const params = job.params || {}
      const format = String(params.format || 'txt')
      const label = String(params.label || '聊天记录')
      const out = path.join(settings.workDir, 'exports', `${job.id}--${safeStem(label)}.${format}`)
      const args = { ...params.args, format: params.innerFormat || format, out, label }
      delete args.password
      const argv = helperArgv(settings, queryCli, ['export', '--json', JSON.stringify(args)])
      const env = { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' }
      if (params.password) env.QQNT_EXPORT_PASSWORD = String(params.password)
      const child = spawn(settings.python, argv, {
        windowsHide: true, env, stdio: ['ignore', 'pipe', 'pipe'],
      })
      const stdout = []
      const stderr = []
      let settled = false
      const watch = setInterval(() => {
        if (ctx.isCanceled()) child.kill()
      }, 300)
      const finish = (fn, value) => {
        if (settled) return
        settled = true
        clearInterval(watch)
        fn(value)
      }
      child.stdout.setEncoding('utf8')
      child.stderr.setEncoding('utf8')
      child.stdout.on('data', (chunk) => stdout.push(chunk))
      child.stderr.on('data', (chunk) => stderr.push(chunk))
      child.on('error', (error) => finish(reject, error.code === 'ENOENT'
        ? new Error(`无法运行 Python 解释器「${settings.python}」：找不到可执行文件`)
        : error))
      child.on('close', (code) => {
        if (ctx.isCanceled()) {
          // A cancelled export must not leave half a file behind.
          try { unlinkSync(out) } catch { /* the sweep will get it */ }
          finish(resolve, { canceled: true })
          return
        }
        const text = stdout.join('').trim()
        const parsed = lastJson(text)
        if (code !== 0) {
          const message = (parsed && typeof parsed.error === 'string' && parsed.error)
            || stderr.join('').trim().split('\n').slice(-3).join(' ')
            || `导出进程退出码 ${code}`
          const error = new Error(sanitizeError(message, { workDir: settings.workDir, label }))
          error.detail = parsed && typeof parsed.detail === 'string'
            ? sanitizeError(parsed.detail, { workDir: settings.workDir, label }) : ''
          finish(reject, error)
          return
        }
        finish(resolve, {
          rows: Number(parsed?.rows) || 0,
          bytes: Number(parsed?.bytes) || 0,
          encrypted: parsed?.encrypted === true,
          media: parsed?.media && Number.isFinite(Number(parsed.media.files))
            ? { files: Number(parsed.media.files), missing: Number(parsed.media.missing) || 0 }
            : null,
          format,
        })
      })
    })
  }
}
