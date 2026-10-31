/**
 * Model files: what each one is for, how big it is, and how to delete it.
 *
 * Deleting is the important half of this view. Models are 15–230 MB and live
 * outside the export directory, so "清理存储" would otherwise never reclaim
 * them; a user who tries OCR once and moves on needs a one-click way out.
 *
 * Deletion is two-step (删除 → 确认删除) because the files are not in the npm
 * package and re-downloading 230 MB on a metered connection is a real cost.
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

  const list = document.createElement('ul')
  list.className = 'models-list'

  section.append(title, hint, list)
  root.append(section)

  let closed = false
  /** id → timestamp of the first click on 删除. */
  const pending = new Map()
  let timer = null

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
      const payload = await api.get('/api/models')
      if (closed) return
      const items = modelList(payload)
      list.replaceChildren()
      for (const item of items) list.append(rowFor(item))
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
