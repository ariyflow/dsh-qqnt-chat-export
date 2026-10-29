import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  clearOverrides,
  DEFAULT_WEB_PORT,
  expandHome,
  loadOverrides,
  resolveSettings,
  saveOverrides,
  validatePatch,
} from '../settings.js'
import { cleanupStorage, storageSnapshot } from '../storage.js'
import { startWebServer } from '../web.js'

const actionHeaders = { 'content-type': 'application/json', 'x-qqnt-action': '1' }

async function tempDir() {
  return mkdtemp(path.join(os.tmpdir(), 'qqnt-test-'))
}

test('settings defaults keep the UI on loopback', () => {
  const settings = resolveSettings({}, {})
  assert.equal(settings.webPort, DEFAULT_WEB_PORT)
  assert.equal(settings.webHost, '127.0.0.1')
  assert.ok(settings.workDir.endsWith('qqnt-chat-export'))
  assert.equal(settings.python, process.platform === 'win32' ? 'python' : 'python3')
  assert.equal(settings.installer, 'auto')
  assert.equal(settings.uv, 'uv')
  assert.equal(settings.pythonVersion, '3.12')
})

test('uv install settings validate like the other fields', () => {
  assert.deepEqual(
    validatePatch({ installer: 'uv', uvPath: ' /opt/uv ', pythonVersion: '3.13' }),
    { installer: 'uv', uvPath: '/opt/uv', pythonVersion: '3.13' })
  assert.deepEqual(validatePatch({ pythonVersion: '' }), { pythonVersion: '' })
  assert.throws(() => validatePatch({ installer: 'conda' }), /installer/)
  assert.throws(() => validatePatch({ pythonVersion: 'latest' }), /3\.12/)
  assert.deepEqual(resolveSettings({}, { installer: 'pip' }).installer, 'pip')
  // An unknown value from a hand-edited file falls back to auto.
  assert.deepEqual(resolveSettings({}, { installer: 'nope' }).installer, 'auto')
})

test('a non-loopback webHost is forced back to loopback', () => {
  const settings = resolveSettings({ webHost: '0.0.0.0' }, {})
  assert.equal(settings.webHost, '127.0.0.1')
})

test('validatePatch rejects unknown keys, wrong types, and bad ports', () => {
  assert.throws(() => validatePatch({ nope: 1 }), /未知设置项/)
  assert.throws(() => validatePatch({ workDir: 3 }), /必须是字符串/)
  assert.throws(() => validatePatch({ webPort: 70000 }), /0~65535/)
  assert.throws(() => validatePatch({ webPort: 1.5 }), /0~65535/)
  assert.deepEqual(validatePatch({ workDir: '  /tmp/x  ' }), { workDir: '/tmp/x' })
})

test('overrides round-trip and can be cleared', async () => {
  const dir = await tempDir()
  const file = path.join(dir, 'settings.json')
  try {
    saveOverrides({ webPort: 47000, workDir: '/tmp/qqnt' }, file)
    assert.deepEqual(loadOverrides(file), { webPort: 47000, workDir: '/tmp/qqnt' })
    if (process.platform !== 'win32') {
      const { stat } = await import('node:fs/promises')
      assert.equal((await stat(file)).mode & 0o777, 0o600)
    }
    clearOverrides(file)
    assert.equal(existsSync(file), false)
    assert.deepEqual(loadOverrides(file), {})
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('expandHome only touches a leading tilde', () => {
  assert.equal(expandHome('~'), os.homedir())
  assert.equal(expandHome('~/x'), path.join(os.homedir(), 'x'))
  assert.equal(expandHome('/a/~/b'), '/a/~/b')
})

test('storage cleanup only removes allow-listed files', async () => {
  const dir = await tempDir()
  try {
    await writeFile(path.join(dir, 'key.txt'), 'secret')
    await writeFile(path.join(dir, 'keep.me'), 'keep')
    await mkdir(path.join(dir, 'exports'))
    await writeFile(path.join(dir, 'exports', 'a.txt'), 'x')

    const snapshot = storageSnapshot(dir)
    assert.ok(snapshot.items.some((item) => item.id === 'key'))
    assert.equal(snapshot.key, true)

    assert.throws(() => cleanupStorage(dir, ['nope']), /未知的清理项/)
    const result = cleanupStorage(dir, ['key', 'exports'])
    assert.equal(result.removed, 2)
    assert.equal(existsSync(path.join(dir, 'key.txt')), false)
    assert.equal(existsSync(path.join(dir, 'exports', 'a.txt')), false)
    assert.equal(existsSync(path.join(dir, 'keep.me')), true)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('cleanup is refused while a build is running', async () => {
  const dir = await tempDir()
  try {
    await writeFile(path.join(dir, 'key.txt'), 'secret')
    await writeFile(path.join(dir, 'build-status.json'), JSON.stringify({
      state: 'running', startedAt: Math.floor(Date.now() / 1000),
    }))
    assert.throws(() => cleanupStorage(dir, ['key']), /索引正在建立/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

/** Start the UI on the first free random loopback port. */
async function startServer(settings, handlers) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const port = 24000 + Math.floor(Math.random() * 4000)
    const server = startWebServer(settings, port, '127.0.0.1', { handlers })
    try {
      await server.ready
      return { server, base: `http://127.0.0.1:${port}` }
    } catch {
      await server.close()
    }
  }
  throw new Error('could not bind a test port')
}

test('web mutations require the loopback action header', async () => {
  const dir = await tempDir()
  const settings = { python: process.execPath, workDir: dir }
  const handlers = {
    getSettings: () => ({ ok: true }),
    updateSettings: (patch) => ({ patched: patch }),
  }
  const { server, base } = await startServer(settings, handlers)
  try {
    let response = await fetch(`${base}/api/settings`)
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { ok: true })

    response = await fetch(`${base}/api/settings`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workDir: '/tmp/x' }),
    })
    assert.equal(response.status, 403)

    response = await fetch(`${base}/api/settings`, {
      method: 'PUT',
      headers: actionHeaders,
      body: JSON.stringify({ workDir: '/tmp/x' }),
    })
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { patched: { workDir: '/tmp/x' } })
  } finally {
    await server.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('key extraction needs confirmation and reports 202', async () => {
  const dir = await tempDir()
  const settings = { python: process.execPath, workDir: dir }
  let started = 0
  const handlers = {
    getKeyJob: () => ({ state: 'idle' }),
    startKeyJob: () => {
      started += 1
      return { state: 'running' }
    },
  }
  const { server, base } = await startServer(settings, handlers)
  try {
    let response = await fetch(`${base}/api/key/extract`, {
      method: 'POST', headers: actionHeaders, body: JSON.stringify({}),
    })
    assert.equal(response.status, 400)
    assert.equal(started, 0)

    response = await fetch(`${base}/api/key/extract`, {
      method: 'POST', headers: actionHeaders, body: JSON.stringify({ confirm: true }),
    })
    assert.equal(response.status, 202)
    assert.equal(started, 1)
  } finally {
    await server.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('a missing interpreter returns 500 without killing the server', async () => {
  const dir = await tempDir()
  const settings = { python: path.join(dir, 'no-such-python'), workDir: dir }
  const { server, base } = await startServer(settings, {})
  try {
    const first = await fetch(`${base}/api/index/build`, { method: 'POST', headers: actionHeaders })
    assert.equal(first.status, 500)
    assert.match((await first.json()).error, /找不到可执行文件/)

    // A failed spawn must not set the ten-second "build in progress" marker.
    const second = await fetch(`${base}/api/index/build`, { method: 'POST', headers: actionHeaders })
    assert.equal(second.status, 500)

    const alive = await fetch(`${base}/api/settings`)
    assert.ok([200, 501].includes(alive.status))
  } finally {
    await server.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('the served page contains the startup checklist and key action', async () => {
  const dir = await tempDir()
  const { server, base } = await startServer({ python: process.execPath, workDir: dir }, {})
  try {
    const html = await (await fetch(`${base}/`)).text()
    assert.match(html, /id="startupKeyBtn"/)
    assert.match(html, /id="startupSetup"/)
    assert.match(html, /location\.origin/)
  } finally {
    await server.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('status reuses the helper report while a build runs', {
  skip: process.platform === 'win32' ? 'needs a POSIX shell wrapper' : false,
}, async () => {
  const dir = await tempDir()
  const work = path.join(dir, 'work')
  await mkdir(work)
  const calls = path.join(dir, 'calls.log')
  const wrapper = path.join(dir, 'py')
  // A real interpreter behind a counting wrapper: the page polls every 1.2 s
  // during a build, and each poll used to spawn one of these.
  await writeFile(wrapper, `#!/bin/sh\necho "$@" >> "${calls}"\nexec python3 "$@"\n`, { mode: 0o755 })
  const { server, base } = await startServer({ python: wrapper, workDir: work }, {})
  const spawns = async () => (await readFile(calls, 'utf8')).trim().split('\n').filter(Boolean).length
  try {
    const first = await (await fetch(`${base}/api/status`)).json()
    const second = await (await fetch(`${base}/api/status`)).json()
    assert.equal(first.build.state, 'idle')
    assert.equal(second.build.state, 'idle')
    assert.equal(await spawns(), 1, 'the second poll should reuse the cached report')

    // A running build is described by its progress file, with no helper call.
    await writeFile(path.join(work, 'build-status.json'),
      JSON.stringify({ state: 'running', processed: 7, total: 20 }))
    const third = await (await fetch(`${base}/api/status`)).json()
    assert.equal(third.build.state, 'running')
    assert.equal(third.build.processed, 7)
    assert.equal(third.index.exists, false)
    assert.equal(await spawns(), 1, 'polling during a build must not spawn the helper')
  } finally {
    await server.close()
    await rm(dir, { recursive: true, force: true })
  }
})
