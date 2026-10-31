/**
 * Pure helpers of the ported session reader.
 *
 * The DOM half of `chats.js` needs a browser, but the filtering, labelling and
 * time formatting are where the parity bugs live, so they are exported and
 * covered here without a DOM shim.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { filterSessions, formatClock, sessionMeta } from '../web/js/views/chats.js'

const sessions = [
  { kind: 'group', id: '111', name: '课程群', qq: '', messages: 42, lastTime: '2026-10-30 12:00' },
  { kind: 'group', id: '222', name: '', qq: '', messages: 3, lastTime: '2026-10-29 09:00' },
  { kind: 'private', id: 'u_abc', name: '小林', qq: '10001', messages: 7, lastTime: '2026-10-28 18:30' },
]

test('an empty query keeps every session', () => {
  assert.equal(filterSessions(sessions, '').length, 3)
  assert.equal(filterSessions(sessions, '   ').length, 3)
})

test('the filter matches name, id and QQ number case-insensitively', () => {
  assert.deepEqual(filterSessions(sessions, '课程').map((s) => s.id), ['111'])
  assert.deepEqual(filterSessions(sessions, 'U_ABC').map((s) => s.id), ['u_abc'])
  assert.deepEqual(filterSessions(sessions, '10001').map((s) => s.id), ['u_abc'])
  assert.deepEqual(filterSessions(sessions, '222').map((s) => s.id), ['222'])
  assert.deepEqual(filterSessions(sessions, 'nope'), [])
})

test('a session without a name still gets a readable meta line', () => {
  assert.equal(sessionMeta(sessions[2]), '私聊 · 7 条 · 2026-10-28 18:30')
  assert.equal(sessionMeta({ kind: 'group', messages: 0 }), '群聊 · 0 条')
})

test('formatClock formats seconds and refuses nonsense', () => {
  assert.equal(formatClock(0), '—')
  assert.equal(formatClock(-5), '—')
  assert.equal(formatClock('abc'), '—')
  const formatted = formatClock(Date.UTC(2026, 9, 31, 12, 5) / 1000)
  // Local timezone: assert the shape, not the exact hour.
  assert.match(formatted, /^2026-10-31 \d{2}:\d{2}$/)
})
