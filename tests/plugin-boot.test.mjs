/**
 * Boot the real plugin (`apply`) on a real listener, the way DSH does.
 *
 * The startup path and the bind-test path used to build different
 * `startWebServer` options: only the bind-test one passed the job runners, so
 * on a normal start every `POST /api/export`, OCR, ASR and chunks job answered
 * 500 "未知的任务类型" while the UI looked healthy. This case fails if the two
 * paths diverge again.
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const PYTHON = process.env.PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3')

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

test('the startup listener knows every job kind (export included)', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'qqnt-boot-'))
  const port = await freePort()
  const disposers = []
  const ctx = {
    tools: { register() {} },
    webServer: { register: () => () => {} },
    effect(fn) {
      const dispose = fn()
      if (typeof dispose === 'function') disposers.push(dispose)
      return dispose
    },
    systemPrompt: { section() {} },
  }
  // `loadOverrides()` reads the user's own settings file; point HOME at the
  // scratch directory so this test cannot pick up a real port or workDir.
  const previousHome = process.env.HOME
  process.env.HOME = dir
  const { apply } = await import('../index.js')
  try {
    apply(ctx, {
      webPort: port,
      workDir: dir,
      tencentRoot: path.join(dir, 'no-qq'),
      autoSync: false,
      python: PYTHON,
    })
    const base = `http://127.0.0.1:${port}`
    let response = null
    for (let attempt = 0; attempt < 50; attempt += 1) {
      try {
        response = await fetch(`${base}/api/jobs`)
        break
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
    }
    assert.ok(response, 'the listener never came up')

    const exportResponse = await fetch(`${base}/api/export`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-qqnt-action': '1' },
      body: JSON.stringify({ format: 'txt', chatKind: 'group', chatId: '1' }),
    })
    const body = await exportResponse.json()
    assert.equal(exportResponse.status, 202, JSON.stringify(body))
    assert.equal(body.kind, 'export')
  } finally {
    process.env.HOME = previousHome
    for (const dispose of disposers) {
      try {
        await dispose()
      } catch {
        // Disposal is best effort in the harness.
      }
    }
    await rm(dir, { recursive: true, force: true })
  }
})
