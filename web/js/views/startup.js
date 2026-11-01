/**
 * First-run banner: the address, whether the environment can decrypt a
 * database, and whether the key is cached.
 *
 * It exists because the page is now the only frontend: someone who installs the
 * bundle and opens the sidebar panel has no other place to learn which URL to
 * bookmark, why "从 QQ 同步" fails, or where the missing dependency is fixed.
 *
 * Shown once per web-server start (the marker is compared with
 * `status.startedAt` in sessionStorage), so a refresh is quiet but a restart
 * with a new problem still says so. Pure helpers are exported for the tests.
 */

export const STARTUP_KEY = 'qqnt.startup.seen'

/** Whether this server start has not been dismissed in this browser tab yet. */
export function startupNeeded(startedAt, marker) {
  if (!startedAt) return false
  return String(startedAt) !== String(marker || '')
}

/** `{ok, text}` for the Python / sqlcipher3 / pyzipper line. */
export function envLine(diagnostics) {
  if (!diagnostics) return { ok: false, text: '正在检查 Python / sqlcipher3 / pyzipper…' }
  if (diagnostics.infoError) {
    return { ok: false, text: `环境检查失败：${diagnostics.infoError}` }
  }
  const parts = [`Python ${diagnostics.version || '?'}`,
    diagnostics.sqlcipher3 ? 'sqlcipher3 已安装' : 'sqlcipher3 缺失']
  if (diagnostics.pyzipper) parts.push('密码 ZIP 可用')
  return { ok: diagnostics.sqlcipher3 === true, text: `环境：${parts.join(' · ')}` }
}

/** `{ok, text}` for the cached-key line. */
export function keyLine(diagnostics) {
  if (!diagnostics) return { ok: false, text: '数据库密钥：状态读取中…' }
  return diagnostics.key
    ? { ok: true, text: '数据库密钥：已配置' }
    : { ok: false, text: '数据库密钥：未提取（点右侧按钮，通常需要 1~3 分钟）' }
}

/**
 * @param {HTMLElement} root - container that may hold the banner
 * @param {{api: object, onOpenSettings?: Function, storage?: Storage, url?: string}} options
 * @returns {() => void} cleanup
 */
export function mountStartup(root, {
  api,
  onOpenSettings = null,
  storage = typeof sessionStorage === 'undefined' ? null : sessionStorage,
  url = typeof location === 'undefined' ? '' : `${location.origin}/`,
} = {}) {
  const box = document.createElement('div')
  box.className = 'startup'
  box.hidden = true

  const main = document.createElement('div')
  main.className = 'startup-main'
  const heading = document.createElement('strong')
  heading.textContent = 'QQ 聊天记录已启动'
  const urlLine = document.createElement('div')
  urlLine.className = 'startup-line'
  const urlLabel = document.createElement('span')
  urlLabel.textContent = '默认访问地址：'
  const urlCode = document.createElement('code')
  urlCode.textContent = url
  urlLine.append(urlLabel, urlCode)
  const envText = document.createElement('div')
  envText.className = 'startup-line'
  envText.textContent = '正在检查 Python / sqlcipher3 / pyzipper…'
  const keyText = document.createElement('div')
  keyText.className = 'startup-line'
  keyText.textContent = '数据库密钥：状态读取中…'
  main.append(heading, urlLine, envText, keyText)

  const actions = document.createElement('div')
  actions.className = 'startup-actions'
  const setupDefault = document.createElement('button')
  setupDefault.type = 'button'
  setupDefault.className = 'primary'
  setupDefault.textContent = '默认源安装'
  setupDefault.hidden = true
  const setupMirror = document.createElement('button')
  setupMirror.type = 'button'
  setupMirror.className = 'ghost'
  setupMirror.textContent = '清华镜像安装'
  setupMirror.hidden = true
  const keyButton = document.createElement('button')
  keyButton.type = 'button'
  keyButton.className = 'primary'
  keyButton.textContent = '提取密钥'
  keyButton.hidden = true
  const settingsButton = document.createElement('button')
  settingsButton.type = 'button'
  settingsButton.className = 'ghost'
  settingsButton.textContent = '设置'
  const dismiss = document.createElement('button')
  dismiss.type = 'button'
  dismiss.className = 'ghost'
  dismiss.textContent = '关闭提示'
  actions.append(setupDefault, setupMirror, keyButton, settingsButton, dismiss)

  box.append(main, actions)
  root.append(box)

  let closed = false
  let startedAt = 0
  let diagnostics = null

  function hide() {
    box.hidden = true
    try {
      storage?.setItem(STARTUP_KEY, String(startedAt || ''))
    } catch {
      // A blocked storage only means the banner shows again on refresh.
    }
  }

  function paint() {
    const env = envLine(diagnostics)
    envText.textContent = env.text
    envText.classList.remove('bad')
    if (!env.ok && diagnostics) envText.classList.add('bad')
    const key = keyLine(diagnostics)
    keyText.textContent = key.text
    keyText.classList.remove('bad')
    if (!key.ok && diagnostics) keyText.classList.add('bad')
    setupDefault.hidden = env.ok
    setupMirror.hidden = env.ok
    keyButton.hidden = Boolean(diagnostics?.key)
  }

  async function startSetup(source) {
    setupDefault.disabled = true
    setupMirror.disabled = true
    try {
      await api.post('/api/setup/venv', { confirm: true, source })
      envText.textContent = '已开始配置环境：进度在「设置 → 运行环境」里。'
    } catch (error) {
      setupDefault.disabled = false
      setupMirror.disabled = false
      envText.textContent = `无法开始配置：${error.message}`
    }
  }

  async function extractKey() {
    keyButton.disabled = true
    try {
      await api.post('/api/key/extract', { confirm: true, force: true })
      keyText.textContent = '已开始提取密钥：进度在「设置 → 数据库密钥」里。'
    } catch (error) {
      keyButton.disabled = false
      keyText.textContent = `无法开始提取：${error.message}`
    }
  }

  setupDefault.addEventListener('click', () => startSetup('default'))
  setupMirror.addEventListener('click', () => startSetup('tsinghua'))
  keyButton.addEventListener('click', extractKey)
  settingsButton.addEventListener('click', () => {
    hide()
    if (typeof onOpenSettings === 'function') onOpenSettings()
  })
  dismiss.addEventListener('click', hide)

  Promise.all([
    api.get('/api/status').catch(() => null),
    api.get('/api/diagnostics').catch(() => null),
  ]).then(([status, info]) => {
    if (closed) return
    startedAt = Number(status?.startedAt) || 0
    let marker = ''
    try {
      marker = storage?.getItem(STARTUP_KEY) || ''
    } catch {
      marker = ''
    }
    if (!status || !startupNeeded(startedAt, marker)) return
    box.hidden = false
    urlCode.textContent = status?.url || url
    if (info) {
      diagnostics = info
      paint()
    } else {
      envText.classList.add('bad')
      envText.textContent = '环境检查失败：无法读取诊断信息（Python 解释器可能不可用）。'
      setupDefault.hidden = false
      setupMirror.hidden = false
    }
  })

  return () => {
    closed = true
    box.remove()
  }
}
