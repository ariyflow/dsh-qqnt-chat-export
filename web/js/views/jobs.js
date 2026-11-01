/**
 * Task panel: one list for every background job.
 *
 * The export queue had its own bottom-right box; the port needs the same
 * affordance for OCR, speech and archiving, so the panel is generic: it lists
 * whatever `/api/jobs` returns, shows progress, and offers cancel/retry.
 *
 * Polling instead of events is deliberate — the page is served from the same
 * process, and a 2 s poll of a tiny JSON body is cheaper than wiring a second
 * channel through the iframe.
 */

const STATE_LABELS = {
  queued: '排队中',
  running: '进行中',
  canceling: '正在停止…',
  done: '完成',
  failed: '失败',
  canceled: '已取消',
  interrupted: '被中断',
}

/** `running · 识别 312/1987 张` — the line under the summary. */
export function jobMeta(job) {
  const label = STATE_LABELS[job.state] || job.state
  const progress = Number(job.progress) > 0 && job.state !== 'done'
    ? `${Math.round(Number(job.progress) * 100)}%`
    : ''
  return [label, progress, job.message].filter((part) => part !== '' && part !== undefined).join(' · ')
}

/** Only show the panel when there is something to show. */
export function visibleJobs(jobs) {
  return (Array.isArray(jobs) ? jobs : []).filter((job) => job && job.id)
}

/**
 * @param {HTMLElement} root - container owned by the caller
 * @param {{api: {get: Function, post: Function}, intervalMs?: number}} options
 * @returns {() => void} cleanup
 */
export function mountJobs(root, { api, intervalMs = 2000 }) {
  const panel = document.createElement('section')
  panel.className = 'jobs-panel'
  panel.hidden = true

  const head = document.createElement('header')
  head.className = 'jobs-head'
  const title = document.createElement('span')
  title.textContent = '任务'
  const close = document.createElement('button')
  close.type = 'button'
  close.className = 'ghost'
  close.textContent = '收起'
  head.append(title, close)

  const list = document.createElement('ul')
  list.className = 'jobs-list'
  panel.append(head, list)
  root.append(panel)

  let closed = false
  let timer = null

  function renderRow(job) {
    const item = document.createElement('li')
    item.className = `job-row is-${job.state}`

    const summary = document.createElement('span')
    summary.className = 'job-summary'
    summary.textContent = job.summary || job.kind

    const meta = document.createElement('span')
    meta.className = 'job-meta'
    meta.textContent = jobMeta(job)

    const actions = document.createElement('span')
    actions.className = 'job-actions'
    if (job.canCancel) {
      const cancel = document.createElement('button')
      cancel.type = 'button'
      cancel.className = 'ghost'
      cancel.textContent = '取消'
      cancel.addEventListener('click', () => act(job.id, 'cancel'))
      actions.append(cancel)
    } else if (job.canRetry) {
      const retry = document.createElement('button')
      retry.type = 'button'
      retry.className = 'ghost'
      retry.textContent = '重试'
      retry.addEventListener('click', () => act(job.id, 'retry'))
      actions.append(retry)
    }

    item.append(summary, meta, actions)
    return item
  }

  async function act(id, action) {
    try {
      await api.post(`/api/jobs/${id}/${action}`)
    } catch (error) {
      title.textContent = `任务：${error.message}`
    }
    await refresh()
  }

  let collapsed = false
  let seen = new Set()

  async function refresh() {
    if (closed) return
    try {
      const payload = await api.get('/api/jobs')
      if (closed) return
      const jobs = visibleJobs(payload?.jobs)
      // A new job reopens the panel; an explicit 收起 keeps it shut while the
      // same rows are still on screen.
      const ids = new Set(jobs.map((job) => job.id))
      if ([...ids].some((id) => !seen.has(id))) collapsed = false
      seen = ids
      panel.hidden = jobs.length === 0 || collapsed
      list.replaceChildren()
      for (const job of jobs) list.append(renderRow(job))
    } catch {
      // The panel is a convenience; a failed poll must not spam the page.
    }
  }

  close.addEventListener('click', () => {
    collapsed = true
    panel.hidden = true
  })

  refresh()
  timer = setInterval(refresh, intervalMs)

  return () => {
    closed = true
    if (timer) clearInterval(timer)
    panel.remove()
  }
}
