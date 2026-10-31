/**
 * Statistics view: the CSV must match the screen, and a bar must stay readable.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { barWidth, mountStats, peak, statsCsv, statsRows } from '../web/js/views/stats.js'
import { findByClass, installDocument, makeElement, textOf } from './support/dom.mjs'

const tick = () => new Promise((resolve) => setTimeout(resolve, 20))

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
