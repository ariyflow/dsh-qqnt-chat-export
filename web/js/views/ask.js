/**
 * Question answering: ask, read the evidence, jump back to the original.
 *
 * The plugin deliberately does not write the answer. What this view shows is
 * what the retrieval found — the conversation spans, the chat and time, and the
 * exact messages behind a citation. A reader (or the host model, through
 * `qqnt_ask`) turns that into a sentence; the page's job is to make the
 * evidence checkable, one click from the original message.
 */
import { formatClock } from './chats.js'

/** Spans asked for per question; more than this does not fit on a screen. */
export const TOP_K = 8

const SOURCE_LABELS = { text: '文字', ocr: '图片文字', asr: '语音转写', file_text: '文件文字' }

/** `[1] 示例课程群 · 2024-10-27 11:33–11:35` — the line above a span. */
export function hitHeading(hit, index) {
  const end = String(hit?.end || '').slice(-5)
  return `[${index + 1}] ${hit?.chat || hit?.chatId || '?'} · ${hit?.start || '—'}–${end}`
}

/** Recognize-or-typed marker list, in a stable order. */
export function sourceLabels(sources) {
  return (Array.isArray(sources) ? sources : [])
    .map((name) => SOURCE_LABELS[name])
    .filter((label) => label !== undefined)
}

/** One citable message: `小林 10-27 11:33 周五下午三点开会吧`. */
export function citationLabel(row) {
  const when = formatClock(row?.ts).slice(-11)
  const text = String(row?.text ?? '').replace(/\s+/g, ' ').trim()
  return `${row?.sender || '?'} ${when} ${text}`
}

/**
 * Mount the view.
 *
 * @param {HTMLElement} root - empty container owned by the caller
 * @param {{api: object, onOpenChat?: (hit: object, rowId: number) => void}} options
 * @returns {() => void} cleanup
 */
export function mountAsk(root, { api, onOpenChat = null }) {
  const shell = document.createElement('section')
  shell.className = 'ask-view'

  const form = document.createElement('form')
  form.className = 'ask-form'
  const input = document.createElement('input')
  input.type = 'search'
  input.className = 'ask-input'
  input.placeholder = '问点什么：上次说的报价单是多少？'
  input.setAttribute('aria-label', '向聊天记录提问')
  const submit = document.createElement('button')
  submit.type = 'submit'
  submit.className = 'primary'
  submit.textContent = '提问'
  form.append(input, submit)

  const tools = document.createElement('div')
  tools.className = 'ask-tools'
  const build = document.createElement('button')
  build.type = 'button'
  build.className = 'ghost'
  build.textContent = '分块与嵌入'
  build.title = '把会话切成片段并计算向量；装了嵌入模型后才有语义检索'
  const note = document.createElement('span')
  note.className = 'meta'
  note.textContent = '插件只给出片段与引用；写答案的是模型或你自己。'
  tools.append(build, note)

  const status = document.createElement('p')
  status.className = 'ask-status'
  status.textContent = '输入一个问题，回车开始。'

  const results = document.createElement('ol')
  results.className = 'ask-results'

  shell.append(form, tools, status, results)
  root.append(shell)

  const state = { question: '', busy: false }
  let closed = false

  function renderCitation(hit, row) {
    const item = document.createElement('li')
    item.className = 'ask-cite'
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'ask-cite-button'
    button.textContent = citationLabel(row)
    button.title = '打开这条消息的上下文'
    button.addEventListener('click', () => {
      if (typeof onOpenChat === 'function') onOpenChat(hit, Number(row.id))
    })
    item.append(button)
    return item
  }

  function renderHit(hit, index) {
    const card = document.createElement('li')
    card.className = 'ask-hit'

    const head = document.createElement('div')
    head.className = 'ask-hit-head'
    const heading = document.createElement('span')
    heading.className = 'ask-hit-title'
    heading.textContent = hitHeading(hit, index)
    head.append(heading)
    for (const label of sourceLabels(hit.sources)) {
      const badge = document.createElement('span')
      badge.className = 'msg-badge'
      badge.textContent = label
      head.append(badge)
    }

    const quote = document.createElement('p')
    quote.className = 'ask-quote'
    quote.textContent = String(hit.text ?? '')

    const citations = document.createElement('ul')
    citations.className = 'ask-cites'
    for (const row of Array.isArray(hit.citations) ? hit.citations : []) {
      citations.append(renderCitation(hit, row))
    }

    card.append(head, quote, citations)
    return card
  }

  function render(payload) {
    const hits = Array.isArray(payload?.hits) ? payload.hits : []
    const notes = Array.isArray(payload?.notes) ? payload.notes : []
    if (hits.length === 0) {
      status.textContent = notes.length > 0
        ? `没有找到相关片段：${notes[0]}`
        : '没有找到相关片段。换个说法，或先点「分块与嵌入」。'
    } else {
      status.textContent = `${hits.length} 个片段（关键词 ${payload.keyword ?? 0} · 向量 ${payload.vector ?? 0}）`
    }
    results.replaceChildren(...hits.map(renderHit))
    if (hits.length > 0 && notes.length > 0) {
      const hint = document.createElement('li')
      hint.className = 'ask-note'
      hint.textContent = notes.join('；')
      results.append(hint)
    }
  }

  async function ask() {
    const question = String(input.value || '').trim()
    if (question === '' || state.busy) return
    state.busy = true
    state.question = question
    submit.disabled = true
    status.textContent = '正在检索…'
    results.replaceChildren()
    try {
      const payload = await api.post('/api/ask', { question, topK: TOP_K })
      if (closed) return
      render(payload)
    } catch (error) {
      if (!closed) status.textContent = `检索失败：${error.message}`
    } finally {
      state.busy = false
      submit.disabled = false
    }
  }

  form.addEventListener('submit', (event) => {
    if (event && typeof event.preventDefault === 'function') event.preventDefault()
    ask()
  })

  build.addEventListener('click', async () => {
    build.disabled = true
    try {
      await api.post('/api/jobs', { kind: 'chunks', summary: '分块与嵌入' })
      status.textContent = '已加入分块与嵌入任务，进度见右下角。'
    } catch (error) {
      status.textContent = `无法开始：${error.message}`
    } finally {
      build.disabled = false
    }
  })

  return () => {
    closed = true
    shell.remove()
  }
}
