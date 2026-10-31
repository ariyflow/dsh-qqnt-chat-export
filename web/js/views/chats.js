/**
 * Session list and message reader.
 *
 * This is the first ported view and the template for the rest: a mount
 * function that owns one container, builds DOM with `textContent` only (chat
 * text is untrusted input), and returns a cleanup function. Pure helpers are
 * exported so they can be tested without a DOM.
 *
 * The list is also where per-chat display state lives: aliases, pinning and
 * hiding are stored server-side (`chats-state.json`, display only), while saved
 * searches and the keyword history are browser-side (`localStorage`). Nothing
 * here changes the QQ data or the index.
 */

/** How many messages one page of the reader asks for. */
export const PAGE_SIZE = 50
/** Saved searches kept per browser. */
export const MAX_SAVED = 30
/** Keyword history kept per browser. */
export const MAX_HISTORY = 20

const SAVED_KEY = 'qqnt.savedSearches'
const HISTORY_KEY = 'qqnt.keywordHistory'

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

/** The query shape a saved search keeps; chat is `{kind, id, name}` or null. */
export function savedFromState(state) {
  return {
    savedAt: Date.now(),
    query: String(state?.query || ''),
    keyword: String(state?.keyword || ''),
    sender: String(state?.sender || ''),
    since: String(state?.since || ''),
    until: String(state?.until || ''),
    chat: state?.chat || null,
  }
}

/** One line describing a saved search, used in the list. */
export function savedLabel(saved) {
  const parts = []
  if (saved.chat) parts.push(saved.chat.name || saved.chat.id)
  if (saved.keyword) parts.push(`关键词「${saved.keyword}」`)
  if (saved.sender) parts.push(`发送者「${saved.sender}」`)
  if (saved.since || saved.until) parts.push(`${saved.since || '…'} → ${saved.until || '…'}`)
  return parts.join(' · ') || '全部会话'
}

/**
 * Read a JSON list from storage, tolerating a missing/blocked storage and a
 * hand-edited value (a broken list must not take the page down).
 * @param {Storage|null} storage
 * @param {string} key
 */
export function readList(storage, key) {
  try {
    const value = JSON.parse(storage.getItem(key) || '[]')
    return Array.isArray(value) ? value : []
  } catch {
    return []
  }
}

export function writeList(storage, key, rows) {
  try {
    storage.setItem(key, JSON.stringify(rows))
  } catch {
    // Private mode or a full quota: the list is a convenience, not state.
  }
}

/** Push a keyword onto the front of the history, de-duplicated and capped. */
export function pushHistory(rows, keyword) {
  const text = String(keyword || '').trim()
  if (text === '') return rows
  return [text, ...rows.filter((item) => item !== text)].slice(0, MAX_HISTORY)
}

/** Key of one saved search, so the same filter combination is kept once. */
function savedKey(saved) {
  return [saved.chat ? `${saved.chat.kind}:${saved.chat.id}` : '',
    saved.keyword, saved.sender, saved.since, saved.until].join('|')
}

/** Keep one saved search per identical filter combination, newest first. */
export function pushSaved(rows, saved) {
  const key = savedKey(saved)
  return [saved, ...rows.filter((item) => savedKey(item) !== key)].slice(0, MAX_SAVED)
}

/**
 * One message row; `text` is set as text, never as HTML.
 *
 * `row.imageSeq` is the first downloaded image of the message: the thumbnail
 * is loaded from `/api/media/<rowId>?seq=…&thumb=1`, and clicking it opens the
 * original. A message whose media was cleaned up simply has no `imageSeq`.
 */
function messageRow(row, { onOpenMedia = null } = {}) {
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

  if (row.imageSeq !== undefined && row.rowId !== undefined) {
    const thumb = document.createElement('img')
    thumb.className = 'msg-thumb'
    thumb.loading = 'lazy'
    thumb.alt = '图片'
    thumb.src = `/api/media/${Number(row.rowId)}?seq=${Number(row.imageSeq)}&thumb=1`
    thumb.addEventListener('click', () => {
      if (typeof onOpenMedia === 'function') onOpenMedia(Number(row.rowId), Number(row.imageSeq))
    })
    item.append(thumb)
  }
  return item
}

/** A small text button used for pin/rename/hide on a session row. */
function actionButton(text, handler) {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'ghost chat-action'
  button.textContent = text
  button.addEventListener('click', (event) => {
    if (event && typeof event.stopPropagation === 'function') event.stopPropagation()
    handler()
  })
  return button
}

/**
 * Mount the view.
 *
 * @param {HTMLElement} root - empty container owned by the caller
 * @param {{api: {get: Function, post: Function}, initial?: {kind: string, id: string, around?: number},
 *   onExport?: (session: object) => void, onExportBatch?: (chats: object[]) => void}} options
 * @returns {() => void} cleanup
 */
export function mountChats(root, { api, initial = null, onExport = null, onExportBatch = null }) {
  const shell = document.createElement('div')
  shell.className = 'app-shell'

  const aside = document.createElement('aside')
  aside.className = 'app-sidebar'
  const filter = document.createElement('input')
  filter.type = 'search'
  filter.className = 'chat-filter'
  filter.placeholder = '筛选群名 / 昵称 / 群号 / QQ'
  filter.setAttribute('aria-label', '筛选会话')

  const savedBox = document.createElement('details')
  savedBox.className = 'saved'
  const savedSummary = document.createElement('summary')
  savedSummary.textContent = '保存的搜索'
  const savedList = document.createElement('div')
  savedList.className = 'saved-list'
  savedBox.append(savedSummary, savedList)

  const hiddenLabel = document.createElement('label')
  hiddenLabel.className = 'chat-search-label'
  const hiddenBox = document.createElement('input')
  hiddenBox.type = 'checkbox'
  const hiddenText = document.createElement('span')
  hiddenText.textContent = '显示已隐藏'
  hiddenLabel.append(hiddenBox, hiddenText)

  const list = document.createElement('ul')
  list.className = 'chat-list'
  const hint = document.createElement('p')
  hint.className = 'hint'
  hint.textContent = '正在读取会话…'
  aside.append(filter, hiddenLabel, savedBox, hint, list)

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
  searchInput.setAttribute('list', 'keywordHistory')
  const historyList = document.createElement('datalist')
  historyList.id = 'keywordHistory'
  const ocrToggle = document.createElement('input')
  ocrToggle.type = 'checkbox'
  ocrToggle.checked = true
  const ocrLabel = document.createElement('label')
  ocrLabel.className = 'chat-search-label'
  ocrLabel.append(ocrToggle, document.createElement('span'))
  ocrLabel.children[1].textContent = '含图片文字'

  const saveButton = document.createElement('button')
  saveButton.type = 'button'
  saveButton.className = 'ghost'
  saveButton.textContent = '保存搜索'
  saveButton.title = '把当前筛选条件存到本机浏览器'

  const exportButton = document.createElement('button')
  exportButton.type = 'button'
  exportButton.className = 'ghost'
  exportButton.textContent = '导出本会话'
  exportButton.title = '用这个会话打开导出页'

  const galleryButton = document.createElement('button')
  galleryButton.type = 'button'
  galleryButton.className = 'ghost'
  galleryButton.textContent = '相册'
  galleryButton.title = '当前会话里本机已有的图片'

  const batchBar = document.createElement('div')
  batchBar.className = 'batch-bar'
  batchBar.hidden = true
  const batchCount = document.createElement('span')
  batchCount.className = 'meta'
  const batchExport = document.createElement('button')
  batchExport.type = 'button'
  batchExport.className = 'primary'
  batchExport.textContent = '导出选中（ZIP）'
  const batchClear = document.createElement('button')
  batchClear.type = 'button'
  batchClear.className = 'ghost'
  batchClear.textContent = '清空'
  batchBar.append(batchCount, batchExport, batchClear)

  const more = document.createElement('button')
  more.type = 'button'
  more.className = 'ghost'
  more.textContent = '载入更早'
  more.hidden = true
  const messages = document.createElement('ol')
  messages.className = 'msg-list'

  // Album: the images of the selected chat, newest first, paged like the reader.
  const album = document.createElement('div')
  album.className = 'album-panel'
  album.hidden = true
  const albumGrid = document.createElement('div')
  albumGrid.className = 'album-grid'
  const albumMore = document.createElement('button')
  albumMore.type = 'button'
  albumMore.className = 'ghost'
  albumMore.textContent = '载入更多'
  albumMore.hidden = true
  const albumHint = document.createElement('p')
  albumHint.className = 'hint'
  album.append(albumHint, albumGrid, albumMore)

  // Lightbox: the original image, closed by clicking the backdrop or ×.
  const lightbox = document.createElement('div')
  lightbox.className = 'media-lightbox'
  lightbox.hidden = true
  const lightboxImage = document.createElement('img')
  lightboxImage.className = 'media-lightbox-image'
  lightboxImage.alt = '图片'
  const lightboxClose = document.createElement('button')
  lightboxClose.type = 'button'
  lightboxClose.className = 'ghost media-lightbox-close'
  lightboxClose.textContent = '关闭'
  lightbox.append(lightboxImage, lightboxClose)

  function openMedia(rowId, seq) {
    lightboxImage.src = `/api/media/${rowId}?seq=${seq}`
    lightbox.hidden = false
  }
  lightboxClose.addEventListener('click', () => { lightbox.hidden = true })
  lightbox.addEventListener('click', (event) => {
    if (event && event.target === lightbox) lightbox.hidden = true
  })

  searchBar.append(searchInput, historyList, ocrLabel, saveButton, exportButton, galleryButton)
  main.append(title, batchBar, searchBar, album, messages, more)
  shell.append(aside, main, lightbox)
  root.append(shell)

  const storage = typeof localStorage === 'undefined' ? null : localStorage
  const state = {
    sessions: [], query: '', selected: null, rows: [], offset: 0, total: 0,
    album: { open: false, offset: 0, total: 0 },
    hidden: false,
    batch: new Set(),
    saved: readList(storage, SAVED_KEY),
    history: readList(storage, HISTORY_KEY),
  }
  let closed = false

  function renderList() {
    const visible = filterSessions(state.sessions, state.query)
    list.replaceChildren()
    hint.textContent = state.sessions.length === 0
      ? '索引里还没有会话：请回到当前界面点「从 QQ 同步」。'
      : `${visible.length} / ${state.sessions.length} 个会话`
    for (const session of visible) {
      const key = `${session.kind}:${session.id}`
      const item = document.createElement('li')
      item.className = 'chat-item'
      if (state.selected && state.selected.kind === session.kind
        && state.selected.id === session.id) item.classList.add('is-active')

      const check = document.createElement('input')
      check.type = 'checkbox'
      check.className = 'chat-check'
      check.checked = state.batch.has(key)
      check.setAttribute('aria-label', `选择 ${session.name || session.id}`)
      check.addEventListener('click', (event) => {
        if (event && typeof event.stopPropagation === 'function') event.stopPropagation()
        if (check.checked) state.batch.add(key)
        else state.batch.delete(key)
        renderBatch()
      })

      const name = document.createElement('span')
      name.className = 'chat-name'
      name.textContent = session.name || session.id
      if (session.pinned) {
        const pin = document.createElement('span')
        pin.className = 'chat-pin'
        pin.textContent = '置顶'
        name.append(' ', pin)
      }
      const meta = document.createElement('span')
      meta.className = 'chat-meta'
      meta.textContent = sessionMeta(session)

      const actions = document.createElement('span')
      actions.className = 'chat-actions'
      actions.append(
        actionButton(session.pinned ? '取消置顶' : '置顶', () => {
          patchChat(session, { pinned: !session.pinned })
        }),
        actionButton('改名', () => {
          if (typeof window === 'undefined' || typeof window.prompt !== 'function') return
          const next = window.prompt('会话显示名（留空恢复原名）', session.alias || '')
          if (next === null) return
          patchChat(session, { alias: next })
        }),
        actionButton(session.hidden ? '取消隐藏' : '隐藏', () => {
          patchChat(session, { hidden: !session.hidden })
        }),
      )

      item.append(check, name, meta, actions)
      item.addEventListener('click', () => select(session))
      list.append(item)
    }
    renderSaved()
  }

  function renderBatch() {
    batchBar.hidden = state.batch.size === 0
    batchCount.textContent = `已选 ${state.batch.size} 个会话`
  }

  function renderSaved() {
    savedList.replaceChildren()
    savedSummary.textContent = `保存的搜索（${state.saved.length}）`
    for (const saved of state.saved) {
      const row = document.createElement('div')
      row.className = 'saved-row'
      const play = document.createElement('button')
      play.type = 'button'
      play.className = 'saved-play'
      play.textContent = savedLabel(saved)
      play.addEventListener('click', () => applySaved(saved))
      const remove = document.createElement('button')
      remove.type = 'button'
      remove.className = 'ghost'
      remove.textContent = '×'
      remove.title = '删除这条保存的搜索'
      remove.addEventListener('click', () => {
        state.saved = state.saved.filter((item) => item !== saved)
        writeList(storage, SAVED_KEY, state.saved)
        renderSaved()
      })
      row.append(play, remove)
      savedList.append(row)
    }
  }

  function applySaved(saved) {
    searchInput.value = saved.keyword || ''
    if (saved.chat) {
      const found = state.sessions.find((session) =>
        session.kind === saved.chat.kind && String(session.id) === String(saved.chat.id))
      if (found) select(found)
    }
    if (saved.keyword) search(saved.keyword, ocrToggle.checked)
    else if (state.selected) select(state.selected)
  }

  function saveCurrent() {
    const saved = savedFromState({
      query: state.query,
      keyword: searchInput.value,
      chat: state.selected ? {
        kind: state.selected.kind, id: state.selected.id, name: state.selected.name,
      } : null,
    })
    state.saved = pushSaved(state.saved, saved)
    writeList(storage, SAVED_KEY, state.saved)
    renderSaved()
  }

  async function patchChat(session, patch) {
    try {
      await api.post('/api/chats/state', { kind: session.kind, id: session.id, patch })
      if (closed) return
      // Re-read the list so alias/pin/hide ordering matches the server.
      await loadSessions()
    } catch (error) {
      if (!closed) title.textContent = `保存失败：${error.message}`
    }
  }

  function renderMessages(reset, rows = state.rows) {
    if (reset) messages.replaceChildren()
    for (const row of rows) messages.append(messageRow(row, { onOpenMedia: openMedia }))
    more.hidden = state.rows.length >= state.total
  }

  /** Album page: images of the selected chat, appended so paging keeps order. */
  async function loadAlbum(reset) {
    if (!state.selected) return
    const offset = reset ? 0 : state.album.offset + albumGrid.children.length
    try {
      const payload = await api.get('/api/media/list', {
        chatKind: state.selected.kind,
        chatId: state.selected.id,
        offset,
        limit: 60,
      })
      if (closed) return
      const items = Array.isArray(payload?.items) ? payload.items : []
      if (reset) albumGrid.replaceChildren()
      for (const item of items) {
        const image = document.createElement('img')
        image.className = 'album-thumb'
        image.loading = 'lazy'
        image.alt = item.name || '图片'
        image.src = `/api/media/${Number(item.rowId)}?seq=${Number(item.seq)}&thumb=1`
        image.addEventListener('click', () => openMedia(Number(item.rowId), Number(item.seq)))
        albumGrid.append(image)
      }
      state.album.total = Number(payload?.total) || items.length
      albumHint.textContent = items.length === 0
        ? '这个会话没有本机已有的图片。'
        : `本机图片 ${state.album.total} 张`
      albumMore.hidden = albumGrid.children.length >= state.album.total
    } catch (error) {
      if (!closed) albumHint.textContent = `读取相册失败：${error.message}`
    }
  }

  function toggleAlbum() {
    state.album.open = !state.album.open
    album.hidden = !state.album.open
    galleryButton.classList.remove('is-active')
    if (state.album.open) {
      galleryButton.classList.add('is-active')
      loadAlbum(true)
    }
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
    state.history = pushHistory(state.history, keyword)
    writeList(storage, HISTORY_KEY, state.history)
    renderHistory()
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
        const item = messageRow(row, { onOpenMedia: openMedia })
        if (row.chatName) {
          const chat = document.createElement('span')
          chat.className = 'msg-chat'
          chat.textContent = row.chatName
          item.children[0].append(chat)
        }
        // A cross-chat hit opens its own conversation at this message; the
        // row id is the index id `around` expects.
        if (row.chatKind && row.chatId && row.rowId !== undefined) {
          item.classList.add('is-clickable')
          item.addEventListener('click', () => {
            const session = state.sessions.find((entry) =>
              entry.kind === row.chatKind && String(entry.id) === String(row.chatId))
            if (session) select(session, Number(row.rowId))
          })
        }
        messages.append(item)
      }
    } catch (error) {
      if (!closed) title.textContent = `搜索失败：${error.message}`
    }
  }

  function renderHistory() {
    historyList.replaceChildren()
    for (const keyword of state.history) {
      const option = document.createElement('option')
      option.value = keyword
      historyList.append(option)
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
    state.album = { open: false, offset: 0, total: 0 }
    album.hidden = true
    albumGrid.replaceChildren()
    galleryButton.classList.remove('is-active')
    title.textContent = `${session.name || session.id} · ${sessionMeta(session)}`
    renderList()
    loadMessages(true, around)
  }

  filter.addEventListener('input', () => {
    state.query = filter.value
    renderList()
  })
  more.addEventListener('click', () => loadMessages(false))
  galleryButton.addEventListener('click', toggleAlbum)
  albumMore.addEventListener('click', () => loadAlbum(false))
  saveButton.addEventListener('click', saveCurrent)
  hiddenBox.addEventListener('change', () => {
    state.hidden = hiddenBox.checked
    loadSessions()
  })
  exportButton.addEventListener('click', () => {
    if (state.selected && typeof onExport === 'function') onExport(state.selected)
    else title.textContent = '先选择一个会话，再导出'
  })
  batchClear.addEventListener('click', () => {
    state.batch.clear()
    renderBatch()
    renderList()
  })
  batchExport.addEventListener('click', () => {
    const chats = state.sessions
      .filter((session) => state.batch.has(`${session.kind}:${session.id}`))
      .map((session) => ({ kind: session.kind, id: session.id, label: session.name || session.id }))
    if (chats.length === 0) return
    if (typeof onExportBatch === 'function') onExportBatch(chats)
    else title.textContent = '导出页还没接上批量导出。'
  })

  async function loadSessions() {
    try {
      const payload = await api.get('/api/sessions', state.hidden ? { hidden: 1 } : {})
      if (closed) return
      state.sessions = Array.isArray(payload?.sessions) ? payload.sessions : []
      const jump = initial && state.sessions.find((session) =>
        session.kind === initial.kind && String(session.id) === String(initial.id))
      const again = state.selected && state.sessions.find((session) =>
        session.kind === state.selected.kind && String(session.id) === String(state.selected.id))
      state.selected = again || null
      renderList()
      if (jump && !state.selected) select(jump, initial.around || null)
      else if (!state.selected && state.sessions.length > 0) select(state.sessions[0])
    } catch (error) {
      if (!closed) hint.textContent = `读取会话失败：${error.message}`
    }
  }

  renderHistory()
  loadSessions()

  return () => {
    closed = true
    shell.remove()
    lightbox.remove()
  }
}
