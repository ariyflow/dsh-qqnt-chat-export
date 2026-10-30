import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { accountDigest, diagnosticsBundle, lastSegment, startWebServer } from '../web.js'

const ACCOUNT = '12345'
const HOME = 'C:\\Users\\someone'
const WORK = `${HOME}\\AppData\\Local\\dsh-qqnt-chat-export\\work`

function sampleDiagnostics(error = '', workDir = WORK) {
  return {
    ok: true,
    python: 'C:\\Users\\someone\\venv\\Scripts\\python.exe',
    version: '3.12.4',
    bits: 64,
    sqlcipher3: true,
    pyzipper: true,
    error,
    uv: { available: true, version: 'uv 0.9.21' },
    key: true,
    index: true,
    platform: {
      os: 'win32',
      arch: 'AMD64',
      bits: 64,
      python: '3.12.4',
      sqlcipher: true,
      pyzipper: true,
      qqProcesses: 8,
      memoryAccess: '允许（Windows 进程 API）',
      dataRootFound: true,
      account: ACCOUNT,
      accounts: 3,
      workDirExists: true,
    },
    paths: {
      tencentRoot: 'C:\\Users\\someone\\Documents\\Tencent Files',
      dbDir: `C:\\Users\\someone\\Documents\\Tencent Files\\${ACCOUNT}\\nt_qq\\nt_db`,
      dataDir: `C:\\Users\\someone\\Documents\\Tencent Files\\${ACCOUNT}\\nt_qq\\nt_data`,
      workDir,
      python: 'C:\\Users\\someone\\venv\\Scripts\\python.exe',
      index: `${workDir}\\index.sqlite`,
      venv: '',
    },
    schema: {
      fingerprint: '7374ab35d26d',
      missing: [],
      unchecked: [],
      tables: { group_msg_table: { db: 'nt_msg', present: 39, missing: [], checked: true } },
    },
    infoError: '',
  }
}

function sampleStatus() {
  return {
    index: {
      exists: true, size: 395_000_000, version: '6', schema: '7374ab35d26d',
      messages: 1_245_833, chats: 293, search: 'fts', account: ACCOUNT,
    },
    build: {
      state: 'done', mode: 'incremental', startedAt: 100, finishedAt: 117,
      walPending: false, schemaChanged: true,
      error: `同步失败：C:\\Users\\someone\\AppData\\Local\\dsh-qqnt-chat-export\\work\\nt_msg.db 被占用（账号 ${ACCOUNT}）`,
    },
    sync: { autoSync: true, intervalMinutes: 60, lastSyncAt: 1700000000, error: '' },
  }
}

const storage = {
  totalBytes: 400_000_000,
  items: [{ id: 'decrypted', bytes: 395_000_000 }, { id: 'index', bytes: 5_000_000 }],
}

test('path and account helpers never echo the original value', () => {
  assert.equal(lastSegment('C:\\Users\\someone\\Documents\\Tencent Files\\'), 'Tencent Files')
  assert.equal(lastSegment('/home/someone/.config/QQ'), 'QQ')
  assert.equal(lastSegment(''), '')
  assert.equal(lastSegment(null), '')
  assert.match(accountDigest(ACCOUNT), /^[0-9a-f]{8}$/)
  assert.notEqual(accountDigest(ACCOUNT), ACCOUNT)
  assert.equal(accountDigest(''), '')
})

test('the bundle keeps the useful fields and drops the identifying ones', () => {
  const bundle = diagnosticsBundle({
    version: '0.12.0',
    diagnostics: sampleDiagnostics(),
    status: sampleStatus(),
    storage,
    now: new Date('2026-10-30T05:00:00Z'),
  })
  const text = JSON.stringify(bundle)

  // No account number, no home directory, no key, no chat content.
  assert.ok(!text.includes(ACCOUNT), 'account number leaked')
  assert.ok(!text.includes('someone'), 'user name leaked')
  assert.ok(!text.includes('Tencent Files\\' + ACCOUNT), 'account path leaked')
  assert.ok(!/key\.txt/.test(text))

  // Still enough to diagnose: platform, dependency state, sizes, schema.
  assert.equal(bundle.version, '0.12.0')
  assert.equal(bundle.platform.os, 'win32')
  assert.equal(bundle.platform.accounts, 3)
  assert.equal(bundle.platform.account, accountDigest(ACCOUNT))
  assert.equal(bundle.paths.workDir, 'work')
  assert.equal(bundle.paths.tencentRoot, 'Tencent Files')
  assert.equal(bundle.paths.python, 'python.exe')
  assert.equal(bundle.schema.fingerprint, '7374ab35d26d')
  assert.equal(bundle.index.version, '6')
  assert.equal(bundle.index.messages, 1_245_833)
  assert.equal(bundle.build.seconds, 17)
  assert.equal(bundle.build.schemaChanged, true)
  assert.equal(bundle.sync.lastRun, new Date(1_700_000_000_000).toISOString())
  assert.equal(bundle.deps.sqlcipher3, true)
  assert.equal(bundle.deps.uv, 'uv 0.9.21')
  assert.equal(bundle.storage.decryptedBytes, 395_000_000)
  assert.equal(bundle.storage.totalBytes, 400_000_000)
  assert.equal(bundle.generatedAt, '2026-10-30T05:00:00.000Z')
})

test('free-text errors are scrubbed of paths and accounts', () => {
  const bundle = diagnosticsBundle({
    version: '0.12.0',
    diagnostics: sampleDiagnostics('cannot run C:\\Users\\someone\\venv\\Scripts\\python.exe'),
    status: sampleStatus(),
    storage,
  })
  const text = JSON.stringify(bundle)
  assert.ok(!text.includes('someone'), 'error text leaked the home directory')
  assert.ok(!text.includes(ACCOUNT), 'error text leaked the account')
  assert.match(bundle.build.error, /work|nt_msg\.db/)
  assert.ok(bundle.errors.length >= 1)
  // A long message is capped rather than shipped whole.
  const long = diagnosticsBundle({
    version: '0.12.0',
    diagnostics: sampleDiagnostics('x'.repeat(5000)),
    status: {},
  })
  assert.ok(long.deps.probeError.length <= 301)
})

test('a broken environment still produces a bundle', () => {
  const bundle = diagnosticsBundle({
    version: '0.12.0',
    diagnostics: { ok: false, error: 'not found', platform: null, paths: null, schema: null, infoError: '无法读取环境信息：not found' },
    status: {},
    storage: null,
  })
  assert.equal(bundle.platform, null)
  assert.equal(bundle.paths, null)
  assert.equal(bundle.schema, null)
  assert.equal(bundle.index.exists, false)
  assert.equal(bundle.build.state, 'idle')
  assert.equal(bundle.deps.sqlcipher3, false)
  assert.equal(bundle.storage.totalBytes, 0)
  assert.match(bundle.deps.infoError, /无法读取环境信息/)
  assert.ok(!JSON.stringify(bundle).includes('undefined'))
})

/** Start the UI on a free random loopback port. */
async function startServer(settings, handlers) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const port = 28000 + Math.floor(Math.random() * 4000)
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

test('GET /api/diagnostics names the running plugin version', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'qqnt-diag-'))
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  const handlers = { getDiagnostics: async () => sampleDiagnostics('', dir) }
  const { server, base } = await startServer({ python: process.execPath, workDir: dir }, handlers)
  try {
    const response = await fetch(`${base}/api/diagnostics`)
    assert.equal(response.status, 200)
    const body = await response.json()
    // `version` stays the Python interpreter; the plugin build is `pluginVersion`.
    assert.equal(body.pluginVersion, pkg.version)
    assert.equal(body.version, '3.12.4')
    assert.equal(body.platform.python, '3.12.4')
  } finally {
    await server.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('GET /api/diagnostics/bundle downloads a scrubbed attachment', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'qqnt-bundle-'))
  const settings = { python: process.execPath, workDir: dir }
  const handlers = {
    getDiagnostics: async () => sampleDiagnostics('', dir),
    getStorage: () => storage,
  }
  const { server, base } = await startServer(settings, handlers)
  try {
    const response = await fetch(`${base}/api/diagnostics/bundle`)
    assert.equal(response.status, 200)
    assert.match(response.headers.get('content-type'), /application\/json/)
    assert.match(response.headers.get('content-disposition'),
      /attachment; filename="qqnt-diagnostics-[\d.]+-\d{8}-\d{4}\.json"/)
    const body = await response.text()
    const bundle = JSON.parse(body)
    const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
    assert.equal(bundle.version, pkg.version)
    assert.equal(bundle.paths.workDir, path.basename(dir))
    assert.ok(!body.includes(ACCOUNT), 'the account number reached the attachment')
    assert.ok(!body.includes('someone'))
  } finally {
    await server.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('the bundle route answers 501 when the host provides no diagnostics', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'qqnt-bundle-'))
  const { server, base } = await startServer({ python: process.execPath, workDir: dir }, {})
  try {
    const response = await fetch(`${base}/api/diagnostics/bundle`)
    assert.equal(response.status, 501)
  } finally {
    await server.close()
    await rm(dir, { recursive: true, force: true })
  }
})
