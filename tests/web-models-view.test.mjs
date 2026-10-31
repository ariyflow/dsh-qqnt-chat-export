/**
 * The model management view.
 *
 * The delete button is the reason this view exists: model files sit outside
 * the export directory, so nothing else in the UI can reclaim them. The
 * two-step confirm is asserted here because a single stray click would mean
 * re-downloading hundreds of megabytes.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { componentList, componentState, formatBytes, modelList, modelState, mountModels } from '../web/js/views/models.js'
import { findByClass, installDocument, makeElement, textOf } from './support/dom.mjs'

const tick = () => new Promise((resolve) => setTimeout(resolve, 15))

const payload = {
  'rapidocr-v4': {
    id: 'rapidocr-v4', label: 'OCR 模型', license: 'Apache-2.0', feature: 'ocr',
    expectedBytes: 15 * 1024 * 1024, bytes: 15 * 1024 * 1024,
    installed: true, intact: true, files: [],
  },
  'paraformer-zh': {
    id: 'paraformer-zh', label: '语音模型', license: 'Apache-2.0', feature: 'asr',
    expectedBytes: 230 * 1024 * 1024, bytes: 0,
    installed: false, intact: false, files: [],
  },
}

test('formatBytes keeps sizes readable and refuses zero', () => {
  assert.equal(formatBytes(0), '—')
  assert.equal(formatBytes(512), '512 B')
  assert.equal(formatBytes(15 * 1024 * 1024), '15 MB')
  assert.equal(formatBytes(230 * 1024 * 1024), '230 MB')
  assert.equal(formatBytes(1024), '1.0 KB')
})

test('modelState distinguishes missing from corrupt files', () => {
  assert.equal(modelState({ installed: true, intact: true }), '已安装')
  assert.equal(modelState({ installed: true, intact: false }), '校验失败')
  assert.equal(modelState({ installed: false, intact: false }), '未安装')
  assert.equal(modelState(null), '未知')
})

test('modelList sorts by feature and drops junk rows', () => {
  assert.deepEqual(modelList({ a: { id: 'a', feature: 'ocr' }, b: null }).map((m) => m.id), ['a'])
})

test('delete needs a second click and then calls the API', async () => {
  const restore = installDocument()
  const removed = []
  const api = {
    get: async () => payload,
    remove: async (path) => {
      removed.push(path)
      return { removed: true, bytes: 15 * 1024 * 1024 }
    },
    post: async () => ({}),
  }
  const root = makeElement('main')
  const cleanup = mountModels(root, { api })
  try {
    await tick()
    const list = findByClass(root, 'models-list')
    assert.equal(list.children.length, 2)

    // Rows are sorted by feature, so pick by label instead of position.
    const installed = list.children.find((row) => textOf(row).includes('OCR 模型'))
    const button = installed.children[2].children[0]
    assert.equal(button.textContent, '删除')
    button.dispatch('click')
    assert.equal(button.textContent, '确认删除')
    assert.deepEqual(removed, [])

    button.dispatch('click')
    await tick()
    assert.deepEqual(removed, ['/api/models/rapidocr-v4'])
    assert.match(textOf(root), /已删除 OCR 模型/)
  } finally {
    cleanup()
    restore()
  }
})

test('a missing model offers download instead of delete', async () => {
  const restore = installDocument()
  const posted = []
  const api = {
    get: async () => payload,
    remove: async () => ({}),
    post: async (path) => {
      posted.push(path)
      return {}
    },
  }
  const root = makeElement('main')
  const cleanup = mountModels(root, { api })
  try {
    await tick()
    const missing = findByClass(root, 'models-list').children
      .find((row) => textOf(row).includes('语音模型'))
    const button = missing.children[2].children[0]
    assert.equal(button.textContent, '下载')
    button.dispatch('click')
    await tick()
    assert.deepEqual(posted, ['/api/models/paraformer-zh/download'])
    assert.match(textOf(root), /正在后台下载/)
  } finally {
    cleanup()
    restore()
  }
})

const componentPayload = {
  components: {
    ocr: {
      id: 'ocr', label: '截图识别', feature: 'ocr', installed: false, venv: true,
      missing: ['rapidocr_onnxruntime'], packages: ['rapidocr-onnxruntime'],
      expectedBytes: 30 * 1024 * 1024,
    },
    embed: {
      id: 'embed', label: '语义检索', feature: 'ask', installed: true, venv: true,
      missing: [], packages: ['numpy', 'onnxruntime', 'tokenizers'],
      expectedBytes: 40 * 1024 * 1024,
    },
  },
}

test('componentState tells missing modules from a non-venv interpreter', () => {
  assert.equal(componentState({ installed: true, venv: true }), '已安装')
  assert.equal(componentState({ installed: false, missing: ['av'], venv: true }), '缺少 av')
  assert.equal(componentState({ installed: false, missing: [], venv: true }), '未安装')
  assert.equal(componentState({ installed: false, missing: [], venv: false }), '需要虚拟环境')
  assert.equal(componentState(null), '未知')
})

test('componentList is empty when the helper has no components endpoint', () => {
  assert.deepEqual(componentList(null), [])
  assert.deepEqual(componentList({}), [])
  assert.deepEqual(componentList(componentPayload).map((item) => item.id), ['embed', 'ocr'])
})

test('the components block installs with one click and never offers a reinstall', async () => {
  const restore = installDocument()
  const posted = []
  const api = {
    get: async (path) => (path === '/api/components' ? componentPayload : payload),
    remove: async () => ({}),
    post: async (path, body) => {
      posted.push({ path, body })
      return {}
    },
  }
  const root = makeElement('main')
  const cleanup = mountModels(root, { api })
  try {
    await tick()
    const rows = findByClass(root, 'components-list').children
    assert.equal(rows.length, 2)
    const ocrRow = rows.find((row) => textOf(row).includes('截图识别'))
    assert.match(textOf(ocrRow), /缺少 rapidocr_onnxruntime/)
    const install = ocrRow.children[2].children[0]
    assert.equal(install.textContent, '安装')
    install.dispatch('click')
    await tick()
    assert.deepEqual(posted, [{ path: '/api/components/install', body: { groups: ['ocr'] } }])
    assert.match(textOf(root), /正在后台安装/)

    // The already-installed group shows a label, not a button.
    const embedRow = rows.find((row) => textOf(row).includes('语义检索'))
    assert.equal(embedRow.children[2].children[0].textContent, '已安装')
  } finally {
    cleanup()
    restore()
  }
})

test('a non-venv interpreter disables the install button', async () => {
  const restore = installDocument()
  const api = {
    get: async (path) => (path === '/api/components'
      ? { components: { ocr: { ...componentPayload.components.ocr, venv: false } } }
      : payload),
    remove: async () => ({}),
    post: async () => ({}),
  }
  const root = makeElement('main')
  const cleanup = mountModels(root, { api })
  try {
    await tick()
    const row = findByClass(root, 'components-list').children[0]
    assert.match(textOf(row), /需要虚拟环境/)
    assert.equal(row.children[2].children[0].attributes.disabled, 'true')
  } finally {
    cleanup()
    restore()
  }
})
