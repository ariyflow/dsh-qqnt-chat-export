/**
 * Statistics view: the CSV must match the screen, and a bar must stay readable.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { barWidth, mountStats, peak, statsCsv, statsRows } from '../web/js/views/stats.js'
import { findAllByClass, findByClass, installDocument, makeElement, textOf } from './support/dom.mjs'

const tick = () => new Promise((resolve) => setTimeout(resolve, 20))

/** The element whose children include `target`. */
function parentOf(node, target) {
  if ((node.children || []).includes(target)) return node
  for (const child of node.children || []) {
    const found = parentOf(child, target)
    if (found) return found
  }
  return null
}

const data = {
  total: 12, chats: 2, senders: 3,
  firstTime: '2026-10-01 09:00', lastTime: '2026-10-31 22:00',
  monthly: [{ month: '2026-10', count: 12 }],
  hourly: Array.from({ length: 24 }, (_, hour) => (hour === 9 ? 12 : 0)),
  daily: [{ date: '2026-10-31', count: 12 }],
  heat: Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 0)),
  topSenders: [{ name: '小林', qq: '10001', count: 8 }, { name: '老师', qq: '', count: 4 }],
  topChats: [{ kind: 'group', id: '123', name: '示例课程群', count: 12 }],
}
data.heat[5][9] = 12

test('statsRows mirrors the panel and quotes CSV cells', () => {
  const rows = statsRows(data)
  assert.deepEqual(rows[1], ['总计', '消息', 12])
  assert.ok(rows.some((row) => row[0] === '发言人' && row[1] === '小林 (10001)'))
  const csv = statsCsv(data)
  assert.match(csv, /^"类目","名称","数量"/)
  assert.match(csv, /"发言人","小林 \(10001\)","8"/)
  assert.equal(statsCsv(null).split('\n').length, 1)
})

test('a quoted name cannot break out of its CSV cell', () => {
  const csv = statsCsv({ topSenders: [{ name: 'a"b', qq: '', count: 1 }] })
  assert.match(csv, /"发言人","a""b","1"/)
})

test('bars keep a tiny value visible and a peak at full width', () => {
  assert.equal(peak([3, 9, 1]), 9)
  assert.equal(barWidth(9, 9), 100)
  assert.equal(barWidth(0, 9), 0)
  assert.equal(barWidth(1, 1000), 2)
})

test('the view renders totals, bars and the heat grid', async () => {
  const restore = installDocument()
  const asked = []
  const api = {
    get: async (path, params) => {
      asked.push({ path, params })
      if (path === '/api/sessions') {
        return { sessions: [{ kind: 'group', id: '123', name: '示例课程群' }] }
      }
      return data
    },
  }
  const root = makeElement('main')
  const cleanup = mountStats(root, { api })
  try {
    await tick()
    const text = textOf(root)
    assert.match(text, /12 条消息 · 2 个会话 · 3 位发言人/)
    assert.match(text, /示例课程群/)
    assert.ok(findByClass(root, 'stats-heat').children.length === 7 * 24)
    const bars = findByClass(root, 'stats-blocks').children
    assert.equal(bars.length, 5)
    assert.match(textOf(bars[2]), /09:00/)
    assert.ok(asked.some((call) => call.path === '/api/stats'))
  } finally {
    cleanup()
    restore()
  }
})

test('choosing a chat scopes the request', async () => {
  const restore = installDocument()
  const asked = []
  const api = {
    get: async (path, params) => {
      asked.push({ path, params })
      if (path === '/api/sessions') {
        return { sessions: [{ kind: 'group', id: '123', name: '示例课程群' }] }
      }
      return data
    },
  }
  const root = makeElement('main')
  const cleanup = mountStats(root, {
    api, initialChat: { kind: 'group', id: '123', name: '示例课程群' },
  })
  try {
    await tick()
    const last = asked.filter((call) => call.path === '/api/stats').at(-1)
    assert.equal(last.params.chatKind, 'group')
    assert.equal(last.params.chatId, '123')
  } finally {
    cleanup()
    restore()
  }
})

test('bars and heat cells write the size to the style property', async () => {
  const restore = installDocument()
  const api = {
    get: async (asked, params) => (asked === '/api/sessions'
      ? { sessions: [{ kind: 'group', id: '123', name: '示例课程群' }] } : data),
  }
  const root = makeElement('main')
  const cleanup = mountStats(root, { api })
  try {
    await tick()
    // Assigning an object to `style` stringifies to "[object Object]" and the
    // browser drops the declaration, so the width/opacity have to be set on
    // the property itself.
    const fills = findAllByClass(root, 'stat-bar-fill')
    assert.ok(fills.length > 0, 'no bar fill rendered')
    for (const fill of fills) assert.match(String(fill.style.width), /^\d+(\.\d+)?%$/)
    const cells = findAllByClass(root, 'heat-cell')
    assert.ok(cells.length > 0)
    for (const cell of cells) assert.match(String(cell.style.opacity), /^0\.\d+$|^1$/)
  } finally {
    cleanup()
    restore()
  }
})

test('picking a chat in the picker keeps its name in the heading', async () => {
  const restore = installDocument()
  const api = {
    get: async (path) => (path === '/api/sessions'
      ? { sessions: [{ kind: 'group', id: '123', name: '示例课程群' }] }
      : data),
  }
  const root = makeElement('main')
  const cleanup = mountStats(root, { api })
  try {
    await tick()
    const select = findByClass(root, 'stats-chat')
    assert.ok(select, 'no chat picker rendered')
    // The heading used to fall back to the raw id because the picker only kept
    // `kind`/`id`; the option label is the name the reader already knows.
    select.value = 'group:123'
    select.dispatch('change')
    const form = parentOf(root, select)
    assert.ok(form, 'the picker must live in the stats form')
    form.dispatch('submit')
    await tick()
    assert.match(textOf(root), /示例课程群 · 12 条/)
    assert.doesNotMatch(textOf(root), /123 · 12 条/)
  } finally {
    cleanup()
    restore()
  }
})

test('mounting asks for the numbers once, not twice', async () => {
  const restore = installDocument()
  const asked = []
  const api = {
    get: async (path) => {
      asked.push(path)
      return path === '/api/sessions'
        ? { sessions: [{ kind: 'group', id: '123', name: '示例课程群' }] }
        : data
    },
  }
  const root = makeElement('main')
  const cleanup = mountStats(root, { api })
  try {
    await tick()
    await tick()
    assert.equal(asked.filter((path) => path === '/api/stats').length, 1)
  } finally {
    cleanup()
    restore()
  }
})
