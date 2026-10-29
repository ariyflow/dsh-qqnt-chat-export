/**
 * Persistent, user-editable settings for the QQ chat export bundle.
 *
 * The bundle config in `cordis.patch.yml` supplies the defaults; this module
 * layers a small JSON file written by the local settings page on top. Keeping
 * it outside `workDir` means changing the work directory does not strand the
 * settings file.
 */
import { chmodSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const DEFAULT_WEB_PORT = 46728
export const DEFAULT_WEB_HOST = '127.0.0.1'
export const SETTINGS_KEYS = [
  'pythonPath', 'workDir', 'tencentRoot', 'account', 'webPort',
  'installer', 'uvPath', 'pythonVersion',
]
/** `auto` prefers uv when it is installed and falls back to venv + pip. */
export const INSTALLERS = ['auto', 'uv', 'pip']
/** Python version uv should fetch for the private environment. */
export const DEFAULT_PYTHON_VERSION = '3.12'
const APP_DIR = 'dsh-qqnt-chat-export'
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

/** Expand a leading `~` because config values do not go through a shell. */
export function expandHome(value) {
  if (value === '~') return os.homedir()
  if (value.startsWith('~/') || value.startsWith('~\\')) return path.join(os.homedir(), value.slice(2))
  return value
}

export function defaultWorkDir() {
  return path.join(os.tmpdir(), 'qqnt-chat-export')
}

export function defaultPython() {
  return process.platform === 'win32' ? 'python' : 'python3'
}

/** Where the one-click environment setup creates its private virtualenv. */
export function defaultVenvDir() {
  if (process.env.DSH_QQNT_VENV_DIR) return path.resolve(process.env.DSH_QQNT_VENV_DIR)
  if (process.platform === 'win32') {
    const base = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
    return path.join(base, APP_DIR, 'venv')
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', APP_DIR, 'venv')
  }
  const base = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share')
  return path.join(base, APP_DIR, 'venv')
}

export function venvPython(dir = defaultVenvDir()) {
  return process.platform === 'win32'
    ? path.join(dir, 'Scripts', 'python.exe')
    : path.join(dir, 'bin', 'python')
}

/** Where the settings-page overrides live. */
export function settingsFile() {
  if (process.env.DSH_QQNT_SETTINGS_FILE) return path.resolve(process.env.DSH_QQNT_SETTINGS_FILE)
  if (process.platform === 'win32') {
    const base = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
    return path.join(base, APP_DIR, 'settings.json')
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', APP_DIR, 'settings.json')
  }
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config')
  return path.join(base, APP_DIR, 'settings.json')
}

function str(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : ''
}

function resolvePython(value) {
  const raw = str(value)
  if (raw === '') return defaultPython()
  // A bare command (`python3`) must stay a PATH lookup; only path-like values
  // are resolved against the host filesystem.
  return /[\\/]/.test(raw) ? path.resolve(expandHome(raw)) : raw
}

/**
 * Compute effective settings from bundle config plus saved overrides.
 *
 * @param {object} config - the bundle row config.
 * @param {object} overrides - values saved by the settings page.
 */
export function resolveSettings(config, overrides = {}) {
  const base = config && typeof config === 'object' ? config : {}
  const raw = { ...base, ...(overrides && typeof overrides === 'object' ? overrides : {}) }
  const pythonPath = str(raw.pythonPath)
  const workDirRaw = str(raw.workDir)
  const tencentRootRaw = str(raw.tencentRoot)
  const port = Number.parseInt(String(raw.webPort ?? ''), 10)
  const host = str(raw.webHost) || DEFAULT_WEB_HOST
  const bindHost = host === '[::1]' ? '::1' : host

  const installer = INSTALLERS.includes(str(raw.installer)) ? str(raw.installer) : 'auto'
  const uvPathRaw = str(raw.uvPath)
  const versionRaw = str(raw.pythonVersion)
  const pythonVersion = /^3\.\d{1,2}$/.test(versionRaw) ? versionRaw : DEFAULT_PYTHON_VERSION

  return {
    python: resolvePython(pythonPath),
    pythonPath,
    uv: uvPathRaw ? resolvePython(uvPathRaw) : 'uv',
    installer,
    pythonVersion,
    workDir: workDirRaw ? path.resolve(expandHome(workDirRaw)) : defaultWorkDir(),
    tencentRoot: tencentRootRaw ? path.resolve(expandHome(tencentRootRaw)) : '',
    account: str(raw.account),
    webPort: Number.isFinite(port) && port >= 0 ? port : DEFAULT_WEB_PORT,
    webHost: LOOPBACK.has(host) ? bindHost : DEFAULT_WEB_HOST,
  }
}

/** Read overrides saved by the settings page; malformed files are ignored. */
export function loadOverrides(file = settingsFile()) {
  let data
  try {
    data = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return {}
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return {}
  const out = {}
  for (const key of SETTINGS_KEYS) {
    if (Object.prototype.hasOwnProperty.call(data, key)) out[key] = data[key]
  }
  return out
}

/** Persist overrides atomically with owner-only permissions on POSIX. */
export function saveOverrides(overrides, file = settingsFile()) {
  const clean = {}
  for (const key of SETTINGS_KEYS) {
    if (Object.prototype.hasOwnProperty.call(overrides, key)) clean[key] = overrides[key]
  }
  const dir = path.dirname(file)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  if (process.platform !== 'win32') {
    try {
      chmodSync(dir, 0o700)
    } catch {
      // A filesystem without chmod support; the file still works.
    }
  }
  const tmp = `${file}.tmp`
  writeFileSync(tmp, `${JSON.stringify(clean, null, 2)}\n`, 'utf8')
  if (process.platform !== 'win32') {
    try {
      chmodSync(tmp, 0o600)
    } catch {
      // A filesystem without chmod support; the file still works.
    }
  }
  renameSync(tmp, file)
}

export function clearOverrides(file = settingsFile()) {
  try {
    unlinkSync(file)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
}

/** Validate only the fields the settings page is allowed to change. */
export function validatePatch(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw Object.assign(new Error('设置格式不正确'), { status: 400 })
  }
  for (const key of Object.keys(patch)) {
    if (!SETTINGS_KEYS.includes(key)) {
      throw Object.assign(new Error(`未知设置项: ${key}`), { status: 400 })
    }
  }
  const out = {}
  for (const key of ['pythonPath', 'workDir', 'tencentRoot', 'account', 'uvPath']) {
    if (!Object.prototype.hasOwnProperty.call(patch, key)) continue
    if (typeof patch[key] !== 'string') {
      throw Object.assign(new Error(`${key} 必须是字符串`), { status: 400 })
    }
    out[key] = patch[key].trim()
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'installer')) {
    const value = String(patch.installer)
    if (!INSTALLERS.includes(value)) {
      throw Object.assign(new Error(`installer 只能是 ${INSTALLERS.join(' / ')}`), { status: 400 })
    }
    out.installer = value
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'pythonVersion')) {
    const value = String(patch.pythonVersion).trim()
    if (value !== '' && !/^3\.\d{1,2}$/.test(value)) {
      throw Object.assign(new Error('Python 版本应形如 3.12'), { status: 400 })
    }
    out.pythonVersion = value
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'webPort')) {
    const port = Number(patch.webPort)
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      throw Object.assign(new Error('端口必须是 0~65535 的整数（0 表示关闭网页）'), { status: 400 })
    }
    out.webPort = port
  }
  return out
}

/** The shape the settings page needs to render and explain the form. */
export function publicSettings(settings, defaults, { url = '', file = settingsFile() } = {}) {
  return {
    settings: {
      pythonPath: settings.pythonPath,
      python: settings.python,
      workDir: settings.workDir,
      tencentRoot: settings.tencentRoot,
      account: settings.account,
      webPort: settings.webPort,
      webHost: settings.webHost,
      installer: settings.installer,
      uv: settings.uv,
      pythonVersion: settings.pythonVersion,
    },
    defaults: {
      pythonPath: defaults.pythonPath,
      python: defaults.python,
      workDir: defaults.workDir,
      tencentRoot: defaults.tencentRoot,
      account: defaults.account,
      webPort: defaults.webPort,
      webHost: defaults.webHost,
      installer: defaults.installer,
      uv: defaults.uv,
      pythonVersion: defaults.pythonVersion,
    },
    file,
    url,
    platform: process.platform,
    venv: { dir: defaultVenvDir(), python: venvPython() },
  }
}
