/**
 * Entry point for the modular UI.
 *
 * At this stage the shell only proves that the pieces fit together: it reads
 * `/api/status`, stores the result, and renders it. Views get mounted here as
 * they are ported, so this file stays a wiring list rather than a second
 * monolith.
 */
import { ApiError, createApi } from './api.js'
import { createStore } from './state.js'

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
    ? `索引就绪 · ${value.messages} 条消息 · ${value.chats} 个会话`
    : '还没有索引：请回到当前界面点「从 QQ 同步」'
  statusBox.classList.remove('is-error')
  statusBox.textContent = [
    `上次构建：${formatTime(value.builtAt)}`,
    `数据库密钥：${value.hasKey ? '已缓存' : '未提取'}`,
  ].join('　')
}

store.subscribe(render)

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
  }
}

render(store.get())
refresh()
