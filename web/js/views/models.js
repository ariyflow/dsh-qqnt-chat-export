/**
 * Model files and the Python packages the content features need.
 *
 * Two kinds of optional weight live behind this view:
 *
 * - **models** (15–230 MB) in `workDir/models/`, downloaded on demand and
 *   deletable per feature — a user who tries OCR once and moves on should get
 *   the disk back without hunting for a filesystem path;
 * - **components**: `pip` packages installed into the plugin's own virtualenv
 *   (`rapidocr-onnxruntime`, `av` + `sherpa-onnx`, `numpy`/`onnxruntime`/
 *   `tokenizers`). They are shown here because "why does OCR do nothing" is
 *   answered by the same screen as "which model is missing".
 *
 * Deletion is two-step (删除 → 确认删除) because re-downloading is a real cost;
 * installing is one step plus a confirmation in the job panel, because pip is
 * itself the expensive, visible part.
 */

/** `12345678` → `11.8 MB`; the view never shows raw bytes. */
export function formatBytes(value) {
  const bytes = Number(value) || 0
  if (bytes <= 0) return '—'
  const units = ['B', 'KB', 'MB', 'GB']
  let size = bytes
  let unit = 0
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024
    unit += 1
  }
  return `${size >= 10 || unit === 0 ? Math.round(size) : size.toFixed(1)} ${units[unit]}`
}

/** 已安装 / 未安装 / 校验失败, plus the download hint. */
export function modelState(item) {
  if (!item) return '未知'
  if (item.installed && item.intact) return '已安装'
  if (item.installed) return '校验失败'
  return '未安装'
}

export function modelList(payload) {
  return Object.values(payload || {})
    .filter((item) => item && item.id)
    .sort((a, b) => String(a.feature).localeCompare(String(b.feature)))
}

/** The `components` block of `/api/components`; empty when unavailable. */
export function componentList(payload) {
  const items = payload && payload.components && typeof payload.components === 'object'
    ? payload.components
    : {}
  return Object.values(items)
    .filter((item) => item && item.id)
    .sort((a, b) => String(a.id).localeCompare(String(b.id)))
}

/** 已安装 / 缺少 <module> / 需要虚拟环境. */
export function componentState(item) {
  if (!item) return '未知'
  if (item.venv === false) return '需要虚拟环境'
  if (item.installed) return '已安装'
  const missing = Array.isArray(item.missing) ? item.missing : []
  return missing.length > 0 ? `缺少 ${missing.join('、')}` : '未安装'
}

/**
 * @param {HTMLElement} root
 * @param {{api: object}} options
 * @returns {() => void} cleanup
 */
export function mountModels(root, { api }) {
  const section = document.createElement('section')
  section.className = 'models-view'

  const title = document.createElement('h2')
  title.className = 'chat-title'
  title.textContent = '模型与组件'

  const hint = document.createElement('p')
  hint.className = 'hint'
  hint.textContent = '模型文件放在工作目录的 models/ 下，可按功能单独下载和删除；删除不影响索引与聊天记录。'

  const componentsTitle = document.createElement('h3')
  componentsTitle.className = 'models-subtitle'
  componentsTitle.textContent = '运行组件'
  const componentsHint = document.createElement('p')
  componentsHint.className = 'hint'
  componentsHint.textContent = '组件是装进插件虚拟环境的 Python 包，装一次即可；模型文件在下面单独下载。'
  const components = document.createElement('ul')
  components.className = 'components-list'

  const modelsTitle = document.createElement('h3')
  modelsTitle.className = 'models-subtitle'
  modelsTitle.textContent = '模型文件'
  const list = document.createElement('ul')
  list.className = 'models-list'

  section.append(title, hint, componentsTitle, componentsHint, components,
    modelsTitle, list)
  root.append(section)

  let closed = false
  /** id → timestamp of the first click on 删除. */
  const pending = new Map()
  let timer = null

  function componentRow(item) {
    const row = document.createElement('li')
    row.className = 'component-row'

    const name = document.createElement('span')
    name.className = 'component-name'
    name.textContent = item.label

    const info = document.createElement('span')
    info.className = 'component-meta'
    info.textContent = `${componentState(item)} · 约 ${formatBytes(item.expectedBytes)}`

    const actions = document.createElement('span')
    actions.className = 'component-actions'
    if (item.installed) {
      const done = document.createElement('span')
      done.className = 'meta'
      done.textContent = '已安装'
      actions.append(done)
    } else {
      const install = document.createElement('button')
      install.type = 'button'
      install.className = 'ghost'
      install.textContent = '安装'
      install.title = `pip install ${(item.packages || []).join(' ')}`
      if (item.venv === false) {
        install.setAttribute('disabled', 'true')
        install.title = '当前解释器不是虚拟环境；先在设置里创建插件虚拟环境'
      }
      install.addEventListener('click', () => installGroup(item, install))
      actions.append(install)
    }

    row.append(name, info, actions)
    return row
  }

  function rowFor(item) {
    const row = document.createElement('li')
    row.className = 'model-row'

    const name = document.createElement('span')
    name.className = 'model-name'
    name.textContent = `${item.label}（${item.license}）`

    const info = document.createElement('span')
    info.className = 'model-meta'
    info.textContent = `${modelState(item)} · ${formatBytes(item.bytes)} / 约 ${formatBytes(item.expectedBytes)}`

    const actions = document.createElement('span')
    actions.className = 'model-actions'
    if (item.installed) {
      const del = document.createElement('button')
      del.type = 'button'
      del.className = 'ghost'
      const armed = pending.has(item.id) && Date.now() - pending.get(item.id) < 4000
      del.textContent = armed ? '确认删除' : '删除'
      if (armed) del.classList.add('danger')
      del.addEventListener('click', () => remove(item, del))
      actions.append(del)
    } else {
      const get = document.createElement('button')
      get.type = 'button'
      get.className = 'ghost'
      get.textContent = '下载'
      get.addEventListener('click', () => download(item, get))
      actions.append(get)
    }

    row.append(name, info, actions)
    return row
  }

  async function installGroup(item, button) {
    button.setAttribute('disabled', 'true')
    button.textContent = '已加入任务'
    try {
      await api.post('/api/components/install', { groups: [item.id] })
      hint.textContent = `正在后台安装 ${item.label} 组件，进度见右下角任务面板；装完刷新即可。`
    } catch (error) {
      button.removeAttribute('disabled')
      button.textContent = '安装'
      hint.textContent = `安装失败：${error.message}`
    }
  }

  async function remove(item, button) {
    const seen = pending.get(item.id)
    if (!seen || Date.now() - seen > 4000) {
      pending.set(item.id, Date.now())
      button.textContent = '确认删除'
      button.classList.add('danger')
      return
    }
    pending.delete(item.id)
    try {
      const result = await api.remove(`/api/models/${encodeURIComponent(item.id)}`)
      hint.textContent = `已删除 ${item.label}，释放 ${formatBytes(result?.bytes)}`
    } catch (error) {
      hint.textContent = `删除失败：${error.message}`
    }
    await refresh()
  }

  async function download(item, button) {
    button.setAttribute('disabled', 'true')
    button.textContent = '已加入任务'
    try {
      await api.post(`/api/models/${encodeURIComponent(item.id)}/download`)
      hint.textContent = `正在后台下载 ${item.label}，进度见右下角任务面板。`
    } catch (error) {
      button.removeAttribute('disabled')
      button.textContent = '下载'
      hint.textContent = `下载失败：${error.message}`
    }
  }

  async function refresh() {
    if (closed) return
    try {
      const [modelPayload, componentPayload] = await Promise.all([
        api.get('/api/models'),
        // An older helper without the components endpoint must not blank the
        // model list; the components block simply stays empty.
        api.get('/api/components').catch(() => null),
      ])
      if (closed) return
      components.replaceChildren()
      for (const item of componentList(componentPayload)) components.append(componentRow(item))
      list.replaceChildren()
      for (const item of modelList(modelPayload)) list.append(rowFor(item))
      if (componentList(componentPayload).length === 0) {
        componentsTitle.hidden = true
        componentsHint.hidden = true
      }
    } catch (error) {
      hint.textContent = `读取模型状态失败：${error.message}`
    }
  }

  refresh()
  // The two-step delete only holds for a few seconds; re-render so the button
  // does not stay armed after the window closes.
  timer = setInterval(() => {
    if (pending.size === 0) return
    const now = Date.now()
    for (const [id, at] of pending) if (now - at >= 4000) pending.delete(id)
    refresh()
  }, 4000)

  return () => {
    closed = true
    if (timer) clearInterval(timer)
    section.remove()
  }
}
