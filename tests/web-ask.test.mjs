/**
 * `POST /api/ask` on the real listener, end to end through the sidecar.
 *
 * Two things are worth locking here: the route is a mutation (action header,
 * same-origin only) and the payload really comes from retrieval — a fixture
 * index is built, the real helper runs, and the citations must point at the
 * message that answers the question.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { startWebServer } from '../web.js'

const PYTHON = process.env.PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3')
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const actionHeader = { 'content-type': 'application/json', 'x-qqnt-action': '1' }

/** Build a two-message index plus an empty derived store in `workDir`. */
const FIXTURE = `
import os, sqlite3, sys
root, work = sys.argv[1], sys.argv[2]
sys.path.insert(0, os.path.join(root, 'scripts'))
import qqnt_query as query
import qqnt_derived as derived
import qqnt_embed as embed

index = os.path.join(work, 'index.sqlite')
derived_path = os.path.join(work, 'derived.sqlite')
conn = sqlite3.connect(index)
conn.executescript(query.SCHEMA)
query.create_fts(conn)
conn.execute("INSERT INTO meta(k, v) VALUES('version', ?)", (query.INDEX_VERSION,))
conn.execute("INSERT INTO chats(chat_kind, chat_id, name, qq)"
             " VALUES('group', '123', '示例课程群', '123')")
rows = [(1, 100, 1730000000, '小林', '周五下午三点开会吧'),
        (2, 101, 1730000060, '老师', '可以，会议室在三楼')]
for row in rows:
    conn.execute("INSERT INTO messages(id, msg_id, chat_kind, chat_id, ts,"
                 " sender_name, is_out, text) VALUES(?, ?, 'group', '123', ?, ?, 0, ?)",
                 row)
conn.commit()
conn.close()
derived.ensure(derived_path)
embed.run(index, derived_path, None)
`

/** A port the OS just handed out, so a running dev server cannot collide. */
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

async function startServer(settings, options) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const port = await freePort()
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

test('ask is a mutation and needs a question', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'qqnt-webask-'))
  const { server, base } = await startServer({ python: PYTHON, workDir: dir }, { handlers: {} })
  try {
    let response = await fetch(`${base}/api/ask`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ question: '周五开会' }),
    })
    assert.equal(response.status, 403)

    response = await fetch(`${base}/api/ask`, {
      method: 'POST',
      headers: actionHeader,
      body: JSON.stringify({ question: '   ' }),
    })
    assert.equal(response.status, 400)
    assert.match((await response.json()).error, /问题不能为空/)

    // No index yet: a client precondition, not a server failure.
    response = await fetch(`${base}/api/ask`, {
      method: 'POST',
      headers: actionHeader,
      body: JSON.stringify({ question: '周五开会' }),
    })
    assert.equal(response.status, 400)
    assert.match((await response.json()).error, /索引/)
  } finally {
    await server.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('ask returns the spans and citations the sidecar found', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'qqnt-webask-'))
  execFileSync(PYTHON, ['-c', FIXTURE, ROOT, dir], { stdio: 'pipe' })
  const { server, base } = await startServer({ python: PYTHON, workDir: dir }, { handlers: {} })
  try {
    const response = await fetch(`${base}/api/ask`, {
      method: 'POST',
      headers: actionHeader,
      body: JSON.stringify({ question: '周五几点开会', topK: 4 }),
    })
    assert.equal(response.status, 200)
    const payload = await response.json()
    assert.equal(payload.ok, true)
    assert.ok(payload.hits.length >= 1)
    const hit = payload.hits[0]
    assert.equal(hit.chat, '示例课程群')
    assert.equal(hit.citations[0].msg_id, 100)
    assert.equal(hit.citations[0].id, 1)
    assert.ok(payload.notes.some((note) => note.includes('关键词')))
  } finally {
    await server.close()
    await rm(dir, { recursive: true, force: true })
  }
})
