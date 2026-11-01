/**
 * Entry point for the modular UI.
 *
 * Wires the shared state, the API client, and the mounted view. Views are
 * added here one at a time; anything not ported yet links back to the legacy
 * page, which keeps working unchanged.
 */
import { ApiError, createApi } from './api.js'
import { createStore } from './state.js'
import { mountAsk } from './views/ask.js'
import { mountExport } from './views/export.js'
import { mountSettings } from './views/settings.js'
import { mountStartup } from './views/startup.js'
import { mountStats } from './views/stats.js'
import { mountChats } from './views/chats.js'
import { mountModels } from './views/models.js'
import { mountJobs } from './views/jobs.js'

const api = createApi()

const store = createStore({
  phase: 'loading',
  error: '',
  messages: null,
  chats: null,
  builtAt: null,
  hasIndex: null,
  hasKey: null,
  buildState: 'idle',
  buildStep: '',
  buildPercent: 0,
  accounts: [],
  indexAccount: '',
  account: '',
})

const meta = document.getElementById('app-meta')
const statusBox = document.getElementById('app-status')
const main = document.getElementById('app-main')
const syncBtn = document.getElementById('syncBtn')
const refreshBtn = document.getElementById('refreshBtn')
const accountSelect = document.getElementById('accountSelect')

/** Build progress as 0..1; the helper reports processed/total. */
function buildPercent(build) {
  const total = Number(build?.total) || 0
  const done = Number(build?.processed) || 0
  if (total <= 0) return 0
  return Math.min(1, Math.max(0, done / total))
}

/**
 * Sidebar account picker: the live index plus any parked caches, exactly like
 * the legacy page (`index.accounts` comes from the status probe).
 */
function renderAccounts(value) {
  if (!accountSelect) return
  const indexed = value.indexAccount || ''
  const current = value.account || indexed || ''
  accountSelect.replaceChildren()
  if (!current) {
    const option = document.createElement('option')
    option.value = ''
    option.textContent = '未检测到账号'
    accountSelect.append(option)
    accountSelect.disabled = true
    return
  }
  const seen = new Set([current])
  const head = document.createElement('option')
  head.value = indexed || current
  head.textContent = `${indexed || current}（当前）`
  accountSelect.append(head)
  for (const item of value.accounts || []) {
    const account = String(item?.account || '')
    if (account === '' || seen.has(account)) continue
    seen.add(account)
    const option = document.createElement('option')
    option.value = account
    option.textContent = `${account}${item.current ? '（当前）' : '（缓存）'}`
    accountSelect.append(option)
  }
  accountSelect.value = indexed || current
  accountSelect.disabled = seen.size < 2 || value.buildState === 'running'
}

/** `1700000000` → `2026-10-31 20:03`; the page never shows raw epochs. */
function formatTime(epochSeconds) {
  const seconds = Number(epochSeconds)
  if (!Number.isFinite(seconds) || seconds <= 0) return '—'
  const date = new Date(seconds * 1000)
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function render(value) {
  if (!meta || !statusBox) return
  if (value.phase === 'loading') {
    meta.textContent = '正在读取索引状态…'
    return
  }
  if (value.phase === 'error') {
    meta.textContent = '读取状态失败'
    statusBox.textContent = value.error
    statusBox.classList.add('is-error')
    return
  }
  meta.textContent = value.hasIndex
    ? `${value.messages} 条消息 · ${value.chats} 个会话`
    : '还没有索引'
  statusBox.classList.remove('is-error')
  if (value.buildState === 'running') {
    const percent = Math.round((Number(value.buildPercent) || 0) * 100)
    statusBox.textContent = `正在同步：${value.buildStep || '处理中'} ${percent}%`
  } else {
    statusBox.textContent = value.hasIndex
      ? `上次构建 ${formatTime(value.builtAt)} · 密钥${value.hasKey ? '已缓存' : '未提取'}`
      : '点「从 QQ 同步」建立索引'
  }
  renderAccounts(value)
}

store.subscribe(render)

let unmount = null
let unmountJobs = null
const NAV = {
  chats: 'viewChats', export: 'viewExport', stats: 'viewStats',
  ask: 'viewAsk', settings: 'viewSettings', models: 'viewModels',
}
// Deep links: `/app/?view=models` and `/app/?view=ask` open that view directly.
const requested = new URLSearchParams(location.search).get('view')
let view = Object.prototype.hasOwnProperty.call(NAV, requested || '') ? requested : 'chats'
/** A chat (and message) the reader should open; consumed on the next mount. */
let initialChat = null
let initialChats = null

/** Highlight the active view button; the shim has no classList.toggle. */
function paintNav() {
  for (const [name, id] of Object.entries(NAV)) {
    const button = document.getElementById(id)
    if (!button) continue
    button.classList.remove('is-active')
    if (name === view) button.classList.add('is-active')
  }
}

/** Switch views, optionally asking the reader to open one chat. */
function setView(next, { chat = null, chats = null } = {}) {
  if (!Object.prototype.hasOwnProperty.call(NAV, next)) return
  view = next
  initialChat = chat
  initialChats = chats
  mount()
}

/**
 * Mount the active view once the first status arrives (or the index is absent).
 *
 * The switch itself is a plain replacement; the motion lives in `base.css` (the
 * new view rises in, its rows cascade). A View Transition was tried here and
 * dropped: its snapshot of the new page is taken before the entrance animations
 * advance, so a cross-fade showed an empty settings page until it finished.
 */
function mount() {
  if (!main) return
  paintNav()
  if (typeof unmount === 'function') unmount()
  if (view === 'ask') {
    // A citation card opens the reader on that message: same page, no reload.
    unmount = mountAsk(main, {
      api,
      onOpenChat: (hit, rowId) => setView('chats', {
        chat: { kind: hit.chatKind, id: hit.chatId, around: rowId },
      }),
    })
  } else if (view === 'settings') {
    unmount = mountSettings(main, { api })
  } else if (view === 'models') {
    unmount = mountModels(main, { api })
  } else if (view === 'export') {
    unmount = mountExport(main, { api, initialChat, initialChats })
    initialChat = null
    initialChats = null
  } else if (view === 'stats') {
    unmount = mountStats(main, { api, initialChat })
    initialChat = null
  } else {
    unmount = mountChats(main, {
      api,
      initial: initialChat,
      onExport: (session) => setView('export', {
        chat: { kind: session.kind, id: session.id, name: session.name || session.id },
      }),
      onExportBatch: (chats) => setView('export', { chats }),
    })
    initialChat = null
  }
  // The task panel floats over the reader so it survives view switches.
  if (!unmountJobs) unmountJobs = mountJobs(document.body, { api })
}

const ocrBtn = document.getElementById('ocrBtn')
if (ocrBtn) {
  ocrBtn.addEventListener('click', async () => {
    ocrBtn.disabled = true
    try {
      await api.post('/api/jobs', { kind: 'ocr', summary: '识别图片文字' })
      if (statusBox) statusBox.textContent = '已加入识别任务，进度见右下角'
    } catch (error) {
      if (statusBox) statusBox.textContent = `无法开始识别：${error.message}`
    } finally {
      ocrBtn.disabled = false
    }
  })
}

const asrBtn = document.getElementById('asrBtn')
if (asrBtn) {
  asrBtn.addEventListener('click', async () => {
    asrBtn.disabled = true
    try {
      await api.post('/api/jobs', { kind: 'asr', summary: '转写语音' })
      if (statusBox) statusBox.textContent = '已加入转写任务，进度见右下角'
    } catch (error) {
      if (statusBox) statusBox.textContent = `无法开始转写：${error.message}`
    } finally {
      asrBtn.disabled = false
    }
  })
}

for (const [name, id] of Object.entries(NAV)) {
  const button = document.getElementById(id)
  if (button) button.addEventListener('click', () => setView(name))
}
paintNav()

let pollTimer = null
let building = false

function schedulePoll() {
  if (pollTimer) clearTimeout(pollTimer)
  pollTimer = setTimeout(pollBuild, 1500)
}

/** Poll the build until it stops, then reload the current view once. */
async function pollBuild() {
  try {
    const status = await api.get('/api/status')
    const build = status?.build || {}
    if (build.state === 'running') {
      building = true
      if (syncBtn) syncBtn.disabled = true
      if (statusBox) {
        const percent = Math.round(buildPercent(build) * 100)
        statusBox.textContent = `正在同步：${build.step || '处理中'} ${percent}%`
      }
      schedulePoll()
      return
    }
  } catch {
    schedulePoll()
    return
  }
  building = false
  if (syncBtn) syncBtn.disabled = false
  await refresh()
}

async function startSync() {
  if (building) return
  building = true
  if (syncBtn) syncBtn.disabled = true
  if (statusBox) statusBox.textContent = '已开始同步，正在复制数据库并更新索引…'
  try {
    await api.post('/api/index/build?refresh=1')
  } catch (error) {
    building = false
    if (syncBtn) syncBtn.disabled = false
    if (statusBox) statusBox.textContent = `无法开始同步：${error.message}`
    return
  }
  schedulePoll()
}

if (syncBtn) syncBtn.addEventListener('click', startSync)
if (refreshBtn) {
  refreshBtn.addEventListener('click', async () => {
    refreshBtn.disabled = true
    try {
      await refresh()
    } finally {
      refreshBtn.disabled = false
    }
  })
}
if (accountSelect) {
  accountSelect.addEventListener('change', async () => {
    const account = String(accountSelect.value || '').trim()
    if (account === '') return
    accountSelect.disabled = true
    if (statusBox) statusBox.textContent = `正在切换到账号 ${account} 的索引…`
    try {
      await api.post('/api/index/select', { account })
      await refresh()
    } catch (error) {
      if (statusBox) statusBox.textContent = `切换失败：${error.message}`
      accountSelect.disabled = false
    }
  })
}

async function refresh() {
  try {
    const status = await api.get('/api/status')
    const index = status?.index || {}
    const build = status?.build || {}
    building = build.state === 'running'
    if (syncBtn) syncBtn.disabled = building
    store.set({
      phase: 'ready',
      error: '',
      messages: Number(index.messages) || 0,
      chats: Number(index.chats) || 0,
      builtAt: index.builtAt || 0,
      hasIndex: !index.error && Number(index.messages) > 0,
      hasKey: status?.key === true,
      buildState: build.state || 'idle',
      buildStep: build.step || '',
      buildPercent: buildPercent(build),
      accounts: Array.isArray(index.accounts) ? index.accounts : [],
      indexAccount: index.account || '',
      account: status?.account || '',
    })
    if (building) schedulePoll()
  } catch (error) {
    store.set({
      phase: 'error',
      error: error instanceof ApiError ? error.message : String(error?.message || error),
    })
  } finally {
    mount()
  }
}

const startupHost = document.getElementById('startup-host')
if (startupHost) {
  mountStartup(startupHost, { api, onOpenSettings: () => setView('settings') })
}

render(store.get())
refresh()
