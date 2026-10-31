/**
 * `/api/jobs*` on the real listener.
 *
 * The queue itself is unit-tested in `jobs.test.mjs`; these cases check the
 * HTTP contract — the action header, the unknown-kind refusal, and that a
 * cancelled job stays cancelled through the route.
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { makeExportRunner } from '../runners.js'
import { startWebServer } from '../web.js'

const PYTHON = process.env.PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3')

const actionHeader = { 'content-type': 'application/json', 'x-qqnt-action': '1' }

async function tempDir() {
  return mkdtemp(path.join(os.tmpdir(), 'qqnt-webjobs-'))
}

async function startServer(settings, options) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const port = 24000 + Math.floor(Math.random() * 4000)
    const server = startWebServer(settings, port, '127.0.0.1', options)
    try {
      await server.ready
      return { server, base: `http://127.0.0.1:${port}` }
    } catch {
      await server.close()
    }
  }
  throw new Error('could not bind a test port')
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 15))

test('jobs need the loopback action header and a known kind', async () => {
  const dir = await tempDir()
  const { server, base } = await startServer(
    { python: process.execPath, workDir: dir },
    { handlers: {}, runners: { demo: async () => 'ok' } },
  )
  try {
    let response = await fetch(`${base}/api/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'demo' }),
    })
    assert.equal(response.status, 403)

    response = await fetch(`${base}/api/jobs`, {
      method: 'POST',
      headers: actionHeader,
      body: JSON.stringify({ kind: 'nope' }),
    })
    assert.equal(response.status, 400)
    assert.match((await response.json()).error, /未知的任务类型/)
  } finally {
    await server.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('a submitted job is listed, polled and finished', async () => {
  const dir = await tempDir()
  const { server, base } = await startServer(
    { python: process.execPath, workDir: dir },
    {
      handlers: {},
      runners: {
        demo: async (job, ctx) => {
          ctx.onProgress(0.5, '做一半')
          ctx.log('demo 开始')
          return { echoed: job.params.token }
        },
      },
    },
  )
  try {
    let response = await fetch(`${base}/api/jobs`, {
      method: 'POST',
      headers: actionHeader,
      body: JSON.stringify({ kind: 'demo', summary: '示例任务', params: { token: 'abc' } }),
    })
    assert.equal(response.status, 202)
    const created = await response.json()
    assert.equal(created.kind, 'demo')
    assert.equal(created.summary, '示例任务')

    await tick()
    response = await fetch(`${base}/api/jobs/${created.id}`)
    const detail = await response.json()
    assert.equal(detail.state, 'done')
    assert.deepEqual(detail.result, { echoed: 'abc' })
    assert.ok(detail.log.includes('demo 开始'))

    response = await fetch(`${base}/api/jobs`)
    const listed = await response.json()
    assert.equal(listed.jobs.length, 1)
    assert.equal(listed.jobs[0].id, created.id)

    response = await fetch(`${base}/api/jobs/missing`)
    assert.equal(response.status, 404)
  } finally {
    await server.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('a running job can be cancelled through the route', async () => {
  const dir = await tempDir()
  const { server, base } = await startServer(
    { python: process.execPath, workDir: dir },
    {
      handlers: {},
      runners: {
        loop: async (job, ctx) => {
          for (let index = 0; index < 200; index += 1) {
            if (ctx.isCanceled()) return 'stopped'
            await new Promise((resolve) => setTimeout(resolve, 5))
          }
          return 'finished'
        },
      },
    },
  )
  try {
    let response = await fetch(`${base}/api/jobs`, {
      method: 'POST',
      headers: actionHeader,
      body: JSON.stringify({ kind: 'loop' }),
    })
    const created = await response.json()
    await tick()

    response = await fetch(`${base}/api/jobs/${created.id}/cancel`, {
      method: 'POST',
      headers: actionHeader,
    })
    assert.equal(response.status, 200)
    await new Promise((resolve) => setTimeout(resolve, 40))

    response = await fetch(`${base}/api/jobs/${created.id}`)
    const detail = await response.json()
    assert.equal(detail.state, 'canceled')
    assert.equal(detail.canCancel, false)
  } finally {
    await server.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('a finished export job downloads through its id prefix', async () => {
  const dir = await tempDir()
  const helper = path.join(dir, 'export-helper.py')
  await writeFile(helper, [
    'import json, os, sys',
    "args = json.loads(sys.argv[-1])",
    "os.makedirs(os.path.dirname(args['out']), exist_ok=True)",
    "open(args['out'], 'w', encoding='utf-8').write('hello')",
    "print(json.dumps({'rows': 3, 'bytes': 5}))",
  ].join('\n'))
  const settings = { python: PYTHON, workDir: dir }
  const { server, base } = await startServer(settings, {
    handlers: {},
    runners: { export: makeExportRunner({ settings, queryCli: helper }) },
  })
  try {
    const response = await fetch(`${base}/api/jobs`, {
      method: 'POST',
      headers: actionHeader,
      body: JSON.stringify({
        kind: 'export',
        summary: '导出聊天记录',
        params: { format: 'txt', label: '示例课程群', args: { keyword: '开会' } },
      }),
    })
    assert.equal(response.status, 202)
    const created = await response.json()

    let detail = null
    for (let attempt = 0; attempt < 40; attempt += 1) {
      await tick()
      const polled = await fetch(`${base}/api/jobs/${created.id}`)
      detail = await polled.json()
      if (detail.state === 'done') break
    }
    assert.equal(detail.state, 'done')
    assert.equal(detail.result.rows, 3)

    const download = await fetch(`${base}/api/jobs/${created.id}/download`)
    assert.equal(download.status, 200)
    assert.match(download.headers.get('content-disposition'), /attachment/)
    assert.equal(await download.text(), 'hello')

    // A job that never produced a file says so instead of 500-ing.
    const missing = await fetch(`${base}/api/jobs/nosuch/download`)
    assert.equal(missing.status, 404)
  } finally {
    await server.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('POST /api/export validates and queues an export job', async () => {
  const dir = await tempDir()
  const seen = []
  const { server, base } = await startServer(
    { python: process.execPath, workDir: dir },
    {
      handlers: {},
      runners: {
        export: async (job) => {
          seen.push(job.params)
          return { rows: 1, bytes: 2, format: 'txt' }
        },
      },
    },
  )
  try {
    let response = await fetch(`${base}/api/export`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ format: 'txt' }),
    })
    assert.equal(response.status, 403)

    response = await fetch(`${base}/api/export`, {
      method: 'POST',
      headers: actionHeader,
      body: JSON.stringify({ format: 'exe' }),
    })
    assert.equal(response.status, 400)

    response = await fetch(`${base}/api/export`, {
      method: 'POST',
      headers: actionHeader,
      body: JSON.stringify({ format: 'csv', keyword: '开会', media: true }),
    })
    assert.equal(response.status, 202)
    const job = await response.json()
    assert.equal(job.kind, 'export')
    assert.equal(job.state, 'queued')
    // Params never appear on the public row.
    assert.equal(job.params, undefined)
    await tick()
    assert.equal(seen.length, 1)
    assert.deepEqual(seen[0].args, { keyword: '开会', media: true })
    assert.equal(seen[0].format, 'zip')
    assert.equal(seen[0].innerFormat, 'csv')
  } finally {
    await server.close()
    await rm(dir, { recursive: true, force: true })
  }
})
