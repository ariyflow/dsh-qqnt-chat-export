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

/**
 * Argument prefix shared by every sidecar call.
 * @param {object} settings
 * @param {string} queryCli - absolute path to `qqnt_query.py`
 * @param {string[]} rest - subcommand and its flags
 */
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
export function runNdjson({ settings, queryCli, args, ctx }) {
  return new Promise((resolve, reject) => {
    const child = spawn(settings.python, helperArgv(settings, queryCli, args), {
      windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let buffer = ''
    const stderr = []
    let last = null
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
        finish(reject, new Error(tail || `OCR 进程退出码 ${code}`))
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
    const result = await runNdjson({ settings, queryCli, args, ctx })
    if (result && result.canceled) return result
    return result
  }
}
