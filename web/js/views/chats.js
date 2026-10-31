/**
 * Session list and message reader.
 *
 * This is the first ported view and the template for the rest: a mount
 * function that owns one container, builds DOM with `textContent` only (chat
 * text is untrusted input), and returns a cleanup function. Pure helpers are
 * exported so they can be tested without a DOM.
 */

/** How many messages one page of the reader asks for. */
export const PAGE_SIZE = 50

/**
 * Filter the session list the way the legacy sidebar does: case-insensitive
 * substring over the display name, the id and the QQ number.
 * @param {Array<object>} sessions
 * @param {string} query
 */
export function filterSessions(sessions, query) {
  const needle = String(query || '').trim().toLowerCase()
  if (needle === '') return sessions
  return sessions.filter((session) => [session.name, session.id, session.qq]
    .some((value) => String(value || '').toLowerCase().includes(needle)))
}

/**
 * Build the secondary line of a session row: kind, message count, last time.
 * @param {object} session
 */
export function sessionMeta(session) {
  const kind = session.kind === 'private' ? '私聊' : '群聊'
  const count = Number(session.messages) || 0
  const when = String(session.lastTime || '').trim()
  return [kind, `${count} 条`, when].filter((part) => part !== '').join(' · ')
}

/** `1700000000` → `2026-10-31 20:03`. */
export function formatClock(epochSeconds) {
  const seconds = Number(epochSeconds)
  if (!Number.isFinite(seconds) || seconds <= 0) return '—'
  const date = new Date(seconds * 1000)
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** One message row; `text` is set as text, never as HTML. */
function messageRow(row) {
  const item = document.createElement('li')
  item.className = 'msg-row'

  const head = document.createElement('div')
  head.className = 'msg-head'

  const who = document.createElement('span')
  who.className = 'msg-sender'
  who.textContent = row.sender || row.qq || '未知'

  const when = document.createElement('span')
  when.className = 'msg-time'
  when.textContent = formatClock(row.ts)

  head.append(who, when)

  // A hit that came from a screenshot or a voice message says so here; without
  // the badge the user would see a keyword match inside text that does not
  // contain the keyword.
  const labels = { ocr: '图片文字', asr: '语音转写' }
  for (const source of Array.isArray(row.sources) ? row.sources : []) {
    const label = labels[source]
    if (!label) continue
    const badge = document.createElement('span')
    badge.className = 'msg-badge'
    badge.textContent = label
    if (row.snippet) badge.setAttribute('title', String(row.snippet))
    head.append(badge)
  }

  const body = document.createElement('p')
  body.className = 'msg-text'
  body.textContent = String(row.text ?? '')

  item.append(head, body)
  return item
}

/**
 * Mount the view.
 *
 * @param {HTMLElement} root - empty container owned by the caller
 * @param {{api: {get: Function}, initial?: {kind: string, id: string, around?: number},
 *   onExport?: (session: object) => void}} options
 *   `initial` opens one chat directly; `around` centers the reader on a message
 *   (used when a citation card is clicked from the answer view); `onExport`
 *   hands the selected chat to the export view.
 * @returns {() => void} cleanup
 */
export function mountChats(root, { api, initial = null, onExport = null }) {
  const shell = document.createElement('div')
  shell.className = 'app-shell'

  const aside = document.createElement('aside')
  aside.className = 'app-sidebar'
  const filter = document.createElement('input')
  filter.type = 'search'
  filter.className = 'chat-filter'
  filter.placeholder = '筛选群名 / 昵称 / 群号 / QQ'
  filter.setAttribute('aria-label', '筛选会话')
  const list = document.createElement('ul')
  list.className = 'chat-list'
  const hint = document.createElement('p')
  hint.className = 'hint'
  hint.textContent = '正在读取会话…'
  aside.append(filter, hint, list)

  const main = document.createElement('section')
  main.className = 'chat-main'
  const title = document.createElement('h2')
  title.className = 'chat-title'
  title.textContent = '选择左侧会话'

  // Cross-chat keyword search. `sources` decides whether recognized text
  // inside images and voice messages participates; both are on by default so
  // the feature is discoverable, and turning them off answers "only what was
  // typed".
  const searchBar = document.createElement('form')
  searchBar.className = 'chat-search'
  const searchInput = document.createElement('input')
  searchInput.type = 'search'
  searchInput.className = 'chat-search-input'
  searchInput.placeholder = '搜索全部会话（回车）'
  searchInput.setAttribute('aria-label', '搜索全部会话')
  const ocrToggle = document.createElement('input')
  ocrToggle.type = 'checkbox'
  ocrToggle.checked = true
  const ocrLabel = document.createElement('label')
  ocrLabel.className = 'chat-search-label'
  ocrLabel.append(ocrToggle, document.createElement('span'))
  ocrLabel.children[1].textContent = '含图片文字'
  const exportButton = document.createElement('button')
  exportButton.type = 'button'
  exportButton.className = 'ghost'
  exportButton.textContent = '导出本会话'
  exportButton.title = '用这个会话打开导出页'
  exportButton.addEventListener('click', () => {
    if (state.selected && typeof onExport === 'function') onExport(state.selected)
    else title.textContent = '先选择一个会话，再导出'
  })
  searchBar.append(searchInput, ocrLabel, exportButton)
  const more = document.createElement('button')
  more.type = 'button'
  more.className = 'ghost'
  more.textContent = '载入更早'
  more.hidden = true
  const messages = document.createElement('ol')
  messages.className = 'msg-list'
  main.append(title, searchBar, messages, more)

  shell.append(aside, main)
  root.append(shell)

  const state = { sessions: [], query: '', selected: null, rows: [], offset: 0, total: 0 }
  let closed = false

  function renderList() {
    const visible = filterSessions(state.sessions, state.query)
    list.replaceChildren()
    hint.textContent = state.sessions.length === 0
      ? '索引里还没有会话：请回到当前界面点「从 QQ 同步」。'
      : `${visible.length} / ${state.sessions.length} 个会话`
    for (const session of visible) {
      const item = document.createElement('li')
      item.className = 'chat-item'
      if (state.selected && state.selected.kind === session.kind
        && state.selected.id === session.id) item.classList.add('is-active')
      const name = document.createElement('span')
      name.className = 'chat-name'
      name.textContent = session.name || session.id
      const meta = document.createElement('span')
      meta.className = 'chat-meta'
      meta.textContent = sessionMeta(session)
      item.append(name, meta)
      item.addEventListener('click', () => select(session))
      list.append(item)
    }
  }

  function renderMessages(reset) {
    if (reset) messages.replaceChildren()
    for (const row of state.rows) messages.append(messageRow(row))
    more.hidden = state.rows.length >= state.total
  }

  async function loadMessages(reset, around = null) {
    if (!state.selected) return
    const offset = reset ? 0 : state.offset + state.rows.length
    const args = {
      chatKind: state.selected.kind,
      chatId: state.selected.id,
      offset,
      limit: PAGE_SIZE,
      order: 'desc',
    }
    if (around) {
      // The helper centres a window on the message; offset and order do not
      // apply to that window, so they are left out rather than sent as noise.
      delete args.offset
      args.around = around
    }
    try {
      const payload = await api.get('/api/messages', args)
      if (closed) return
      const rows = Array.isArray(payload?.rows) ? payload.rows : []
      state.rows = reset ? rows : state.rows.concat(rows)
      state.offset = offset
      state.total = Number(payload?.total) || state.rows.length
      renderMessages(reset)
    } catch (error) {
      if (closed) return
      title.textContent = `读取消息失败：${error.message}`
      more.hidden = true
    }
  }

  async function search(keyword, includeOcr) {
    const args = { keyword, limit: 100, order: 'desc' }
    if (!includeOcr) args.sources = ['text']
    title.textContent = `搜索：${keyword}`
    messages.replaceChildren()
    more.hidden = true
    try {
      const payload = await api.get('/api/messages', args)
      if (closed) return
      const rows = Array.isArray(payload?.rows) ? payload.rows : []
      state.rows = rows
      state.total = Number(payload?.total) || rows.length
      state.selected = null
      title.textContent = rows.length === 0
        ? `没有匹配「${keyword}」的消息`
        : `搜索「${keyword}」· ${state.total} 条（显示最近 ${rows.length} 条）`
      for (const row of rows) {
        const item = messageRow(row)
        if (row.chatName) {
          const chat = document.createElement('span')
          chat.className = 'msg-chat'
          chat.textContent = row.chatName
          item.children[0].append(chat)
        }
        messages.append(item)
      }
    } catch (error) {
      if (!closed) title.textContent = `搜索失败：${error.message}`
    }
  }

  searchBar.addEventListener('submit', (event) => {
    event.preventDefault()
    const keyword = String(searchInput.value || '').trim()
    if (keyword === '') {
      if (state.selected) select(state.selected)
      return
    }
    search(keyword, ocrToggle.checked)
  })

  function select(session, around = null) {
    state.selected = session
    state.rows = []
    title.textContent = `${session.name || session.id} · ${sessionMeta(session)}`
    renderList()
    loadMessages(true, around)
  }

  filter.addEventListener('input', () => {
    state.query = filter.value
    renderList()
  })
  more.addEventListener('click', () => loadMessages(false))

  api.get('/api/sessions')
    .then((payload) => {
      if (closed) return
      state.sessions = Array.isArray(payload?.sessions) ? payload.sessions : []
      renderList()
      const jump = initial && state.sessions.find((session) =>
        session.kind === initial.kind && String(session.id) === String(initial.id))
      if (jump) select(jump, initial.around || null)
      else if (state.sessions.length > 0) select(state.sessions[0])
    })
    .catch((error) => {
      if (closed) return
      hint.textContent = `读取会话失败：${error.message}`
    })

  return () => {
    closed = true
    shell.remove()
  }
}
