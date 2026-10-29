import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  clearOverrides,
  DEFAULT_WEB_PORT,
  defaultWorkDir,
  expandHome,
  legacyWorkDir,
  loadOverrides,
  resolveSettings,
  saveOverrides,
  validatePatch,
} from '../settings.js'
import { cleanupStorage, migrateWorkDir, removeWorkDirEntries, storageSnapshot } from '../storage.js'
import { pruneAccountIndexes, startWebServer } from '../web.js'

const actionHeaders = { 'content-type': 'application/json', 'x-qqnt-action': '1' }

async function tempDir() {
  return mkdtemp(path.join(os.tmpdir(), 'qqnt-test-'))
}

test('settings defaults keep the UI on loopback', () => {
  const settings = resolveSettings({}, {})
  assert.equal(settings.webPort, DEFAULT_WEB_PORT)
  assert.equal(settings.webHost, '127.0.0.1')
  assert.ok([defaultWorkDir(), legacyWorkDir()].includes(settings.workDir))
  assert.equal(settings.python, process.platform === 'win32' ? 'python' : 'python3')
  assert.equal(settings.installer, 'auto')
  assert.equal(settings.uv, 'uv')
  assert.equal(settings.pythonVersion, '3.12')
  assert.equal(settings.keepAccountIndexes, 2)
  assert.equal(settings.searchIndex, 'fts')
  assert.equal(settings.autoSync, true)
  assert.equal(settings.syncIntervalMinutes, 60)
})

test('automatic sync settings validate and fall back', () => {
  assert.deepEqual(validatePatch({ autoSync: false, syncIntervalMinutes: 15 }),
    { autoSync: false, syncIntervalMinutes: 15 })
  assert.deepEqual(validatePatch({ syncIntervalMinutes: '5' }), { syncIntervalMinutes: 5 })
  assert.throws(() => validatePatch({ autoSync: 'yes' }), /布尔值/)
  assert.throws(() => validatePatch({ syncIntervalMinutes: 4 }), /5~1440/)
  assert.throws(() => validatePatch({ syncIntervalMinutes: 1441 }), /5~1440/)
  assert.throws(() => validatePatch({ syncIntervalMinutes: 1.5 }), /5~1440/)
  assert.equal(resolveSettings({}, { autoSync: false }).autoSync, false)
  assert.equal(resolveSettings({}, { autoSync: 'false' }).autoSync, false)
  // A hand-edited file with garbage keeps the safe defaults: on, every hour.
  assert.equal(resolveSettings({}, { autoSync: 'nope' }).autoSync, true)
  assert.equal(resolveSettings({}, { syncIntervalMinutes: 'x' }).syncIntervalMinutes, 60)
  assert.equal(resolveSettings({}, { syncIntervalMinutes: 0 }).syncIntervalMinutes, 60)
})

test('account index retention and search mode validate', () => {
  assert.deepEqual(
    validatePatch({ keepAccountIndexes: 0, searchIndex: 'like' }),
    { keepAccountIndexes: 0, searchIndex: 'like' })
  assert.deepEqual(validatePatch({ keepAccountIndexes: '3' }), { keepAccountIndexes: 3 })
  assert.throws(() => validatePatch({ keepAccountIndexes: 6 }), /0~5/)
  assert.throws(() => validatePatch({ keepAccountIndexes: -1 }), /0~5/)
  assert.throws(() => validatePatch({ keepAccountIndexes: 1.5 }), /0~5/)
  assert.throws(() => validatePatch({ searchIndex: 'prefix' }), /searchIndex/)
  assert.equal(resolveSettings({}, { keepAccountIndexes: 4 }).keepAccountIndexes, 4)
  assert.equal(resolveSettings({}, { searchIndex: 'like' }).searchIndex, 'like')
  // Hand-edited garbage falls back to the defaults rather than 0.
  assert.equal(resolveSettings({}, { keepAccountIndexes: '2x' }).keepAccountIndexes, 2)
  assert.equal(resolveSettings({}, { keepAccountIndexes: -3 }).keepAccountIndexes, 2)
  assert.equal(resolveSettings({}, { searchIndex: 'nope' }).searchIndex, 'fts')
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

test('an upgraded install keeps the legacy temp work directory', {
  skip: process.platform === 'darwin' ? 'persistent path ignores the test env' : false,
}, async () => {
  const dir = await tempDir()
  const saved = {
    TMPDIR: process.env.TMPDIR,
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
    XDG_DATA_HOME: process.env.XDG_DATA_HOME,
    LOCALAPPDATA: process.env.LOCALAPPDATA,
  }
  const restore = () => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
  try {
    const tmp = path.join(dir, 'tmp')
    await mkdir(tmp, { recursive: true })
    process.env.TMPDIR = tmp
    process.env.TEMP = tmp
    process.env.TMP = tmp
    process.env.XDG_DATA_HOME = path.join(dir, 'data')
    process.env.LOCALAPPDATA = path.join(dir, 'data')

    const fresh = resolveSettings({}, {})
    assert.equal(fresh.workDir, defaultWorkDir())
    assert.equal(fresh.workDirLegacy, false)

    const legacy = legacyWorkDir()
    await mkdir(legacy, { recursive: true })
    await writeFile(path.join(legacy, 'key.txt'), 'secret')
    const upgraded = resolveSettings({}, {})
    assert.equal(upgraded.workDir, legacy)
    assert.equal(upgraded.workDirLegacy, true)

    // An explicit setting always wins; the old temp path is still flagged so
    // users whose settings.json already contains it see the migration hint.
    const explicit = resolveSettings({}, { workDir: path.join(dir, 'explicit') })
    assert.equal(explicit.workDir, path.join(dir, 'explicit'))
    assert.equal(explicit.workDirLegacy, false)
    assert.equal(resolveSettings({}, { workDir: legacy }).workDirLegacy, true)
    assert.equal(resolveSettings({}, {
      workDir: legacy, legacyWorkDirDismissed: true,
    }).workDirLegacy, false)

    assert.deepEqual(validatePatch({ legacyWorkDirDismissed: true }),
      { legacyWorkDirDismissed: true })
    assert.throws(() => validatePatch({ legacyWorkDirDismissed: 'yes' }), /布尔值/)

    // Once the persistent directory exists it wins over the old temp one.
    await mkdir(defaultWorkDir(), { recursive: true })
    assert.equal(resolveSettings({}, {}).workDir, defaultWorkDir())
  } finally {
    restore()
    await rm(dir, { recursive: true, force: true })
  }
})

test('work dir migration copies first, then the caller cleans up', async () => {
  const dir = await tempDir()
  const from = path.join(dir, 'old')
  const to = path.join(dir, 'new')
  try {
    await mkdir(path.join(from, 'exports'), { recursive: true })
    await writeFile(path.join(from, 'key.txt'), 'secret')
    await writeFile(path.join(from, 'index.sqlite'), 'idx')
    await writeFile(path.join(from, 'build.lock'), '999')
    await writeFile(path.join(from, 'exports', 'a.txt'), 'x')

    const result = await migrateWorkDir(from, to)
    assert.deepEqual(result.copied.sort(), ['exports', 'index.sqlite', 'key.txt'])
    assert.equal(existsSync(path.join(from, 'key.txt')), true, 'source survives until commit')
    assert.equal(existsSync(path.join(to, 'key.txt')), true)
    assert.equal(existsSync(path.join(to, 'build.lock')), false)

    // A second run must not overwrite what the target already has.
    await writeFile(path.join(to, 'index.sqlite'), 'newer')
    const again = await migrateWorkDir(from, to)
    assert.ok(again.skipped.includes('index.sqlite'))
    assert.equal(await readFile(path.join(to, 'index.sqlite'), 'utf8'), 'newer')

    await removeWorkDirEntries(from, result.copied)
    assert.equal(existsSync(path.join(from, 'key.txt')), false)
    assert.equal(existsSync(path.join(from, 'exports')), false)
    assert.equal(existsSync(path.join(from, 'build.lock')), true)

    // Nested paths and the same path are refused instead of copying twice.
    await assert.rejects(migrateWorkDir(to, path.join(to, 'inner')), /互相包含/)
    await assert.rejects(migrateWorkDir(to, to), /目标位置/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
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

test('parked account indexes are listed and removable, live index is kept', async () => {
  const dir = await tempDir()
  try {
    await writeFile(path.join(dir, 'index.sqlite'), 'live')
    await writeFile(path.join(dir, 'index.12345.sqlite'), 'cached')
    await writeFile(path.join(dir, 'index.12345.sqlite-wal'), 'wal')
    await writeFile(path.join(dir, 'not-index.sqlite'), 'keep')

    let snapshot = storageSnapshot(dir)
    const cache = snapshot.items.find((item) => item.id === 'indexCache')
    assert.ok(cache)
    assert.equal(cache.bytes, 9)
    assert.deepEqual(cache.files.map((file) => file.account), ['12345', '12345'])
    // The live index stays in its own category and is never part of the cache.
    assert.ok(snapshot.items.find((item) => item.id === 'index').files
      .every((file) => file.name === 'index.sqlite'))

    const result = cleanupStorage(dir, ['indexCache'])
    assert.equal(result.removed, 2)
    assert.equal(existsSync(path.join(dir, 'index.sqlite')), true)
    assert.equal(existsSync(path.join(dir, 'index.12345.sqlite')), false)
    assert.equal(existsSync(path.join(dir, 'index.12345.sqlite-wal')), false)
    assert.equal(existsSync(path.join(dir, 'not-index.sqlite')), true)
    snapshot = storageSnapshot(dir)
    assert.equal(snapshot.items.some((item) => item.id === 'indexCache'), false)
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

test('status exposes the automatic sync setting and its last run', {
  skip: process.platform === 'win32' ? 'needs python3 on PATH' : false,
}, async () => {
  const dir = await tempDir()
  const settings = {
    python: 'python3', workDir: dir, autoSync: true, syncIntervalMinutes: 30,
  }
  await writeFile(path.join(dir, 'sync-status.json'), JSON.stringify({
    checkedAt: 1700000000, lastSyncAt: 1699999000, added: 7, mode: 'incremental',
  }))
  const { server, base } = await startServer(settings, {})
  try {
    const status = await (await fetch(`${base}/api/status`)).json()
    assert.equal(status.sync.autoSync, true)
    assert.equal(status.sync.intervalMinutes, 30)
    assert.equal(status.sync.lastSyncAt, 1699999000)
    assert.equal(status.sync.added, 7)

    // A disabled timer is reported as such; the page hides the hint.
    settings.autoSync = false
    const off = await (await fetch(`${base}/api/status`)).json()
    assert.equal(off.sync.autoSync, false)
  } finally {
    await server.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('messages around and query syntax reach the helper verbatim', {
  skip: process.platform === 'win32' ? 'needs a POSIX shell wrapper' : false,
}, async () => {
  const dir = await tempDir()
  const work = path.join(dir, 'work')
  await mkdir(work)
  const calls = path.join(dir, 'calls')
  const wrapper = path.join(dir, 'py')
  // Answer with one row so the route returns 200; record the argv it got.
  await writeFile(wrapper,
    '#!/bin/sh\necho "$@" >> "' + calls + '"\necho \'{"total":1,"offset":0,"limit":40,"rows":[]}\'\n',
    { mode: 0o755 })
  const { server, base } = await startServer({ python: wrapper, workDir: work }, {})
  const lastCall = async () => {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      try {
        const lines = (await readFile(calls, 'utf8')).trim().split('\n').filter(Boolean)
        if (lines.length) return lines[lines.length - 1]
      } catch {
        // Not written yet.
      }
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    return ''
  }
  try {
    const response = await fetch(
      `${base}/api/messages?around=42&keyword=${encodeURIComponent('from:张三 -红包')}`)
    assert.equal(response.status, 200)
    const call = await lastCall()
    assert.match(call, /messages --json/)
    assert.match(call, /"around":"42"/)
    assert.match(call, /from:张三/)
  } finally {
    await server.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('the stats route forwards the current filters to the helper', {
  skip: process.platform === 'win32' ? 'needs a POSIX shell wrapper' : false,
}, async () => {
  const dir = await tempDir()
  const work = path.join(dir, 'work')
  await mkdir(work)
  const calls = path.join(dir, 'calls')
  const wrapper = path.join(dir, 'py')
  await writeFile(wrapper,
    '#!/bin/sh\necho "$@" >> "' + calls + '"\n' +
    'echo \'{"total":3,"chats":1,"senders":2,"monthly":[],"hourly":[],"topSenders":[],"topChats":[]}\'\n',
    { mode: 0o755 })
  const { server, base } = await startServer({ python: wrapper, workDir: work }, {})
  const lastCall = async () => {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      try {
        const lines = (await readFile(calls, 'utf8')).trim().split('\n').filter(Boolean)
        if (lines.length) return lines[lines.length - 1]
      } catch {
        // Not written yet.
      }
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    return ''
  }
  try {
    const response = await fetch(
      `${base}/api/stats?chatKind=group&chatId=1&since=2024-01-01`)
    assert.equal(response.status, 200)
    assert.equal((await response.json()).total, 3)
    const call = await lastCall()
    assert.match(call, /stats --json/)
    assert.match(call, /"chatId":"1"/)
    assert.match(call, /"since":"2024-01-01"/)
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
    // 0.9.0 controls: batch selection, redaction, media and the stats panel.
    assert.match(html, /id="batchBar"/)
    assert.match(html, /id="batchExport"/)
    assert.match(html, /id="redact"/)
    assert.match(html, /id="media"/)
    assert.match(html, /id="embed"/)
    assert.match(html, /id="split"/)
    assert.match(html, /id="statsBtn"/)
    assert.match(html, /id="statsPanel"/)
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

test('index select validates input and reports the helper JSON', {
  skip: process.platform === 'win32' ? 'needs python3 on PATH' : false,
}, async () => {
  const dir = await tempDir()
  const work = path.join(dir, 'work')
  await mkdir(work)
  const { server, base } = await startServer(
    { python: 'python3', workDir: work, keepAccountIndexes: 3 }, {})
  try {
    let response = await fetch(`${base}/api/index/select`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ account: '12345' }),
    })
    assert.equal(response.status, 403)

    response = await fetch(`${base}/api/index/select`, {
      method: 'POST', headers: actionHeaders, body: JSON.stringify({ account: '../etc' }),
    })
    assert.equal(response.status, 400)

    // A running build must not be raced by a switch.
    await writeFile(path.join(work, 'build-status.json'), JSON.stringify({ state: 'running' }))
    response = await fetch(`${base}/api/index/select`, {
      method: 'POST', headers: actionHeaders, body: JSON.stringify({ account: '12345' }),
    })
    assert.equal(response.status, 409)
    await rm(path.join(work, 'build-status.json'))

    response = await fetch(`${base}/api/index/select`, {
      method: 'POST', headers: actionHeaders, body: JSON.stringify({ account: '12345' }),
    })
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.equal(body.account, '12345')
    assert.equal(body.switched, false)
    assert.equal(body.cached, false)
  } finally {
    await server.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('migration leaves stale status and journal sidecars behind', async () => {
  const dir = await tempDir()
  const from = path.join(dir, 'old')
  const to = path.join(dir, 'new')
  try {
    await mkdir(from, { recursive: true })
    await writeFile(path.join(from, 'key.txt'), 'secret')
    await writeFile(path.join(from, 'index.sqlite'), 'idx')
    await writeFile(path.join(from, 'index.sqlite-wal'), 'wal')
    await writeFile(path.join(from, 'index.sqlite-shm'), 'shm')
    await writeFile(path.join(from, 'nt_msg.db-journal'), 'journal')
    await writeFile(path.join(from, 'build-status.json'), JSON.stringify({
      state: 'done', index: path.join(from, 'index.sqlite'),
    }))
    await writeFile(path.join(from, 'build.lock'), '1')

    const result = await migrateWorkDir(from, to)
    assert.deepEqual(result.copied.sort(), ['index.sqlite', 'key.txt'])
    // The old progress file would point `/api/status` at the temp directory,
    // and a copied lock would block every later build.
    for (const name of ['build-status.json', 'build.lock', 'index.sqlite-wal',
      'index.sqlite-shm', 'nt_msg.db-journal']) {
      assert.equal(existsSync(path.join(to, name)), false, `${name} must not be copied`)
      assert.ok(result.discarded.includes(name), `${name} should be reported as discarded`)
    }
    assert.equal(existsSync(path.join(from, 'key.txt')), true, 'source survives until commit')

    // A status left in the target by an earlier attempt is cleared as well.
    await writeFile(path.join(to, 'build-status.json'), JSON.stringify({ state: 'running' }))
    await migrateWorkDir(from, to)
    assert.equal(existsSync(path.join(to, 'build-status.json')), false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('lowering the cache limit spawns a prune with the new value', {
  skip: process.platform === 'win32' ? 'needs a POSIX shell wrapper' : false,
}, async () => {
  const dir = await tempDir()
  try {
    const calls = path.join(dir, 'calls')
    const wrapper = path.join(dir, 'py')
    await writeFile(wrapper, `#!/bin/sh\necho "$@" >> "${calls}"\n`, { mode: 0o755 })
    assert.equal(pruneAccountIndexes({ python: wrapper, workDir: dir }, 0), true)
    let argv = ''
    for (let attempt = 0; attempt < 60 && argv === ''; attempt += 1) {
      try {
        argv = (await readFile(calls, 'utf8')).trim()
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
    }
    assert.match(argv, /qqnt_query\.py/)
    assert.match(argv, /--work/)
    assert.match(argv, / prune --keep 0$/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('work dir migration is a guarded mutation', {
  skip: process.platform === 'win32' ? 'needs python3 on PATH' : false,
}, async () => {
  const dir = await tempDir()
  const work = path.join(dir, 'work')
  await mkdir(work)
  let calls = 0
  const { server, base } = await startServer(
    { python: 'python3', workDir: work, workDirLegacy: true }, {
      migrateWorkDir: async () => {
        calls += 1
        return { copied: ['key.txt'], skipped: [], from: work, to: '/persistent' }
      },
    })
  try {
    let response = await fetch(`${base}/api/workdir/migrate`, { method: 'POST' })
    assert.equal(response.status, 403)
    assert.equal(calls, 0)

    response = await fetch(`${base}/api/workdir/migrate`, { method: 'POST', headers: actionHeaders })
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), {
      copied: ['key.txt'], skipped: [], from: work, to: '/persistent',
    })
    assert.equal(calls, 1)

    // The page learns about the legacy directory from /api/status.
    const status = await (await fetch(`${base}/api/status`)).json()
    assert.equal(status.workDirLegacy, true)
    assert.equal(status.workDir, work)
  } finally {
    await server.close()
    await rm(dir, { recursive: true, force: true })
  }
})
