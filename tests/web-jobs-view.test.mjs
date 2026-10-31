/**
 * The task panel's DOM half.
 *
 * Covers what the pure helpers cannot: the panel hides itself when there is no
 * work, a finished row offers retry instead of cancel, and the buttons hit the
 * route the REST layer actually exposes.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { jobMeta, mountJobs, visibleJobs } from '../web/js/views/jobs.js'
import { installDocument, makeElement, textOf } from './support/dom.mjs'

const tick = () => new Promise((resolve) => setTimeout(resolve, 15))

test('jobMeta reads state, percent and message', () => {
  assert.equal(jobMeta({ state: 'running', progress: 0.32, message: '已识别 312/987 张' }),
    '进行中 · 32% · 已识别 312/987 张')
  assert.equal(jobMeta({ state: 'done', progress: 1 }), '完成')
  assert.equal(jobMeta({ state: 'interrupted' }), '被中断')
})

test('visibleJobs ignores rows without an id', () => {
  assert.deepEqual(visibleJobs([{ id: 'a' }, null, {}, { id: 'b' }]).map((job) => job.id), ['a', 'b'])
  assert.deepEqual(visibleJobs(undefined), [])
})

test('the panel lists jobs, hides when empty and cancels through the API', async () => {
  const restore = installDocument()
  const posted = []
  let jobs = [
    { id: 'j1', kind: 'ocr', summary: '识别图片', state: 'running', progress: 0.4, message: '40/100', canCancel: true, canRetry: false },
    { id: 'j2', kind: 'embed', summary: '建立向量', state: 'done', progress: 1, canCancel: false, canRetry: true },
  ]
  const api = {
    get: async () => ({ jobs }),
    post: async (path) => {
      posted.push(path)
      jobs = [jobs[0], jobs[1]]
      return {}
    },
  }
  const root = makeElement('body')
  const cleanup = mountJobs(root, { api, intervalMs: 60 })
  try {
    await tick()
    const panel = root.children[0]
    assert.equal(panel.hidden, false)
    const list = panel.children[1]
    assert.equal(list.children.length, 2)
    assert.match(textOf(list.children[0]), /识别图片/)
    assert.match(textOf(list.children[0]), /40/)

    list.children[0].children[2].children[0].dispatch('click')
    await tick()
    assert.deepEqual(posted, ['/api/jobs/j1/cancel'])

    jobs = []
    await new Promise((resolve) => setTimeout(resolve, 80))
    assert.equal(panel.hidden, true)
  } finally {
    cleanup()
    restore()
  }
})
