/**
 * Export, as a page rather than a toolbar squeezed next to the search box.
 *
 * The legacy page packed format, redaction, media, split, password, CSV columns
 * and Markdown front matter into one row of tiny selects; the port gives each
 * option a label and keeps the two derived rules visible:
 *
 * - **bundle becomes ZIP**: more than one chat, media, day-split or a password
 *   means the download is a ZIP no matter which inner format was picked;
 * - **inline images are one HTML**: `embed` forbids a bundle, a password and a
 *   split, so the form disables them instead of failing on submit.
 *
 * The export itself runs as a background job (`kind: 'export'`): the table
 * polls `/api/jobs?kind=export`, offers cancel while it runs, and links to
 * `/api/jobs/<id>/download` when done.
 */
import { formatBytes } from './models.js'

export const EXPORT_FORMATS = ['txt', 'csv', 'json', 'md', 'html', 'sqlite']
export const CSV_COLUMNS = [
  ['time', '时间'], ['sender', '发送者'], ['qq', 'QQ'], ['direction', '方向'],
  ['kinds', '类型'], ['text', '正文'],
]
export const REDACT_OPTIONS = [['', '不脱敏'], ['names', '昵称打码'], ['qq', 'QQ 打码'], ['all', '全部打码']]

/** What the download will be: a single file, or a bundle because of an option. */
export function containerFor(state) {
  const format = String(state?.format || 'txt')
  if (state?.embed) return format
  const bundled = Number(state?.chatCount || 0) > 1
    || state?.media === true || state?.split === true || String(state?.password || '') !== ''
  return bundled ? 'zip' : format
}

/**
 * The body `POST /api/export` expects, from the form's current state.
 * @param {object} state
 */
export function exportBody(state) {
  const body = {
    format: String(state?.format || 'txt'),
    redact: String(state?.redact || ''),
  }
  // One chat is a filter (and a plain file); several are a batch (and a ZIP).
  const chats = Array.isArray(state?.chats) ? state.chats : []
  if (chats.length > 1) {
    body.chats = chats.slice()
  } else {
    const single = chats.length === 1 ? chats[0] : state?.chat
    if (single) {
      body.chatKind = single.kind
      body.chatId = single.id
    }
  }
  if (String(state?.keyword || '').trim() !== '') body.keyword = String(state.keyword).trim()
  if (String(state?.sender || '').trim() !== '') body.sender = String(state.sender).trim()
  if (String(state?.since || '').trim() !== '') body.since = String(state.since).trim()
  if (String(state?.until || '').trim() !== '') body.until = String(state.until).trim()
  if (state?.media === true) body.media = true
  if (state?.embed === true) body.embed = true
  if (state?.split === true) body.split = 'day'
  if (String(state?.password || '') !== '') body.password = String(state.password)
  if (body.format === 'csv' && Array.isArray(state?.columns) && state.columns.length > 0) {
    body.columns = state.columns.slice()
  }
  if (body.format === 'md' && state?.frontMatter === true) body.frontMatter = true
  if (state?.label) body.label = String(state.label)
  return body
}

/** 中文状态 for a job row. */
export function jobStateLabel(job) {
  const state = String(job?.state || '')
  if (state === 'queued') return '排队中'
  if (state === 'running') {
    const percent = Math.round((Number(job?.progress) || 0) * 100)
    return percent > 0 ? `导出中 ${percent}%` : '导出中'
  }
  if (state === 'done') {
    const rows = Number(job?.result?.rows) || 0
    const bytes = Number(job?.result?.bytes) || 0
    const encrypted = job?.result?.encrypted === true ? ' · 加密' : ''
    const media = job?.result?.media?.files ? ` · 媒体 ${job.result.media.files} 个` : ''
    return `${rows} 条 · ${formatBytes(bytes)}${media}${encrypted}`
  }
  if (state === 'failed') return '失败'
  if (state === 'canceled') return '已取消'
  if (state === 'interrupted') return '上次运行被中断'
  return '—'
}

export function downloadHref(job) {
  if (!job || job.state !== 'done') return ''
  return `/api/jobs/${encodeURIComponent(job.id)}/download`
}

/**
 * @param {HTMLElement} root
 * @param {{api: object, initialChat?: object}} options
 * @returns {() => void} cleanup
 */
export function mountExport(root, { api, initialChat = null, initialChats = null }) {
  const section = document.createElement('section')
  section.className = 'export-view'

  const title = document.createElement('h2')
  title.className = 'chat-title'
  title.textContent = '导出'

  const form = document.createElement('form')
  form.className = 'export-form'

  const chatSelect = document.createElement('select')
  chatSelect.className = 'export-chat'
  chatSelect.setAttribute('aria-label', '导出范围')
  const allOption = document.createElement('option')
  allOption.value = ''
  allOption.textContent = '全部会话（按筛选条件）'
  chatSelect.append(allOption)

  const keyword = document.createElement('input')
  keyword.type = 'search'
  keyword.className = 'export-keyword'
  keyword.placeholder = '关键词（可留空）'
  const sender = document.createElement('input')
  sender.type = 'search'
  sender.className = 'export-sender'
  sender.placeholder = '发送者 / QQ'
  const since = document.createElement('input')
  since.type = 'date'
  since.className = 'export-since'
  const until = document.createElement('input')
  until.type = 'date'
  until.className = 'export-until'

  const format = document.createElement('select')
  format.className = 'export-format'
  for (const name of EXPORT_FORMATS) {
    const option = document.createElement('option')
    option.value = name
    option.textContent = name.toUpperCase()
    format.append(option)
  }

  const preset = document.createElement('select')
  preset.className = 'export-preset'
  const presetEmpty = document.createElement('option')
  presetEmpty.value = ''
  presetEmpty.textContent = '导出预设…'
  preset.append(presetEmpty)

  const redact = document.createElement('select')
  redact.className = 'export-redact'
  for (const [value, label] of REDACT_OPTIONS) {
    const option = document.createElement('option')
    option.value = value
    option.textContent = label
    redact.append(option)
  }

  const media = document.createElement('input')
  media.type = 'checkbox'
  const split = document.createElement('input')
  split.type = 'checkbox'
  const embed = document.createElement('input')
  embed.type = 'checkbox'
  const frontMatter = document.createElement('input')
  frontMatter.type = 'checkbox'
  const password = document.createElement('input')
  password.type = 'password'
  password.className = 'export-password'
  password.placeholder = 'ZIP 密码（可选，4~128 位）'

  const columns = document.createElement('span')
  columns.className = 'export-columns'
  const columnBoxes = CSV_COLUMNS.map(([value, label]) => {
    const box = document.createElement('input')
    box.type = 'checkbox'
    box.checked = true
    box.dataset.column = value
    const wrap = document.createElement('label')
    wrap.className = 'check'
    const text = document.createElement('span')
    text.textContent = label
    wrap.append(box, text)
    columns.append(wrap)
    return { value, box }
  })

  const submit = document.createElement('button')
  submit.type = 'submit'
  submit.className = 'primary'
  submit.textContent = '开始导出'

  const savePreset = document.createElement('button')
  savePreset.type = 'button'
  savePreset.className = 'ghost'
  savePreset.textContent = '存为预设'

  const derived = document.createElement('p')
  derived.className = 'hint export-derived'

  const row1 = document.createElement('div')
  row1.className = 'export-row'
  row1.append(chatSelect, keyword, sender, since, until)
  const row2 = document.createElement('div')
  row2.className = 'export-row'
  const mediaLabel = labelWrap(media, '含媒体')
  const splitLabel = labelWrap(split, '按天分文件')
  const embedLabel = labelWrap(embed, '内嵌图片')
  const frontLabel = labelWrap(frontMatter, 'MD 元信息')
  row2.append(format, preset, redact, mediaLabel, splitLabel, embedLabel, password)
  const row3 = document.createElement('div')
  row3.className = 'export-row'
  row3.append(columns, frontLabel, submit, savePreset)

  form.append(row1, row2, row3, derived)

  const tasksTitle = document.createElement('h3')
  tasksTitle.className = 'models-subtitle'
  tasksTitle.textContent = '导出任务'
  const status = document.createElement('p')
  status.className = 'hint'
  status.textContent = '正在读取任务…'
  const tasks = document.createElement('ul')
  tasks.className = 'export-tasks'

  section.append(title, form, tasksTitle, status, tasks)
  root.append(section)

  const sessions = []
  const state = {
    chat: initialChat ? { kind: initialChat.kind, id: initialChat.id, label: initialChat.name || '' } : null,
    chats: Array.isArray(initialChats) ? initialChats.slice() : [],
    presets: [],
    lastJobId: '',
  }
  let closed = false
  let timer = null

  function labelWrap(box, text) {
    const wrap = document.createElement('label')
    wrap.className = 'check'
    const label = document.createElement('span')
    label.textContent = text
    wrap.append(box, label)
    return wrap
  }

  function syncDerived() {
    // Derivation is explained rather than silently applied: a user who picks
    // CSV + media should see why the download is a ZIP.
    const chats = state.chats.length > 0 ? state.chats.length : (state.chat ? 1 : 0)
    const container = containerFor({
      format: format.value,
      chatCount: chats,
      media: media.checked,
      split: split.checked,
      password: password.value,
      embed: embed.checked,
    })
    const embedOn = embed.checked
    media.disabled = embedOn
    split.disabled = embedOn
    password.disabled = embedOn
    // Disabling a control does not clear it, and `currentBody()` reads the
    // value anyway: without this, picking 内嵌图片 with 按天 or a password
    // already set submits the combination the server rejects.
    if (embedOn) {
      media.checked = false
      split.checked = false
      password.value = ''
    }
    chatSelect.disabled = false
    derived.textContent = container === 'zip'
      ? `下载：ZIP（内部 ${String(format.value).toUpperCase()}）`
      : `下载：${String(format.value).toUpperCase()}`
    columns.hidden = format.value !== 'csv'
    frontLabel.hidden = format.value !== 'md'
  }

  function currentBody() {
    const chat = state.chats.length > 0 ? null : state.chat
    const chats = state.chats.length > 0 ? state.chats : null
    return exportBody({
      format: format.value,
      redact: redact.value,
      chat,
      chats,
      chatCount: state.chats.length > 0 ? state.chats.length : (chat ? 1 : 0),
      keyword: keyword.value,
      sender: sender.value,
      since: since.value,
      until: until.value,
      media: media.checked,
      split: split.checked,
      embed: embed.checked,
      frontMatter: frontMatter.checked,
      password: password.value,
      columns: columnBoxes.filter((item) => item.box.checked).map((item) => item.value),
      label: state.chats.length > 0
        ? `批量导出 ${state.chats.length} 个会话`
        : (chat ? chat.label : ''),
    })
  }

  async function run(event) {
    if (event && typeof event.preventDefault === 'function') event.preventDefault()
    submit.disabled = true
    status.textContent = '正在提交…'
    try {
      const job = await api.post('/api/export', currentBody())
      state.lastJobId = job.id
      await refresh()
      status.textContent = '已加入导出队列，完成后可在这里下载。'

    } catch (error) {
      status.textContent = `导出失败：${error.message}`
    } finally {
      submit.disabled = false
    }
  }

  function taskRow(job) {
    const row = document.createElement('li')
    row.className = 'export-task'
    row.classList.add(`is-${job.state}`)

    const name = document.createElement('span')
    name.className = 'export-task-name'
    name.textContent = job.summary || '导出'
    const info = document.createElement('span')
    info.className = 'export-task-meta'
    info.textContent = jobStateLabel(job)

    const actions = document.createElement('span')
    actions.className = 'export-task-actions'
    const href = downloadHref(job)
    if (href) {
      const link = document.createElement('a')
      link.href = href
      link.textContent = '下载'
      link.className = 'ghost'
      actions.append(link)
    } else if (job.canCancel) {
      const cancel = document.createElement('button')
      cancel.type = 'button'
      cancel.className = 'ghost'
      cancel.textContent = '取消'
      cancel.addEventListener('click', async () => {
        try {
          await api.post(`/api/jobs/${encodeURIComponent(job.id)}/cancel`)
        } catch (error) {
          status.textContent = `取消失败：${error.message}`
        }
        await refresh()
      })
      actions.append(cancel)
    }
    if (job.state === 'failed' || job.state === 'interrupted' || job.state === 'canceled') {
      const retry = document.createElement('button')
      retry.type = 'button'
      retry.className = 'ghost'
      retry.textContent = '重试'
      retry.addEventListener('click', async () => {
        try {
          await api.post(`/api/jobs/${encodeURIComponent(job.id)}/retry`)
        } catch (error) {
          status.textContent = `重试失败：${error.message}`
        }
        await refresh()
      })
      actions.append(retry)
    }

    row.append(name, info, actions)
    return row
  }

  async function refresh() {
    if (closed) return
    try {
      const payload = await api.get('/api/jobs', { kind: 'export' })
      if (closed) return
      const list = Array.isArray(payload?.jobs) ? payload.jobs : []
      status.textContent = list.length === 0
        ? '还没有导出任务。'
        : `${list.length} 个任务（导出文件只保留一小时）`
      tasks.replaceChildren(...list.map(taskRow))
    } catch (error) {
      if (!closed) status.textContent = `读取任务失败：${error.message}`
    }
  }

  async function loadOptions() {
    try {
      const payload = await api.get('/api/sessions')
      if (closed) return
      for (const session of payload?.sessions || []) {
        sessions.push(session)
        const option = document.createElement('option')
        option.value = `${session.kind}:${session.id}`
        option.textContent = session.name || session.id
        chatSelect.append(option)
      }
      if (state.chats.length > 0) {
        const batch = document.createElement('option')
        batch.value = '__batch__'
        batch.textContent = `已选 ${state.chats.length} 个会话（批量导出）`
        chatSelect.append(batch)
        chatSelect.value = '__batch__'
      } else if (state.chat) {
        chatSelect.value = `${state.chat.kind}:${state.chat.id}`
      }
    } catch {
      // The picker stays with "all chats"; filtering still works.
    }
    try {
      const payload = await api.get('/api/presets')
      if (closed) return
      state.presets = Array.isArray(payload?.presets) ? payload.presets : []
      for (const item of state.presets) {
        const option = document.createElement('option')
        option.value = item.name
        option.textContent = item.name
        option.dataset.preset = JSON.stringify(item)
        preset.append(option)
      }
    } catch {
      // No presets file yet.
    }
  }

  async function storePreset() {
    if (typeof window === 'undefined' || typeof window.prompt !== 'function') return
    const name = window.prompt('预设名字（例如「CSV 只要时间与正文」）', '')
    if (!name || String(name).trim() === '') return
    const preset = {
      name: String(name).trim().slice(0, 40),
      format: format.value,
      redact: redact.value,
      media: media.checked,
      embed: embed.checked,
      split: split.checked ? 'day' : '',
      frontMatter: frontMatter.checked,
      columns: columnBoxes.filter((item) => item.box.checked).map((item) => item.value),
    }
    try {
      const payload = await api.post('/api/presets', {
        presets: [...state.presets, preset],
      })
      state.presets = Array.isArray(payload?.presets) ? payload.presets : state.presets
      const option = document.createElement('option')
      option.value = preset.name
      option.textContent = preset.name
      option.dataset.preset = JSON.stringify(preset)
      preset.append(option)
      derived.textContent = `已保存预设「${preset.name}」`
    } catch (error) {
      derived.textContent = `保存预设失败：${error.message}`
    }
  }

  chatSelect.addEventListener('change', () => {
    const value = String(chatSelect.value || '')
    if (value === '') {
      state.chat = null
      state.chats = []
    } else if (value === '__batch__') {
      state.chat = null
    } else {
      state.chats = []
      const index = value.indexOf(':')
      const kind = value.slice(0, index)
      const id = value.slice(index + 1)
      const found = sessions.find((session) => session.kind === kind && String(session.id) === id)
      state.chat = { kind, id, label: found?.name || '' }
    }
    syncDerived()
  })

  preset.addEventListener('change', () => {
    const option = [...(preset.children || [])].find((child) => child.value === preset.value)
    if (!option || !option.dataset?.preset) return
    try {
      const item = JSON.parse(option.dataset.preset)
      format.value = item.format || 'txt'
      redact.value = item.redact || ''
      media.checked = item.media === true
      embed.checked = item.embed === true
      split.checked = item.split === 'day'
      frontMatter.checked = item.frontMatter === true
      if (item.format === 'csv' && Array.isArray(item.columns)) {
        for (const entry of columnBoxes) entry.box.checked = item.columns.includes(entry.value)
      }
      syncDerived()
    } catch {
      // A hand-edited preset that is not JSON is ignored.
    }
  })

  for (const box of [media, split, embed, frontMatter]) {
    box.addEventListener('change', syncDerived)
  }
  format.addEventListener('change', syncDerived)
  password.addEventListener('input', syncDerived)
  form.addEventListener('submit', run)
  savePreset.addEventListener('click', storePreset)

  syncDerived()
  loadOptions().then(refresh)
  refresh()
  timer = setInterval(refresh, 2000)

  return () => {
    closed = true
    if (timer) clearInterval(timer)
    section.remove()
  }
}
