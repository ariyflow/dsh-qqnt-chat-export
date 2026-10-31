/**
 * The session reader's DOM half, driven through a tiny document shim.
 *
 * This is not a browser: the shim only implements what `chats.js` touches. It
 * exists to catch the mistakes a pure-helper test cannot see — a typo in a
 * property name, a listener bound to a detached node, a view that never
 * clears its list.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { mountChats } from '../web/js/views/chats.js'
import { installDocument, makeElement, textOf } from './support/dom.mjs'

const sessions = [
  { kind: 'group', id: '111', name: '课程群', messages: 42, lastTime: '2026-10-30 12:00' },
  { kind: 'private', id: 'u_abc', name: '小林', qq: '10001', messages: 7, lastTime: '2026-10-28 18:30' },
]

const rows = [
  { ts: 1730000000, sender: '小林', qq: '10001', text: '第一条' },
  { ts: 1730000100, sender: '老师', qq: '10002', text: '第二条' },
]

test('mounting renders the sessions, selects the first and loads its page', async () => {
  const restore = installDocument()
  const calls = []
  const api = {
    get: async (path, params) => {
      calls.push({ path, params })
      if (path === '/api/sessions') return { sessions }
      return { rows, total: 2, offset: 0, limit: 50 }
    },
  }
  const root = makeElement('main')
  const cleanup = mountChats(root, { api })
  try {
    // Two awaits: one for /api/sessions, one for the follow-up /api/messages.
    await new Promise((resolve) => setTimeout(resolve, 0))
    await new Promise((resolve) => setTimeout(resolve, 0))

    assert.equal(calls[0].path, '/api/sessions')
    assert.equal(calls[1].path, '/api/messages')
    assert.equal(calls[1].params.chatId, '111')
    assert.equal(calls[1].params.order, 'desc')

    const shell = root.children[0]
    const [aside, main] = shell.children
    const [filter, hint, list] = aside.children
    assert.equal(filter.tagName, 'input')
    assert.match(hint.textContent, /2 \/ 2 个会话/)
    assert.equal(list.children.length, 2)
    assert.match(textOf(list.children[0]), /课程群/)
    assert.match(textOf(main.children[0]), /课程群/)

    // Clicking the second session loads it.
    list.children[1].dispatch('click')
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.equal(calls.at(-1).params.chatId, 'u_abc')
  } finally {
    cleanup()
    restore()
  }
})

test('mounting without an index explains what to do instead of throwing', async () => {
  const restore = installDocument()
  const api = {
    get: async (path) => {
      if (path === '/api/sessions') return { sessions: [] }
      return { rows: [], total: 0 }
    },
  }
  const root = makeElement('main')
  const cleanup = mountChats(root, { api })
  try {
    await new Promise((resolve) => setTimeout(resolve, 0))
    const aside = root.children[0].children[0]
    const hint = aside.children[1]
    assert.match(hint.textContent, /还没有会话/)
  } finally {
    cleanup()
    restore()
  }
})

test('a failing sessions request is surfaced in the sidebar hint', async () => {
  const restore = installDocument()
  const api = {
    get: async () => {
      throw new Error('索引正在建立')
    },
  }
  const root = makeElement('main')
  const cleanup = mountChats(root, { api })
  try {
    await new Promise((resolve) => setTimeout(resolve, 0))
    const hint = root.children[0].children[0].children[1]
    assert.match(hint.textContent, /索引正在建立/)
  } finally {
    cleanup()
    restore()
  }
})
