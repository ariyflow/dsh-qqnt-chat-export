/**
 * Robustness of the listener itself: inputs that used to throw out of the
 * request callback (and take the host process with them) must become answers.
 *
 * No fixture index is needed — both cases fail before any helper runs.
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { filtersFrom, startWebServer } from '../web.js'

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address()
      probe.close(() => resolve(port))
    })
  })
}

async function startServer(settings, options = {}) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const port = await freePort()
    const server = startWebServer(settings, port, '127.0.0.1', options)
    try {
      await server.ready
      return { server, port }
    } catch {
      await server.close()
    }
  }
  throw new Error('could not bind a test port')
}

test('a request target that is not a path answers 400 instead of crashing', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'qqnt-robust-'))
  const { server, port } = await startServer({ python: process.platform === 'win32' ? 'python' : 'python3', workDir: dir }, { handlers: {} })
  try {
    for (const target of ['//', '//[', 'http://[', '//%5B', '/\\']) {
      const status = await new Promise((resolve, reject) => {
        const socket = net.connect(port, '127.0.0.1', () => {
          socket.write(`GET ${target} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`)
        })
        let head = ''
        socket.setEncoding('utf8')
        socket.on('data', (chunk) => { head += chunk })
        socket.on('error', reject)
        socket.on('close', () => resolve(Number((head.match(/^HTTP\/1\.[01] (\d{3})/) || [])[1] || 0)))
        setTimeout(() => { socket.destroy() }, 2000)
      })
      assert.equal(status, 400, `${JSON.stringify(target)} → ${status}`)
    }
    // The listener is still there: a throw here would have ended the process.
    const alive = await fetch(`http://127.0.0.1:${port}/api/status`)
    assert.equal(alive.status, 200)
  } finally {
    await server.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('a missing interpreter fails the job instead of killing the host', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'qqnt-robust-'))
  const missing = process.platform === 'win32'
    ? path.join(dir, 'no-python.exe') : path.join(dir, 'no-python')
  const { server, port } = await startServer({ python: missing, workDir: dir }, { handlers: {} })
  const base = `http://127.0.0.1:${port}`
  try {
    const response = await fetch(`${base}/api/models/bge-small-zh/download`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-qqnt-action': '1' },
      body: JSON.stringify({}),
    })
    assert.equal(response.status, 202)
    const job = await response.json()
    let row = null
    for (let attempt = 0; attempt < 50; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20))
      row = await (await fetch(`${base}/api/jobs/${job.id}`)).json()
      if (row.state === 'failed' || row.state === 'done') break
    }
    assert.equal(row.state, 'failed')
    assert.match(row.error, /找不到|解释器/)
    // Still serving: the spawn error used to be an unhandled 'error' event.
    // `/` is static, so it answers even with no working interpreter.
    assert.equal((await fetch(`${base}/`)).status, 200)
  } finally {
    await server.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('sweepExports drops old files and staging directories, keeps fresh ones', async () => {
  const { sweepExports } = await import('../web.js')
  const { mkdir, stat, utimes, writeFile } = await import('node:fs/promises')
  const dir = await mkdtemp(path.join(os.tmpdir(), 'qqnt-sweep-'))
  const oldDir = path.join(dir, '.bundle-old')
  const oldFile = path.join(dir, 'old.txt')
  const freshFile = path.join(dir, 'fresh.txt')
  await mkdir(oldDir)
  await writeFile(oldFile, 'x')
  await writeFile(freshFile, 'y')
  const stale = new Date(Date.now() - 2 * 60 * 60 * 1000)
  await utimes(oldDir, stale, stale)
  await utimes(oldFile, stale, stale)
  try {
    sweepExports(dir)
    await assert.rejects(stat(oldDir), 'a stale bundle directory must be removed')
    await assert.rejects(stat(oldFile), 'a stale export must be removed')
    assert.ok((await stat(freshFile)).isFile(), 'a fresh export must survive')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('presets accept add and remove without clobbering the other tab', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'qqnt-presets-'))
  const { server, port } = await startServer({ python: 'python3', workDir: dir }, { handlers: {} })
  const base = `http://127.0.0.1:${port}`
  const post = (body) => fetch(`${base}/api/presets`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-qqnt-action': '1' },
    body: JSON.stringify(body),
  })
  try {
    let response = await post({ add: { name: 'A', format: 'txt' } })
    assert.equal(response.status, 200)
    assert.equal((await response.json()).presets.length, 1)

    // A second tab adds B against the list on disk, not against its own copy.
    response = await post({ add: { name: 'B', format: 'csv' } })
    let payload = await response.json()
    assert.deepEqual(payload.presets.map((item) => item.name), ['A', 'B'])

    // Same name replaces in place.
    response = await post({ add: { name: 'A', format: 'json' } })
    payload = await response.json()
    assert.equal(payload.presets.length, 2)
    assert.equal(payload.presets.find((item) => item.name === 'A').format, 'json')

    response = await post({ remove: 'A' })
    payload = await response.json()
    assert.deepEqual(payload.presets.map((item) => item.name), ['B'])

    response = await post({})
    assert.equal(response.status, 400)
  } finally {
    await server.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('the message filters the page sends reach the helper', () => {
  // `order` is the one the reader sends on every page; it used to be dropped
  // here, so a documented parameter only ever existed on the client.
  const params = new URLSearchParams({
    chatKind: 'private', chatId: 'u1', keyword: '开会', sender: '小林',
    senderRegex: '1', since: '2026-10-01', until: '2026-10-31', order: 'asc',
  })
  params.append('sources', 'text')
  params.append('sources', 'ocr')
  assert.deepEqual(filtersFrom(params), {
    chatKind: 'private',
    chatId: 'u1',
    keyword: '开会',
    sender: '小林',
    senderRegex: '1',
    since: '2026-10-01',
    until: '2026-10-31',
    order: 'asc',
    sources: ['text', 'ocr'],
  })
  // An unknown or absent order stays absent: the helper's default wins.
  assert.equal(filtersFrom(new URLSearchParams({ order: 'sideways' })).order, undefined)
  assert.equal(filtersFrom(new URLSearchParams({ order: 'desc' })).order, 'desc')
})
