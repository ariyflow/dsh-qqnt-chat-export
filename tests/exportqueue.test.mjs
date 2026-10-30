import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createExportQueue, MAX_CONCURRENT } from '../exportQueue.js'
import { startWebServer } from '../web.js'

const actionHeaders = { 'content-type': 'application/json', 'x-qqnt-action': '1' }
const PYTHON = process.env.PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3')

async function tempDir() {
  return mkdtemp(path.join(os.tmpdir(), 'qqnt-queue-'))
}

/**
 * A stand-in helper script that writes the requested file and prints the JSON
 * shape the real helper produces. `mode` switches to a slow or failing run.
 *
 * It is a plain `.py` run by the real interpreter rather than a `#!/bin/sh`
 * wrapper: Windows cannot spawn the wrapper, which kept 26 cases skipped there.
 * Direct queue tests pass the path as `queryCli`; the HTTP routes get it through
 * `QQNT_HELPER_SCRIPT` (a test-only seam, see `queryCli()` in web.js).
 */
async function fakeHelper(dir, mode = 'ok') {
  const file = path.join(dir, `py-${mode}.py`)
  const body = {
    ok: `import json, os, sys
args = sys.argv[1:]
payload = json.loads(args[args.index('--json') + 1])
os.makedirs(os.path.dirname(payload['out']), exist_ok=True)
with open(payload['out'], 'wb') as f:
    f.write(b'hello')
print(json.dumps({'path': payload['out'], 'format': payload['format'],
                  'rows': 7, 'bytes': 5, 'label': payload.get('label', '')}))`,
    fail: `import json, sys
print(json.dumps({'error': '磁盘满了'}))
sys.exit(1)`,
    hang: `import time
time.sleep(30)`,
    echo: `import json, os, sys
args = sys.argv[1:]
payload = json.loads(args[args.index('--json') + 1])
os.makedirs(os.path.dirname(payload['out']), exist_ok=True)
with open(payload['out'], 'wb') as f:
    f.write(b'PK')
with open(payload['out'] + '.args.json', 'w', encoding='utf-8') as f:
    json.dump(payload, f)
with open(payload['out'] + '.env.json', 'w', encoding='utf-8') as f:
    json.dump({'password': os.environ.get('QQNT_EXPORT_PASSWORD', '')}, f)
print(json.dumps({'path': payload['out'], 'format': payload['format'],
                  'rows': 3, 'bytes': 2, 'label': payload.get('label', ''),
                  'encrypted': bool(os.environ.get('QQNT_EXPORT_PASSWORD'))}))`,
    outside: `import json, sys
args = sys.argv[1:]
payload = json.loads(args[args.index('--json') + 1])
print(json.dumps({'path': '/etc/passwd', 'format': payload['format'],
                  'rows': 1, 'bytes': 1, 'label': 'x'}))`,
  }[mode]
  await writeFile(file, `${body}\n`)
  return file
}

async function waitFor(predicate, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await predicate()
    if (value) return value
    await new Promise((resolve) => setTimeout(resolve, 40))
  }
  return null
}

async function startServer(settings) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const port = 24000 + Math.floor(Math.random() * 4000)
    const server = startWebServer(settings, port, '127.0.0.1', {})
    try {
      await server.ready
      return { server, base: `http://127.0.0.1:${port}` }
    } catch {
      await server.close()
    }
  }
  throw new Error('could not bind a test port')
}

test('a queued export runs in the background and becomes downloadable', async () => {
  const dir = await tempDir()
  const work = path.join(dir, 'work')
  await mkdir(work)
  const helper = await fakeHelper(dir)
  const queue = createExportQueue({ settings: { python: PYTHON, workDir: work }, queryCli: helper })
  try {
    const task = queue.enqueue({ chatKind: 'group', chatId: '1' }, { label: '群 1', format: 'txt' })
    assert.ok(task)
    assert.equal(task.state, 'running')
    const done = await waitFor(() => queue.list().tasks.find((row) => row.state !== 'running'))
    assert.equal(done.state, 'done')
    assert.equal(done.rows, 7)
    assert.equal(done.bytes, 5)
    assert.ok(done.path.startsWith(path.join(work, 'exports')))
    assert.equal(await readFile(done.path, 'utf8'), 'hello')
    const file = queue.file(task.id)
    assert.ok(file, 'a finished task must expose its file')
    assert.equal(file.path, done.path)
  } finally {
    queue.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('a failing export reports the helper error', async () => {
  const dir = await tempDir()
  const work = path.join(dir, 'work')
  await mkdir(work)
  const helper = await fakeHelper(dir, 'fail')
  const queue = createExportQueue({ settings: { python: PYTHON, workDir: work }, queryCli: helper })
  try {
    const task = queue.enqueue({}, { label: '全部', format: 'csv' })
    const failed = await waitFor(() => queue.list().tasks.find((row) => row.state !== 'running'))
    assert.equal(failed.state, 'error')
    assert.match(failed.error, /磁盘满了/)
    assert.equal(queue.file(task.id), null, 'a failed task has no file')
  } finally {
    queue.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('a helper that reports a path outside exports is refused', async () => {
  const dir = await tempDir()
  const work = path.join(dir, 'work')
  await mkdir(work)
  const helper = await fakeHelper(dir, 'outside')
  const queue = createExportQueue({ settings: { python: PYTHON, workDir: work }, queryCli: helper })
  try {
    const task = queue.enqueue({}, { label: 'x', format: 'txt' })
    const done = await waitFor(() => queue.list().tasks.find((row) => row.state !== 'running'))
    assert.equal(done.state, 'done')
    assert.equal(queue.file(task.id), null, 'the download must stay inside exports/')
  } finally {
    queue.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('only three exports run at once', async () => {
  const dir = await tempDir()
  const work = path.join(dir, 'work')
  await mkdir(work)
  const helper = await fakeHelper(dir, 'hang')
  const queue = createExportQueue({ settings: { python: PYTHON, workDir: work }, queryCli: helper })
  try {
    for (let index = 0; index < MAX_CONCURRENT; index += 1) {
      assert.ok(queue.enqueue({}, { label: `t${index}`, format: 'txt' }))
    }
    assert.equal(queue.enqueue({}, { label: 'over', format: 'txt' }), null)
    assert.equal(queue.list().running, MAX_CONCURRENT)
  } finally {
    queue.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('a running export can be cancelled and frees its slot', async () => {
  const dir = await tempDir()
  const work = path.join(dir, 'work')
  await mkdir(work)
  const helper = await fakeHelper(dir, 'hang')
  const queue = createExportQueue({ settings: { python: PYTHON, workDir: work }, queryCli: helper })
  try {
    const task = queue.enqueue({}, { label: '慢任务', format: 'txt' })
    assert.ok(task)
    const cancelled = queue.cancel(task.id)
    assert.ok(cancelled)
    assert.equal(cancelled.state, 'cancelled')
    assert.equal(queue.list().running, 0)
    assert.equal(queue.file(task.id), null, 'a cancelled task has no download')
    assert.equal(queue.cancel(task.id), null, 'cancelling twice is a no-op')
    // The slot must be reusable right away.
    for (let index = 0; index < MAX_CONCURRENT; index += 1) {
      assert.ok(queue.enqueue({}, { label: `again ${index}`, format: 'txt' }))
    }
  } finally {
    queue.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('the HTTP route queues, reports and serves a finished export', async () => {
  const dir = await tempDir()
  const work = path.join(dir, 'work')
  await mkdir(work)
  const helper = await fakeHelper(dir)
  process.env.QQNT_HELPER_SCRIPT = helper
  const { server, base } = await startServer({ python: PYTHON, workDir: work })
  try {
    let response = await fetch(`${base}/api/export/queue`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ format: 'txt', label: '群 1' }),
    })
    assert.equal(response.status, 403, 'queuing is a mutation')

    response = await fetch(`${base}/api/export/queue`, {
      method: 'POST', headers: actionHeaders,
      body: JSON.stringify({ format: 'nope' }),
    })
    assert.equal(response.status, 400)

    response = await fetch(`${base}/api/export/queue`, {
      method: 'POST', headers: actionHeaders,
      body: JSON.stringify({ format: 'txt', label: '群 1', chatKind: 'group', chatId: '1' }),
    })
    assert.equal(response.status, 202)
    const { id } = await response.json()

    const finished = await waitFor(async () => {
      const list = await (await fetch(`${base}/api/export/queue`)).json()
      return list.tasks.find((task) => task.id === id && task.state === 'done')
    })
    assert.ok(finished, 'the task should finish')

    const download = await fetch(`${base}/api/export/queue/${id}/file`)
    assert.equal(download.status, 200)
    assert.match(download.headers.get('content-disposition'), /attachment/)
    assert.equal(await download.text(), 'hello')

    const missing = await fetch(`${base}/api/export/queue/nope/file`)
    assert.equal(missing.status, 404)
  } finally {
    await server.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('the HTTP route bundles a batch selection as one zip', async () => {
  const dir = await tempDir()
  const work = path.join(dir, 'work')
  await mkdir(work)
  const helper = await fakeHelper(dir, 'echo')
  process.env.QQNT_HELPER_SCRIPT = helper
  const { server, base } = await startServer({ python: PYTHON, workDir: work })
  try {
    const response = await fetch(`${base}/api/export/queue`, {
      method: 'POST', headers: actionHeaders,
      body: JSON.stringify({
        chats: [{ kind: 'group', id: '1', label: '群 1' },
                { kind: 'private', id: 'u_1' }],
        format: 'csv', label: '批量',
      }),
    })
    assert.equal(response.status, 202)
    const { id, task } = await response.json()
    assert.equal(task.format, 'zip', 'a bundle downloads as a zip')
    assert.ok(task.path.endsWith('.zip'))

    const finished = await waitFor(async () => {
      const list = await (await fetch(`${base}/api/export/queue`)).json()
      return list.tasks.find((row) => row.id === id && row.state === 'done')
    })
    assert.ok(finished)
    const args = JSON.parse(await readFile(`${finished.path}.args.json`, 'utf8'))
    assert.equal(args.format, 'csv', 'the inner files keep the chosen format')
    assert.equal(args.chats.length, 2)
    assert.equal(args.chats[1].kind, 'private')
    assert.ok(args.out.endsWith('.zip'))

    const download = await fetch(`${base}/api/export/queue/${id}/file`)
    assert.equal(download.status, 200)
    assert.match(download.headers.get('content-disposition'), /attachment/)
    assert.equal(await download.text(), 'PK')
  } finally {
    await server.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('a media export is bundled as a zip even for one chat', async () => {
  const dir = await tempDir()
  const work = path.join(dir, 'work')
  await mkdir(work)
  const helper = await fakeHelper(dir, 'echo')
  process.env.QQNT_HELPER_SCRIPT = helper
  const { server, base } = await startServer({ python: PYTHON, workDir: work })
  try {
    const response = await fetch(`${base}/api/export/queue`, {
      method: 'POST', headers: actionHeaders,
      body: JSON.stringify({ chatKind: 'group', chatId: '1', media: true, format: 'html' }),
    })
    assert.equal(response.status, 202)
    const { id, task } = await response.json()
    assert.equal(task.format, 'zip')
    const finished = await waitFor(async () => {
      const list = await (await fetch(`${base}/api/export/queue`)).json()
      return list.tasks.find((row) => row.id === id && row.state === 'done')
    })
    const args = JSON.parse(await readFile(`${finished.path}.args.json`, 'utf8'))
    assert.equal(args.media, true)
    assert.equal(args.format, 'html')
    assert.equal(args.chatId, '1')
  } finally {
    await server.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('an embedded HTML export stays one html file', async () => {
  const dir = await tempDir()
  const work = path.join(dir, 'work')
  await mkdir(work)
  const helper = await fakeHelper(dir, 'echo')
  process.env.QQNT_HELPER_SCRIPT = helper
  const { server, base } = await startServer({ python: PYTHON, workDir: work })
  try {
    let response = await fetch(`${base}/api/export/queue`, {
      method: 'POST', headers: actionHeaders,
      body: JSON.stringify({ chatKind: 'group', chatId: '1', format: 'txt', embed: true }),
    })
    assert.equal(response.status, 400)
    assert.match((await response.json()).error, /html/)

    response = await fetch(`${base}/api/export/queue`, {
      method: 'POST', headers: actionHeaders,
      body: JSON.stringify({ chats: [{ kind: 'group', id: '1' }, { kind: 'group', id: '2' }],
                             format: 'html', embed: true }),
    })
    assert.equal(response.status, 400)

    response = await fetch(`${base}/api/export/queue`, {
      method: 'POST', headers: actionHeaders,
      body: JSON.stringify({ chatKind: 'group', chatId: '1', format: 'html', embed: true }),
    })
    assert.equal(response.status, 202)
    const { id, task } = await response.json()
    assert.equal(task.format, 'html')
    assert.ok(task.path.endsWith('.html'))
    const finished = await waitFor(async () => {
      const list = await (await fetch(`${base}/api/export/queue`)).json()
      return list.tasks.find((row) => row.id === id && row.state === 'done')
    })
    const args = JSON.parse(await readFile(`${finished.path}.args.json`, 'utf8'))
    assert.equal(args.embed, true)
    assert.equal(args.media, true)
  } finally {
    await server.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('a day-split export is bundled as a zip', async () => {
  const dir = await tempDir()
  const work = path.join(dir, 'work')
  await mkdir(work)
  const helper = await fakeHelper(dir, 'echo')
  process.env.QQNT_HELPER_SCRIPT = helper
  const { server, base } = await startServer({ python: PYTHON, workDir: work })
  try {
    let response = await fetch(`${base}/api/export/queue`, {
      method: 'POST', headers: actionHeaders,
      body: JSON.stringify({ chatKind: 'group', chatId: '1', format: 'txt', split: 'week' }),
    })
    assert.equal(response.status, 400)

    response = await fetch(`${base}/api/export/queue`, {
      method: 'POST', headers: actionHeaders,
      body: JSON.stringify({ chatKind: 'group', chatId: '1', format: 'txt', split: 'day' }),
    })
    assert.equal(response.status, 202)
    const { id, task } = await response.json()
    assert.equal(task.format, 'zip')
    const finished = await waitFor(async () => {
      const list = await (await fetch(`${base}/api/export/queue`)).json()
      return list.tasks.find((row) => row.id === id && row.state === 'done')
    })
    const args = JSON.parse(await readFile(`${finished.path}.args.json`, 'utf8'))
    assert.equal(args.split, 'day')
    assert.equal(args.format, 'txt')
  } finally {
    await server.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('a password export travels in the environment and comes back encrypted', async () => {
  const dir = await tempDir()
  const work = path.join(dir, 'work')
  await mkdir(work)
  const helper = await fakeHelper(dir, 'echo')
  process.env.QQNT_HELPER_SCRIPT = helper
  const { server, base } = await startServer({ python: PYTHON, workDir: work })
  try {
    let response = await fetch(`${base}/api/export/queue`, {
      method: 'POST', headers: actionHeaders,
      body: JSON.stringify({ chatKind: 'group', chatId: '1', format: 'txt', password: 'abc' }),
    })
    assert.equal(response.status, 400, 'short passwords are refused')

    response = await fetch(`${base}/api/export/queue`, {
      method: 'POST', headers: actionHeaders,
      body: JSON.stringify({ chatKind: 'group', chatId: '1', format: 'html', embed: true, password: 'secret123' }),
    })
    assert.equal(response.status, 400, 'embed and a password cannot be combined')

    response = await fetch(`${base}/api/export/queue`, {
      method: 'POST', headers: actionHeaders,
      body: JSON.stringify({ chatKind: 'group', chatId: '1', format: 'txt', password: 'secret123' }),
    })
    assert.equal(response.status, 202)
    const { id, task } = await response.json()
    assert.equal(task.format, 'zip', 'a password always means a zip')
    assert.equal(task.password, undefined, 'the task must not keep the password')

    const finished = await waitFor(async () => {
      const list = await (await fetch(`${base}/api/export/queue`)).json()
      return list.tasks.find((row) => row.id === id && row.state === 'done')
    })
    assert.equal(finished.encrypted, true)
    const args = JSON.parse(await readFile(`${finished.path}.args.json`, 'utf8'))
    assert.equal(args.password, undefined, 'the password must not be in argv')
    const env = JSON.parse(await readFile(`${finished.path}.env.json`, 'utf8'))
    assert.equal(env.password, 'secret123')
  } finally {
    await server.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('CSV columns and Markdown front-matter reach the helper', async () => {
  const dir = await tempDir()
  const work = path.join(dir, 'work')
  await mkdir(work)
  const helper = await fakeHelper(dir, 'echo')
  process.env.QQNT_HELPER_SCRIPT = helper
  const { server, base } = await startServer({ python: PYTHON, workDir: work })
  try {
    let response = await fetch(`${base}/api/export/queue`, {
      method: 'POST', headers: actionHeaders,
      body: JSON.stringify({
        chatKind: 'group', chatId: '1', format: 'csv',
        columns: ['time', 'sender', 'text'],
      }),
    })
    assert.equal(response.status, 202)
    const csvTask = (await response.json()).task
    const csvDone = await waitFor(async () => {
      const list = await (await fetch(`${base}/api/export/queue`)).json()
      return list.tasks.find((row) => row.id === csvTask.id && row.state === 'done')
    })
    const csvArgs = JSON.parse(await readFile(`${csvDone.path}.args.json`, 'utf8'))
    assert.deepEqual(csvArgs.columns, ['time', 'sender', 'text'])

    response = await fetch(`${base}/api/export/queue`, {
      method: 'POST', headers: actionHeaders,
      body: JSON.stringify({
        chatKind: 'group', chatId: '1', format: 'md', frontMatter: true,
      }),
    })
    assert.equal(response.status, 202)
    const mdTask = (await response.json()).task
    const mdDone = await waitFor(async () => {
      const list = await (await fetch(`${base}/api/export/queue`)).json()
      return list.tasks.find((row) => row.id === mdTask.id && row.state === 'done')
    })
    const mdArgs = JSON.parse(await readFile(`${mdDone.path}.args.json`, 'utf8'))
    assert.equal(mdArgs.frontMatter, true)
  } finally {
    await server.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('the HTTP route refuses a malformed batch selection', async () => {
  const dir = await tempDir()
  const work = path.join(dir, 'work')
  await mkdir(work)
  const helper = await fakeHelper(dir)
  process.env.QQNT_HELPER_SCRIPT = helper
  const { server, base } = await startServer({ python: PYTHON, workDir: work })
  try {
    let response = await fetch(`${base}/api/export/queue`, {
      method: 'POST', headers: actionHeaders,
      body: JSON.stringify({ chats: 'nope', format: 'txt' }),
    })
    assert.equal(response.status, 400)
    response = await fetch(`${base}/api/export/queue`, {
      method: 'POST', headers: actionHeaders,
      body: JSON.stringify({ chats: [{ kind: 'group' }], format: 'txt' }),
    })
    assert.equal(response.status, 400)
    assert.match((await response.json()).error, /kind/)
  } finally {
    await server.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('the HTTP route cancels a running export', async () => {
  const dir = await tempDir()
  const work = path.join(dir, 'work')
  await mkdir(work)
  const helper = await fakeHelper(dir, 'hang')
  process.env.QQNT_HELPER_SCRIPT = helper
  const { server, base } = await startServer({ python: PYTHON, workDir: work })
  try {
    const queued = await fetch(`${base}/api/export/queue`, {
      method: 'POST', headers: actionHeaders,
      body: JSON.stringify({ format: 'txt', label: '慢任务' }),
    })
    assert.equal(queued.status, 202)
    const { id } = await queued.json()

    const refused = await fetch(`${base}/api/export/queue/${id}/cancel`, { method: 'POST' })
    assert.equal(refused.status, 403, 'cancelling is a mutation')

    const cancelled = await fetch(`${base}/api/export/queue/${id}/cancel`, {
      method: 'POST', headers: actionHeaders,
    })
    assert.equal(cancelled.status, 200)
    assert.equal((await cancelled.json()).task.state, 'cancelled')

    const again = await fetch(`${base}/api/export/queue/${id}/cancel`, {
      method: 'POST', headers: actionHeaders,
    })
    assert.equal(again.status, 409)

    const missing = await fetch(`${base}/api/export/queue/nope/cancel`, {
      method: 'POST', headers: actionHeaders,
    })
    assert.equal(missing.status, 404)

    const list = await (await fetch(`${base}/api/export/queue`)).json()
    assert.equal(list.running, 0)
  } finally {
    await server.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('the HTTP route answers 429 when every slot is busy', async () => {
  const dir = await tempDir()
  const work = path.join(dir, 'work')
  await mkdir(work)
  const helper = await fakeHelper(dir, 'hang')
  process.env.QQNT_HELPER_SCRIPT = helper
  const { server, base } = await startServer({ python: PYTHON, workDir: work })
  try {
    for (let index = 0; index < MAX_CONCURRENT; index += 1) {
      const response = await fetch(`${base}/api/export/queue`, {
        method: 'POST', headers: actionHeaders,
        body: JSON.stringify({ format: 'txt', label: `t${index}` }),
      })
      assert.equal(response.status, 202)
    }
    const busy = await fetch(`${base}/api/export/queue`, {
      method: 'POST', headers: actionHeaders,
      body: JSON.stringify({ format: 'txt', label: 'over' }),
    })
    assert.equal(busy.status, 429)
    assert.match((await busy.json()).error, /最多同时/)
  } finally {
    await server.close()
    await rm(dir, { recursive: true, force: true })
  }
})
