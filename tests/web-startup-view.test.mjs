/**
 * First-run banner: the only place that names the URL and explains a broken
 * Python before the user tries to sync.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  envLine, keyLine, mountStartup, startupNeeded, STARTUP_KEY,
} from '../web/js/views/startup.js'
import { findByClass, installDocument, makeElement, textOf } from './support/dom.mjs'

const tick = () => new Promise((resolve) => setTimeout(resolve, 20))

function fakeStorage(initial = {}) {
  const map = new Map(Object.entries(initial))
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)) },
    map,
  }
}

const healthy = { key: true, sqlcipher3: true, pyzipper: true, version: '3.12.4' }

test('the marker is compared with the server start time', () => {
  assert.equal(startupNeeded(100, ''), true)
  assert.equal(startupNeeded(100, '100'), false)
  assert.equal(startupNeeded(0, ''), false, 'an unknown start time is not a reason to nag')
})

test('the environment line says what is missing', () => {
  assert.match(envLine(null).text, /正在检查/)
  assert.equal(envLine(healthy).ok, true)
  assert.match(envLine(healthy).text, /Python 3\.12\.4 · sqlcipher3 已安装 · 密码 ZIP 可用/)
  const broken = envLine({ infoError: 'Python 没有响应', sqlcipher3: false })
  assert.equal(broken.ok, false)
  assert.match(broken.text, /Python 没有响应/)
  assert.equal(keyLine({ key: true }).ok, true)
  assert.match(keyLine({ key: false }).text, /未提取/)
})

test('the banner shows once, offers the fixes, and remembers being closed', async () => {
  const restore = installDocument()
  const storage = fakeStorage()
  const posts = []
  const api = {
    get: async (path) => (path === '/api/status'
      ? { startedAt: 123, url: 'http://127.0.0.1:46728/' }
      : { ...healthy, key: false }),
    post: async (path, body) => {
      posts.push({ path, body })
      return {}
    },
  }
  const root = makeElement('main')
  const cleanup = mountStartup(root, { api, storage })
  try {
    await tick()
    const box = findByClass(root, 'startup')
    assert.equal(box.hidden, false)
    assert.match(textOf(box), /http:\/\/127\.0\.0\.1:46728\//)
    assert.match(textOf(box), /sqlcipher3 已安装/)
    // Environment is fine, so only the missing key is offered.
    const buttons = findByClass(box, 'startup-actions').children
    const extract = buttons.find((item) => textOf(item) === '提取密钥')
    assert.equal(extract.hidden, false)
    assert.equal(buttons.find((item) => textOf(item) === '默认源安装').hidden, true)

    extract.dispatch('click')
    await tick()
    assert.deepEqual(posts, [{ path: '/api/key/extract', body: { confirm: true, force: true } }])

    buttons.find((item) => textOf(item) === '关闭提示').dispatch('click')
    assert.equal(storage.map.get(STARTUP_KEY), '123')
  } finally {
    cleanup()
    restore()
  }
})

test('a dismissed server start stays quiet, a new one shows again', async () => {
  const restore = installDocument()
  try {
    const root = makeElement('main')
    const api = {
      get: async (path) => (path === '/api/status'
        ? { startedAt: 123, url: 'http://x/' }
        : healthy),
      post: async () => ({}),
    }
    const cleanup = mountStartup(root, { api, storage: fakeStorage({ [STARTUP_KEY]: '123' }) })
    await tick()
    assert.equal(findByClass(root, 'startup').hidden, true)
    cleanup()

    const again = makeElement('main')
    const stale = mountStartup(again, {
      api: {
        get: async (path) => (path === '/api/status'
          ? { startedAt: 456, url: 'http://x/' }
          : healthy),
        post: async () => ({}),
      },
      storage: fakeStorage({ [STARTUP_KEY]: '123' }),
    })
    await tick()
    assert.equal(findByClass(again, 'startup').hidden, false)
    stale()
  } finally {
    restore()
  }
})

test('a broken environment offers the one-click setup', async () => {
  const restore = installDocument()
  const posts = []
  const api = {
    get: async (path) => (path === '/api/status'
      ? { startedAt: 9, url: 'http://x/' }
      : { infoError: 'Python 没有响应', sqlcipher3: false, key: false }),
    post: async (path, body) => {
      posts.push({ path, body })
      return {}
    },
  }
  const root = makeElement('main')
  const cleanup = mountStartup(root, { api, storage: fakeStorage() })
  try {
    await tick()
    const box = findByClass(root, 'startup')
    assert.match(textOf(box), /环境检查失败/)
    const buttons = findByClass(box, 'startup-actions').children
    const mirror = buttons.find((item) => textOf(item) === '清华镜像安装')
    assert.equal(mirror.hidden, false)
    mirror.dispatch('click')
    await tick()
    assert.deepEqual(posts, [{ path: '/api/setup/venv', body: { confirm: true, source: 'tsinghua' } }])
  } finally {
    cleanup()
    restore()
  }
})
