/**
 * Settings view: the shape of the patch, and the two-step destructive actions.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  keyStateLabel, mountSettings, platformLabel, settingsPatch, setupStateLabel, storageSummary,
} from '../web/js/views/settings.js'
import { findAllByClass, findByClass, installDocument, makeElement, textOf } from './support/dom.mjs'

const tick = () => new Promise((resolve) => setTimeout(resolve, 25))

const settingsPayload = {
  settings: {
    webPort: 46728, workDir: '/tmp/w', installer: 'auto', pythonPath: '',
    tencentRoot: '', account: '', keepAccountIndexes: 2, searchIndex: 'fts',
    autoSync: true, syncIntervalMinutes: 60,
  },
  file: '/home/user/.config/settings.json',
}

const storagePayload = {
  totalBytes: 2048, items: [
    { id: 'index', label: '索引', detail: '可重建', bytes: 1024 },
    { id: 'key', label: '密钥', detail: '需重新提取', bytes: 32 },
  ],
}

/** Every endpoint the view touches, so one fake serves all cards. */
function fakeApi(overrides = {}) {
  const calls = []
  const api = {
    get: async (path) => {
      calls.push({ method: 'GET', path })
      if (overrides[path]) return overrides[path]
      if (path === '/api/settings') return settingsPayload
      if (path === '/api/key/extract') return { state: 'idle', log: [] }
      if (path === '/api/setup') return { state: 'idle', log: [], python: 'python3' }
      if (path === '/api/presets') return { presets: [] }
      if (path === '/api/diagnostics') return { pluginVersion: '0.16.0', python: 'python3', version: '3.12', sqlcipher3: true }
      if (path === '/api/storage') return storagePayload
      return {}
    },
    put: async (path, body) => {
      calls.push({ method: 'PUT', path, body })
      return {}
    },
    post: async (path, body) => {
      calls.push({ method: 'POST', path, body })
      return { removed: 1, freedBytes: 1024 }
    },
  }
  return { api, calls }
}

test('settingsPatch turns form strings into typed values', () => {
  const patch = settingsPatch({
    webPort: '46728', workDir: ' /data ', installer: 'uv', pythonPath: '',
    tencentRoot: '', account: '10001', keepAccountIndexes: '1',
    searchIndex: 'like', autoSync: false, syncIntervalMinutes: '30',
  })
  assert.equal(patch.webPort, 46728)
  assert.equal(patch.workDir, '/data')
  assert.equal(patch.keepAccountIndexes, 1)
  assert.equal(patch.syncIntervalMinutes, 30)
  assert.equal(patch.autoSync, false)
  assert.equal(patch.installer, 'uv')
})

test('labels say what happened, not just the raw state', () => {
  assert.match(keyStateLabel({ state: 'running', step: '扫描内存' }), /正在提取：扫描内存/)
  assert.match(keyStateLabel({ state: 'done', key: false }), /没有找到密钥/)
  assert.match(setupStateLabel({ state: 'error', error: 'pip 失败' }), /配置失败：pip 失败/)
  assert.match(storageSummary(storagePayload), /2 类 · 共 2\.0 KB/)
  assert.match(storageSummary({ items: [] }), /没有可清理/)
})

test('the form loads settings and saves a patch', async () => {
  const restore = installDocument()
  const { api, calls } = fakeApi()
  const root = makeElement('main')
  const cleanup = mountSettings(root, { api })
  try {
    await tick()
    assert.match(textOf(root), /设置文件：\/home\/user/)
    const form = findByClass(root, 'settings-form')
    const inputs = findAllByClass(form, 'settings-row')
    assert.equal(inputs.length, 10)
    form.dispatch('submit')
    await tick()
    const put = calls.find((call) => call.method === 'PUT')
    assert.equal(put.path, '/api/settings')
    assert.equal(put.body.webPort, 46728)
    assert.equal(put.body.searchIndex, 'fts')
    assert.match(textOf(root), /已保存/)
  } finally {
    cleanup()
    restore()
  }
})

test('key extraction asks for confirmation in the request body', async () => {
  const restore = installDocument()
  const { api, calls } = fakeApi()
  const root = makeElement('main')
  const cleanup = mountSettings(root, { api })
  try {
    await tick()
    const button = findAllByClass(root, 'primary')
      .find((item) => textOf(item) === '提取密钥')
    button.dispatch('click')
    await tick()
    const post = calls.find((call) => call.method === 'POST' && call.path === '/api/key/extract')
    assert.deepEqual(post.body, { confirm: true, force: true })
  } finally {
    cleanup()
    restore()
  }
})

test('storage cleanup needs two clicks and then sends the ids', async () => {
  const restore = installDocument()
  const { api, calls } = fakeApi()
  const root = makeElement('main')
  const cleanup = mountSettings(root, { api })
  try {
    await tick()
    const rows = findByClass(root, 'storage-list').children
    const check = rows[0].children[0]
    check.checked = true
    check.dispatch('change')
    const button = findAllByClass(root, 'danger')
      .find((item) => textOf(item) === '删除选中')
    button.dispatch('click')
    assert.equal(button.textContent, '确认删除')
    assert.equal(calls.filter((call) => call.method === 'POST').length, 0)

    button.dispatch('click')
    await tick()
    const post = calls.find((call) => call.method === 'POST' && call.path === '/api/storage/cleanup')
    assert.deepEqual(post.body, { confirm: true, ids: ['index'] })
    assert.match(textOf(root), /已删除 1 项/)
  } finally {
    cleanup()
    restore()
  }
})

test('a preset can be deleted from settings', async () => {
  const restore = installDocument()
  const { api, calls } = fakeApi({
    '/api/presets': {
      presets: [{ name: 'CSV 只要正文', format: 'csv', redact: '', media: false, split: '', frontMatter: false }],
    },
  })
  const root = makeElement('main')
  const cleanup = mountSettings(root, { api })
  try {
    await tick()
    const row = findByClass(root, 'preset-list').children[0]
    assert.match(textOf(row), /CSV 只要正文/)
    row.children[2].dispatch('click')
    await tick()
    const post = calls.find((call) => call.method === 'POST' && call.path === '/api/presets')
    assert.deepEqual(post.body, { remove: 'CSV 只要正文' })
  } finally {
    cleanup()
    restore()
  }
})

test('a legacy temp work directory can be migrated from settings', async () => {
  const restore = installDocument()
  const posts = []
  const legacy = {
    settings: { ...settingsPayload.settings, workDirLegacy: true },
    url: 'http://127.0.0.1:46728/',
    file: '/home/user/.config/settings.json',
  }
  const api = {
    get: async (path) => {
      if (path === '/api/settings') return legacy
      if (path === '/api/presets') return { presets: [] }
      if (path === '/api/storage') return storagePayload
      if (path === '/api/key/extract') return { state: 'idle', log: [] }
      if (path === '/api/setup') return { state: 'idle', log: [] }
      return {}
    },
    put: async () => ({}),
    post: async (path, body) => {
      posts.push({ path, body })
      return { copied: ['key.txt', 'index.sqlite'], workDir: '/data' }
    },
  }
  const root = makeElement('main')
  const cleanup = mountSettings(root, { api })
  try {
    await tick()
    assert.match(textOf(root), /地址 http:\/\/127\.0\.0\.1:46728\//)
    const note = findByClass(root, 'migration-note')
    const buttons = findAllByClass(root, 'ghost')
    const migrate = buttons.find((item) => textOf(item) === '迁移到持久目录')
    assert.ok(migrate, 'the migration button must appear for a legacy work dir')
    migrate.dispatch('click')
    assert.equal(migrate.textContent, '确认迁移')
    migrate.dispatch('click')
    await tick()
    assert.deepEqual(posts, [{ path: '/api/workdir/migrate', body: undefined }])
    assert.match(textOf(note), /已迁移 2 项/)
  } finally {
    cleanup()
    restore()
  }
})

test('an empty numeric field is left out instead of becoming zero', () => {
  const patch = settingsPatch({
    webPort: '', workDir: '/data', installer: 'auto', pythonPath: '', tencentRoot: '',
    account: '', keepAccountIndexes: '  ', searchIndex: 'fts', autoSync: true,
    syncIntervalMinutes: '',
  })
  assert.equal(patch.webPort, undefined, 'an empty port must not close the listener')
  assert.equal(patch.keepAccountIndexes, undefined)
  assert.equal(patch.syncIntervalMinutes, undefined)
  assert.equal(patch.workDir, '/data')
})

test('a port change tells the user the page moved instead of "next start"', async () => {
  const restore = installDocument()
  const { api, calls } = fakeApi()
  api.put = async (path, body) => {
    calls.push({ method: 'PUT', path, body })
    return { ...settingsPayload, restart: true, url: 'http://127.0.0.1:47000/', previousUrl: 'http://127.0.0.1:46728/' }
  }
  const root = makeElement('main')
  const cleanup = mountSettings(root, { api })
  try {
    await tick()
    findByClass(root, 'settings-form').dispatch('submit')
    await tick()
    const text = textOf(root)
    assert.match(text, /端口已切换/)
    assert.match(text, /47000/)
    assert.doesNotMatch(text, /下次启动/)
  } finally {
    cleanup()
    restore()
  }
})

test('the diagnostics card prints the platform, not "[object Object]"', async () => {
  const restore = installDocument()
  const { api } = fakeApi({
    '/api/diagnostics': {
      pluginVersion: '0.17.3', python: 'python3', version: '3.12', sqlcipher3: true,
      platform: { os: 'linux', arch: 'x86_64', bits: 64, python: '3.12' },
      key: false, index: true, venv: { python: '/v/bin/python' },
    },
  })
  const root = makeElement('main')
  const cleanup = mountSettings(root, { api })
  try {
    await tick()
    const grid = findByClass(root, 'diag-grid')
    const values = findAllByClass(grid, 'diag-value').map((node) => node.textContent)
    assert.ok(values.includes('linux x86_64'), `no platform value in ${JSON.stringify(values)}`)
    assert.doesNotMatch(textOf(grid), /\[object Object\]/)
  } finally {
    cleanup()
    restore()
  }
})

test('platformLabel accepts the object and the plain string', () => {
  assert.equal(platformLabel({ os: 'linux', arch: 'x86_64' }), 'linux x86_64')
  assert.equal(platformLabel({ os: 'win32' }), 'win32')
  assert.equal(platformLabel('linux'), 'linux')
  assert.equal(platformLabel(null), '')
})
