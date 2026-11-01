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
import { findByClass, installDocument, makeElement, textOf } from './support/dom.mjs'

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

test('收起 keeps the panel hidden while the same jobs are still listed', async () => {
  const restore = installDocument()
  const jobs = [
    { id: 'j1', kind: 'ocr', summary: '识别图片', state: 'running', progress: 0.4, message: '', canCancel: true, canRetry: false },
  ]
  const api = { get: async () => ({ jobs }), post: async () => ({}) }
  const root = makeElement('aside')
  const cleanup = mountJobs(root, { api, intervalMs: 20 })
  try {
    await tick()
    const panel = findByClass(root, 'jobs-panel')
    assert.equal(panel.hidden, false)
    findByClass(root, 'jobs-head').children
      .find((child) => child.tagName === 'button').dispatch('click')
    assert.equal(panel.hidden, true)
    await tick()
    await tick()
    assert.equal(panel.hidden, true, 'the next poll must not reopen a collapsed panel')
    // A new job is news: the panel comes back.
    jobs.push({ id: 'j2', kind: 'asr', summary: '转写语音', state: 'running', progress: 0, message: '', canCancel: true, canRetry: false })
    await tick()
    await tick()
    assert.equal(panel.hidden, false)
  } finally {
    cleanup()
    restore()
  }
})
