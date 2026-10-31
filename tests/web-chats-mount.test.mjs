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

import {
  mountChats, pushSaved, readList, savedLabel,
} from '../web/js/views/chats.js'
import { findByClass, installDocument, makeElement, textOf } from './support/dom.mjs'

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
    const aside = findByClass(shell, 'app-sidebar')
    const main = findByClass(shell, 'chat-main')
    const filter = findByClass(aside, 'chat-filter')
    const hint = findByClass(aside, 'hint')
    const list = findByClass(aside, 'chat-list')
    assert.equal(filter.tagName, 'input')
    assert.match(hint.textContent, /2 \/ 2 个会话/)
    assert.equal(list.children.length, 2)
    assert.match(textOf(list.children[0]), /课程群/)
    assert.match(textOf(findByClass(main, 'chat-title')), /课程群/)

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
    const aside = findByClass(root, 'app-sidebar')
    const hint = findByClass(aside, 'hint')
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
    const hint = findByClass(findByClass(root, 'app-sidebar'), 'hint')
    assert.match(hint.textContent, /索引正在建立/)
  } finally {
    cleanup()
    restore()
  }
})

test('a media match is badged so a keyword hit inside a screenshot reads correctly', async () => {
  const restore = installDocument()
  const api = {
    get: async (path) => {
      if (path === '/api/sessions') return { sessions }
      return {
        rows: [{ ts: 1730000000, sender: '小林', text: '见图', sources: ['ocr'], snippet: '课程安排：402 教室' }],
        total: 1,
      }
    },
  }
  const root = makeElement('main')
  const cleanup = mountChats(root, { api })
  try {
    await new Promise((resolve) => setTimeout(resolve, 0))
    await new Promise((resolve) => setTimeout(resolve, 0))
    const row = findByClass(root, 'msg-list').children[0]
    assert.match(textOf(row), /图片文字/)
    assert.doesNotMatch(textOf(row), /语音转写/)
  } finally {
    cleanup()
    restore()
  }
})

test('searching sends the keyword and shows where a media hit came from', async () => {
  const restore = installDocument()
  const calls = []
  const api = {
    get: async (path, params) => {
      calls.push({ path, params })
      if (path === '/api/sessions') return { sessions }
      if (params && params.keyword) {
        return {
          total: 1,
          rows: [{
            ts: 1730000000, sender: '小林', text: '见图', sources: ['ocr'],
            snippet: '课程安排：402 教室', chatName: '示例课程群',
          }],
        }
      }
      return { rows, total: 2 }
    },
  }
  const root = makeElement('main')
  const cleanup = mountChats(root, { api })
  try {
    await new Promise((resolve) => setTimeout(resolve, 0))
    const main = findByClass(root, 'chat-main')
    const form = findByClass(main, 'chat-search')
    const input = findByClass(form, 'chat-search-input')
    input.value = '402'
    form.dispatch('submit')
    await new Promise((resolve) => setTimeout(resolve, 0))

    const search = calls.find((call) => call.params && call.params.keyword === '402')
    assert.ok(search, 'a keyword request must be made')
    assert.equal(search.params.order, 'desc')
    assert.equal(search.params.sources, undefined, 'media search is on by default')

    const hit = findByClass(main, 'msg-list').children[0]
    assert.match(textOf(hit), /图片文字/)
    assert.match(textOf(hit), /示例课程群/)
    assert.match(textOf(findByClass(main, 'chat-title')), /402/)
  } finally {
    cleanup()
    restore()
  }
})

test('an initial chat with a message id opens that window, not the newest page', async () => {
  const restore = installDocument()
  const calls = []
  const api = {
    get: async (path, params) => {
      calls.push({ path, params })
      if (path === '/api/sessions') return { sessions }
      return { rows, total: 42, offset: 0, limit: 50, anchor: params.around }
    },
  }
  const root = makeElement('main')
  mountChats(root, { api, initial: { kind: 'private', id: 'u_abc', around: 9001 } })
  try {
    await new Promise((resolve) => setTimeout(resolve, 0))
    await new Promise((resolve) => setTimeout(resolve, 0))
    const last = calls.at(-1)
    assert.equal(last.params.chatKind, 'private')
    assert.equal(last.params.chatId, 'u_abc')
    assert.equal(last.params.around, 9001)
    // `around` already centres the window; a stale offset would be ignored
    // server-side but makes the request harder to read.
    assert.equal(last.params.offset, undefined)
    const shell = root.children[0]
    assert.match(textOf(findByClass(shell, 'chat-title')), /小林/)
  } finally {
    restore()
  }
})

test('a message with a downloaded image renders a thumbnail that opens the original', async () => {
  const restore = installDocument()
  const api = {
    get: async (path) => {
      if (path === '/api/sessions') return { sessions }
      return {
        rows: [{ ts: 1730000000, sender: '小林', text: '[图片]', rowId: 9, imageSeq: 2 }],
        total: 1, offset: 0, limit: 50,
      }
    },
  }
  const root = makeElement('main')
  const cleanup = mountChats(root, { api })
  try {
    await new Promise((resolve) => setTimeout(resolve, 0))
    await new Promise((resolve) => setTimeout(resolve, 0))
    const shell = root.children[0]
    const thumb = findByClass(shell, 'msg-thumb')
    assert.match(thumb.src, /\/api\/media\/9\?seq=2&thumb=1/)
    thumb.dispatch('click')
    const lightbox = findByClass(shell, 'media-lightbox')
    assert.equal(lightbox.hidden, false)
    assert.match(findByClass(lightbox, 'media-lightbox-image').src, /\/api\/media\/9\?seq=2$/)
    findByClass(lightbox, 'media-lightbox-close').dispatch('click')
    assert.equal(lightbox.hidden, true)
  } finally {
    cleanup()
    restore()
  }
})

test('the album button lists the chat images and pages through them', async () => {
  const restore = installDocument()
  const asked = []
  const api = {
    get: async (path, params) => {
      if (path === '/api/sessions') return { sessions }
      if (path === '/api/media/list') {
        asked.push(params)
        return {
          total: 2,
          items: [{ rowId: 11, seq: 1, name: 'a.png' }, { rowId: 12, seq: 1, name: 'b.png' }],
        }
      }
      return { rows, total: 2, offset: 0, limit: 50 }
    },
  }
  const root = makeElement('main')
  const cleanup = mountChats(root, { api })
  try {
    await new Promise((resolve) => setTimeout(resolve, 0))
    await new Promise((resolve) => setTimeout(resolve, 0))
    const shell = root.children[0]
    const buttons = findByClass(shell, 'chat-search').children
    const albumButton = buttons.find((item) => textOf(item) === '相册')
    albumButton.dispatch('click')
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.deepEqual(asked, [{ chatKind: 'group', chatId: '111', offset: 0, limit: 60 }])
    const panel = findByClass(shell, 'album-panel')
    assert.equal(panel.hidden, false)
    assert.equal(findByClass(panel, 'album-grid').children.length, 2)
    assert.match(textOf(panel), /本机图片 2 张/)
    findByClass(panel, 'album-thumb').dispatch('click')
    assert.equal(findByClass(shell, 'media-lightbox').hidden, false)
  } finally {
    cleanup()
    restore()
  }
})

function fakeStorage() {
  const map = new Map()
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)) },
    removeItem: (key) => { map.delete(key) },
  }
}

test('saved searches are de-duplicated by filter combination', () => {
  const one = { chat: { kind: 'group', id: '1', name: '群' }, keyword: 'a', sender: '', since: '', until: '' }
  const two = { ...one, keyword: 'b' }
  let rows = pushSaved([], one)
  rows = pushSaved(rows, one)
  assert.equal(rows.length, 1)
  rows = pushSaved(rows, two)
  assert.deepEqual(rows.map((row) => row.keyword), ['b', 'a'])
  assert.match(savedLabel(two), /群 · 关键词「b」/)
  assert.equal(readList(null, 'x').length, 0)
  assert.deepEqual(readList({ getItem: () => '{bad' }, 'x'), [])
})

test('a search is remembered and can be saved, replayed and deleted', async () => {
  const restore = installDocument()
  globalThis.localStorage = fakeStorage()
  try {
    const calls = []
    const api = {
      get: async (path, params) => {
        calls.push({ path, params })
        if (path === '/api/sessions') return { sessions }
        return { rows, total: 2 }
      },
      post: async () => ({}),
    }
    const root = makeElement('main')
    const cleanup = mountChats(root, { api })
    await new Promise((resolve) => setTimeout(resolve, 0))
    await new Promise((resolve) => setTimeout(resolve, 0))
    const shell = root.children[0]
    const form = findByClass(shell, 'chat-search')
    findByClass(form, 'chat-search-input').value = '402'
    form.dispatch('submit')
    await new Promise((resolve) => setTimeout(resolve, 20))

    const history = findByClass(shell, 'chat-search').children
      .find((item) => item.tagName === 'datalist')
    assert.equal(history.children[0].value, '402')

    const save = findByClass(shell, 'chat-search').children
      .find((item) => textOf(item) === '保存搜索')
    save.dispatch('click')
    const savedRow = findByClass(shell, 'saved-list').children[0]
    assert.match(textOf(savedRow), /402/)

    const before = calls.filter((call) => call.params?.keyword === '402').length
    savedRow.children[0].dispatch('click')
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.ok(calls.filter((call) => call.params?.keyword === '402').length > before)

    savedRow.children[1].dispatch('click')
    assert.equal(findByClass(shell, 'saved-list').children.length, 0)
    assert.equal(globalThis.localStorage.getItem('qqnt.savedSearches'), '[]')
  } finally {
    delete globalThis.localStorage
    restore()
  }
})

test('batch selection exports the checked sessions as one bundle', async () => {
  const restore = installDocument()
  try {
    let exported = null
    const api = {
      get: async (path) => (path === '/api/sessions'
        ? { sessions }
        : { rows, total: 2 }),
      post: async () => ({}),
    }
    const root = makeElement('main')
    const cleanup = mountChats(root, { api, onExportBatch: (chats) => { exported = chats } })
    await new Promise((resolve) => setTimeout(resolve, 0))
    await new Promise((resolve) => setTimeout(resolve, 0))
    const shell = root.children[0]
    const items = findByClass(shell, 'chat-list').children
    const check = items[1].children[0]
    check.checked = true
    check.dispatch('click')
    const bar = findByClass(shell, 'batch-bar')
    assert.equal(bar.hidden, false)
    assert.match(textOf(bar), /已选 1 个会话/)

    const exportButton = bar.children.find((item) => textOf(item) === '导出选中（ZIP）')
    exportButton.dispatch('click')
    assert.deepEqual(exported, [{ kind: 'private', id: 'u_abc', label: '小林' }])

    const clear = bar.children.find((item) => textOf(item) === '清空')
    clear.dispatch('click')
    assert.equal(findByClass(shell, 'batch-bar').hidden, true)
  } finally {
    restore()
  }
})

test('pin, rename and hide go through /api/chats/state', async () => {
  const restore = installDocument()
  try {
    const posts = []
    const api = {
      get: async (path) => (path === '/api/sessions'
        ? { sessions }
        : { rows, total: 2 }),
      post: async (path, body) => {
        posts.push({ path, body })
        return { key: 'group:111', state: { pinned: true } }
      },
    }
    globalThis.window = { prompt: () => '新名字' }
    const root = makeElement('main')
    const cleanup = mountChats(root, { api })
    await new Promise((resolve) => setTimeout(resolve, 0))
    await new Promise((resolve) => setTimeout(resolve, 0))
    const shell = root.children[0]
    const actions = findByClass(shell, 'chat-actions')
    assert.ok(actions)
    const buttons = actions.children
    buttons.find((item) => textOf(item) === '置顶').dispatch('click')
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.deepEqual(posts[0], {
      path: '/api/chats/state',
      body: { kind: 'group', id: '111', patch: { pinned: true } },
    })
    buttons.find((item) => textOf(item) === '改名').dispatch('click')
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.deepEqual(posts[1].body.patch, { alias: '新名字' })
    buttons.find((item) => textOf(item) === '隐藏').dispatch('click')
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.deepEqual(posts[2].body.patch, { hidden: true })
  } finally {
    delete globalThis.window
    restore()
  }
})

test('a cross-chat hit opens its conversation at that message', async () => {
  const restore = installDocument()
  const calls = []
  const api = {
    get: async (path, params) => {
      calls.push({ path, params })
      if (path === '/api/sessions') return { sessions }
      if (params && params.keyword) {
        return {
          total: 1,
          rows: [{
            ts: 1730000000, sender: '小林', text: '命中', keyword: 'x',
            chatKind: 'private', chatId: 'u_abc', chatName: '小林', rowId: 77,
          }],
        }
      }
      return { rows, total: 2 }
    },
  }
  const root = makeElement('main')
  const cleanup = mountChats(root, { api })
  try {
    await new Promise((resolve) => setTimeout(resolve, 0))
    await new Promise((resolve) => setTimeout(resolve, 0))
    const shell = root.children[0]
    const form = findByClass(shell, 'chat-search')
    findByClass(form, 'chat-search-input').value = '命中'
    form.dispatch('submit')
    await new Promise((resolve) => setTimeout(resolve, 20))
    findByClass(shell, 'msg-list').children[0].dispatch('click')
    await new Promise((resolve) => setTimeout(resolve, 20))
    const last = calls.at(-1)
    assert.equal(last.path, '/api/messages')
    assert.equal(last.params.chatId, 'u_abc')
    assert.equal(last.params.around, 77)
  } finally {
    cleanup()
    restore()
  }
})
