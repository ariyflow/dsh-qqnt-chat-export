/**
 * The answer view.
 *
 * The view exists to make retrieval checkable: a question goes out, spans and
 * citations come back, and clicking a citation returns to the original message.
 * These cases assert that contract with an injected API, and that no question
 * text ever ends up in `innerHTML`-style markup (the shim has no innerHTML at
 * all, which is the point).
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { citationLabel, hitHeading, mountAsk, sourceLabels } from '../web/js/views/ask.js'
import { installDocument, makeElement, textOf } from './support/dom.mjs'

const tick = () => new Promise((resolve) => setTimeout(resolve, 15))

const hit = {
  chunk_id: 7,
  chatKind: 'group',
  chatId: '123',
  chat: '示例课程群',
  start: '2024-10-27 11:33',
  end: '2024-10-27 11:35',
  text: '小林：周五下午三点开会吧\n老师：可以，会议室在三楼',
  sources: ['text', 'ocr'],
  msg_ids: [100, 101],
  citations: [
    { id: 1, msg_id: 100, ts: 1730000000, sender: '小林', text: '周五下午三点开会吧' },
    { id: 2, msg_id: 101, ts: 1730000060, sender: '老师', text: '可以，会议室在三楼' },
  ],
}

/** Depth-first search for the first element with a class. */
function findByClass(node, name) {
  const classes = String(node.className || '').split(/\s+/)
  if (classes.includes(name)) return node
  for (const child of node.children || []) {
    const found = findByClass(child, name)
    if (found) return found
  }
  return null
}

function findAllByClass(node, name, out = []) {
  const classes = String(node.className || '').split(/\s+/)
  if (classes.includes(name)) out.push(node)
  for (const child of node.children || []) findAllByClass(child, name, out)
  return out
}

test('hitHeading numbers the span and keeps the time range', () => {
  assert.equal(hitHeading(hit, 0), '[1] 示例课程群 · 2024-10-27 11:33–11:35')
  assert.equal(hitHeading({ chatId: '9', start: '', end: '' }, 2), '[3] 9 · —–')
})

test('sourceLabels names recognized text and ignores unknown sources', () => {
  assert.deepEqual(sourceLabels(['text', 'ocr', 'asr']), ['文字', '图片文字', '语音转写'])
  assert.deepEqual(sourceLabels(['nope']), [])
  assert.deepEqual(sourceLabels(null), [])
})

test('citationLabel is one readable line', () => {
  assert.equal(citationLabel(hit.citations[0]), '小林 10-27 11:33 周五下午三点开会吧')
})

test('a question is posted and its spans are rendered', async () => {
  const restore = installDocument()
  try {
    const calls = []
    const api = {
      post: async (path, body) => {
        calls.push({ path, body })
        return { ok: true, question: body.question, hits: [hit], notes: [], keyword: 3, vector: 1 }
      },
    }
    const root = makeElement('main')
    const unmount = mountAsk(root, { api })
    const input = findByClass(root, 'ask-input')
    input.value = '  周五几点开会  '
    findByClass(root, 'ask-form').dispatch('submit')
    await tick()

    assert.deepEqual(calls, [{ path: '/api/ask', body: { question: '周五几点开会', topK: 8 } }])
    const text = textOf(root)
    assert.match(text, /\[1\] 示例课程群/)
    assert.match(text, /周五下午三点开会吧/)
    assert.match(text, /图片文字/)
    assert.match(text, /找到 1 个片段|1 个片段/)
    assert.match(findByClass(root, 'ask-status').textContent, /关键词 3 · 向量 1/)
    const shell = root.children[0]
    unmount()
    assert.equal(shell.removed, true)
  } finally {
    restore()
  }
})

test('a citation click hands the message id back to the caller', async () => {
  const restore = installDocument()
  try {
    const opened = []
    const api = {
      post: async () => ({ ok: true, hits: [hit], notes: [] }),
    }
    const root = makeElement('main')
    mountAsk(root, { api, onOpenChat: (clicked, rowId) => opened.push([clicked.chunk_id, rowId]) })
    findByClass(root, 'ask-input').value = '周五几点开会'
    findByClass(root, 'ask-form').dispatch('submit')
    await tick()

    const buttons = findAllByClass(root, 'ask-cite-button')
    assert.equal(buttons.length, 2)
    assert.match(buttons[1].textContent, /老师/)
    buttons[1].dispatch('click')
    assert.deepEqual(opened, [[7, 2]])
  } finally {
    restore()
  }
})

test('a blank question never reaches the server', async () => {
  const restore = installDocument()
  try {
    let called = 0
    const api = { post: async () => { called += 1; return {} } }
    const root = makeElement('main')
    mountAsk(root, { api })
    findByClass(root, 'ask-input').value = '   '
    findByClass(root, 'ask-form').dispatch('submit')
    await tick()
    assert.equal(called, 0)
  } finally {
    restore()
  }
})

test('an empty result shows the helper note instead of a blank page', async () => {
  const restore = installDocument()
  try {
    const api = {
      post: async () => ({
        ok: true, hits: [], notes: ['派生库还没有向量：先运行一次「分块与嵌入」'], keyword: 0, vector: 0,
      }),
    }
    const root = makeElement('main')
    mountAsk(root, { api })
    findByClass(root, 'ask-input').value = '不存在的主题'
    findByClass(root, 'ask-form').dispatch('submit')
    await tick()
    const text = textOf(root)
    assert.match(text, /没有找到相关片段/)
    assert.match(text, /分块与嵌入/)
  } finally {
    restore()
  }
})

test('the build button queues the chunks job', async () => {
  const restore = installDocument()
  try {
    const calls = []
    const api = {
      post: async (path, body) => {
        calls.push({ path, body })
        return {}
      },
    }
    const root = makeElement('main')
    mountAsk(root, { api })
    findByClass(root, 'ask-tools')
    const build = findAllByClass(root, 'ghost')[0]
    build.dispatch('click')
    await tick()
    assert.deepEqual(calls, [{ path: '/api/jobs', body: { kind: 'chunks', summary: '分块与嵌入' } }])
    assert.match(findByClass(root, 'ask-status').textContent, /已加入/)
  } finally {
    restore()
  }
})
