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

    // Save with a sidebar filter too: replaying it must restore the filter.
    const filter = findByClass(shell, 'chat-filter')
    filter.value = '课程'
    filter.dispatch('input')
    const save = findByClass(shell, 'chat-search').children
      .find((item) => textOf(item) === '保存搜索')
    save.dispatch('click')
    const savedRow = findByClass(shell, 'saved-list').children[0]
    assert.match(textOf(savedRow), /402/)
    filter.value = ''
    filter.dispatch('input')
    assert.match(textOf(findByClass(shell, 'hint')), /2 \/ 2 个会话/)

    const before = calls.filter((call) => call.params?.keyword === '402').length
    // Clearing the filter re-renders the saved list, so re-read the row.
    findByClass(shell, 'saved-list').children[0].children[0].dispatch('click')
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.ok(calls.filter((call) => call.params?.keyword === '402').length > before)
    assert.equal(filter.value, '课程', 'the saved list filter comes back')
    assert.match(textOf(findByClass(shell, 'hint')), /1 \/ 2 个会话/)

    findByClass(shell, 'saved-list').children[0].children[1].dispatch('click')
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

test('search results offer "export these chats" for the distinct hits', async () => {
  const restore = installDocument()
  try {
    const exported = []
    const api = {
      get: async (path, params) => {
        if (path === '/api/sessions') return { sessions }
        if (params && params.keyword) {
          return {
            total: 3,
            rows: [
              { ts: 1, sender: '甲', text: 'a', chatKind: 'group', chatId: '111', chatName: '课程群', rowId: 1 },
              { ts: 2, sender: '乙', text: 'b', chatKind: 'group', chatId: '111', chatName: '课程群', rowId: 2 },
              { ts: 3, sender: '丙', text: 'c', chatKind: 'private', chatId: 'u_abc', chatName: '小林', rowId: 3 },
            ],
          }
        }
        return { rows, total: 2 }
      },
      post: async () => ({}),
    }
    const root = makeElement('main')
    const cleanup = mountChats(root, { api, onExportBatch: (chats) => exported.push(chats) })
    await new Promise((resolve) => setTimeout(resolve, 0))
    await new Promise((resolve) => setTimeout(resolve, 0))
    const shell = root.children[0]
    const form = findByClass(shell, 'chat-search')
    findByClass(form, 'chat-search-input').value = 'a'
    form.dispatch('submit')
    await new Promise((resolve) => setTimeout(resolve, 20))

    const bar = findByClass(shell, 'hit-bar')
    assert.equal(bar.hidden, false)
    assert.match(textOf(bar), /命中 3 条 · 2 个会话/)
    bar.children.find((item) => textOf(item) === '导出这些会话').dispatch('click')
    assert.deepEqual(exported, [[
      { kind: 'group', id: '111', label: '课程群' },
      { kind: 'private', id: 'u_abc', label: '小林' },
    ]])
  } finally {
    restore()
  }
})

/** A page of rows whose text says which chat they belong to. */
function page(chat, texts) {
  return {
    total: texts.length,
    offset: 0,
    limit: 50,
    rows: texts.map((text) => ({ ts: 1730000000, sender: chat, text })),
  }
}

test('a slow page for the previous chat never paints into the new one', async () => {
  const restore = installDocument()
  const pending = new Map()
  const api = {
    get: (path, params) => {
      if (path === '/api/sessions') return Promise.resolve({ sessions })
      return new Promise((resolve) => pending.set(params.chatId, resolve))
    },
  }
  const root = makeElement('main')
  const cleanup = mountChats(root, { api })
  try {
    await new Promise((resolve) => setTimeout(resolve, 0))
    const shell = root.children[0]
    const list = findByClass(shell, 'chat-list')
    const main = findByClass(shell, 'chat-main')
    const msgList = findByClass(main, 'msg-list')
    const title = findByClass(main, 'chat-title')

    pending.get('111')(page('老师', ['第一条']))
    pending.clear()
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.equal(msgList.children.length, 1)

    // Open the private chat, then immediately go back to the group one. Both
    // requests are still running; the group answer lands first, the private one
    // last - which is exactly the order that used to show the wrong chat.
    list.children[1].dispatch('click')
    list.children[0].dispatch('click')
    const newest = pending.get('111')
    const stale = pending.get('u_abc')
    pending.clear()
    assert.ok(stale, 'the superseded request must still be in flight')

    newest(page('老师', ['第二条']))
    await new Promise((resolve) => setTimeout(resolve, 0))
    stale(page('小林', ['不该出现的私聊']))
    await new Promise((resolve) => setTimeout(resolve, 0))

    assert.match(title.textContent, /课程群/)
    assert.equal(msgList.children.length, 1)
    assert.match(textOf(msgList), /第二条/)
    assert.doesNotMatch(textOf(msgList), /不该出现/)
  } finally {
    cleanup()
    restore()
  }
})

test('two quick "载入更早" clicks append one page, not two copies', async () => {
  const restore = installDocument()
  const pending = []
  const api = {
    get: (path, params) => {
      if (path === '/api/sessions') return Promise.resolve({ sessions })
      return new Promise((resolve) => pending.push(resolve))
    },
  }
  const root = makeElement('main')
  const cleanup = mountChats(root, { api })
  try {
    await new Promise((resolve) => setTimeout(resolve, 0))
    pending.shift()({ total: 4, offset: 0, limit: 2, rows: [
      { ts: 2, sender: '甲', text: '第二页首条' },
      { ts: 1, sender: '甲', text: '第二页次条' },
    ] })
    await new Promise((resolve) => setTimeout(resolve, 0))
    const shell = root.children[0]
    const main = findByClass(shell, 'chat-main')
    const msgList = findByClass(main, 'msg-list')
    const more = main.children.find((item) => textOf(item) === '载入更早')
    assert.equal(more.hidden, false)

    more.dispatch('click')
    more.dispatch('click')
    pending.shift()(page('甲', ['甲页']))
    pending.shift()(page('甲', ['乙页']))
    await new Promise((resolve) => setTimeout(resolve, 0))
    // Two rows from the first page plus one appended page: the older of the two
    // "载入更早" answers is dropped instead of being appended a second time.
    assert.equal(msgList.children.length, 3)
    assert.match(textOf(msgList), /乙页/)
    assert.doesNotMatch(textOf(msgList), /甲页/)
  } finally {
    cleanup()
    restore()
  }
})

test('an anchored window goes back to the newest instead of appending an offset', async () => {
  const restore = installDocument()
  const calls = []
  const hit = { ts: 9, sender: '甲', text: '命中', chatKind: 'group', chatId: '111', chatName: '课程群', rowId: 7 }
  const api = {
    get: async (path, params) => {
      calls.push({ path, params })
      if (path === '/api/sessions') return { sessions }
      if (params.keyword) return { total: 1, rows: [hit] }
      if (params.around) {
        return { total: 200, offset: 0, limit: 50, rows: [
          { ts: 3, sender: '甲', text: '窗口甲', rowId: 8 },
          { ts: 2, sender: '甲', text: '窗口乙', rowId: 7 },
        ] }
      }
      return { total: 200, offset: 0, limit: 2, rows: [
        { ts: 9, sender: '甲', text: '最新甲' },
        { ts: 8, sender: '甲', text: '最新乙' },
      ] }
    },
  }
  const root = makeElement('main')
  const cleanup = mountChats(root, { api })
  try {
    await new Promise((resolve) => setTimeout(resolve, 0))
    const shell = root.children[0]
    const main = findByClass(shell, 'chat-main')
    const msgList = findByClass(main, 'msg-list')

    // Search, then open the hit: this asks for a window centred on the message.
    findByClass(shell, 'chat-search-input').value = '命中'
    findByClass(shell, 'chat-search').dispatch('submit')
    await new Promise((resolve) => setTimeout(resolve, 0))
    msgList.children[0].dispatch('click')
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.equal(calls.at(-1).params.around, 7)
    assert.match(textOf(msgList), /窗口甲/)
    // The message the hit pointed at is marked, so the reader knows where it is.
    const anchored = msgList.children.filter((item) => item.className.includes('is-anchor'))
    assert.equal(anchored.length, 1)
    assert.equal(anchored[0].dataset.rowId, '7')

    // "载入更早" here would ask for offset 50 of a list that is not on screen.
    const more = main.children.find((item) => textOf(item) === '回到最新')
    assert.ok(more, 'the button must say 回到最新 for an anchored window')
    assert.equal(more.hidden, false)
    more.dispatch('click')
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.equal(calls.at(-1).params.around, undefined)
    assert.equal(calls.at(-1).params.offset, 0)
    assert.match(textOf(msgList), /最新甲/)
    assert.doesNotMatch(textOf(msgList), /窗口甲/)
  } finally {
    cleanup()
    restore()
  }
})

test('the first list staggers in, selecting repaints in place, filtering does not animate', async () => {
  const restore = installDocument()
  const api = {
    get: async (path) => (path === '/api/sessions'
      ? { sessions }
      : { rows, total: 2, offset: 0, limit: 50 }),
  }
  const root = makeElement('main')
  const cleanup = mountChats(root, { api })
  try {
    await new Promise((resolve) => setTimeout(resolve, 0))
    await new Promise((resolve) => setTimeout(resolve, 0))
    const shell = root.children[0]
    const list = findByClass(shell, 'chat-list')
    const first = list.children[0]
    const second = list.children[1]
    assert.match(first.className, /is-enter/, 'the first paint announces itself')
    assert.match(first.className, /is-active/)

    second.dispatch('click')
    await new Promise((resolve) => setTimeout(resolve, 0))
    // Same nodes: the list is not rebuilt, so the stagger cannot replay over
    // the user's click and keyboard focus stays where it was.
    assert.equal(list.children[0], first)
    assert.equal(list.children[1], second)
    assert.doesNotMatch(first.className, /is-active/)
    assert.match(second.className, /is-active/)

    // Filtering follows the keyboard: rows appear without the entrance class.
    const filter = findByClass(findByClass(shell, 'app-sidebar'), 'chat-filter')
    filter.value = '小林'
    filter.dispatch('input')
    assert.equal(list.children.length, 1)
    assert.doesNotMatch(list.children[0].className, /is-enter/)
  } finally {
    cleanup()
    restore()
  }
})

test('the single-pane layout switches between list and reader', async () => {
  const restore = installDocument()
  const api = {
    get: async (path) => (path === '/api/sessions' ? { sessions } : { rows, total: 2, offset: 0, limit: 50 }),
  }
  const root = makeElement('main')
  const cleanup = mountChats(root, { api })
  try {
    await new Promise((resolve) => setTimeout(resolve, 0))
    await new Promise((resolve) => setTimeout(resolve, 0))
    const shell = root.children[0]
    const aside = findByClass(shell, 'app-sidebar')
    const main = findByClass(shell, 'chat-main')
    // The header keeps the back button next to the title; CSS decides whether
    // it is visible (only under 720 px, where the panes do not fit together).
    const back = findByClass(main, 'chat-back')
    assert.equal(back.hidden, false)
    assert.match(textOf(back), /会话/)
    assert.equal(findByClass(main, 'chat-title').textContent.includes('课程群'), true)

    // Mounting with a chat selected goes straight to the reader.
    assert.match(shell.className, /is-reading/)

    back.dispatch('click')
    assert.doesNotMatch(shell.className, /is-reading/, 'back returns to the list')

    // Choosing a chat opens the reader again.
    findByClass(aside, 'chat-list').children[1].dispatch('click')
    assert.match(shell.className, /is-reading/)
  } finally {
    cleanup()
    restore()
  }
})
