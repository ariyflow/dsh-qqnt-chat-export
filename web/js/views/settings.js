/**
 * Settings, key extraction, environment setup, presets, diagnostics, storage.
 *
 * These used to be an overlay in `page.html`; the port splits them into cards
 * inside one view, because a settings dialog that covers the page is exactly
 * the thing that made the old UI feel modal. Every card loads on its own: a
 * broken diagnostics probe must not hide the storage table.
 *
 * Destructive actions are two-step (删除 → 确认删除, 恢复默认 → 确认恢复), and
 * the long ones (key extraction, environment setup) run on the server with
 * their own progress and log, polled here while they run.
 */
import { formatBytes } from './models.js'

export const INSTALLERS = [['auto', '自动（优先 uv）'], ['uv', '只用 uv'], ['pip', '只用 venv + pip']]
export const SEARCH_MODES = [['fts', 'FTS5（快，需重建一次）'], ['like', 'LIKE（兼容性最好）']]

/** Form values → the patch `PUT /api/settings` expects. */
export function settingsPatch(values) {
  const patch = {}
  const port = Number(values?.webPort)
  if (Number.isFinite(port)) patch.webPort = Math.round(port)
  patch.workDir = String(values?.workDir ?? '').trim()
  patch.installer = String(values?.installer ?? 'auto')
  patch.pythonPath = String(values?.pythonPath ?? '').trim()
  patch.tencentRoot = String(values?.tencentRoot ?? '').trim()
  patch.account = String(values?.account ?? '').trim()
  const keep = Number(values?.keepAccountIndexes)
  if (Number.isFinite(keep)) patch.keepAccountIndexes = Math.round(keep)
  patch.searchIndex = String(values?.searchIndex ?? 'fts')
  patch.autoSync = values?.autoSync === true
  const interval = Number(values?.syncIntervalMinutes)
  if (Number.isFinite(interval)) patch.syncIntervalMinutes = Math.round(interval)
  return patch
}

/** `{totalBytes, items}` → one sentence for the storage card. */
export function storageSummary(storage) {
  const items = Array.isArray(storage?.items) ? storage.items : []
  if (items.length === 0) return '没有可清理的明文文件。'
  return `${items.length} 类 · 共 ${formatBytes(storage.totalBytes)}`
}

/** The setup job's one-line state, in Chinese. */
export function setupStateLabel(setup) {
  const state = String(setup?.state || 'idle')
  if (state === 'running') return setup.step ? `正在配置：${setup.step}` : '正在配置…'
  if (state === 'done') return '环境配置完成'
  if (state === 'error') return `配置失败：${setup.error || '未知原因'}`
  return '未运行过一键配置'
}

export function keyStateLabel(job) {
  const state = String(job?.state || 'idle')
  if (state === 'running') return job.step ? `正在提取：${job.step}` : '正在提取…'
  if (state === 'done') return job.key === false ? '没有找到密钥（QQ 是否已登录？）' : '密钥已缓存'
  if (state === 'error') return `提取失败：${job.error || '未知原因'}`
  return '未提取'
}

/**
 * @param {HTMLElement} root
 * @param {{api: object}} options
 * @returns {() => void} cleanup
 */
export function mountSettings(root, { api }) {
  const section = document.createElement('section')
  section.className = 'settings-view'

  const title = document.createElement('h2')
  title.className = 'chat-title'
  title.textContent = '设置'

  const status = document.createElement('p')
  status.className = 'hint'
  status.textContent = '正在读取设置…'

  const runtimeCard = card('运行参数')
  const runtimeForm = document.createElement('form')
  runtimeForm.className = 'settings-form'
  const fields = {
    webPort: numberField('网页端口', 0, 65535),
    workDir: textField('工作目录（留空用默认持久目录）'),
    installer: selectField('环境安装方式', INSTALLERS),
    pythonPath: textField('Python 解释器（留空用默认）'),
    tencentRoot: textField('QQ 数据根目录（留空自动识别）'),
    account: textField('QQ 号（留空自动选择）'),
    keepAccountIndexes: numberField('保留其它账号索引数', 0, 5),
    searchIndex: selectField('搜索索引方式', SEARCH_MODES),
    autoSync: checkField('每小时自动同步'),
    syncIntervalMinutes: numberField('同步间隔（分钟）', 5, 1440),
  }
  for (const [name, field] of Object.entries(fields)) {
    const row = document.createElement('label')
    row.className = 'settings-row'
    const text = document.createElement('span')
    text.textContent = field.label
    row.append(text, field.input)
    runtimeForm.append(row)
  }
  const runtimeActions = document.createElement('div')
  runtimeActions.className = 'settings-actions'
  const save = document.createElement('button')
  save.type = 'submit'
  save.className = 'primary'
  save.textContent = '保存'
  const reset = document.createElement('button')
  reset.type = 'button'
  reset.className = 'ghost danger'
  reset.textContent = '恢复默认'
  const runtimeNote = document.createElement('span')
  runtimeNote.className = 'hint'
  runtimeActions.append(save, reset, runtimeNote)
  runtimeForm.append(runtimeActions)
  runtimeCard.body.append(runtimeForm)

  const keyCard = card('数据库密钥')
  const keyLine = document.createElement('p')
  keyLine.className = 'hint'
  keyLine.textContent = '正在读取密钥状态…'
  const keyButton = document.createElement('button')
  keyButton.type = 'button'
  keyButton.className = 'primary'
  keyButton.textContent = '提取密钥'
  keyButton.title = '从已登录的 QQ 进程内存里取密钥，通常需要 1~3 分钟'
  const keyLog = preLog()
  keyCard.body.append(keyLine, keyButton, keyLog)

  const setupCard = card('运行环境')
  const setupLine = document.createElement('p')
  setupLine.className = 'hint'
  setupLine.textContent = '正在检查 Python 与 sqlcipher3…'
  const setupActions = document.createElement('div')
  setupActions.className = 'settings-actions'
  const setupDefault = document.createElement('button')
  setupDefault.type = 'button'
  setupDefault.className = 'primary'
  setupDefault.textContent = '默认源安装'
  const setupMirror = document.createElement('button')
  setupMirror.type = 'button'
  setupMirror.className = 'ghost'
  setupMirror.textContent = '清华镜像安装'
  setupActions.append(setupDefault, setupMirror)
  const setupLog = preLog()
  setupCard.body.append(setupLine, setupActions, setupLog)

  const presetCard = card('导出预设')
  const presetLine = document.createElement('p')
  presetLine.className = 'hint'
  presetLine.textContent = '预设在导出页保存；这里可以查看与删除。'
  const presetList = document.createElement('div')
  presetList.className = 'preset-list'
  presetCard.body.append(presetLine, presetList)

  const diagCard = card('诊断')
  const diagGrid = document.createElement('div')
  diagGrid.className = 'diag-grid'
  const diagActions = document.createElement('div')
  diagActions.className = 'settings-actions'
  const diagDownload = document.createElement('a')
  diagDownload.className = 'ghost'
  diagDownload.href = '/api/diagnostics/bundle'
  diagDownload.textContent = '下载诊断包'
  const diagNote = document.createElement('span')
  diagNote.className = 'hint'
  diagNote.textContent = '路径只留末段，账号做哈希，不含聊天内容与密钥。'
  diagActions.append(diagDownload, diagNote)
  diagCard.body.append(diagGrid, diagActions)

  const storageCard = card('存储与清理')
  const storageLine = document.createElement('p')
  storageLine.className = 'hint'
  storageLine.textContent = '正在读取体积…'
  const storageList = document.createElement('div')
  storageList.className = 'storage-list'
  const storageActions = document.createElement('div')
  storageActions.className = 'settings-actions'
  const storageRefresh = document.createElement('button')
  storageRefresh.type = 'button'
  storageRefresh.className = 'ghost'
  storageRefresh.textContent = '刷新大小'
  const cleanupButton = document.createElement('button')
  cleanupButton.type = 'button'
  cleanupButton.className = 'danger'
  cleanupButton.textContent = '删除选中'
  cleanupButton.disabled = true
  const storageNote = document.createElement('span')
  storageNote.className = 'hint'
  storageActions.append(storageRefresh, cleanupButton, storageNote)
  storageCard.body.append(storageLine, storageList, storageActions)

  section.append(title, status, runtimeCard.node, keyCard.node, setupCard.node,
    presetCard.node, diagCard.node, storageCard.node)
  root.append(section)

  let closed = false
  let timer = null
  let armed = false
  let armedAt = 0
  const storageChecks = new Map()
  let presets = []

  function card(heading) {
    const node = document.createElement('section')
    node.className = 'card settings-card'
    const head = document.createElement('h3')
    head.textContent = heading
    const body = document.createElement('div')
    body.className = 'card-body'
    node.append(head, body)
    return { node, body }
  }

  function textField(label) {
    const input = document.createElement('input')
    input.type = 'text'
    input.spellcheck = false
    return { label, input }
  }

  function numberField(label, min, max) {
    const input = document.createElement('input')
    input.type = 'number'
    input.min = String(min)
    input.max = String(max)
    return { label, input }
  }

  function selectField(label, options) {
    const input = document.createElement('select')
    for (const [value, text] of options) {
      const option = document.createElement('option')
      option.value = value
      option.textContent = text
      input.append(option)
    }
    return { label, input }
  }

  function checkField(label) {
    const input = document.createElement('input')
    input.type = 'checkbox'
    return { label, input }
  }

  function preLog() {
    const pre = document.createElement('pre')
    pre.className = 'setup-log'
    pre.hidden = true
    return pre
  }

  function values() {
    return {
      webPort: fields.webPort.input.value,
      workDir: fields.workDir.input.value,
      installer: fields.installer.input.value,
      pythonPath: fields.pythonPath.input.value,
      tencentRoot: fields.tencentRoot.input.value,
      account: fields.account.input.value,
      keepAccountIndexes: fields.keepAccountIndexes.input.value,
      searchIndex: fields.searchIndex.input.value,
      autoSync: fields.autoSync.input.checked,
      syncIntervalMinutes: fields.syncIntervalMinutes.input.value,
    }
  }

  function fill(settings) {
    fields.webPort.input.value = String(settings.webPort ?? '')
    fields.workDir.input.value = String(settings.workDir ?? '')
    fields.installer.input.value = String(settings.installer ?? 'auto')
    fields.pythonPath.input.value = String(settings.pythonPath ?? '')
    fields.tencentRoot.input.value = String(settings.tencentRoot ?? '')
    fields.account.input.value = String(settings.account ?? '')
    fields.keepAccountIndexes.input.value = String(settings.keepAccountIndexes ?? 2)
    fields.searchIndex.input.value = String(settings.searchIndex ?? 'fts')
    fields.autoSync.input.checked = settings.autoSync !== false
    fields.syncIntervalMinutes.input.value = String(settings.syncIntervalMinutes ?? 60)
  }

  async function loadSettings() {
    try {
      const payload = await api.get('/api/settings')
      if (closed) return
      fill(payload?.settings || {})
      status.textContent = payload?.file
        ? `设置文件：${payload.file}`
        : '设置保存在插件自己的配置目录。'
    } catch (error) {
      if (!closed) status.textContent = `读取设置失败：${error.message}`
    }
  }

  async function saveSettings(event) {
    if (event && typeof event.preventDefault === 'function') event.preventDefault()
    save.disabled = true
    try {
      await api.put('/api/settings', settingsPatch(values()))
      runtimeNote.textContent = '已保存；端口与工作目录的改动在下次启动时生效。'
      await loadSettings()
    } catch (error) {
      runtimeNote.textContent = `保存失败：${error.message}`
    } finally {
      save.disabled = false
    }
  }

  async function resetSettings() {
    const now = Date.now()
    if (!armed || now - armedAt > 4000) {
      armed = true
      armedAt = now
      reset.textContent = '确认恢复'
      return
    }
    armed = false
    reset.textContent = '恢复默认'
    try {
      await api.post('/api/settings/reset')
      runtimeNote.textContent = '已恢复默认设置。'
      await loadSettings()
    } catch (error) {
      runtimeNote.textContent = `恢复失败：${error.message}`
    }
  }

  async function loadKey() {
    try {
      const job = await api.get('/api/key/extract')
      if (closed) return
      keyLine.textContent = keyStateLabel(job)
      const lines = Array.isArray(job?.log) ? job.log : []
      keyLog.hidden = lines.length === 0
      keyLog.textContent = lines.slice(-40).join('\n')
      keyButton.disabled = job?.state === 'running'
      if (job?.state === 'running') schedule(loadKey, 1500)
    } catch (error) {
      if (!closed) keyLine.textContent = `读取密钥状态失败：${error.message}`
    }
  }

  async function extractKey() {
    keyButton.disabled = true
    keyLine.textContent = '已开始提取：查找密钥通常需要 1~3 分钟，请保持 QQ 登录。'
    try {
      await api.post('/api/key/extract', { confirm: true, force: true })
      schedule(loadKey, 800)
    } catch (error) {
      keyButton.disabled = false
      keyLine.textContent = `无法开始提取：${error.message}`
    }
  }

  async function loadSetup() {
    try {
      const payload = await api.get('/api/setup')
      if (closed) return
      setupLine.textContent = [
        setupStateLabel(payload),
        payload?.python ? `解释器：${payload.python}` : '',
        payload?.engine ? `引擎：${payload.engine}` : '',
      ].filter((part) => part !== '').join(' · ')
      const lines = Array.isArray(payload?.log) ? payload.log : []
      setupLog.hidden = lines.length === 0
      setupLog.textContent = lines.slice(-60).join('\n')
      const running = payload?.state === 'running'
      setupDefault.disabled = running
      setupMirror.disabled = running
      if (running) schedule(loadSetup, 1500)
    } catch (error) {
      if (!closed) setupLine.textContent = `读取环境状态失败：${error.message}`
    }
  }

  async function startSetup(source) {
    setupDefault.disabled = true
    setupMirror.disabled = true
    try {
      await api.post('/api/setup/venv', { confirm: true, source })
      schedule(loadSetup, 800)
    } catch (error) {
      setupLine.textContent = `无法开始配置：${error.message}`
      setupDefault.disabled = false
      setupMirror.disabled = false
    }
  }

  async function loadPresets() {
    try {
      const payload = await api.get('/api/presets')
      if (closed) return
      presets = Array.isArray(payload?.presets) ? payload.presets : []
      presetList.replaceChildren()
      if (presets.length === 0) {
        const empty = document.createElement('span')
        empty.className = 'hint'
        empty.textContent = '还没有预设；在导出页点「存为预设」。'
        presetList.append(empty)
        return
      }
      for (const item of presets) {
        const row = document.createElement('div')
        row.className = 'preset-row'
        const name = document.createElement('span')
        name.className = 'preset-name'
        name.textContent = `${item.name} · ${String(item.format).toUpperCase()}`
        const detail = document.createElement('span')
        detail.className = 'preset-meta'
        detail.textContent = [
          item.redact ? '脱敏' : '', item.media ? '媒体' : '',
          item.split ? '按天' : '', item.frontMatter ? 'MD 元信息' : '',
        ].filter((part) => part !== '').join(' · ') || '无额外选项'
        const remove = document.createElement('button')
        remove.type = 'button'
        remove.className = 'ghost danger'
        remove.textContent = '删除'
        remove.addEventListener('click', async () => {
          const remaining = presets.filter((entry) => entry !== item)
          try {
            await api.post('/api/presets', { presets: remaining })
            await loadPresets()
          } catch (error) {
            presetLine.textContent = `删除失败：${error.message}`
          }
        })
        row.append(name, detail, remove)
        presetList.append(row)
      }
    } catch (error) {
      presetLine.textContent = `读取预设失败：${error.message}`
    }
  }

  async function loadDiagnostics() {
    try {
      const payload = await api.get('/api/diagnostics')
      if (closed) return
      diagGrid.replaceChildren()
      const rows = [
        ['插件版本', payload?.pluginVersion],
        ['Python', `${payload?.python || ''} ${payload?.version || ''}`.trim()],
        ['sqlcipher3', payload?.sqlcipher3 ? '可用' : '缺失'],
        ['平台', payload?.platform],
        ['密钥', payload?.key ? '已缓存' : '未提取'],
        ['索引', payload?.index ? '已建立' : '未建立'],
        ['venv', payload?.venv?.python],
        ['infoError', payload?.infoError],
      ]
      for (const [label, value] of rows) {
        if (value === undefined || value === '' || value === null) continue
        const key = document.createElement('span')
        key.className = 'diag-key'
        key.textContent = label
        const text = document.createElement('span')
        text.className = 'diag-value'
        text.textContent = String(value)
        diagGrid.append(key, text)
      }
    } catch (error) {
      diagNote.textContent = `读取诊断失败：${error.message}`
    }
  }

  async function loadStorage() {
    try {
      const payload = await api.get('/api/storage')
      if (closed) return
      storageChecks.clear()
      storageList.replaceChildren()
      storageLine.textContent = storageSummary(payload)
      for (const item of payload?.items || []) {
        const row = document.createElement('label')
        row.className = 'storage-row'
        const check = document.createElement('input')
        check.type = 'checkbox'
        check.dataset.id = item.id
        check.addEventListener('change', () => {
          if (check.checked) storageChecks.set(item.id, check)
          else storageChecks.delete(item.id)
          cleanupButton.disabled = storageChecks.size === 0
        })
        const name = document.createElement('span')
        name.className = 'storage-name'
        name.textContent = item.label
        const detail = document.createElement('span')
        detail.className = 'storage-detail'
        detail.textContent = `${formatBytes(item.bytes)} · ${item.detail || ''}`
        row.append(check, name, detail)
        storageList.append(row)
      }
      if ((payload?.items || []).length === 0) {
        const empty = document.createElement('span')
        empty.className = 'hint'
        empty.textContent = '没有可清理的明文文件。'
        storageList.append(empty)
      }
    } catch (error) {
      storageLine.textContent = `读取体积失败：${error.message}`
    }
  }

  let cleanupArmed = 0
  async function cleanup() {
    const ids = [...storageChecks.keys()]
    if (ids.length === 0) return
    const now = Date.now()
    if (now - cleanupArmed > 4000) {
      cleanupArmed = now
      cleanupButton.textContent = '确认删除'
      storageNote.textContent = '删除后密钥需要重新提取，索引需要重建。'
      return
    }
    cleanupArmed = 0
    cleanupButton.textContent = '删除选中'
    cleanupButton.disabled = true
    try {
      const result = await api.post('/api/storage/cleanup', { confirm: true, ids })
      storageNote.textContent = `已删除 ${result?.removed ?? 0} 项，释放 ${formatBytes(result?.freedBytes)}`
      await loadStorage()
    } catch (error) {
      storageNote.textContent = `删除失败：${error.message}`
    }
  }

  /** One-shot delayed refresh; polling stops as soon as the job is not running. */
  function schedule(fn, ms) {
    if (closed) return
    setTimeout(() => { if (!closed) fn() }, ms)
  }

  runtimeForm.addEventListener('submit', saveSettings)
  reset.addEventListener('click', resetSettings)
  keyButton.addEventListener('click', extractKey)
  setupDefault.addEventListener('click', () => startSetup('default'))
  setupMirror.addEventListener('click', () => startSetup('tsinghua'))
  cleanupButton.addEventListener('click', cleanup)
  storageRefresh.addEventListener('click', loadStorage)

  loadSettings()
  loadKey()
  loadSetup()
  loadPresets()
  loadDiagnostics()
  loadStorage()
  timer = setInterval(() => {
    if (closed) return
  }, 5000)

  return () => {
    closed = true
    if (timer) clearInterval(timer)
    section.remove()
  }
}
