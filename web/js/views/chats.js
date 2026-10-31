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
 * @param {{api: {get: Function}}} options
 * @returns {() => void} cleanup
 */
export function mountChats(root, { api }) {
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
  const more = document.createElement('button')
  more.type = 'button'
  more.className = 'ghost'
  more.textContent = '载入更早'
  more.hidden = true
  const messages = document.createElement('ol')
  messages.className = 'msg-list'
  main.append(title, messages, more)

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

  async function loadMessages(reset) {
    if (!state.selected) return
    const offset = reset ? 0 : state.offset + state.rows.length
    try {
      const payload = await api.get('/api/messages', {
        chatKind: state.selected.kind,
        chatId: state.selected.id,
        offset,
        limit: PAGE_SIZE,
        order: 'desc',
      })
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

  function select(session) {
    state.selected = session
    state.rows = []
    title.textContent = `${session.name || session.id} · ${sessionMeta(session)}`
    renderList()
    loadMessages(true)
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
      if (state.sessions.length > 0) select(state.sessions[0])
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
