/**
 * `POST /api/export`: the validation that used to live in the queue route.
 *
 * The file that was the export queue is gone; these cases keep its rules — an
 * unknown format, an inline-image request that cannot be a bundle, and the
 * container each option combination produces — exercised over HTTP.
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { startWebServer } from '../web.js'

const actionHeader = { 'content-type': 'application/json', 'x-qqnt-action': '1' }

async function tempDir() {
  return mkdtemp(path.join(os.tmpdir(), 'qqnt-export-routes-'))
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

async function harness() {
  const dir = await tempDir()
  const seen = []
  const { server, base } = await startServer(
    { python: process.execPath, workDir: dir },
    {
      handlers: {},
      runners: {
        export: async (job) => {
          seen.push(job.params)
          return { rows: 1, bytes: 2, format: job.params.format }
        },
      },
    },
  )
  return { dir, server, base, seen }
}

async function post(base, body, headers = actionHeader) {
  const response = await fetch(`${base}/api/export`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
  return { response, payload: await response.json() }
}

test('an unknown format or a bad combination is a 400', async () => {
  const { dir, server, base } = await harness()
  try {
    let { response } = await post(base, { format: 'exe' })
    assert.equal(response.status, 400)

    ;({ response } = await post(base, { format: 'txt', embed: true }))
    assert.equal(response.status, 400, 'inline images are html only')

    ;({ response } = await post(base, { format: 'html', embed: true, split: 'day' }))
    assert.equal(response.status, 400)

    ;({ response } = await post(base, {
      format: 'html', embed: true,
      chats: [{ kind: 'group', id: '1' }, { kind: 'group', id: '2' }],
    }))
    assert.equal(response.status, 400, 'inline images are one chat')

    ;({ response } = await post(base, { format: 'html', embed: true, password: 'abcdef' }))
    assert.equal(response.status, 400)

    ;({ response } = await post(base, { format: 'txt', password: 'abc' }))
    assert.equal(response.status, 400, 'password length is checked')

    ;({ response } = await post(base, { format: 'txt' }, { 'content-type': 'application/json' }))
    assert.equal(response.status, 403, 'queuing is a mutation')
  } finally {
    await server.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('single chat, batch and media pick the container they imply', async () => {
  const { dir, server, base, seen } = await harness()
  try {
    let { response } = await post(base, {
      format: 'csv', chatKind: 'group', chatId: '123',
    })
    assert.equal(response.status, 202)
    assert.equal(seen[0].format, 'csv')
    assert.equal(seen[0].innerFormat, 'csv')

    ;({ response } = await post(base, {
      format: 'csv',
      chats: [{ kind: 'group', id: '1' }, { kind: 'group', id: '2' }, { kind: 'private', id: 'u9' }],
    }))
    assert.equal(response.status, 202)
    assert.equal(seen[1].format, 'zip')
    assert.equal(seen[1].label, '批量导出 3 个会话')
    assert.equal(seen[1].args.chats.length, 3)

    ;({ response } = await post(base, {
      format: 'html', chatKind: 'group', chatId: '123', media: true,
    }))
    assert.equal(response.status, 202)
    assert.equal(seen[2].format, 'zip', 'media always bundles')

    ;({ response } = await post(base, {
      format: 'html', chatKind: 'group', chatId: '123', media: true, embed: true,
    }))
    assert.equal(response.status, 202)
    assert.equal(seen[3].format, 'html', 'inline images stay one file')
    assert.equal(seen[3].args.embed, true)

    ;({ response } = await post(base, {
      format: 'json', chatKind: 'group', chatId: '123', split: 'day', media: true,
      password: 'abcdef',
    }))
    assert.equal(response.status, 202)
    assert.equal(seen[4].format, 'zip')
    assert.equal(seen[4].args.split, 'day')
    assert.equal(seen[4].password, 'abcdef')
  } finally {
    await server.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('starting an export also drops the files that are past their hour', async () => {
  const { rm, mkdir, writeFile, utimes } = await import('node:fs/promises')
  const { dir, server, base } = await harness()
  try {
    const exportsDir = path.join(dir, 'exports')
    await mkdir(exportsDir, { recursive: true })
    const oldFile = path.join(exportsDir, 'old--stale.txt')
    const newFile = path.join(exportsDir, 'new--fresh.txt')
    await writeFile(oldFile, 'stale')
    await writeFile(newFile, 'fresh')
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000)
    await utimes(oldFile, twoHoursAgo, twoHoursAgo)

    const { response } = await post(base, { format: 'txt', chatKind: 'group', chatId: '1' })
    assert.equal(response.status, 202)

    const { existsSync } = await import('node:fs')
    assert.equal(existsSync(oldFile), false, 'a file older than an hour is swept on the next export')
    assert.equal(existsSync(newFile), true, 'a fresh download is kept')
  } finally {
    await server.close()
    await rm(dir, { recursive: true, force: true })
  }
})
