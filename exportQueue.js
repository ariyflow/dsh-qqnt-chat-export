/**
 * Asynchronous export queue for the local web UI.
 *
 * An export of a whole account can take minutes; running it inside the HTTP
 * request hit the 180-second request timeout. The finished list is written to
 * `workDir/export-tasks.json` so a restart can restore it; the generated files
 * stay in `workDir/exports`, where the sweep removes them after an hour.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'

/** Concurrent helper processes. Each one parses the encrypted database. */
export const MAX_CONCURRENT = 3
/** Finished tasks kept for the task panel. */
export const MAX_KEPT = 20
/** A stuck export must not pin a slot forever. */
export const TASK_TIMEOUT_MS = 30 * 60 * 1000

/**
 * @param {object} options
 * @param {object} options.settings - live settings object (`python`, `workDir`).
 * @param {string} options.queryCli - absolute path to `qqnt_query.py`.
 * @param {number} [options.concurrency] - override for tests.
 */
export function createExportQueue({ settings, queryCli, concurrency = MAX_CONCURRENT }) {
  const tasks = []
  const children = new Map()
  const timers = new Map()
  let counter = 0

  const running = () => tasks.filter((task) => task.state === 'running').length
  const exportsDir = () => path.resolve(settings.workDir, 'exports')
  /**
   * Where the finished list survives a restart. It lives beside `exports/`,
   * not inside it: the hourly sweep and "清理临时导出文件" own that directory
   * and must not delete the list itself. Rows keep only a basename, so moving
   * the work directory keeps the download links working.
   */
  const tasksFile = () => path.join(path.resolve(settings.workDir), 'export-tasks.json')
  /** 0.13.0 wrote the list inside `exports/`; read it once and rewrite it. */
  const legacyTasksFile = () => path.join(exportsDir(), 'tasks.json')

  /** A task's file, when it is still inside `exports/` and still on disk. */
  function insideExports(target) {
    if (!target) return false
    const root = exportsDir()
    const resolved = path.resolve(String(target))
    const rel = path.relative(root, resolved)
    if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return false
    try {
      return statSync(resolved).isFile()
    } catch {
      return false
    }
  }

  /**
   * Labels that never contain a chat name, so they may be written to disk.
   * A single-chat label is a group/contact name — the restored row says
   * "聊天记录" instead, which is enough to find the file again.
   */
  function safeLabel(label) {
    const text = String(label || '')
    return /^(全部会话|批量导出 )/.test(text) ? text : '聊天记录'
  }

  /** Fields kept on disk: no chat id, no chat name, no traceback, no path. */
  function persisted(task) {
    return {
      id: task.id,
      label: safeLabel(task.label),
      format: task.format,
      state: task.state,
      rows: task.rows,
      bytes: task.bytes,
      // A basename survives a work-dir move and never leaks the home path.
      file: path.basename(String(task.path || '').replace(/\\/g, '/')),
      encrypted: task.encrypted === true,
      media: task.media || null,
      error: task.error,
      createdAt: task.createdAt,
      finishedAt: task.finishedAt,
    }
  }

  /** Parse one list file, or `null` when it is missing/garbage. */
  function readRows(file) {
    try {
      const rows = JSON.parse(readFileSync(file, 'utf8'))
      return Array.isArray(rows) ? rows : null
    } catch {
      return null
    }
  }

  /** Old rows stored an absolute `path`; new rows store `file` alone. */
  function restoredPath(row) {
    const pick = typeof row.file === 'string' && row.file !== '' ? row.file
      : (typeof row.path === 'string' ? row.path : '')
    const name = pick === '' ? '' : path.basename(pick.replace(/\\/g, '/'))
    return name === '' ? '' : path.join(exportsDir(), name)
  }

  /**
   * Read the previous run's list back. `done` survives only while its file is
   * still there; the hourly sweep that removes old files therefore also turns
   * yesterday's rows into "文件已清理" instead of dead download links.
   */
  function restore() {
    let rows = readRows(tasksFile())
    const legacy = rows === null
    if (legacy) rows = readRows(legacyTasksFile())
    if (rows === null) return
    for (const row of rows.slice(0, MAX_KEPT)) {
      if (!row || typeof row !== 'object' || typeof row.id !== 'string' || row.id === '') continue
      const state = row.state === 'done' || row.state === 'cancelled' || row.state === 'error'
        ? row.state
        : 'gone'
      const task = {
        id: row.id,
        label: typeof row.label === 'string' && row.label ? row.label : '聊天记录',
        format: typeof row.format === 'string' && row.format ? row.format : 'txt',
        state,
        rows: Number(row.rows) || 0,
        bytes: Number(row.bytes) || 0,
        path: restoredPath(row),
        error: typeof row.error === 'string' ? row.error.slice(0, 400) : '',
        detail: '',
        createdAt: Number(row.createdAt) || 0,
        finishedAt: Number(row.finishedAt) || 0,
        restored: true,
      }
      if (row.encrypted === true) task.encrypted = true
      if (row.media && Number.isFinite(Number(row.media.files))) {
        task.media = {
          files: Number(row.media.files),
          missing: Number(row.media.missing) || 0,
        }
      }
      if (task.state === 'done' && !insideExports(task.path)) {
        task.state = 'gone'
        task.error = '文件已清理（导出文件只保留一小时）'
      }
      tasks.push(task)
    }
    trim()
    // Rewrite straight away: the next sweep is free to delete the old file.
    if (legacy) writeTasks()
  }

  let saveTimer = null
  function writeTasks() {
    try {
      mkdirSync(path.dirname(tasksFile()), { recursive: true })
      const payload = tasks.filter((task) => task.state !== 'running').map(persisted)
      const tmp = `${tasksFile()}.tmp`
      writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
      renameSync(tmp, tasksFile())
    } catch {
      // A read-only work directory must not break finished exports.
    }
  }

  /** Debounced: a burst of finishes writes once. */
  function scheduleSave() {
    if (saveTimer) return
    saveTimer = setTimeout(() => {
      saveTimer = null
      writeTasks()
    }, 500)
    if (typeof saveTimer.unref === 'function') saveTimer.unref()
  }

  function flushSave() {
    if (saveTimer) {
      clearTimeout(saveTimer)
      saveTimer = null
    }
    writeTasks()
  }

  function trim() {
    while (tasks.length > MAX_KEPT) {
      const index = tasks.findIndex((task) => task.state !== 'running')
      if (index === -1) return
      const [task] = tasks.splice(index, 1)
      children.delete(task.id)
    }
  }

  function snapshot() {
    return {
      tasks: tasks.map((task) => ({ ...task })),
      running: running(),
      concurrency,
    }
  }

  function finish(task, { payload, error, detail } = {}) {
    children.delete(task.id)
    timers.delete(task.id)
    task.finishedAt = Date.now()
    if (error) {
      task.state = 'error'
      task.error = String(error).split('\n').slice(-4).join(' ').slice(0, 400)
      task.detail = typeof detail === 'string' ? detail.slice(0, 4000) : ''
      scheduleSave()
      return
    }
    task.state = 'done'
    task.bytes = Number(payload?.bytes) || 0
    task.rows = Number(payload?.rows) || 0
    if (payload?.encrypted === true) task.encrypted = true
    if (payload?.media && Number.isFinite(Number(payload.media.files))) {
      task.media = { files: Number(payload.media.files), missing: Number(payload.media.missing) || 0 }
    }
    if (typeof payload?.path === 'string' && payload.path !== '') task.path = payload.path
    scheduleSave()
  }

  /**
   * The last JSON object the helper printed, or `null`.
   *
   * `export` prints exactly one line, but a crash wrapper prints its payload
   * after whatever the failing code already wrote, so walk up from the end
   * instead of assuming the whole stdout is one document.
   */
  function lastJson(text) {
    const lines = String(text).split('\n').map((line) => line.trim()).filter(Boolean)
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      try {
        const value = JSON.parse(lines[index])
        if (value && typeof value === 'object') return value
      } catch {
        // Not JSON; keep walking up.
      }
    }
    return null
  }

  function start(task, args, password = '') {
    const argv = ['-X', 'utf8', queryCli, '--work', settings.workDir]
    if (settings.tencentRoot) argv.push('--root', settings.tencentRoot)
    if (settings.account) argv.push('--account', String(settings.account))
    argv.push('export', '--json', JSON.stringify(args))

    // The password travels in the environment, not argv: `ps` exposes every
    // argument to other users, environment blocks do not.
    const env = { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' }
    if (password) env.QQNT_EXPORT_PASSWORD = password

    let child
    try {
      child = spawn(settings.python, argv, {
        windowsHide: true,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      finish(task, { error: `无法启动导出进程：${error.message}` })
      return
    }
    children.set(task.id, child)
    const stdout = []
    const stderr = []
    let settled = false
    const timer = setTimeout(() => {
      if (settled || task.state === 'cancelled') return
      try {
        child.kill()
      } catch {
        // Already gone.
      }
      finish(task, { error: '导出超过 30 分钟，已停止；数据量太大可以改用命令行导出' })
      settled = true
    }, TASK_TIMEOUT_MS)
    timers.set(task.id, timer)

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => stdout.push(chunk))
    child.stderr.on('data', (chunk) => stderr.push(chunk))
    child.on('error', (error) => {
      if (settled || task.state === 'cancelled') return
      settled = true
      clearTimeout(timer)
      finish(task, {
        error: error.code === 'ENOENT'
          ? `无法运行 Python 解释器「${settings.python}」：找不到可执行文件`
          : `无法启动导出进程：${error.message}`,
      })
    })
    child.on('close', (code) => {
      if (settled || task.state === 'cancelled') return
      settled = true
      clearTimeout(timer)
      const out = stdout.join('').trim()
      if (code !== 0) {
        const parsed = lastJson(out)
        let message = stderr.join('').trim().split('\n').slice(-4).join(' ')
        if (parsed && typeof parsed.error === 'string') message = parsed.error
        const detail = parsed && typeof parsed.detail === 'string' ? parsed.detail : ''
        finish(task, { error: message || `导出进程退出码 ${code}`, detail })
        return
      }
      try {
        const payload = lastJson(out)
        finish(task, { payload: payload || {} })
      } catch (error) {
        finish(task, { error: `无法读取导出结果：${error.message}` })
      }
    })
  }

  /**
   * Queue one export. Returns `null` when every slot is busy; the HTTP layer
   * turns that into 429 instead of silently dropping the request.
   *
   * `format` is the file the user downloads (a bundle is always `zip`);
   * `innerFormat` is what each chat file inside a bundle should be.
   */
  function enqueue(args, { label = 'QQ聊天记录', format = 'txt', innerFormat, password = '' } = {}) {
    if (running() >= concurrency) return null
    const id = `e${Date.now().toString(36)}${(counter += 1).toString(36)}`
    const out = path.join(exportsDir(), `${id}.${format}`)
    const task = {
      id,
      label,
      format,
      state: 'running',
      rows: 0,
      bytes: 0,
      path: out,
      error: '',
      detail: '',
      restored: false,
      createdAt: Date.now(),
      finishedAt: 0,
    }
    tasks.unshift(task)
    trim()
    start(task, { ...args, format: innerFormat || format, out, label }, password)
    return { ...task }
  }

  function get(id) {
    const task = tasks.find((item) => item.id === id)
    return task ? { ...task } : null
  }

  /**
   * Stop a running export. Returns the cancelled task, or `null` when the id
   * is unknown or the task already finished (the HTTP layer turns that into
   * 404/409). Killing the child frees its slot immediately.
   */
  function cancel(id) {
    const task = tasks.find((item) => item.id === id)
    if (!task || task.state !== 'running') return null
    const child = children.get(id)
    const timer = timers.get(id)
    if (timer) {
      clearTimeout(timer)
      timers.delete(id)
    }
    children.delete(id)
    task.state = 'cancelled'
    task.finishedAt = Date.now()
    task.error = '已取消'
    scheduleSave()
    try {
      child?.kill()
    } catch {
      // Already exited.
    }
    try {
      if (task.path && existsSync(task.path)) unlinkSync(task.path)
    } catch {
      // Windows may still hold the partial file; the sweep removes it later.
    }
    return { ...task }
  }

  /** The finished file, or `null` when the task is missing or not ready. */
  function file(id) {
    const task = tasks.find((item) => item.id === id)
    if (!task || task.state !== 'done' || !task.path) return null
    const root = exportsDir()
    const target = path.resolve(task.path)
    const rel = path.relative(root, target)
    if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return null
    if (!existsSync(target)) return null
    try {
      if (!statSync(target).isFile()) return null
    } catch {
      return null
    }
    return { task: { ...task }, path: target }
  }

  /**
   * Mark finished rows whose file disappeared as "gone".
   *
   * The startup sweep and "清理临时导出文件" delete files behind the queue's
   * back; without this a restored row would keep a dead download link until
   * the next restart.
   */
  function revalidate() {
    let changed = false
    for (const task of tasks) {
      if (task.state !== 'done' || insideExports(task.path)) continue
      task.state = 'gone'
      task.error = '文件已清理（导出文件只保留一小时）'
      changed = true
    }
    if (changed) scheduleSave()
  }

  /** Kill running children when the listener stops. */
  function close() {
    for (const child of children.values()) {
      try {
        child.kill()
      } catch {
        // Already exited.
      }
    }
    children.clear()
    // The debounce may still be pending; losing the last finished row on a
    // clean shutdown would make the panel forget the export it just showed.
    flushSave()
  }

  restore()

  return { enqueue, list: snapshot, get, cancel, file, close, revalidate }
}
