/**
 * The export page and its derived rules.
 *
 * The rules matter more than the markup: a bundle is always a ZIP, inline
 * images are always a single HTML, and a CSV with no columns still exports the
 * default set. These cases pin the body that goes to `POST /api/export` so the
 * server-side validation and the form cannot drift apart.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  containerFor, downloadHref, exportBody, jobStateLabel, mountExport,
} from '../web/js/views/export.js'
import { findAllByClass, findByClass, installDocument, makeElement, textOf } from './support/dom.mjs'

const tick = () => new Promise((resolve) => setTimeout(resolve, 20))

test('a bundle becomes a zip and inline images stay a single file', () => {
  assert.equal(containerFor({ format: 'txt' }), 'txt')
  assert.equal(containerFor({ format: 'csv', chatCount: 1 }), 'csv')
  assert.equal(containerFor({ format: 'csv', chatCount: 3 }), 'zip')
  assert.equal(containerFor({ format: 'html', media: true }), 'zip')
  assert.equal(containerFor({ format: 'html', split: true }), 'zip')
  assert.equal(containerFor({ format: 'txt', password: 'abcd' }), 'zip')
  assert.equal(containerFor({ format: 'html', embed: true, media: true }), 'html')
})

test('exportBody keeps only the values the server needs', () => {
  const body = exportBody({
    format: 'csv', redact: 'names', chat: { kind: 'group', id: '123', label: '示例课程群' },
    chatCount: 1, keyword: ' 开会 ', sender: '', since: '2026-01-01',
    columns: ['time', 'text'], frontMatter: true, media: true,
  })
  assert.deepEqual(body, {
    format: 'csv',
    redact: 'names',
    chatKind: 'group',
    chatId: '123',
    keyword: '开会',
    since: '2026-01-01',
    media: true,
    columns: ['time', 'text'],
  })
})

test('front matter and columns only travel with their format', () => {
  const md = exportBody({ format: 'md', frontMatter: true, columns: ['text'] })
  assert.equal(md.frontMatter, true)
  assert.equal(md.columns, undefined)
  const txt = exportBody({ format: 'txt', frontMatter: true, columns: ['text'] })
  assert.equal(txt.frontMatter, undefined)
})

test('jobStateLabel reads the result, not just the state', () => {
  assert.equal(jobStateLabel({ state: 'queued' }), '排队中')
  assert.equal(jobStateLabel({ state: 'running', progress: 0.4 }), '导出中 40%')
  assert.match(jobStateLabel({
    state: 'done',
    result: { rows: 12, bytes: 2048, encrypted: true, media: { files: 3 } },
  }), /12 条 · 2\.0 KB · 媒体 3 个 · 加密/)
  assert.equal(jobStateLabel({ state: 'failed' }), '失败')
  assert.equal(jobStateLabel({ state: 'canceled' }), '已取消')
  assert.equal(downloadHref({ id: 'abc', state: 'done' }), '/api/jobs/abc/download')
  assert.equal(downloadHref({ id: 'abc', state: 'running' }), '')
})

test('submitting the form posts one export job for the chosen chat', async () => {
  const restore = installDocument()
  const posted = []
  const api = {
    get: async (path) => {
      if (path === '/api/sessions') {
        return { sessions: [{ kind: 'group', id: '123', name: '示例课程群', messages: 3 }] }
      }
      if (path === '/api/presets') return { presets: [] }
      return { jobs: [] }
    },
    post: async (path, body) => {
      posted.push({ path, body })
      return { id: 'job1', kind: 'export', summary: '导出 TXT', state: 'queued' }
    },
  }
  const root = makeElement('main')
  const cleanup = mountExport(root, {
    api, initialChat: { kind: 'group', id: '123', name: '示例课程群' },
  })
  try {
    await tick()
    findByClass(root, 'export-form').dispatch('submit')
    await tick()
    assert.equal(posted.length, 1)
    assert.equal(posted[0].path, '/api/export')
    assert.equal(posted[0].body.format, 'txt')
    assert.equal(posted[0].body.chatKind, 'group')
    assert.equal(posted[0].body.chatId, '123')
    assert.equal(posted[0].body.chats, undefined)
    assert.match(textOf(root), /已加入导出队列/)
  } finally {
    cleanup()
    restore()
  }
})

test('a finished task offers a download and a failed one a retry', async () => {
  const restore = installDocument()
  const api = {
    get: async (path) => {
      if (path === '/api/sessions') return { sessions: [] }
      if (path === '/api/presets') return { presets: [] }
      return {
        jobs: [
          { id: 'done1', kind: 'export', summary: '导出 ZIP', state: 'done',
            result: { rows: 5, bytes: 1024, format: 'zip' }, canCancel: false },
          { id: 'fail1', kind: 'export', summary: '导出 TXT', state: 'failed',
            error: '磁盘满了', canCancel: false, canRetry: true },
        ],
      }
    },
    post: async () => ({}),
  }
  const root = makeElement('main')
  const cleanup = mountExport(root, { api })
  try {
    await tick()
    const rows = findByClass(root, 'export-tasks').children
    assert.equal(rows.length, 2)
    const download = rows[0].children[2].children
      .find((item) => item.tagName === 'a')
    assert.equal(download.attributes.href, undefined)
    assert.equal(download.href, '/api/jobs/done1/download')
    assert.equal(textOf(rows[0]), '导出 ZIP5 条 · 1.0 KB下载')
    const retry = rows[1].children[2].children
      .find((item) => item.tagName === 'button' && textOf(item) === '重试')
    assert.ok(retry)
  } finally {
    cleanup()
    restore()
  }
})

test('a batch selection goes out as chats and derives a zip', async () => {
  const restore = installDocument()
  const posted = []
  const api = {
    get: async (path) => {
      if (path === '/api/sessions') {
        return {
          sessions: [
            { kind: 'group', id: '123', name: '示例课程群', messages: 3 },
            { kind: 'private', id: 'u9', name: '小林', messages: 2 },
          ],
        }
      }
      if (path === '/api/presets') return { presets: [] }
      return { jobs: [] }
    },
    post: async (path, body) => {
      posted.push({ path, body })
      return { id: 'job2', kind: 'export', summary: '导出 ZIP', state: 'queued' }
    },
  }
  const root = makeElement('main')
  const cleanup = mountExport(root, {
    api,
    initialChats: [
      { kind: 'group', id: '123', label: '示例课程群' },
      { kind: 'private', id: 'u9', label: '小林' },
    ],
  })
  try {
    await tick()
    assert.match(textOf(findByClass(root, 'export-derived')), /下载：ZIP/)
    findByClass(root, 'export-form').dispatch('submit')
    await tick()
    assert.deepEqual(posted[0].body.chats, [
      { kind: 'group', id: '123', label: '示例课程群' },
      { kind: 'private', id: 'u9', label: '小林' },
    ])
    assert.equal(posted[0].body.label, '批量导出 2 个会话')
  } finally {
    cleanup()
    restore()
  }
})

test('picking 内嵌图片 clears the options it disables before submitting', async () => {
  const restore = installDocument()
  const posted = []
  const api = {
    get: async (path) => {
      if (path === '/api/sessions') return { sessions: [] }
      if (path === '/api/presets') return { presets: [] }
      return { jobs: [] }
    },
    post: async (path, body) => {
      posted.push({ path, body })
      return { id: 'job1', kind: 'export', summary: '导出 HTML', state: 'queued' }
    },
  }
  const root = makeElement('main')
  const cleanup = mountExport(root, {
    api, initialChat: { kind: 'group', id: '123', name: '示例课程群' },
  })
  const box = (label) => {
    const wrap = findAllByClass(root, 'check').find((node) => textOf(node).includes(label))
    return wrap && wrap.children.find((child) => child.tagName === 'input')
  }
  try {
    await tick()
    box('按天分文件').checked = true
    const password = findAllByClass(root, 'export-password')[0]
    password.value = 'abcd'
    box('内嵌图片').checked = true
    box('内嵌图片').dispatch('change')
    findByClass(root, 'export-form').dispatch('submit')
    await tick()
    assert.equal(posted.length, 1)
    assert.equal(posted[0].body.embed, true)
    assert.equal(posted[0].body.split, undefined, 'split must not ride along with embed')
    assert.equal(posted[0].body.password, undefined, 'password must not ride along with embed')
    assert.equal(box('按天分文件').checked, false)
    assert.equal(password.value, '')
  } finally {
    cleanup()
    restore()
  }
})

/** First element in the subtree whose own text is exactly `text`. */
function byText(node, text) {
  if (typeof node.textContent === 'string' && node.textContent === text) return node
  for (const child of node.children || []) {
    const found = byText(child, text)
    if (found) return found
  }
  return null
}

test('saving a preset updates the dropdown instead of throwing or duplicating', async () => {
  const restore = installDocument()
  const previousWindow = globalThis.window
  globalThis.window = { prompt: () => '我的预设' }
  let stored = []
  const api = {
    get: async (path) => {
      if (path === '/api/sessions') return { sessions: [] }
      if (path === '/api/presets') return { presets: stored }
      return { jobs: [] }
    },
    post: async (path, body) => {
      if (path === '/api/presets') {
        // The server merges one preset and answers with the whole list.
        stored = [...stored.filter((item) => item.name !== body.add.name), body.add]
        return { presets: stored }
      }
      return { id: 'job1', state: 'queued' }
    },
  }
  const root = makeElement('main')
  const cleanup = mountExport(root, { api })
  try {
    await tick()
    // A browser selects the first option ('txt') by default; the shim has no
    // option machinery, so the test states it explicitly.
    findByClass(root, 'export-format').value = 'txt'
    const save = byText(root, '存为预设')
    assert.ok(save, 'the export page must offer 存为预设')
    save.dispatch('click')
    await tick()

    const picker = findByClass(root, 'export-preset')
    const saved = picker.children.filter((option) => option.value === '我的预设')
    assert.equal(saved.length, 1)
    assert.match(saved[0].dataset.preset, /"format":"txt"/)
    assert.match(textOf(root), /已保存预设「我的预设」/)
    assert.doesNotMatch(textOf(root), /保存预设失败/)

    // Saving the same name with another format replaces the old copy: no stale
    // duplicate may win the lookup in the change handler.
    findByClass(root, 'export-format').value = 'json'
    byText(root, '存为预设').dispatch('click')
    await tick()
    const again = findByClass(root, 'export-preset').children
      .filter((option) => option.value === '我的预设')
    assert.equal(again.length, 1)
    assert.match(again[0].dataset.preset, /"format":"json"/)
    assert.equal(stored.length, 1)
  } finally {
    cleanup()
    restore()
    if (previousWindow === undefined) delete globalThis.window
    else globalThis.window = previousWindow
  }
})
