/**
 * The generic job queue behind the task panel.
 *
 * Two properties matter more than the happy path and are asserted directly:
 * a restart must not leave a job looking alive (`running` → `interrupted`),
 * and `jobs.json` must never contain a chat id or a keyword — it is a plain
 * file on disk next to the index.
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createJobQueue } from '../jobs.js'

async function tempDir() {
  return mkdtemp(path.join(os.tmpdir(), 'qqnt-jobs-'))
}

/** A runner that resolves after the test decides to release it. */
function gate() {
  let release
  const promise = new Promise((resolve) => {
    release = resolve
  })
  return { promise, release }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 10))

test('a submitted job runs, reports progress and keeps its result', async () => {
  const dir = await tempDir()
  const queue = createJobQueue({
    settings: { workDir: dir },
    runners: {
      demo: async (job, ctx) => {
        ctx.onProgress(0.5, '一半')
        ctx.log('working')
        return { wrote: 2 }
      },
    },
  })
  try {
    const row = queue.submit('demo', { summary: '示例任务' })
    assert.equal(row.state, 'queued')
    await tick()
    const done = queue.get(row.id)
    assert.equal(done.state, 'done')
    assert.equal(done.progress, 1)
    assert.deepEqual(done.result, { wrote: 2 })
    assert.ok(done.log.includes('working'))
    assert.equal(done.canRetry, true)
  } finally {
    await queue.shutdown()
    await rm(dir, { recursive: true, force: true })
  }
})

test('concurrency is capped and queued work starts when a slot frees up', async () => {
  const dir = await tempDir()
  const started = []
  const gates = [gate(), gate()]
  const queue = createJobQueue({
    settings: { workDir: dir },
    concurrency: 1,
    runners: {
      slow: async (job) => {
        started.push(job.id)
        await gates[started.length - 1].promise
        return 'ok'
      },
    },
  })
  try {
    const first = queue.submit('slow')
    const second = queue.submit('slow')
    await tick()
    assert.deepEqual(started, [first.id])
    assert.equal(queue.get(second.id).state, 'queued')

    gates[0].release()
    await tick()
    await tick()
    assert.deepEqual(started, [first.id, second.id])
    gates[1].release()
    await tick()
    assert.equal(queue.get(second.id).state, 'done')
  } finally {
    await queue.shutdown()
    await rm(dir, { recursive: true, force: true })
  }
})

test('a throwing runner fails the job with its message', async () => {
  const dir = await tempDir()
  const queue = createJobQueue({
    settings: { workDir: dir },
    runners: {
      boom: async () => {
        throw new Error('磁盘满了')
      },
    },
  })
  try {
    const row = queue.submit('boom')
    await tick()
    const failed = queue.get(row.id)
    assert.equal(failed.state, 'failed')
    assert.match(failed.error, /磁盘满了/)
    assert.equal(failed.progress, 0)
  } finally {
    await queue.shutdown()
    await rm(dir, { recursive: true, force: true })
  }
})

test('a queued job cancels without ever running', async () => {
  const dir = await tempDir()
  let ran = 0
  const hold = gate()
  const queue = createJobQueue({
    settings: { workDir: dir },
    concurrency: 1,
    runners: {
      held: async () => {
        ran += 1
        await hold.promise
      },
    },
  })
  try {
    const first = queue.submit('held')
    const second = queue.submit('held')
    await tick()
    assert.equal(queue.get(second.id).state, 'queued')
    queue.cancel(second.id)
    assert.equal(queue.get(second.id).state, 'canceled')
    hold.release()
    await tick()
    assert.equal(ran, 1)
    assert.equal(queue.get(first.id).state, 'done')
  } finally {
    await queue.shutdown()
    await rm(dir, { recursive: true, force: true })
  }
})

test('a running job stops cooperatively through isCanceled()', async () => {
  const dir = await tempDir()
  let observed = false
  const queue = createJobQueue({
    settings: { workDir: dir },
    runners: {
      loop: async (job, ctx) => {
        for (let index = 0; index < 50; index += 1) {
          if (ctx.isCanceled()) {
            observed = true
            return 'stopped'
          }
          await new Promise((resolve) => setTimeout(resolve, 5))
        }
        return 'finished'
      },
    },
  })
  try {
    const row = queue.submit('loop')
    await tick()
    queue.cancel(row.id)
    await new Promise((resolve) => setTimeout(resolve, 60))
    assert.equal(observed, true)
    assert.equal(queue.get(row.id).state, 'canceled')
  } finally {
    await queue.shutdown()
    await rm(dir, { recursive: true, force: true })
  }
})

test('jobs.json never holds params, and a restart marks running rows interrupted', async () => {
  const dir = await tempDir()
  const hold = gate()
  const queue = createJobQueue({
    settings: { workDir: dir },
    runners: {
      leaky: async () => {
        await hold.promise
        return 'ok'
      },
    },
  })
  const row = queue.submit('leaky', {
    summary: '识别 3 张图片',
    params: { keyword: '这是聊天内容', chatId: '100001', name: '示例课程群' },
  })
  await tick()
  const text = await readFile(path.join(dir, 'jobs.json'), 'utf8')
  assert.doesNotMatch(text, /这是聊天内容/)
  assert.doesNotMatch(text, /100001/)
  assert.doesNotMatch(text, /示例课程群/)
  assert.match(text, /识别 3 张图片/)

  // Simulate a crash: a new queue reading the same file.
  await queue.shutdown()
  hold.release()
  const revived = createJobQueue({ settings: { workDir: dir }, runners: { leaky: async () => 'ok' } })
  try {
    const rows = revived.list()
    assert.equal(rows.length, 1)
    assert.equal(rows[0].id, row.id)
    assert.equal(rows[0].state, 'interrupted')
    assert.throws(() => revived.retry(rows[0].id), /参数已不保留/)
  } finally {
    await revived.shutdown()
    await rm(dir, { recursive: true, force: true })
  }
})

test('retry re-runs a failed job with the same arguments', async () => {
  const dir = await tempDir()
  let attempt = 0
  const queue = createJobQueue({
    settings: { workDir: dir },
    runners: {
      flaky: async (job) => {
        attempt += 1
        if (attempt === 1) throw new Error('第一次失败')
        return `第二次成功:${job.params.token}`
      },
    },
  })
  try {
    const row = queue.submit('flaky', { params: { token: 'abc' } })
    await tick()
    assert.equal(queue.get(row.id).state, 'failed')
    const second = queue.retry(row.id)
    await tick()
    assert.equal(queue.get(second.id).state, 'done')
    assert.equal(queue.get(second.id).result, '第二次成功:abc')
    assert.equal(queue.get(row.id).state, 'failed')
  } finally {
    await queue.shutdown()
    await rm(dir, { recursive: true, force: true })
  }
})

test('sweep drops old finished rows and an unknown kind is rejected', async () => {
  const dir = await tempDir()
  const queue = createJobQueue({ settings: { workDir: dir }, runners: { ok: async () => 1 } })
  try {
    assert.throws(() => queue.submit('missing'), /未知的任务类型/)
    const row = queue.submit('ok')
    await tick()
    assert.equal(queue.list().length, 1)
    // Nothing is old enough yet.
    assert.equal(queue.sweep({ ageMs: 60 * 60 * 1000 }), 0)
    // Pretend the row finished a day ago.
    queue.get(row.id)
    const rows = queue.list()
    assert.equal(rows.length, 1)
    assert.equal(queue.sweep({ ageMs: -1000 }), 1)
    assert.equal(queue.list().length, 0)
  } finally {
    await queue.shutdown()
    await rm(dir, { recursive: true, force: true })
  }
})
