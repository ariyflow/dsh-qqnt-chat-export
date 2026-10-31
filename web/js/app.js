/**
 * Entry point for the modular UI.
 *
 * Wires the shared state, the API client, and the mounted view. Views are
 * added here one at a time; anything not ported yet links back to the legacy
 * page, which keeps working unchanged.
 */
import { ApiError, createApi } from './api.js'
import { createStore } from './state.js'
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
})

const meta = document.getElementById('app-meta')
const statusBox = document.getElementById('app-status')
const main = document.getElementById('app-main')

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
  statusBox.textContent = value.hasIndex
    ? `上次构建 ${formatTime(value.builtAt)} · 密钥${value.hasKey ? '已缓存' : '未提取'}`
    : '请回到当前界面点「从 QQ 同步」'
}

store.subscribe(render)

let unmount = null
let unmountJobs = null
// Deep link: `/app/?view=models` opens the model panel directly.
let view = new URLSearchParams(location.search).get('view') === 'models' ? 'models' : 'chats'
/** Mount the active view once the first status arrives (or the index is absent). */
function mount() {
  if (!main) return
  if (typeof unmount === 'function') unmount()
  unmount = view === 'models' ? mountModels(main, { api }) : mountChats(main, { api })
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

const toggle = document.getElementById('viewToggle')
if (toggle) {
  toggle.textContent = view === 'models' ? '回到会话' : '模型与组件'
  toggle.addEventListener('click', () => {
    view = view === 'models' ? 'chats' : 'models'
    toggle.textContent = view === 'models' ? '回到会话' : '模型与组件'
    mount()
  })
}

async function refresh() {
  try {
    const status = await api.get('/api/status')
    const index = status?.index || {}
    store.set({
      phase: 'ready',
      error: '',
      messages: Number(index.messages) || 0,
      chats: Number(index.chats) || 0,
      builtAt: index.builtAt || 0,
      hasIndex: !index.error && Number(index.messages) > 0,
      hasKey: status?.key === true,
    })
  } catch (error) {
    store.set({
      phase: 'error',
      error: error instanceof ApiError ? error.message : String(error?.message || error),
    })
  } finally {
    mount()
  }
}

render(store.get())
refresh()
