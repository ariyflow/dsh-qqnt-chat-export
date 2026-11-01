/**
 * Polling lists patch their rows; they do not rebuild them.
 *
 * The task panels re-read `/api/jobs` every two seconds. A running job's
 * progress and message change on every poll, and rebuilding the row for that
 * dropped the focus of the 取消 button under the pointer (and restarted the
 * row's entrance animation for as long as the job ran). These cases pin the
 * split: structure updates rebuild, volatile text updates in place.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { createRowList } from '../web/js/rows.js'
import { makeElement, textOf } from './support/dom.mjs'

const id = (item) => String(item.id)
const signature = (item) => [item.state, item.summary, item.canCancel ? 1 : 0].join('~')

/** A row whose structure never moves, plus the text that does. */
function create(item, isEnter) {
  const node = makeElement('li')
  node.className = `row is-${item.state}${isEnter ? ' is-enter' : ''}`
  const meta = makeElement('span')
  const paint = (next) => {
    meta.textContent = `${next.progress}% ${next.message}`
  }
  paint(item)
  node.append(meta)
  return { node, update: paint }
}

const job = (name, extra = {}) => ({
  id: name, state: 'running', summary: '导出 TXT', progress: 0,
  message: '开始', canCancel: true, ...extra,
})

test('progress and message move without replacing the row', () => {
  const list = makeElement('ul')
  const render = createRowList(list, { id, signature, create })
  assert.equal(render([job('a'), job('b')]), true)
  const [first, second] = list.children
  assert.match(first.className, /is-enter/)

  assert.equal(render([
    job('a', { progress: 40, message: '一半' }),
    job('b', { progress: 10 }),
  ]), false)
  // The very same node: focus, hover and the running animation survive.
  assert.equal(list.children[0], first)
  assert.equal(list.children[1], second)
  assert.match(textOf(first), /40% 一半/)
  assert.match(textOf(second), /10% 开始/)
})

test('a state change rebuilds the rows, and only new ones animate in', () => {
  const list = makeElement('ul')
  const render = createRowList(list, { id, signature, create })
  render([job('a'), job('b')])
  const [first] = list.children

  assert.equal(render([
    job('a', { state: 'done', canCancel: false, progress: 100, message: '完成' }),
    job('b'),
    job('c'),
  ]), true)
  assert.notEqual(list.children[0], first)
  assert.match(list.children[0].className, /is-done/)
  assert.doesNotMatch(list.children[0].className, /is-enter/)
  assert.doesNotMatch(list.children[1].className, /is-enter/)
  // "c" was not on screen a moment ago, so it is the only row that lands.
  assert.match(list.children[2].className, /is-enter/)
})

test('an empty list and a repeated poll are both no-ops', () => {
  const list = makeElement('ul')
  const render = createRowList(list, { id, signature, create })
  assert.equal(render([job('a')]), true)
  assert.equal(render([job('a')]), false)
  assert.equal(render([]), true)
  assert.deepEqual(list.children, [])
  assert.equal(render([]), false)
})

test('reordering the same rows rebuilds them without a fake entrance', () => {
  const list = makeElement('ul')
  const render = createRowList(list, { id, signature, create })
  render([job('a'), job('b')])
  assert.equal(render([job('b'), job('a')]), true)
  assert.deepEqual(list.children.map((node) => textOf(node)), ['0% 开始', '0% 开始'])
  assert.doesNotMatch(list.children[0].className, /is-enter/)
  assert.doesNotMatch(list.children[1].className, /is-enter/)
})
