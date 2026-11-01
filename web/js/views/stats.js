/**
 * Statistics over the same filters as the reader; computed in SQL, shown here.
 *
 * The numbers are already aggregated by the helper (`/api/stats`), so this view
 * is presentation only: totals, a monthly/daily/hourly bar strip, a weekday ×
 * hour heat grid, and the two top-10 lists. The CSV download is built from the
 * same rows the screen shows, so what you look at is what you export.
 */

/** One CSV row per number; the header is fixed so a spreadsheet opens cleanly. */
export function statsRows(data) {
  const rows = [['类目', '名称', '数量']]
  if (!data) return rows
  rows.push(['总计', '消息', data.total])
  rows.push(['总计', '会话', data.chats])
  rows.push(['总计', '发言人', data.senders])
  for (const item of data.monthly || []) rows.push(['每月', item.month, item.count])
  ;(data.hourly || []).forEach((count, hour) => {
    rows.push(['小时', `${String(hour).padStart(2, '0')}:00`, count])
  })
  for (const item of data.daily || []) rows.push(['每日', item.date, item.count])
  for (const item of data.topSenders || []) {
    rows.push(['发言人', item.qq ? `${item.name} (${item.qq})` : item.name, item.count])
  }
  for (const item of data.topChats || []) rows.push(['会话', item.name, item.count])
  return rows
}

/** RFC 4180 quoting, without a dependency. */
export function statsCsv(data) {
  return statsRows(data).map((row) => row
    .map((cell) => `"${String(cell).replace(/"/g, '""')}"`)
    .join(',')).join('\n')
}

/** The biggest value in a series, so bars can share one scale; 0 stays 0. */
export function peak(values) {
  return (values || []).reduce((max, value) => Math.max(max, Number(value) || 0), 0)
}

/** `count → percentage of peak`, floored at 2% so a tiny bar is still visible. */
export function barWidth(count, max) {
  const value = Number(count) || 0
  if (!max || value <= 0) return 0
  return Math.max(2, Math.round((value / max) * 100))
}

/**
 * @param {HTMLElement} root
 * @param {{api: object, initialChat?: object}} options
 * @returns {() => void} cleanup
 */
export function mountStats(root, { api, initialChat = null }) {
  const section = document.createElement('section')
  section.className = 'stats-view'

  const title = document.createElement('h2')
  title.className = 'chat-title'
  title.textContent = '统计'

  const form = document.createElement('form')
  form.className = 'stats-form'
  const chatSelect = document.createElement('select')
  chatSelect.className = 'stats-chat'
  chatSelect.setAttribute('aria-label', '统计范围')
  const allOption = document.createElement('option')
  allOption.value = ''
  allOption.textContent = '全部会话'
  chatSelect.append(allOption)
  const keyword = document.createElement('input')
  keyword.type = 'search'
  keyword.className = 'export-keyword'
  keyword.placeholder = '关键词（可留空）'
  const since = document.createElement('input')
  since.type = 'date'
  const until = document.createElement('input')
  until.type = 'date'
  const run = document.createElement('button')
  run.type = 'submit'
  run.className = 'primary'
  run.textContent = '统计'
  const csv = document.createElement('button')
  csv.type = 'button'
  csv.className = 'ghost'
  csv.textContent = '导出 CSV'
  form.append(chatSelect, keyword, since, until, run, csv)

  const scope = document.createElement('p')
  scope.className = 'hint'
  scope.textContent = '选择范围后点「统计」；全部在本机计算。'
  const body = document.createElement('div')
  body.className = 'stats-body'

  section.append(title, form, scope, body)
  root.append(section)

  let closed = false
  let data = null
  /** Which `load()` owns the screen; only the newest answer renders. */
  let loadSeq = 0
  const state = { chat: initialChat || null }

  function bar(label, count, max, extraClass = '') {
    const row = document.createElement('div')
    row.className = `stat-bar ${extraClass}`.trim()
    const name = document.createElement('span')
    name.className = 'stat-bar-label'
    name.textContent = label
    const track = document.createElement('span')
    track.className = 'stat-bar-track'
    const fill = document.createElement('i')
    fill.className = 'stat-bar-fill'
    fill.style.width = `${barWidth(count, max)}%`
    track.append(fill)
    const value = document.createElement('span')
    value.className = 'stat-bar-value'
    value.textContent = String(count)
    row.append(name, track, value)
    return row
  }

  function block(heading, rows, extraClass = '') {
    const sectionEl = document.createElement('section')
    sectionEl.className = `stat-block ${extraClass}`.trim()
    const head = document.createElement('h3')
    head.className = 'models-subtitle'
    head.textContent = heading
    // The rows are wrapped so a long block (24 hours) can flow into two
    // columns without the heading landing in the middle of the list.
    const list = document.createElement('div')
    list.className = 'stat-bars'
    for (const row of rows) list.append(row)
    sectionEl.append(head, list)
    return sectionEl
  }

  function render() {
    if (!data) {
      body.replaceChildren()
      return
    }
    const summary = document.createElement('p')
    summary.className = 'stat-summary'
    summary.textContent = `${data.total} 条消息 · ${data.chats} 个会话 · ${data.senders} 位发言人`
      + (data.firstTime ? ` · ${data.firstTime} → ${data.lastTime}` : '')

    const monthlyMax = peak((data.monthly || []).map((item) => item.count))
    const dailyMax = peak((data.daily || []).map((item) => item.count))
    const hourlyMax = peak(data.hourly || [])

    const blocks = [
      block('每月消息量', (data.monthly || []).slice(-12).map((item) =>
        bar(item.month, item.count, monthlyMax))),
      block('最近 30 天', (data.daily || []).map((item) =>
        bar(item.date.slice(5), item.count, dailyMax))),
      block('24 小时分布', (data.hourly || []).map((count, hour) =>
        bar(`${String(hour).padStart(2, '0')}:00`, count, hourlyMax)), 'is-hours'),
      block('发言人 Top 10', (data.topSenders || []).map((item) =>
        bar(item.qq ? `${item.name} (${item.qq})` : item.name,
          item.count, peak((data.topSenders || []).map((entry) => entry.count))))),
      block('活跃会话 Top 10', (data.topChats || []).map((item) =>
        bar(item.name, item.count, peak((data.topChats || []).map((entry) => entry.count))))),
    ]

    const heat = document.createElement('section')
    heat.className = 'stat-block is-heat'
    const heatTitle = document.createElement('h3')
    heatTitle.className = 'models-subtitle'
    heatTitle.textContent = '周 × 小时'
    const grid = document.createElement('div')
    grid.className = 'stats-heat'
    const week = ['日', '一', '二', '三', '四', '五', '六']
    const heatMax = peak((data.heat || []).flat())
    for (let day = 0; day < 7; day += 1) {
      for (let hour = 0; hour < 24; hour += 1) {
        const cell = document.createElement('span')
        cell.className = 'heat-cell'
        const count = Number(data.heat?.[day]?.[hour]) || 0
        cell.textContent = count === 0 ? '' : String(count)
        cell.title = `周${week[day]} ${String(hour).padStart(2, '0')}:00 · ${count} 条`
        cell.style.opacity = String(0.12 + 0.88 * (heatMax ? count / heatMax : 0))
        // The grid resolves left to right: the delay follows the hour, so a
        // week of activity appears like a clock sweeping through the day.
        cell.style.animationDelay = `${hour * 8}ms`
        grid.append(cell)
      }
    }
    heat.append(heatTitle, grid)

    body.replaceChildren(summary, barsWrap(blocks), heat)
  }

  /** Keep the blocks in a plain container so tests can walk them. */
  function barsWrap(blocks) {
    const wrap = document.createElement('div')
    wrap.className = 'stats-blocks'
    for (const item of blocks) wrap.append(item)
    return wrap
  }

  async function load(event) {
    if (event && typeof event.preventDefault === 'function') event.preventDefault()
    const seq = ++loadSeq
    scope.textContent = '正在统计…'
    const params = {}
    if (state.chat) {
      params.chatKind = state.chat.kind
      params.chatId = state.chat.id
    }
    if (String(keyword.value || '').trim() !== '') params.keyword = String(keyword.value).trim()
    if (String(since.value || '').trim() !== '') params.since = String(since.value).trim()
    if (String(until.value || '').trim() !== '') params.until = String(until.value).trim()
    try {
      const payload = await api.get('/api/stats', params)
      // A second submit while the first is still running decides for itself.
      if (closed || seq !== loadSeq) return
      data = payload
      scope.textContent = state.chat
        ? `${state.chat.name || state.chat.id} · ${data.total} 条`
        : `全部会话 · ${data.total} 条`
      render()
    } catch (error) {
      if (!closed && seq === loadSeq) scope.textContent = `统计失败：${error.message}`
    }
  }

  function saveCsv() {
    if (!data) {
      scope.textContent = '先统计一次，再导出 CSV。'
      return
    }
    const blob = new Blob([statsCsv(data)], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = 'qqnt-stats.csv'
    link.click()
    URL.revokeObjectURL(url)
  }

  async function fillChats() {
    try {
      const payload = await api.get('/api/sessions')
      if (closed) return
      for (const session of payload?.sessions || []) {
        const option = document.createElement('option')
        option.value = `${session.kind}:${session.id}`
        option.textContent = session.name || session.id
        chatSelect.append(option)
        if (state.chat && state.chat.kind === session.kind
          && String(session.id) === String(state.chat.id)) {
          chatSelect.value = option.value
        }
      }
    } catch {
      // "All chats" remains available.
    }
  }

  chatSelect.addEventListener('change', () => {
    const value = String(chatSelect.value || '')
    if (value === '') {
      state.chat = null
    } else {
      const index = value.indexOf(':')
      // The option label is the display name; without it the heading fell back
      // to the raw chat id right after the reader picked a chat.
      const option = [...(chatSelect.children || [])].find((child) => child.value === value)
      const name = String(option ? (option.textContent || '') : '').trim()
      state.chat = { kind: value.slice(0, index), id: value.slice(index + 1), name }
    }
  })
  form.addEventListener('submit', load)
  csv.addEventListener('click', saveCsv)

  // One load, after the picker is filled: the old pair (`fillChats().then(load)`
  // plus an immediate `load()`) asked for the same numbers twice and let the
  // slower answer of the two win the render.
  fillChats().then(() => load())

  return () => {
    closed = true
    section.remove()
  }
}
