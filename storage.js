/**
 * Inspection and safe cleanup of files this bundle generates.
 *
 * Everything listed here lives directly inside `workDir`; the QQ data
 * directory is never touched. Deletion is limited to an allow-list so a bad
 * request cannot turn into a recursive delete of an arbitrary path.
 */
import { existsSync, lstatSync, readFileSync, readdirSync, unlinkSync } from 'node:fs'
import { cp, mkdir, readdir, rm } from 'node:fs/promises'
import path from 'node:path'

const LOCK_MAX_AGE_MS = 15 * 60 * 1000
/** Parked indexes for other accounts: index.<uin>.sqlite (+ sidecars). */
const CACHE_RE = /^index\.[0-9A-Za-z_-]+\.sqlite(?:-(?:wal|shm))?$/
export const ACCOUNT_CACHE_ID = 'indexCache'

export const STORAGE_ITEMS = [
  {
    id: 'decrypted',
    label: '解密数据库副本',
    detail: 'nt_msg.db / group_info.db / profile_info.db；可重新从 QQ 复制',
    files: ['nt_msg.db', 'group_info.db', 'profile_info.db'],
  },
  {
    id: 'index',
    label: '查询索引',
    detail: 'index.sqlite；删除后需要重建（约 1 分钟）',
    files: ['index.sqlite', 'index.sqlite-wal', 'index.sqlite-shm',
      'index.sqlite.tmp', 'index.sqlite.tmp-wal', 'index.sqlite.tmp-shm'],
  },
  {
    id: 'key',
    label: '数据库密钥',
    detail: 'key.txt / key.json；删除后需要重新提取密钥',
    files: ['key.txt', 'key.json', 'key.json.tmp'],
  },
  {
    id: 'exports',
    label: '临时导出文件',
    detail: 'exports/ 里尚未清理的下载临时文件',
    dir: 'exports',
  },
  {
    id: 'state',
    label: '构建状态与锁',
    detail: 'build-status.json / build.lock；索引构建进行中时不能删除',
    files: ['build-status.json', 'build-status.json.tmp', 'build.lock'],
  },
]

function safeInside(root, name) {
  const resolvedRoot = path.resolve(root)
  const target = path.resolve(resolvedRoot, name)
  const rel = path.relative(resolvedRoot, target)
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`拒绝删除工作目录之外的路径: ${name}`)
  }
  return target
}

function infoFor(target, name) {
  try {
    const st = lstatSync(target)
    if (!st.isFile() && !st.isSymbolicLink()) {
      return { name, bytes: 0, exists: false, directory: true }
    }
    return { name, bytes: st.isFile() ? st.size : 0, exists: true, directory: false }
  } catch {
    return { name, bytes: 0, exists: false, directory: false }
  }
}

/** Parked account indexes, scanned rather than allow-listed by name. */
function cacheNames(workDir) {
  try {
    return readdirSync(workDir).filter((name) => CACHE_RE.test(name)).sort()
  } catch {
    return []
  }
}

function cacheItem(workDir) {
  const files = cacheNames(workDir)
    .map((name) => {
      const match = /^index\.([0-9A-Za-z_-]+)\.sqlite/.exec(name)
      return { ...infoFor(safeInside(workDir, name), name), account: match ? match[1] : '' }
    })
    .filter((file) => file.exists)
  if (files.length === 0) return null
  return {
    id: ACCOUNT_CACHE_ID,
    label: '账号索引缓存',
    detail: 'index.<账号>.sqlite；切回该账号时可直接增量更新（保留数量见设置）',
    bytes: files.reduce((sum, file) => sum + (file.exists ? file.bytes : 0), 0),
    files,
  }
}

function directoryFiles(root, name) {
  const dir = safeInside(root, name)
  try {
    if (!lstatSync(dir).isDirectory()) return []
    return readdirSync(dir)
      .map((entry) => infoFor(path.join(dir, entry), `${name}/${entry}`))
      .filter((entry) => entry.exists && !entry.directory)
  } catch {
    return []
  }
}

/** Whether an index build is still running (fresh lock or a recent status). */
function buildRunning(workDir) {
  const statusFile = path.join(workDir, 'build-status.json')
  let status = {}
  try {
    status = JSON.parse(readFileSync(statusFile, 'utf8'))
  } catch {
    // No readable status.
  }
  let lockAge = Number.POSITIVE_INFINITY
  try {
    lockAge = Date.now() - lstatSync(path.join(workDir, 'build.lock')).mtimeMs
  } catch {
    // No lock.
  }
  const startedAgo = status.startedAt ? Date.now() - status.startedAt * 1000 : Number.POSITIVE_INFINITY
  const stale = startedAgo > LOCK_MAX_AGE_MS && lockAge > LOCK_MAX_AGE_MS
  return status.state === 'running' && !stale
}

/** A snapshot used both by the settings page and by the deletion guard. */
export function storageSnapshot(workDir) {
  const running = buildRunning(workDir)
  let totalBytes = 0
  const items = STORAGE_ITEMS.map((item) => {
    const files = item.dir
      ? directoryFiles(workDir, item.dir)
      : item.files.map((name) => infoFor(safeInside(workDir, name), name))
    const bytes = files.reduce((sum, file) => sum + (file.exists ? file.bytes : 0), 0)
    totalBytes += bytes
    return {
      id: item.id,
      label: item.label,
      detail: item.detail,
      bytes,
      files: files.filter((file) => file.exists),
    }
  }).filter((item) => item.files.length > 0)
  // Scanned rather than allow-listed: the account names are not known ahead
  // of time, and the live `index.sqlite` deliberately never matches.
  const cache = cacheItem(workDir)
  if (cache) {
    totalBytes += cache.bytes
    items.push(cache)
  }
  return {
    workDir,
    exists: existsSync(workDir),
    running,
    key: existsSync(path.join(workDir, 'key.txt')),
    index: existsSync(path.join(workDir, 'index.sqlite')),
    totalBytes,
    items,
  }
}

/**
 * Delete the selected allow-listed categories.
 *
 * @returns {{removed: number, freedBytes: number, failed: Array<{name: string, error: string}>}}
 */
export function cleanupStorage(workDir, ids) {
  if (!Array.isArray(ids) || ids.length === 0) {
    throw Object.assign(new Error('没有选择要删除的内容'), { status: 400 })
  }
  const wanted = new Set(ids)
  const known = new Set([...STORAGE_ITEMS.map((item) => item.id), ACCOUNT_CACHE_ID])
  for (const id of wanted) {
    if (!known.has(id)) throw Object.assign(new Error('包含未知的清理项'), { status: 400 })
  }
  const items = STORAGE_ITEMS.filter((item) => wanted.has(item.id))
  if (buildRunning(workDir)) {
    throw Object.assign(new Error('索引正在建立，等它结束后再清理'), { status: 409 })
  }

  let removed = 0
  let freedBytes = 0
  const failed = []
  const removeFile = (target, name) => {
    try {
      const st = lstatSync(target)
      if (!st.isFile() && !st.isSymbolicLink()) {
        failed.push({ name, error: '不是普通文件，已跳过' })
        return
      }
      unlinkSync(target)
      removed += 1
      freedBytes += st.isFile() ? st.size : 0
    } catch (error) {
      if (error.code !== 'ENOENT') failed.push({ name, error: error.message })
    }
  }

  if (wanted.has(ACCOUNT_CACHE_ID)) {
    // Re-scan instead of trusting a name from the request: only files that
    // currently match the pattern can be deleted.
    for (const name of cacheNames(workDir)) removeFile(safeInside(workDir, name), name)
  }

  for (const item of items) {
    if (item.dir) {
      const dir = safeInside(workDir, item.dir)
      try {
        if (!lstatSync(dir).isDirectory()) {
          failed.push({ name: item.dir, error: '不是目录，已跳过' })
          continue
        }
        for (const entry of readdirSync(dir)) {
          removeFile(path.join(dir, entry), `${item.dir}/${entry}`)
        }
      } catch (error) {
        if (error.code !== 'ENOENT') failed.push({ name: item.dir, error: error.message })
      }
      continue
    }
    for (const name of item.files) {
      removeFile(safeInside(workDir, name), name)
    }
  }
  return { removed, freedBytes, failed }
}

export { buildRunning }

/** Whether `child` is `parent` itself or sits underneath it. */
function inside(parent, child) {
  const rel = path.relative(path.resolve(parent), path.resolve(child))
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

/**
 * Copy a work directory to a new location, leaving the source intact.
 *
 * `removeSource` defaults to false: the caller commits the new `workDir` first
 * and only then deletes the source entries, so a failed settings write never
 * loses the key. Existing files in the target are reported as `skipped`
 * instead of overwritten.
 */
export async function migrateWorkDir(from, to, { removeSource = false } = {}) {
  const source = path.resolve(from)
  const target = path.resolve(to)
  if (source === target) {
    throw Object.assign(new Error('工作目录已经在目标位置'), { status: 400 })
  }
  if (inside(source, target) || inside(target, source)) {
    throw Object.assign(new Error('新旧工作目录不能互相包含'), { status: 400 })
  }
  if (!existsSync(source)) {
    throw Object.assign(new Error(`旧工作目录不存在：${source}`), { status: 400 })
  }
  await mkdir(target, { recursive: true, mode: 0o700 })
  const entries = await readdir(source, { withFileTypes: true })
  const copied = []
  const skipped = []
  try {
    for (const entry of entries) {
      // The lock belongs to the old directory; a build cannot be running here
      // (the caller checks first), and copying a lock file would block the new
      // directory forever.
      if (entry.name === 'build.lock') continue
      const src = path.join(source, entry.name)
      const dst = path.join(target, entry.name)
      if (existsSync(dst)) {
        skipped.push(entry.name)
        continue
      }
      await cp(src, dst, { recursive: true, force: false, errorOnExist: true })
      copied.push(entry.name)
    }
    if (existsSync(path.join(source, 'key.txt')) && !existsSync(path.join(target, 'key.txt'))) {
      throw new Error('key.txt 没有复制成功')
    }
  } catch (error) {
    for (const name of copied) await rm(path.join(target, name), { recursive: true, force: true })
    throw Object.assign(error, { status: 500 })
  }
  if (removeSource) await removeWorkDirEntries(source, copied)
  return { from: source, to: target, copied, skipped }
}

/** Best-effort deletion of the entries a migration copied (source cleanup). */
export async function removeWorkDirEntries(dir, names) {
  const removed = []
  for (const name of names) {
    try {
      await rm(path.join(dir, name), { recursive: true, force: true })
      removed.push(name)
    } catch {
      // Leaving a stale source copy is harmless; the target is authoritative.
    }
  }
  return removed
}
