/**
 * Generic background jobs for the local UI.
 *
 * The export queue proved that minutes-long work cannot live inside one HTTP
 * request. The port needs the same thing for OCR, speech-to-text, embedding and
 * archiving, so the queue is generalised here: a job is a kind plus a params
 * object, a runner does the work, and the state machine is small enough to
 * reason about.
 *
 * Two rules come from the export queue and stay:
 *
 * - **Nothing user-authored is persisted.** Rows keep a `summary` written by
 *   the runner ("导出 3 个会话"), never the chat id, the keyword or the name,
 *   because `workDir/jobs.json` is a plain text file on disk.
 * - **A restart must not resurrect a running job.** Rows that were `running`
 *   when the process died become `interrupted` and can be retried, instead of
 *   showing a progress bar that will never move.
 *
 * Cancellation is cooperative: runners poll `isCanceled()` between items.
 * Nothing here kills a process; a runner that spawns one is responsible for it.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'

/** Jobs allowed to run at once; OCR and ASR are CPU-bound, so this stays low. */
export const DEFAULT_CONCURRENCY = 2
/** Finished rows kept in the list. */
export const MAX_KEPT = 40
/** A job older than this is failed rather than pinning a slot forever. */
export const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000

/** @typedef {'queued'|'running'|'done'|'failed'|'canceled'|'interrupted'} JobState */

/**
 * @param {object} options
 * @param {{workDir: string}} options.settings - live settings; `workDir` may change
 * @param {number} [options.concurrency]
 * @param {Record<string, Function>} [options.runners] - kind → runner
 * @param {number} [options.timeoutMs]
 * @param {number} [options.maxKept]
 */
export function createJobQueue({
  settings,
  concurrency = DEFAULT_CONCURRENCY,
  runners = {},
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxKept = MAX_KEPT,
}) {
  /** Newest first, like the task panel. */
  const jobs = []
  const contexts = new Map()
  const timers = new Map()
  let closed = false

  const file = () => path.join(path.resolve(settings.workDir), 'jobs.json')
  const logDir = () => path.join(path.resolve(settings.workDir), 'jobs')

  const active = () => jobs.filter((job) => job.state === 'running').length
  const queued = () => jobs.filter((job) => job.state === 'queued')

  let counter = 0
  function nextId() {
    counter += 1
    return `${Date.now().toString(36)}-${counter.toString(36)}${Math.random().toString(36).slice(2, 6)}`
  }

  /**
   * The row shape that may reach disk, and the shape the UI sees. `params`
   * never survives: a keyword is chat content and a chat id identifies a
   * conversation, while `summary` is written by the caller for display.
   */
  function publicRow(job, { withLog = false } = {}) {
    const row = {
      id: job.id,
      kind: job.kind,
      summary: job.summary,
      state: job.state,
      progress: Number(job.progress) || 0,
      message: job.message || '',
      error: job.error || '',
      result: job.result === undefined ? null : job.result,
      createdAt: job.createdAt,
      startedAt: job.startedAt || 0,
      finishedAt: job.finishedAt || 0,
      canCancel: job.state === 'running' || job.state === 'queued',
      canRetry: ['done', 'failed', 'canceled', 'interrupted'].includes(job.state),
    }
    if (withLog) row.log = job.log.slice(-40)
    return row
  }

  function persist() {
    if (closed) return
    const target = file()
    try {
      mkdirSync(path.dirname(target), { recursive: true })
      const rows = jobs.slice(0, maxKept).map((job) => publicRow(job))
      const temp = `${target}.tmp`
      writeFileSync(temp, JSON.stringify(rows, null, 2))
      renameSync(temp, target)
    } catch {
      // A read-only work directory must not take the queue down with it.
    }
  }

  function restore() {
    let rows = null
    try {
      rows = JSON.parse(readFileSync(file(), 'utf8'))
    } catch {
      return
    }
    if (!Array.isArray(rows)) return
    for (const row of rows.slice(0, maxKept)) {
      if (!row || typeof row !== 'object' || typeof row.id !== 'string' || row.id === '') continue
      const state = ['done', 'failed', 'canceled'].includes(row.state) ? row.state
        : (row.state === 'running' ? 'interrupted' : 'canceled')
      jobs.push({
        id: row.id,
        kind: String(row.kind || ''),
        summary: String(row.summary || ''),
        state,
        progress: Number(row.progress) || 0,
        message: String(row.message || ''),
        error: String(row.error || ''),
        result: row.result ?? null,
        createdAt: Number(row.createdAt) || 0,
        startedAt: Number(row.startedAt) || 0,
        finishedAt: Number(row.finishedAt) || 0,
        log: [],
      })
    }
  }

  /** Keep the in-memory list bounded without dropping running jobs. */
  function trim() {
    const finished = jobs.filter((job) => job.state !== 'running' && job.state !== 'queued')
    const excess = jobs.length - maxKept
    if (excess <= 0) return
    for (const job of finished.slice().reverse().slice(0, excess)) {
      const index = jobs.indexOf(job)
      if (index >= 0) jobs.splice(index, 1)
    }
  }

  function logFile(id) {
    return path.join(logDir(), `${id}.log`)
  }

  function appendLog(job, line) {
    const text = String(line || '').trim()
    if (text === '') return
    job.log.push(text)
    if (job.log.length > 60) job.log.splice(0, job.log.length - 60)
    try {
      mkdirSync(logDir(), { recursive: true })
      writeFileSync(logFile(job.id), `${job.log.join('\n')}\n`)
    } catch {
      // Logs are a convenience; losing them must not fail the job.
    }
  }

  /**
   * Start a job. The runner receives `{ onProgress, isCanceled, log }` and may
   * be async; its resolved value becomes `result`.
   *
   * @param {string} kind
   * @param {object} [options]
   * @param {string} [options.summary] - display text, must not contain chat names
   * @param {object} [options.params] - handed to the runner only, never persisted
   * @returns {object} the public row
   */
  function submit(kind, { summary = '', params = {} } = {}) {
    if (closed) throw new Error('任务队列已关闭')
    const runner = runners[kind]
    if (typeof runner !== 'function') throw new Error(`未知的任务类型：${kind}`)
    const job = {
      id: nextId(),
      kind,
      summary: String(summary || kind),
      state: 'queued',
      progress: 0,
      message: '',
      error: '',
      result: null,
      createdAt: Math.floor(Date.now() / 1000),
      startedAt: 0,
      finishedAt: 0,
      log: [],
      params,
    }
    jobs.unshift(job)
    trim()
    persist()
    // Snapshot before `pump()`: starting a runner flips the state to `running`
    // synchronously, and the caller should still see what it just queued.
    const snapshot = publicRow(job)
    pump()
    return snapshot
  }

  /** Start queued jobs while a slot is free. */
  function pump() {
    if (closed) return
    for (const job of queued()) {
      if (active() >= concurrency) return
      void start(job)
    }
  }

  async function start(job) {
    const runner = runners[job.kind]
    const ctx = {
      canceled: false,
      isCanceled: () => ctx.canceled || job.state === 'canceled',
      log: (line) => appendLog(job, line),
      onProgress(progress, message = '') {
        const value = Number(progress)
        if (!Number.isFinite(value)) return
        job.progress = Math.min(1, Math.max(0, value))
        if (message) job.message = String(message)
      },
    }
    job.state = 'running'
    job.startedAt = Math.floor(Date.now() / 1000)
    job.progress = 0
    contexts.set(job.id, ctx)
    persist()

    const timer = setTimeout(() => {
      ctx.canceled = true
      job.error = job.error || '任务超时'
    }, timeoutMs)
    timers.set(job.id, timer)

    try {
      const result = await runner({ ...job, params: job.params }, ctx)
      job.result = result === undefined ? null : result
      // `cancel()` may already have flipped the state while the runner was
      // finishing; that verdict wins over the runner's return value.
      if (ctx.canceled || job.state === 'canceled') {
        job.state = 'canceled'
      } else {
        job.state = 'done'
        job.progress = 1
      }
    } catch (error) {
      if (ctx.canceled) job.state = 'canceled'
      else {
        job.state = 'failed'
        job.error = String(error?.message || error)
      }
    } finally {
      clearTimeout(timer)
      timers.delete(job.id)
      contexts.delete(job.id)
      job.finishedAt = Math.floor(Date.now() / 1000)
      // `params` stays in memory so `retry()` can reuse it; `persist()` never
      // writes it, so the file on disk holds no chat ids or keywords.
      persist()
      pump()
    }
  }

  /**
   * Ask a job to stop. Cooperative: the runner observes `isCanceled()` and
   * returns; a queued job is canceled immediately without ever starting.
   */
  function cancel(id) {
    const job = jobs.find((entry) => entry.id === id)
    if (!job) return null
    if (job.state === 'queued') {
      job.state = 'canceled'
      job.finishedAt = Math.floor(Date.now() / 1000)
      persist()
      return publicRow(job)
    }
    if (job.state !== 'running') return publicRow(job)
    const ctx = contexts.get(job.id)
    if (ctx) ctx.canceled = true
    job.state = 'canceled'
    job.message = '正在停止…'
    persist()
    return publicRow(job)
  }

  /**
   * Re-submit a job with the arguments it was created with. Only finished jobs
   * qualify, and the original row is left in place as history.
   */
  function retry(id) {
    const job = jobs.find((entry) => entry.id === id)
    if (!job) return null
    if (!['failed', 'canceled', 'interrupted', 'done'].includes(job.state)) return null
    if (!job.params) {
      // Restored rows lost their params: retrying them would silently run a
      // different job, so the caller is told to start a fresh one instead.
      throw new Error('该任务来自上次运行，参数已不保留，请重新发起')
    }
    return submit(job.kind, { summary: job.summary, params: job.params })
  }

  function list({ kind = '' } = {}) {
    return jobs
      .filter((job) => kind === '' || job.kind === kind)
      .slice(0, maxKept)
      .map((job) => publicRow(job))
  }

  function get(id) {
    const job = jobs.find((entry) => entry.id === id)
    return job ? publicRow(job, { withLog: true }) : null
  }

  /** Remove finished rows (and their logs) older than `ageMs`. */
  function sweep({ ageMs = 24 * 60 * 60 * 1000 } = {}) {
    const cutoff = Date.now() - ageMs
    let removed = 0
    for (let index = jobs.length - 1; index >= 0; index -= 1) {
      const job = jobs[index]
      if (job.state === 'running' || job.state === 'queued') continue
      if ((job.finishedAt || 0) * 1000 > cutoff) continue
      jobs.splice(index, 1)
      removed += 1
      try {
        if (existsSync(logFile(job.id))) unlinkSync(logFile(job.id))
      } catch {
        // A stuck log file is not worth failing a sweep for.
      }
    }
    if (removed > 0) persist()
    return removed
  }

  /** Stop accepting work; running runners observe `isCanceled()` on their own. */
  async function shutdown() {
    closed = true
    for (const timer of timers.values()) clearTimeout(timer)
    timers.clear()
    for (const ctx of contexts.values()) ctx.canceled = true
    persist()
  }

  restore()
  return { submit, list, get, cancel, retry, sweep, shutdown, file, logFile }
}
